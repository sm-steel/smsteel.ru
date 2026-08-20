import { useFrame } from "@react-three/fiber"
import { useMemo, useRef } from "react"
import * as THREE from "three"
import {
  type CrystalSite,
  mulberry32,
  type Shard,
  SHARD_VARIANT_METRICS,
  type ShardVariantMetrics,
  triggerGlow,
} from "./crystals"

// How fast an arc/resonance-triggered glow decays once it's lit — a quick,
// punchy fade (vs. AmbientGlow's much slower one in crystals.tsx) so a
// strike still reads as a snap of brightness, not a lingering glow.
const ARC_GLOW_DECAY_TAU = 0.35

// --- electrical discharge -------------------------------------------------
// Three independent, differently-paced systems, matching how real corona
// discharge reads: a constant fizz of tiny surface-hugging specks (cheap,
// many at once, no shape to speak of), rare full branching arcs off a
// single crystal (a jagged polyline that snaps to length then decays in
// brightness+thickness, with short branches that die first), and rarer
// still, resonance bolts that jump between two crystals close enough
// together to plausibly arc to one another. All three spawn biased toward
// the crystal's high-curvature features (its apex tip and its six edges)
// rather than uniformly over the surface, and all are pooled/ref-driven —
// no React state, no per-frame allocation — following the same shape as
// `RippleState` in ripples.ts.

const UNIT_X = new THREE.Vector3(1, 0, 0)
const UNIT_Y = new THREE.Vector3(0, 1, 0)

// Exported alongside the arc machinery below so other glass objects (e.g.
// title.tsx) can build their own small arc pool without duplicating it.
export function lerp(a: number, b: number, t: number) {
  return a + (b - a) * t
}

export function randInt(rand: () => number, min: number, max: number) {
  return min + Math.floor(rand() * (max - min + 1))
}

// --- curvature-biased spawn points ----------------------------------------
// Each shard now has its own (approximate) silhouette — see
// SHARD_VARIANT_METRICS in crystals.tsx, one entry per geometry variant —
// rather than every shard sharing one fixed shape. Callers pass in the
// specific shard's metrics (looked up by its variantId) so fizz/arc/
// resonance spawn points still roughly track each shard's real proportions
// instead of assuming a single silhouette for the whole field.

const scratchLocal = new THREE.Vector3()
const scratchDir = new THREE.Vector3()

/** Biases spawn points toward the shard's highest-curvature convex features — its apex tip and its six edges — rather than sampling its surface uniformly. Writes into the shared scratch vectors; callers must consume them before calling again. */
function pickSurfacePoint(
  rand: () => number,
  apexWeight: number,
  metrics: ShardVariantMetrics,
) {
  if (rand() < apexWeight) {
    const jitter = (rand() - 0.5) * 0.08
    scratchLocal.set(jitter, metrics.apexY - rand() * 0.1, jitter)
    scratchDir.set(rand() - 0.5, 1, rand() - 0.5).normalize()
    return { local: scratchLocal, direction: scratchDir }
  }
  const edgeIndex = Math.floor(rand() * 6)
  const angle = (edgeIndex / 6) * Math.PI * 2 + (rand() - 0.5) * 0.35
  const heightT = rand()
  const y = lerp(metrics.bodyBottomY, metrics.bodyTopY, heightT)
  const radius = lerp(metrics.radiusBottom, metrics.radiusTop, heightT)
  scratchLocal.set(Math.cos(angle) * radius, y, Math.sin(angle) * radius)
  scratchDir.set(Math.cos(angle), 0.15, Math.sin(angle)).normalize()
  return { local: scratchLocal, direction: scratchDir }
}

// --- local -> world resolution ---------------------------------------------
// Reuses three.js's own matrix composition instead of re-deriving the
// site/shard transform chain by hand: a scratch site->shard dummy hierarchy
// is set to match the same position/rotation/scale props crystals.tsx
// applies to its `<group>`s, and world position/direction are read back off
// it. Both sites and (for arcs) fizz/arcs render at the scene root in world
// space, since a small global pool needs to jump between randomly chosen
// crystals on every spawn — reparenting a mesh between per-site groups on
// every firing would be far more awkward than resolving world space once.
const siteDummy = new THREE.Object3D()
const shardDummy = new THREE.Object3D()
siteDummy.add(shardDummy)

function resolveWorldPoint(
  site: CrystalSite,
  shard: Shard,
  local: THREE.Vector3,
  direction: THREE.Vector3,
  outPos: THREE.Vector3,
  outDir: THREE.Vector3,
) {
  siteDummy.position.set(...site.position)
  siteDummy.rotation.set(0, 0, 0)
  siteDummy.scale.setScalar(site.scale)
  shardDummy.position.set(...shard.offset)
  shardDummy.rotation.set(shard.tilt[0], shard.rotationY, shard.tilt[1])
  shardDummy.scale.setScalar(shard.scale)
  siteDummy.updateMatrixWorld(true)
  outPos.copy(local).applyMatrix4(shardDummy.matrixWorld)
  outDir.copy(direction).transformDirection(shardDummy.matrixWorld)
}

function pickShard(rand: () => number, site: CrystalSite): Shard {
  return site.shards[Math.floor(rand() * site.shards.length)]
}

// --- fizz: constant surface-hugging speck cloud -----------------------------
// One global THREE.Points cloud (one draw call for the whole field) rather
// than a mesh per speck — this tier is too small and numerous to justify
// per-instance shape/layering. gl_PointSize is set directly in pixels (no
// perspective falloff), matching "1-4px" literally.

const FIZZ_COUNT = 1240
const FIZZ_LIFETIME_MIN = 0.08
const FIZZ_LIFETIME_MAX = 0.22
const FIZZ_GAP_MIN = 0.05
const FIZZ_GAP_MAX = 0.28
const FIZZ_SIZE_MIN = 4
const FIZZ_SIZE_MAX = 5
const FIZZ_APEX_WEIGHT = 0.2
// Exported alongside the pool/render machinery below so other glass
// objects (e.g. title.tsx) can run their own fizz speck cloud in the same
// color family without duplicating the shader.
export const FIZZ_COLOR = new THREE.Color("#eafcff")

const fizzVertexShader = /* glsl */ `
  attribute float aSize;
  attribute float aStartTime;
  attribute float aDuration;
  uniform float uTime;
  varying float vAlpha;

  void main() {
    float age = uTime - aStartTime;
    float t = clamp(age / aDuration, 0.0, 1.0);
    // Snap to peak, then fade over the back half of its life — no growth.
    vAlpha = (age >= 0.0 && age <= aDuration) ? 1.0 - smoothstep(0.3, 1.0, t) : 0.0;
    vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
    gl_PointSize = aSize;
    gl_Position = projectionMatrix * mvPosition;
  }
`

const fizzFragmentShader = /* glsl */ `
  uniform vec3 uColor;
  varying float vAlpha;

  void main() {
    if (vAlpha <= 0.001) discard;
    float d = length(gl_PointCoord - 0.5);
    float mask = smoothstep(0.5, 0.0, d);
    gl_FragColor = vec4(uColor, vAlpha * mask);
  }
`

// Exported alongside createFizzPool/writeFizzSlot/FizzPoints below so other
// glass objects (e.g. title.tsx) can run their own fizz speck cloud without
// duplicating the pool/shader machinery — only *where* a speck spawns is
// crystal-specific (respawnFizzSlot below samples the shard field), same
// split as the arc pool machinery further down this file.
export interface FizzPool {
  positions: Float32Array
  sizes: Float32Array
  startTimes: Float32Array
  durations: Float32Array
  gaps: Float32Array
  geometry: THREE.BufferGeometry
}

export function createFizzPool(count: number): FizzPool {
  const positions = new Float32Array(count * 3)
  const sizes = new Float32Array(count)
  const startTimes = new Float32Array(count)
  const durations = new Float32Array(count).fill(FIZZ_LIFETIME_MIN)
  const gaps = new Float32Array(count).fill(0)
  // Stagger initial deaths across the pool so every slot doesn't spawn on
  // the very first frame at once.
  for (let i = 0; i < count; i++) {
    startTimes[i] = -(FIZZ_LIFETIME_MAX + FIZZ_GAP_MAX) * (i / count)
  }

  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute(
    "position",
    new THREE.BufferAttribute(positions, 3).setUsage(THREE.DynamicDrawUsage),
  )
  geometry.setAttribute(
    "aSize",
    new THREE.BufferAttribute(sizes, 1).setUsage(THREE.DynamicDrawUsage),
  )
  geometry.setAttribute(
    "aStartTime",
    new THREE.BufferAttribute(startTimes, 1).setUsage(THREE.DynamicDrawUsage),
  )
  geometry.setAttribute(
    "aDuration",
    new THREE.BufferAttribute(durations, 1).setUsage(THREE.DynamicDrawUsage),
  )

  return { positions, sizes, startTimes, durations, gaps, geometry }
}

/** Writes one respawned fizz slot's position/size/timing into the pool. Callers own picking the spawn point and timing ranges — this just writes them. */
export function writeFizzSlot(
  pool: FizzPool,
  i: number,
  now: number,
  position: THREE.Vector3,
  size: number,
  duration: number,
  gap: number,
) {
  pool.positions[i * 3] = position.x
  pool.positions[i * 3 + 1] = position.y
  pool.positions[i * 3 + 2] = position.z
  pool.sizes[i] = size
  pool.startTimes[i] = now
  pool.durations[i] = duration
  pool.gaps[i] = gap
}

function respawnFizzSlot(
  pool: FizzPool,
  i: number,
  now: number,
  sites: CrystalSite[],
  rand: () => number,
) {
  const site = sites[Math.floor(rand() * sites.length)]
  const shard = pickShard(rand, site)
  const metrics = SHARD_VARIANT_METRICS[shard.variantId]
  const { local, direction } = pickSurfacePoint(rand, FIZZ_APEX_WEIGHT, metrics)
  const worldPos = new THREE.Vector3()
  const worldDir = new THREE.Vector3()
  resolveWorldPoint(site, shard, local, direction, worldPos, worldDir)

  writeFizzSlot(
    pool,
    i,
    now,
    worldPos,
    lerp(FIZZ_SIZE_MIN, FIZZ_SIZE_MAX, rand()),
    lerp(FIZZ_LIFETIME_MIN, FIZZ_LIFETIME_MAX, rand()),
    lerp(FIZZ_GAP_MIN, FIZZ_GAP_MAX, rand()),
  )
}

/** Generic fizz speck-cloud renderer: owns the shader material/time uniform and the per-frame respawn scan, agnostic to *where* specks spawn — callers supply `respawn`. Reused by crystals.tsx's Fizz and title.tsx's own fizz cloud. */
export function FizzPoints({
  pool,
  count,
  color,
  reducedMotion,
  respawn,
}: {
  pool: FizzPool
  count: number
  color: THREE.Color
  reducedMotion: boolean
  respawn: (pool: FizzPool, index: number, now: number) => void
}) {
  const materialRef = useRef<THREE.ShaderMaterial>(null)
  const uniforms = useMemo(
    () => ({
      uTime: { value: 0 },
      uColor: { value: color },
    }),
    [color],
  )

  // Accumulated locally from `delta` rather than read off `clock.elapsedTime`
  // — R3F stops the render loop entirely while the tab is hidden
  // (frameloop="never" in scene-background.tsx), and three.js's Clock resets
  // elapsedTime back to ~0 on resume rather than continuing from where it
  // left off. Reading it directly would make every already-spawned speck's
  // stored startTime look like it's in the future forever, so it would never
  // become eligible to respawn again. Matches CrystalEdges's `uTime.value +=
  // delta` pattern in crystals.tsx, which is immune to the same reset.
  const timeRef = useRef(0)
  useFrame((_, delta) => {
    if (reducedMotion || !materialRef.current) return
    timeRef.current += delta
    const now = timeRef.current
    materialRef.current.uniforms.uTime.value = now

    let respawned = false
    for (let i = 0; i < count; i++) {
      const age = now - pool.startTimes[i]
      if (age > pool.durations[i] + pool.gaps[i]) {
        respawn(pool, i, now)
        respawned = true
      }
    }
    if (respawned) {
      pool.geometry.attributes.position.needsUpdate = true
      pool.geometry.attributes.aSize.needsUpdate = true
      pool.geometry.attributes.aStartTime.needsUpdate = true
      pool.geometry.attributes.aDuration.needsUpdate = true
    }
  })

  if (reducedMotion) return null

  return (
    <points geometry={pool.geometry} frustumCulled={false}>
      <shaderMaterial
        ref={materialRef}
        uniforms={uniforms}
        vertexShader={fizzVertexShader}
        fragmentShader={fizzFragmentShader}
        transparent
        depthWrite={false}
        blending={THREE.AdditiveBlending}
      />
    </points>
  )
}

function Fizz({
  sites,
  reducedMotion,
}: {
  sites: CrystalSite[]
  reducedMotion: boolean
}) {
  const rand = useMemo(() => mulberry32(0x5eed1), [])
  const pool = useMemo(() => createFizzPool(FIZZ_COUNT), [])
  const respawn = useMemo(
    () => (p: FizzPool, i: number, now: number) =>
      respawnFizzSlot(p, i, now, sites, rand),
    [sites, rand],
  )

  return (
    <FizzPoints
      pool={pool}
      count={FIZZ_COUNT}
      color={FIZZ_COLOR}
      reducedMotion={reducedMotion}
      respawn={respawn}
    />
  )
}

// --- arcs: rare branching lightning bolts -----------------------------------
// The "electricity" tier: snaps to near-full length within ~2 frames, then
// decays in brightness and thickness together (never shrinking in length),
// with 1-2 short branches that die before the main stroke. A small global
// pool (not one per crystal — 42 simultaneously-arcing crystals would be
// noise) round-robins which crystal it strikes next, same shape as
// RippleState's `nextSlot`.

const ARC_SLOT_COUNT = 150
const ARC_INTERVAL_MIN = 0.08
const ARC_INTERVAL_MAX = 0.25
const ARC_APEX_WEIGHT = 0.5
// Exported: the shape-generation tunables below are geometry-agnostic (no
// crystal-specific data), reused as-is by title.tsx's own small arc pool
// so its sparks look like the same species of bolt, not a re-tuned copy.
export const ARC_MAIN_SEGMENTS_MIN = 4
export const ARC_MAIN_SEGMENTS_MAX = 8
export const ARC_BRANCH_COUNT_MIN = 1
export const ARC_BRANCH_COUNT_MAX = 2
export const ARC_BRANCH_SEGMENTS_MIN = 2
export const ARC_BRANCH_SEGMENTS_MAX = 4
export const ARC_HARD_ANGLE = 0.9 // radians of random deviation per segment step
const ARC_REVEAL_TIME = 0.2 // ~2 frames @ 60fps — never slower than this
export const ARC_MAIN_DURATION_MIN = 0.28
export const ARC_MAIN_DURATION_MAX = 0.48
const ARC_BRANCH_DURATION_FACTOR = 0.6
const ARC_TAIL_TIME = 0.08
const ARC_TAIL_PEAK = 0.2
const ARC_DECAY_POWER = 2.2
const ARC_CORE_HALF_WIDTH = 0.03
const ARC_GLOW_HALF_WIDTH = 0.11
const ARC_CORE_COLOR = new THREE.Color("#f6fbff")
const ARC_GLOW_COLOR = new THREE.Color("#7fd6ff")
// Reach is a fraction of the struck shard's actual world-space size (its
// approximate height × its scale × the site's scale), not of site.scale
// alone — otherwise it under-reports how big the shard actually renders.
// The height itself now comes from the struck shard's own variant metrics
// (see fireArc) rather than one fixed constant, since shards vary in size.
const ARC_REACH_MIN = 0.32
const ARC_REACH_MAX = 0.48

// Fixed vertex layout, identical for every slot: 8 reserved main segments +
// two 4-segment branch reservations, each a self-contained quad (no shared
// vertices between segments). Slots a firing doesn't use are written as
// zero-area degenerate quads rather than resized, so geometry never needs
// reallocating — same index buffer is shared by every arc slot.
const ARC_MAIN_QUADS = ARC_MAIN_SEGMENTS_MAX
const ARC_BRANCH_QUADS = ARC_BRANCH_SEGMENTS_MAX
const ARC_TOTAL_QUADS = ARC_MAIN_QUADS + ARC_BRANCH_QUADS * 2
const ARC_TOTAL_VERTS = ARC_TOTAL_QUADS * 4

function buildArcIndex(): Uint16Array {
  const indices = new Uint16Array(ARC_TOTAL_QUADS * 6)
  for (let q = 0; q < ARC_TOTAL_QUADS; q++) {
    const base = q * 4
    const o = q * 6
    indices[o] = base
    indices[o + 1] = base + 1
    indices[o + 2] = base + 2
    indices[o + 3] = base + 1
    indices[o + 4] = base + 3
    indices[o + 5] = base + 2
  }
  return indices
}
const ARC_INDEX = buildArcIndex()

const arcVertexShader = /* glsl */ `
  attribute vec3 aPerp;
  attribute float aSide;
  attribute float aT;
  attribute float aStrand;
  uniform float uHalfWidth;
  uniform float uMainEnvelope;
  uniform float uBranchEnvelope;
  varying float vT;
  varying float vEnvelope;

  void main() {
    float envelope = mix(uMainEnvelope, uBranchEnvelope, aStrand);
    vT = aT;
    vEnvelope = envelope;
    vec3 p = position + aPerp * aSide * uHalfWidth * max(envelope, 0.05);
    gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
  }
`

const arcFragmentShader = /* glsl */ `
  uniform vec3 uColor;
  uniform float uRevealT;
  varying float vT;
  varying float vEnvelope;

  void main() {
    if (vT > uRevealT || vEnvelope <= 0.001) discard;
    gl_FragColor = vec4(uColor, vEnvelope);
  }
`

/** Rotates `dir` by a hard random angle around a random-ish axis each step — straight zigzag segments, not a smoothed curve. */
function deviate(rand: () => number, dir: THREE.Vector3, hardAngle: number) {
  const axis = new THREE.Vector3(
    rand() - 0.5,
    rand() - 0.5,
    rand() - 0.5,
  ).normalize()
  const angle = (rand() - 0.5) * hardAngle
  return dir.clone().applyAxisAngle(axis, angle).normalize()
}

export function walkBolt(
  rand: () => number,
  origin: THREE.Vector3,
  direction: THREE.Vector3,
  segments: number,
  totalLength: number,
  hardAngle: number,
): THREE.Vector3[] {
  const points = [origin.clone()]
  const stepLength = totalLength / segments
  let dir = direction.clone().normalize()
  const cur = origin.clone()
  for (let i = 0; i < segments; i++) {
    dir = deviate(rand, dir, hardAngle)
    cur.add(dir.clone().multiplyScalar(stepLength))
    points.push(cur.clone())
  }
  return points
}

/** Like walkBolt, but re-aims at `target` every step instead of wandering from a fixed starting direction, and snaps its last point exactly onto `target` — so the jagged strand still visibly connects the two endpoints instead of just heading off in their general direction. */
function walkBoltToward(
  rand: () => number,
  origin: THREE.Vector3,
  target: THREE.Vector3,
  segments: number,
  hardAngle: number,
): THREE.Vector3[] {
  const stepLength = origin.distanceTo(target) / segments
  const points = [origin.clone()]
  const cur = origin.clone()
  for (let i = 0; i < segments; i++) {
    const towardTarget = target.clone().sub(cur).normalize()
    const dir = deviate(rand, towardTarget, hardAngle)
    cur.add(dir.multiplyScalar(stepLength))
    points.push(cur.clone())
  }
  points[points.length - 1].copy(target)
  return points
}

/** A short strand splitting off the main stroke ~30 degrees from its local direction at the branch point, dying before the main stroke does. */
export function buildBranch(
  rand: () => number,
  mainPoints: THREE.Vector3[],
  atIndex: number,
  segments: number,
  totalLength: number,
): THREE.Vector3[] {
  const origin = mainPoints[atIndex].clone()
  const baseDir = mainPoints[atIndex]
    .clone()
    .sub(mainPoints[Math.max(0, atIndex - 1)])
    .normalize()
  const axis = new THREE.Vector3(
    rand() - 0.5,
    rand() - 0.5,
    rand() - 0.5,
  ).normalize()
  const splitAngle =
    (Math.PI / 6) * (0.7 + rand() * 0.6) * (rand() < 0.5 ? -1 : 1)
  const dir = baseDir.applyAxisAngle(axis, splitAngle)
  return walkBolt(
    rand,
    origin,
    dir,
    segments,
    totalLength,
    ARC_HARD_ANGLE * 1.3,
  )
}

function perpendicularFor(direction: THREE.Vector3): THREE.Vector3 {
  const ref = Math.abs(direction.y) > 0.9 ? UNIT_X : UNIT_Y
  return direction.clone().cross(ref).normalize()
}

export interface ArcSlotBuffers {
  positions: Float32Array
  perps: Float32Array
  sides: Float32Array
  ts: Float32Array
  strands: Float32Array
  geometry: THREE.BufferGeometry
  coreMaterial: THREE.ShaderMaterial
  glowMaterial: THREE.ShaderMaterial
}

export function createArcSlotBuffers(): ArcSlotBuffers {
  const positions = new Float32Array(ARC_TOTAL_VERTS * 3)
  const perps = new Float32Array(ARC_TOTAL_VERTS * 3)
  const sides = new Float32Array(ARC_TOTAL_VERTS)
  const ts = new Float32Array(ARC_TOTAL_VERTS)
  const strands = new Float32Array(ARC_TOTAL_VERTS)

  const geometry = new THREE.BufferGeometry()
  geometry.setIndex(new THREE.BufferAttribute(ARC_INDEX, 1))
  geometry.setAttribute(
    "position",
    new THREE.BufferAttribute(positions, 3).setUsage(THREE.DynamicDrawUsage),
  )
  geometry.setAttribute(
    "aPerp",
    new THREE.BufferAttribute(perps, 3).setUsage(THREE.DynamicDrawUsage),
  )
  geometry.setAttribute(
    "aSide",
    new THREE.BufferAttribute(sides, 1).setUsage(THREE.DynamicDrawUsage),
  )
  geometry.setAttribute(
    "aT",
    new THREE.BufferAttribute(ts, 1).setUsage(THREE.DynamicDrawUsage),
  )
  geometry.setAttribute(
    "aStrand",
    new THREE.BufferAttribute(strands, 1).setUsage(THREE.DynamicDrawUsage),
  )
  // Everything starts fully degenerate (all-zero positions) so an unfired
  // slot draws nothing rather than a stray triangle at the origin.
  geometry.setDrawRange(0, ARC_INDEX.length)

  const sharedUniforms = () => ({
    uMainEnvelope: { value: 0 },
    uBranchEnvelope: { value: 0 },
    uRevealT: { value: 0 },
  })

  const coreMaterial = new THREE.ShaderMaterial({
    uniforms: {
      ...sharedUniforms(),
      uHalfWidth: { value: ARC_CORE_HALF_WIDTH },
      uColor: { value: ARC_CORE_COLOR },
    },
    vertexShader: arcVertexShader,
    fragmentShader: arcFragmentShader,
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    blending: THREE.AdditiveBlending,
  })
  const glowMaterial = new THREE.ShaderMaterial({
    uniforms: {
      ...sharedUniforms(),
      uHalfWidth: { value: ARC_GLOW_HALF_WIDTH },
      uColor: { value: ARC_GLOW_COLOR },
    },
    vertexShader: arcVertexShader,
    fragmentShader: arcFragmentShader,
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    blending: THREE.AdditiveBlending,
  })

  return {
    positions,
    perps,
    sides,
    ts,
    strands,
    geometry,
    coreMaterial,
    glowMaterial,
  }
}

/** Writes one strand's segments into their reserved quad slots starting at `quadBase`, filling any unused reserved segments with a degenerate (zero-area) quad. */
function writeStrand(
  buffers: ArcSlotBuffers,
  points: THREE.Vector3[],
  reservedSegments: number,
  quadBase: number,
  strand: number,
) {
  const segments = points.length - 1
  const totalLength = points.reduce(
    (sum, p, i) => (i === 0 ? 0 : sum + p.distanceTo(points[i - 1])),
    0,
  )
  let cumulative = 0

  for (let s = 0; s < reservedSegments; s++) {
    const vertBase = (quadBase + s) * 4
    if (s < segments) {
      const a = points[s]
      const b = points[s + 1]
      const segLength = a.distanceTo(b)
      const tA = totalLength > 0 ? cumulative / totalLength : 0
      cumulative += segLength
      const tB = totalLength > 0 ? cumulative / totalLength : 1
      const dir = b.clone().sub(a).normalize()
      const perp = perpendicularFor(dir)

      const verts = [a, a, b, b]
      const sides = [1, -1, 1, -1]
      const ts = [tA, tA, tB, tB]
      for (let v = 0; v < 4; v++) {
        const idx = vertBase + v
        buffers.positions[idx * 3] = verts[v].x
        buffers.positions[idx * 3 + 1] = verts[v].y
        buffers.positions[idx * 3 + 2] = verts[v].z
        buffers.perps[idx * 3] = perp.x
        buffers.perps[idx * 3 + 1] = perp.y
        buffers.perps[idx * 3 + 2] = perp.z
        buffers.sides[idx] = sides[v]
        buffers.ts[idx] = ts[v]
        buffers.strands[idx] = strand
      }
    } else {
      // Unused reserved segment: collapse to a point so the quad has zero area.
      const p = points[points.length - 1]
      for (let v = 0; v < 4; v++) {
        const idx = vertBase + v
        buffers.positions[idx * 3] = p.x
        buffers.positions[idx * 3 + 1] = p.y
        buffers.positions[idx * 3 + 2] = p.z
        buffers.perps[idx * 3] = 0
        buffers.perps[idx * 3 + 1] = 0
        buffers.perps[idx * 3 + 2] = 0
        buffers.sides[idx] = 0
        buffers.ts[idx] = 1
        buffers.strands[idx] = strand
      }
    }
  }
}

export function writeArcGeometry(
  buffers: ArcSlotBuffers,
  mainPoints: THREE.Vector3[],
  branches: THREE.Vector3[][],
) {
  writeStrand(buffers, mainPoints, ARC_MAIN_QUADS, 0, 0)
  writeStrand(
    buffers,
    branches[0] ?? [mainPoints[0], mainPoints[0]],
    ARC_BRANCH_QUADS,
    ARC_MAIN_QUADS,
    1,
  )
  writeStrand(
    buffers,
    branches[1] ?? [mainPoints[0], mainPoints[0]],
    ARC_BRANCH_QUADS,
    ARC_MAIN_QUADS + ARC_BRANCH_QUADS,
    1,
  )

  buffers.geometry.attributes.position.needsUpdate = true
  buffers.geometry.attributes.aPerp.needsUpdate = true
  buffers.geometry.attributes.aSide.needsUpdate = true
  buffers.geometry.attributes.aT.needsUpdate = true
  buffers.geometry.attributes.aStrand.needsUpdate = true
}

export interface ArcPool {
  slots: ArcSlotBuffers[]
  startTimes: Float32Array
  mainDurations: Float32Array
  nextSlot: number
  nextArcTime: number
}

export function createArcPool(slotCount: number): ArcPool {
  return {
    slots: Array.from({ length: slotCount }, () => createArcSlotBuffers()),
    startTimes: new Float32Array(slotCount).fill(-9999),
    mainDurations: new Float32Array(slotCount).fill(ARC_MAIN_DURATION_MIN),
    nextSlot: 0,
    nextArcTime: 0,
  }
}

/** Advances every slot's decay/reveal uniforms from its age — shared by both the single-crystal arc pool and the resonance pool, which only differ in how a slot's geometry gets written when it fires. */
export function updateSlotEnvelopes(pool: ArcPool, now: number) {
  for (let i = 0; i < pool.slots.length; i++) {
    const age = now - pool.startTimes[i]
    const mainEnvelope = envelopeFor(age, pool.mainDurations[i])
    const branchEnvelope = envelopeFor(
      age,
      pool.mainDurations[i] * ARC_BRANCH_DURATION_FACTOR,
    )
    const revealT = Math.min(1, Math.max(0, age / ARC_REVEAL_TIME))
    const slot = pool.slots[i]
    for (const material of [slot.coreMaterial, slot.glowMaterial]) {
      material.uniforms.uMainEnvelope.value = mainEnvelope
      material.uniforms.uBranchEnvelope.value = branchEnvelope
      material.uniforms.uRevealT.value = revealT
    }
  }
}

/** The core+glow mesh pair for every slot in a pool — shared JSX for both the single-crystal arc pool and the resonance pool. */
export function ArcPoolMeshes({ pool }: { pool: ArcPool }) {
  return (
    <>
      {pool.slots.map((slot, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: fixed-size pool, slots never reorder
        <group key={i}>
          <mesh
            geometry={slot.geometry}
            material={slot.glowMaterial}
            frustumCulled={false}
          />
          <mesh
            geometry={slot.geometry}
            material={slot.coreMaterial}
            frustumCulled={false}
          />
        </group>
      ))}
    </>
  )
}

function fireArc(
  pool: ArcPool,
  now: number,
  sites: CrystalSite[],
  rand: () => number,
) {
  const slotIndex = pool.nextSlot
  pool.nextSlot = (pool.nextSlot + 1) % pool.slots.length

  const site = sites[Math.floor(rand() * sites.length)]
  const shard = pickShard(rand, site)
  const metrics = SHARD_VARIANT_METRICS[shard.variantId]
  const { local, direction } = pickSurfacePoint(rand, ARC_APEX_WEIGHT, metrics)
  const worldPos = new THREE.Vector3()
  const worldDir = new THREE.Vector3()
  resolveWorldPoint(site, shard, local, direction, worldPos, worldDir)

  const segments = randInt(rand, ARC_MAIN_SEGMENTS_MIN, ARC_MAIN_SEGMENTS_MAX)
  const shardHeight = metrics.apexY - metrics.bodyBottomY
  const objectSize = site.scale * shard.scale * shardHeight
  const totalLength = objectSize * lerp(ARC_REACH_MIN, ARC_REACH_MAX, rand())
  const mainPoints = walkBolt(
    rand,
    worldPos,
    worldDir,
    segments,
    totalLength,
    ARC_HARD_ANGLE,
  )

  const branchCount = randInt(rand, ARC_BRANCH_COUNT_MIN, ARC_BRANCH_COUNT_MAX)
  const branches: THREE.Vector3[][] = []
  for (let b = 0; b < branchCount; b++) {
    const atIndex = 1 + Math.floor(rand() * Math.min(2, segments - 1))
    const branchSegments = randInt(
      rand,
      ARC_BRANCH_SEGMENTS_MIN,
      ARC_BRANCH_SEGMENTS_MAX,
    )
    const branchLength = totalLength * lerp(0.35, 0.6, rand())
    branches.push(
      buildBranch(rand, mainPoints, atIndex, branchSegments, branchLength),
    )
  }

  writeArcGeometry(pool.slots[slotIndex], mainPoints, branches)
  pool.startTimes[slotIndex] = now
  pool.mainDurations[slotIndex] = lerp(
    ARC_MAIN_DURATION_MIN,
    ARC_MAIN_DURATION_MAX,
    rand(),
  )
  triggerGlow(site, ARC_GLOW_DECAY_TAU)
}

/** Brightness/thickness envelope: fast front-loaded decay, then a short low tail so the death isn't a hard cut (cheaper than tracking a literal duplicate "ghost" mesh, same visual result of killing the strobe). */
function envelopeFor(age: number, duration: number): number {
  if (age < 0) return 0
  if (age <= duration) {
    return (1 - age / duration) ** ARC_DECAY_POWER
  }
  const tailAge = age - duration
  if (tailAge <= ARC_TAIL_TIME) {
    return ARC_TAIL_PEAK * (1 - tailAge / ARC_TAIL_TIME)
  }
  return 0
}

function Arcs({
  sites,
  reducedMotion,
}: {
  sites: CrystalSite[]
  reducedMotion: boolean
}) {
  const rand = useMemo(() => mulberry32(0xa4c1), [])
  const pool = useMemo(() => createArcPool(ARC_SLOT_COUNT), [])

  // See the identical comment on Fizz's timeRef — clock.elapsedTime resets
  // to ~0 whenever the tab is hidden and R3F's render loop stops, which
  // would strand every stored startTime/nextArcTime in what looks like the
  // future forever.
  const timeRef = useRef(0)
  useFrame((_, delta) => {
    if (reducedMotion) return
    timeRef.current += delta
    const now = timeRef.current

    if (now >= pool.nextArcTime) {
      fireArc(pool, now, sites, rand)
      pool.nextArcTime = now + lerp(ARC_INTERVAL_MIN, ARC_INTERVAL_MAX, rand())
    }

    updateSlotEnvelopes(pool, now)
  })

  if (reducedMotion) return null

  return <ArcPoolMeshes pool={pool} />
}

// --- resonance: bolts jumping between nearby crystals -----------------------
// Same visual treatment as the single-crystal arcs above — same geometry
// helpers, materials, decay curve, branch logic — but the main strand is
// aimed at a second crystal (via walkBoltToward) instead of wandering
// outward, and it only fires between pairs of crystals close enough
// together to plausibly arc to one another. Eligible pairs are found once,
// not uniformly across all sites: each site's single nearest neighbor
// qualifies only if it's closer than RESONANCE_MAX_DISTANCE, so a sparse
// layout naturally produces few (or zero) pairs rather than every crystal
// always having a partner.

const RESONANCE_MAX_DISTANCE = 4.5
const RESONANCE_SLOT_COUNT = 100
const RESONANCE_INTERVAL_MIN = 0.15
const RESONANCE_INTERVAL_MAX = 0.5
const RESONANCE_APEX_WEIGHT = 0.5
// Branches are shorter fractions of the strand than a single-crystal arc's
// (branchLength * lerp(0.35, 0.6, …) there) since a resonance strand
// already spans real distance between two crystals rather than a small
// outward reach.
const RESONANCE_BRANCH_LENGTH_MIN = 0.2
const RESONANCE_BRANCH_LENGTH_MAX = 0.35

function findClosePairs(sites: CrystalSite[]): Array<[number, number]> {
  const pairs: Array<[number, number]> = []
  const seen = new Set<string>()
  for (let i = 0; i < sites.length; i++) {
    let nearest = -1
    let nearestDist = Number.POSITIVE_INFINITY
    for (let j = 0; j < sites.length; j++) {
      if (i === j) continue
      const dx = sites[i].position[0] - sites[j].position[0]
      const dy = sites[i].position[1] - sites[j].position[1]
      const dz = sites[i].position[2] - sites[j].position[2]
      const dist = Math.sqrt(dx * dx + dy * dy + dz * dz)
      if (dist < nearestDist) {
        nearestDist = dist
        nearest = j
      }
    }
    if (nearest !== -1 && nearestDist <= RESONANCE_MAX_DISTANCE) {
      const key = i < nearest ? `${i}-${nearest}` : `${nearest}-${i}`
      if (!seen.has(key)) {
        seen.add(key)
        pairs.push(i < nearest ? [i, nearest] : [nearest, i])
      }
    }
  }
  return pairs
}

function fireResonance(
  pool: ArcPool,
  now: number,
  pairs: Array<[number, number]>,
  sites: CrystalSite[],
  rand: () => number,
) {
  const slotIndex = pool.nextSlot
  pool.nextSlot = (pool.nextSlot + 1) % pool.slots.length

  const [indexA, indexB] = pairs[Math.floor(rand() * pairs.length)]
  const siteA = sites[indexA]
  const siteB = sites[indexB]

  const shardA = pickShard(rand, siteA)
  const { local: localA, direction: dirA } = pickSurfacePoint(
    rand,
    RESONANCE_APEX_WEIGHT,
    SHARD_VARIANT_METRICS[shardA.variantId],
  )
  const worldA = new THREE.Vector3()
  const dirAOut = new THREE.Vector3()
  resolveWorldPoint(siteA, shardA, localA, dirA, worldA, dirAOut)

  const shardB = pickShard(rand, siteB)
  const { local: localB, direction: dirB } = pickSurfacePoint(
    rand,
    RESONANCE_APEX_WEIGHT,
    SHARD_VARIANT_METRICS[shardB.variantId],
  )
  const worldB = new THREE.Vector3()
  const dirBOut = new THREE.Vector3()
  resolveWorldPoint(siteB, shardB, localB, dirB, worldB, dirBOut)

  const segments = randInt(rand, ARC_MAIN_SEGMENTS_MIN, ARC_MAIN_SEGMENTS_MAX)
  const mainPoints = walkBoltToward(
    rand,
    worldA,
    worldB,
    segments,
    ARC_HARD_ANGLE,
  )

  const totalLength = worldA.distanceTo(worldB)
  const branchCount = randInt(rand, ARC_BRANCH_COUNT_MIN, ARC_BRANCH_COUNT_MAX)
  const branches: THREE.Vector3[][] = []
  for (let b = 0; b < branchCount; b++) {
    const atIndex = 1 + Math.floor(rand() * Math.min(2, segments - 1))
    const branchSegments = randInt(
      rand,
      ARC_BRANCH_SEGMENTS_MIN,
      ARC_BRANCH_SEGMENTS_MAX,
    )
    const branchLength =
      totalLength *
      lerp(RESONANCE_BRANCH_LENGTH_MIN, RESONANCE_BRANCH_LENGTH_MAX, rand())
    branches.push(
      buildBranch(rand, mainPoints, atIndex, branchSegments, branchLength),
    )
  }

  writeArcGeometry(pool.slots[slotIndex], mainPoints, branches)
  pool.startTimes[slotIndex] = now
  pool.mainDurations[slotIndex] = lerp(
    ARC_MAIN_DURATION_MIN,
    ARC_MAIN_DURATION_MAX,
    rand(),
  )
  // Both ends light up together — the crystal-body flicker is what actually
  // sells "these two are resonating" rather than one striking the other.
  triggerGlow(siteA, ARC_GLOW_DECAY_TAU)
  triggerGlow(siteB, ARC_GLOW_DECAY_TAU)
}

function Resonance({
  sites,
  reducedMotion,
}: {
  sites: CrystalSite[]
  reducedMotion: boolean
}) {
  const rand = useMemo(() => mulberry32(0xc0ffee), [])
  const pairs = useMemo(() => findClosePairs(sites), [sites])
  const pool = useMemo(() => createArcPool(RESONANCE_SLOT_COUNT), [])

  // See the identical comment on Fizz's timeRef.
  const timeRef = useRef(0)
  useFrame((_, delta) => {
    if (reducedMotion) return
    timeRef.current += delta
    const now = timeRef.current

    if (pairs.length > 0 && now >= pool.nextArcTime) {
      fireResonance(pool, now, pairs, sites, rand)
      pool.nextArcTime =
        now + lerp(RESONANCE_INTERVAL_MIN, RESONANCE_INTERVAL_MAX, rand())
    }

    updateSlotEnvelopes(pool, now)
  })

  if (reducedMotion) return null

  return <ArcPoolMeshes pool={pool} />
}

/** Electrical discharge over the crystal field: a constant fizz of tiny surface-hugging specks, rare branching arcs off single crystals, and rarer resonance bolts jumping between nearby ones — all flashing the struck crystal(s)' rim in sync. */
export function Sparks({
  sites,
  reducedMotion,
}: {
  sites: CrystalSite[]
  reducedMotion: boolean
}) {
  return (
    <>
      <Fizz sites={sites} reducedMotion={reducedMotion} />
      <Arcs sites={sites} reducedMotion={reducedMotion} />
      <Resonance sites={sites} reducedMotion={reducedMotion} />
    </>
  )
}
