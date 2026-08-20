import { useFrame } from "@react-three/fiber"
import { type RefObject, useMemo, useRef } from "react"
import * as THREE from "three"
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js"
import { useCrystalEnvironmentMap } from "./crystal-environment"
import { PROCEDURAL_NORMAL_MAP } from "./procedural-normal-map"
import { Sparks } from "./sparks"
import { FOG_OCCLUDER_LAYER } from "./volumetric-fog"

// --- randomized layout --------------------------------------------------
// A reseedable PRNG so the field is dense and size-varied, with a fresh
// layout (positions, sizes, tilts) generated on every page load, and
// candidates rejected from a center-front zone that roughly matches where
// the centered UI card covers the screen.

export function mulberry32(seed: number) {
  let state = seed
  return () => {
    state |= 0
    state = (state + 0x6d2b79f5) | 0
    let t = Math.imul(state ^ (state >>> 15), 1 | state)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function lerp(a: number, b: number, t: number) {
  return a + (b - a) * t
}

export interface Shard {
  id: string
  offset: [number, number, number]
  rotationY: number
  /** [tiltX, tiltZ] — most shards stand upright ([0, 0]); a random subset lean a bit on a random axis. */
  tilt: [number, number]
  scale: number
  /** Index into SHARD_GEOMETRY_VARIANTS / SHARD_EDGE_GEOMETRY_VARIANTS / SHARD_VARIANT_METRICS — which of the pre-generated shard shapes this instance renders. */
  variantId: number
}

/** Approximate local-space silhouette of one geometry variant — nominal (pre-facet-jitter) values, just enough for sparks.tsx to roughly track a shard's real surface for spawn placement, not to sit exactly on it. */
export interface ShardVariantMetrics {
  bodyBottomY: number
  bodyTopY: number
  apexY: number
  radiusBottom: number
  radiusTop: number
}

export interface CrystalSite {
  id: string
  position: [number, number, number]
  scale: number
  timeOffset: number
  shards: Shard[]
  /** Current glow strength driving this site's shard emissive intensity — set to 1 via triggerGlow (by an ambient twinkle or an arc/resonance strike) and decayed each frame in CrystalCluster's useFrame. Only up to MAX_GLOWING_CRYSTALS sites have a nonzero glow at once, whatever the cause. */
  glow: {
    value: number
    /** How fast this glow decays once triggered — a quick, punchy tau for arc strikes, a slower one for ambient twinkles, set by whichever call to triggerGlow last (re)lit this site. */
    decayTau: number
    /** True while this site was evicted early (cap pressure) and is running a forced linear fade-to-0 over GLOW_EVICTION_FADE_TIME, instead of its normal exponential decayTau falloff. */
    fading: boolean
    fadeFrom: number
    fadeElapsed: number
  }
  /** Tracks membership in `glowingSites` — lets the decay loop below remove a site from that list once it fades out, without a linear "is this the same site" scan every frame. */
  isGlowing: boolean
}

const SITE_COUNT = 110
// Perspective means the camera's visible width grows with distance — a
// fixed X range leaves the far corners (near the horizon) empty while
// over-covering the near field. FIELD_HALF_WIDTH is the spread at Z_NEAR;
// it widens linearly out to FAR_HALF_WIDTH at Z_FAR so the field roughly
// matches the view frustum's shape instead of a fixed-width box.
const FIELD_HALF_WIDTH = 20
const FAR_HALF_WIDTH = 46
// Camera sits at z=12 (see CameraRig in scene-background.tsx); Z_NEAR stops
// just short of it so crystals can loom in the foreground on either side
// instead of only ever appearing mid-to-far away.
const Z_NEAR = 9
const Z_FAR = -55
const EXCLUDE_HALF_WIDTH = 3.5
// Matches Z_NEAR so the center corridor stays clear of the login card at
// every depth crystals can now spawn at, not just the old -6..-17 band.
const EXCLUDE_Z_NEAR = 9
const EXCLUDE_Z_FAR = -17

// --- shard shape variants -----------------------------------------------
// Rather than every crystal sharing one literal geometry, a small pool of
// SHARD_VARIANT_COUNT unique shapes is built once (proportions + per-facet
// irregularity, each randomized), and every shard instance just picks one
// by index. Bounded cost (a fixed number of geometries/edge-geometries
// built once at module load) while still reading as "every crystal is
// unique" given 110+ sites — many with several shards — sampling from the
// pool. Built from its own fixed seed, independent of the per-load
// placement seed below, so the shape "species" itself stays stable/tunable
// across reloads while layout (position/size/tilt/which-variant) still
// varies fresh every load.

const SHARD_VARIANT_COUNT = 18
// Every variant's base is translated to sit at this same local Y regardless
// of its randomized height, so taller/shorter variants all still look
// "planted" at a consistent ground level rather than floating or sinking.
// Floor.tsx renders a solid, opaque, non-transparent plane at world y=0, so
// depth-testing hides any geometry below that entirely — a small negative
// value (not e.g. the -0.7 this used to be) keeps the base just barely
// embedded for a "planted" look without burying a large chunk of every
// crystal's modeled height (and, worse, most of its edge/spark spawn
// points, which sample down toward this Y) permanently out of view.
const BODY_BOTTOM_Y_TARGET = -0.05

interface ShardShapeParams {
  radiusBottom: number
  radiusTop: number
  bodyHeight: number
  capHeight: number
  /** One radius multiplier per hex facet (6 values) — the same array is applied to both the body and cap so the facets line up seamlessly at their shared seam. */
  facetJitter: number[]
}

/** Scales each vertex's local radius by its facet's jitter factor, bucketing by angle into the 6 wedges that match the hex cross-section. Vertices at (near) zero radius — the cone's apex tip — are left untouched so the tip stays sharp. Only touches vertex positions (not topology/index buffers), so this is safe to run before `mergeGeometries`. Mutates `geometry` in place. */
function applyFacetJitter(geometry: THREE.BufferGeometry, facetJitter: number[]) {
  const pos = geometry.getAttribute("position")
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i)
    const z = pos.getZ(i)
    const r = Math.hypot(x, z)
    if (r < 1e-5) continue
    const angle = Math.atan2(z, x)
    const facet =
      Math.round(((angle + Math.PI * 2) % (Math.PI * 2)) / (Math.PI / 3)) % 6
    const scale = facetJitter[facet]
    pos.setX(i, x * scale)
    pos.setZ(i, z * scale)
  }
  pos.needsUpdate = true
}

/** Builds one shard geometry variant: a hex-prism body capped with a hex pointed cap, proportions and per-facet radius jitter driven by `params`, grounded so its base always sits at BODY_BOTTOM_Y_TARGET regardless of height. */
function buildShardGeometry(params: ShardShapeParams) {
  const { radiusBottom, radiusTop, bodyHeight, capHeight, facetJitter } =
    params
  const body = new THREE.CylinderGeometry(radiusTop, radiusBottom, bodyHeight, 6)
  const cap = new THREE.ConeGeometry(radiusTop, capHeight, 6)
  cap.translate(0, bodyHeight / 2 + capHeight / 2, 0)
  applyFacetJitter(body, facetJitter)
  applyFacetJitter(cap, facetJitter)
  const merged = mergeGeometries([body, cap])
  merged.translate(0, BODY_BOTTOM_Y_TARGET + bodyHeight / 2, 0)
  body.dispose()
  cap.dispose()
  return merged
}

// Exported so other glass objects (e.g. title.tsx's 3D wordmark) can grow
// the same edge "snake" outline on their own geometry.
export function buildEdgeGeometry(geometry: THREE.BufferGeometry) {
  const rand = mulberry32(99)
  const edges = new THREE.EdgesGeometry(geometry, 1)
  const count = edges.getAttribute("position").count
  const edgeCount = count / 2
  const aParam = new Float32Array(count)
  const aPhase = new Float32Array(count)
  const aSpeed = new Float32Array(count)

  for (let e = 0; e < edgeCount; e++) {
    const phase = rand() * Math.PI * 2
    const speed = 0.5 + rand() * 0.7
    aParam[e * 2] = 0
    aParam[e * 2 + 1] = 1
    aPhase[e * 2] = phase
    aPhase[e * 2 + 1] = phase
    aSpeed[e * 2] = speed
    aSpeed[e * 2 + 1] = speed
  }

  edges.setAttribute("aParam", new THREE.BufferAttribute(aParam, 1))
  edges.setAttribute("aPhase", new THREE.BufferAttribute(aPhase, 1))
  edges.setAttribute("aSpeed", new THREE.BufferAttribute(aSpeed, 1))
  return edges
}

/** Builds the shared pool of `count` shard shape variants — each with independently randomized proportions and facet jitter — plus their edge-outline geometries and approximate silhouette metrics (used by sparks.tsx to keep fizz/arc spawn points tracking each shard's real shape). */
function buildShardGeometryVariants(count: number) {
  const rand = mulberry32(0x5c4a17)
  const geometries: THREE.BufferGeometry[] = []
  const edgeGeometries: THREE.BufferGeometry[] = []
  const metrics: ShardVariantMetrics[] = []

  for (let i = 0; i < count; i++) {
    const radiusBottom = lerp(0.34, 0.58, rand())
    // Always tapers upward (top narrower than bottom), like real quartz —
    // never flares outward.
    const taperRatio = lerp(0.55, 0.85, rand())
    const radiusTop = radiusBottom * taperRatio
    const bodyHeight = lerp(0.75, 1.6, rand())
    const capHeightRatio = lerp(0.35, 0.65, rand())
    const capHeight = THREE.MathUtils.clamp(bodyHeight * capHeightRatio, 0.3, 0.9)
    const facetJitter = Array.from({ length: 6 }, () => 1 + (rand() - 0.5) * 0.3)

    const geometry = buildShardGeometry({
      radiusBottom,
      radiusTop,
      bodyHeight,
      capHeight,
      facetJitter,
    })
    geometries.push(geometry)
    edgeGeometries.push(buildEdgeGeometry(geometry))
    metrics.push({
      bodyBottomY: BODY_BOTTOM_Y_TARGET,
      bodyTopY: BODY_BOTTOM_Y_TARGET + bodyHeight,
      apexY: BODY_BOTTOM_Y_TARGET + bodyHeight + capHeight,
      radiusBottom,
      radiusTop,
    })
  }

  return { geometries, edgeGeometries, metrics }
}

const {
  geometries: SHARD_GEOMETRY_VARIANTS,
  edgeGeometries: SHARD_EDGE_GEOMETRY_VARIANTS,
  metrics: SHARD_VARIANT_METRICS,
} = buildShardGeometryVariants(SHARD_VARIANT_COUNT)

// Exported so sparks.tsx can look up a shard's real (approximate) silhouette
// by its variantId instead of assuming every shard has the same proportions.
export { SHARD_VARIANT_METRICS }

// The largest bottom radius across every variant — used as a deliberately
// conservative footprint bound in buildCrystalSites' collision check below,
// so the check never undersizes a site's footprint regardless of which
// variant a given shard actually rolled.
const MAX_VARIANT_RADIUS_BOTTOM = Math.max(
  ...SHARD_VARIANT_METRICS.map((m) => m.radiusBottom),
)

// Variant indices sorted narrowest-to-widest by radiusBottom — a tall,
// slender variant still reads fine as a cluster crystal (that's just
// "pointy"), but a wide/thick one looks wrong even as a node's centerpiece,
// so node crystals restrict their variant picks to the narrow end of the
// pool (see NODE_NARROW_VARIANT_COUNT / pickNarrowVariantId below) instead
// of the full range singles draw from.
const VARIANTS_BY_RADIUS = SHARD_VARIANT_METRICS.map((_, i) => i).sort(
  (a, b) => SHARD_VARIANT_METRICS[a].radiusBottom - SHARD_VARIANT_METRICS[b].radiusBottom,
)
// The narrowest two-thirds of the pool (excludes the widest third) — every
// crystal in a node, centerpiece included, picks its shape from only this
// slice.
const NODE_NARROW_VARIANT_COUNT = Math.round((SHARD_VARIANT_COUNT * 2) / 3)

function pickNarrowVariantId(rand: () => number): number {
  return VARIANTS_BY_RADIUS[Math.floor(rand() * NODE_NARROW_VARIANT_COUNT)]
}

// --- per-shard tilt & clustering -----------------------------------------

/** A random subset of shards lean slightly off-vertical on a random axis; the rest stay upright. An optional rarer "dramatic" tier gives a few shards a much bigger lean instead of just scaling up the ordinary one. */
function randomTilt(
  rand: () => number,
  chance: number,
  magnitude: number,
  dramaticChance = 0,
  dramaticMagnitude = 0,
): [number, number] {
  if (dramaticChance > 0 && rand() < dramaticChance) {
    return [
      (rand() - 0.5) * dramaticMagnitude,
      (rand() - 0.5) * dramaticMagnitude,
    ]
  }
  if (rand() >= chance) return [0, 0]
  return [(rand() - 0.5) * magnitude, (rand() - 0.5) * magnitude]
}

const SINGLE_TILT_CHANCE = 0.75
const SINGLE_TILT_MAGNITUDE = 0.55
const SINGLE_DRAMATIC_CHANCE = 0.08
const SINGLE_DRAMATIC_MAGNITUDE = 1.1

// ~1 in 5 sites becomes a "node": several crystals fanning from nearly one
// base point, like a real quartz cluster. The rest stay single crystals,
// sometimes with one small leaning companion (unchanged odds from before).
const NODE_CHANCE = 0.2
const NODE_SHARD_COUNT_MIN = 4
const NODE_SHARD_COUNT_MAX = 9
// A satellite's real height, as a fraction of the centerpiece's real
// height (not a raw shard.scale multiplier — see the scale calc below,
// which converts through each shard's own variant height) — always < 1,
// so there's always one unambiguous "main" crystal the rest visibly grow
// from, regardless of which geometry variant either of them rolled.
const NODE_SCALE_MIN = 0.28
const NODE_SCALE_MAX = 0.7
const NODE_TILT_MIN = 0.15
const NODE_TILT_MAX = 0.9
// Satellites root close to the main crystal's own base — a small fraction
// of its radius, not spread out past it — so the whole node reads as
// "several crystals growing from almost one point," matching the
// reference photo. It's the outward TILT below (not this base offset)
// that does the work of visually fanning their bodies/tips apart as they
// rise, the same way real clustered crystals share a tight root but splay
// out above it.
const NODE_ROOT_SPREAD_MIN = 0.1
const NODE_ROOT_SPREAD_MAX = 0.45
// Even angular spacing (plus jitter) so satellites fan out around the full
// circle instead of a fully random angle ever bunching two of them
// together by chance.
const NODE_ANGLE_JITTER = 0.6

const SINGLE_COMPANION_CHANCE = 0.45
const COMPANION_RADIUS = 0.3
const COMPANION_SCALE_MIN = 0.4
const COMPANION_SCALE_MAX = 0.7
const COMPANION_TILT_MAGNITUDE = 0.4

// Scratch objects reused to derive an "outward lean" rotationY/tilt pair —
// Shard.tilt/rotationY are later consumed as a literal 'XYZ'-order Euler
// triple (see CrystalCluster below and resolveWorldPoint in sparks.tsx), so
// this builds the lean as a quaternion (tipping the shard's local +Y growth
// axis toward the actual outward radial direction at `angle`) and converts
// that back to an XYZ Euler rather than hand-deriving tiltX/tiltZ — trying
// to compose those independently doesn't reliably land on "leans away from
// `angle`" once rotationY and tilt magnitude are both large. Build-time
// only (once per satellite shard at generation), never touched per frame.
const LEAN_UP = new THREE.Vector3(0, 1, 0)
const leanDir = new THREE.Vector3()
const leanQuat = new THREE.Quaternion()
const spinQuat = new THREE.Quaternion()
const leanEuler = new THREE.Euler()

/** `angle` is the shard's placement angle around the node (matching `offset = [cos(angle)*dist, ..., sin(angle)*dist]`) — the growth axis tips away from center toward that same direction, by `tiltMag` radians off vertical. `spin` is a free rotation around the shard's own (still-mostly-vertical) axis purely for facet-orientation variety, applied before the tilt. */
function outwardLean(
  angle: number,
  tiltMag: number,
  spin: number,
): { rotationY: number; tilt: [number, number] } {
  // The growth axis tipped by tiltMag off vertical, toward the same
  // (cos(angle), sin(angle)) direction the shard's XZ offset already uses —
  // so a shard placed further along +X leans further along +X, not
  // sideways across the node.
  leanDir.set(
    Math.sin(tiltMag) * Math.cos(angle),
    Math.cos(tiltMag),
    Math.sin(tiltMag) * Math.sin(angle),
  )
  leanQuat.setFromUnitVectors(LEAN_UP, leanDir)
  spinQuat.setFromAxisAngle(LEAN_UP, spin)
  leanQuat.multiply(spinQuat) // spin around its own axis first, then tilt the whole thing outward
  leanEuler.setFromQuaternion(leanQuat, "XYZ")
  return {
    rotationY: leanEuler.y,
    tilt: [leanEuler.x, leanEuler.z],
  }
}

/**
 * Builds one site's shard array: a single centerpiece crystal, optionally
 * surrounded by satellites fanning outward from near its base. One shared
 * code path covers both shapes the site can take, rather than parallel
 * special cases:
 * - an ordinary single crystal (most sites), sometimes with one small
 *   leaning companion (SINGLE_COMPANION_CHANCE, same look as before);
 * - a "node" (NODE_CHANCE of sites): NODE_SHARD_COUNT_MIN-MAX crystals
 *   fanning from one base point, tightly clustered, with a dramatic
 *   tall-center/shorter-sides size range — like the reference photo. Every
 *   crystal in a node (centerpiece included) draws its shape only from the
 *   narrow end of the variant pool (pickNarrowVariantId) — tall and
 *   slender reads fine clustered together, wide/thick doesn't, even for
 *   the centerpiece.
 */
function buildShardCluster(
  rand: () => number,
): { shards: Shard[]; isNode: boolean } {
  const isNode = rand() < NODE_CHANCE
  const satelliteCount = isNode
    ? NODE_SHARD_COUNT_MIN +
      Math.floor(rand() * (NODE_SHARD_COUNT_MAX - NODE_SHARD_COUNT_MIN + 1)) -
      1
    : rand() < SINGLE_COMPANION_CHANCE
      ? 1
      : 0

  const primaryVariantId = isNode
    ? pickNarrowVariantId(rand)
    : Math.floor(rand() * SHARD_VARIANT_COUNT)
  const shards: Shard[] = [
    {
      id: "primary",
      offset: [0, 0, 0],
      rotationY: rand() * Math.PI * 2,
      tilt: randomTilt(
        rand,
        SINGLE_TILT_CHANCE,
        SINGLE_TILT_MAGNITUDE,
        SINGLE_DRAMATIC_CHANCE,
        SINGLE_DRAMATIC_MAGNITUDE,
      ),
      scale: 1,
      variantId: primaryVariantId,
    },
  ]
  // The centerpiece's own real footprint (scale is fixed at 1, so this is
  // already its actual local-space radius) — satellites root themselves off
  // this, not a generic constant, so the "grows from the main crystal's
  // base" placement below tracks whichever variant it actually rolled.
  const mainMetrics = SHARD_VARIANT_METRICS[primaryVariantId]
  const mainRadius = mainMetrics.radiusBottom
  // Real world-space height (scale is fixed at 1) — satellites size
  // themselves as a fraction of THIS, not of their own variant's raw
  // height, so the centerpiece stays the unambiguous biggest crystal in
  // the node even when a satellite happens to roll a tall/wide variant
  // that would otherwise render bigger than the main one at matching
  // shard.scale values.
  const mainHeight = mainMetrics.apexY - mainMetrics.bodyBottomY

  // A random starting angle plus even spacing around the full circle (not a
  // fully random angle per satellite) so satellites fan out on all sides
  // rather than ever bunching together by chance; jitter keeps it from
  // looking mechanically regular.
  const angleOffset = rand() * Math.PI * 2
  const angleSlot = (Math.PI * 2) / Math.max(satelliteCount, 1)

  for (let i = 0; i < satelliteCount; i++) {
    const angle = isNode
      ? angleOffset + i * angleSlot + (rand() - 0.5) * angleSlot * NODE_ANGLE_JITTER
      : rand() * Math.PI * 2
    // How far this satellite reaches — also drives its tilt/dip below, so
    // satellites that reach further also lean and dip more, matching the
    // reference photo's mix of close-in and far-flung crystals. The base
    // offset itself stays small (close to the main crystal's own root, see
    // NODE_ROOT_SPREAD_*) — it's the tilt, not this offset, that fans each
    // satellite's body and tip outward and clear of its neighbors as it
    // rises from that shared root.
    const reachT = rand() ** 0.5
    const variantId = isNode
      ? pickNarrowVariantId(rand)
      : Math.floor(rand() * SHARD_VARIANT_COUNT)
    // NODE_SCALE_* is a fraction of the CENTERPIECE's real height, not a raw
    // shard.scale multiplier — converting through this satellite's own
    // variant height (which can differ a lot from the centerpiece's) is
    // what actually guarantees it renders smaller than the main crystal,
    // regardless of which variant either of them rolled.
    const scale = isNode
      ? (lerp(NODE_SCALE_MIN, NODE_SCALE_MAX, rand()) * mainHeight) /
        (SHARD_VARIANT_METRICS[variantId].apexY -
          SHARD_VARIANT_METRICS[variantId].bodyBottomY)
      : lerp(COMPANION_SCALE_MIN, COMPANION_SCALE_MAX, rand())

    const dist = isNode
      ? mainRadius * lerp(NODE_ROOT_SPREAD_MIN, NODE_ROOT_SPREAD_MAX, reachT)
      : COMPANION_RADIUS
    const x = Math.cos(angle) * dist
    const z = Math.sin(angle) * dist
    // A small downward dip so satellites read as sprouting from slightly
    // lower on the main crystal's base rather than floating level with its
    // own root — kept small (not the old -0.15) now that the whole
    // geometry's own root sits at ~ground level instead of buried well
    // below it.
    const dipY = isNode ? -0.03 * reachT : -0.03

    let rotationY: number
    let tilt: [number, number]
    if (isNode) {
      const tiltMag = lerp(NODE_TILT_MIN, NODE_TILT_MAX, reachT)
      const spin = rand() * Math.PI * 2
      ;({ rotationY, tilt } = outwardLean(angle, tiltMag, spin))
    } else {
      rotationY = rand() * Math.PI * 2
      tilt = [
        (rand() - 0.5) * COMPANION_TILT_MAGNITUDE,
        (rand() - 0.5) * COMPANION_TILT_MAGNITUDE,
      ]
    }

    shards.push({
      id: `s${i}`,
      offset: [x, dipY, z],
      rotationY,
      tilt,
      scale,
      variantId,
    })
  }

  return { shards, isNode }
}

// --- placement ------------------------------------------------------------

/** The site's effective collision radius: how far its farthest shard's own footprint reaches from the site's center, in the site's local (pre-scale) units. Conservatively uses the largest possible variant radius rather than the specific variant each shard rolled, so the check never undersizes a footprint. */
function footprintRadius(shards: Shard[]): number {
  let maxReach = 0
  for (const shard of shards) {
    const offsetXZ = Math.hypot(shard.offset[0], shard.offset[2])
    const reach = offsetXZ + shard.scale * MAX_VARIANT_RADIUS_BOTTOM
    if (reach > maxReach) maxReach = reach
  }
  return maxReach
}

// Extra clearance kept between two sites' footprints beyond the point where
// they'd just touch, so crystals read as visually separate rather than
// grazing.
const MIN_GAP = 0.6
// Raised from the original SITE_COUNT * 30 to absorb the higher rejection
// rate a real minimum-distance check introduces (most attempts near an
// already-dense part of the field will now fail the gap check, not just the
// UI-exclusion rectangle).
const ATTEMPTS_CAP = SITE_COUNT * 80
// Applied to every site's overall scale — the raw baseScale/sizeJitter
// formula below reads the same as before, but the field as a whole renders
// noticeably smaller (user feedback: the big ones were way too big).
const SIZE_SCALE = 0.7
// A single (non-node) site's baseScale (post-SIZE_SCALE, pre-sizeJitter)
// above this counts as "large" for MAX_LARGE_SINGLE_CRYSTALS below. Doesn't
// apply to nodes — a node's whole point is a big, dramatic centerpiece.
const LARGE_SINGLE_THRESHOLD = 2.0
// Hard cap on how many oversized single crystals the whole field can have
// at once, so a run of unlucky rolls can't fill the scene with huge ones —
// once reached, further "large" candidates still spawn, just capped down
// to LARGE_SINGLE_THRESHOLD instead of being one more outlier.
const MAX_LARGE_SINGLE_CRYSTALS = 6

function buildCrystalSites(): CrystalSite[] {
  // Reseed from the current time so the field's positions, sizes, and tilts
  // differ on every load, rather than the fixed arrangement a hardcoded seed
  // would give.
  const rand = mulberry32(Date.now() ^ Math.floor(Math.random() * 0xffffffff))
  const sites: CrystalSite[] = []
  // Parallel to `sites` — each entry's (x, z, footprint) in world space, for
  // the O(n) per-candidate distance scan below. SITE_COUNT accepted sites is
  // small enough that this stays a one-time, load-time-only cost (no
  // per-frame allocation), comparable to sparks.tsx's findClosePairs, which
  // already does a full O(n^2) scan over the same field once at mount.
  const placed: Array<{ x: number; z: number; footprint: number }> = []
  let attempts = 0
  let largeSingleCount = 0

  while (sites.length < SITE_COUNT && attempts < ATTEMPTS_CAP) {
    attempts++
    const z = Z_NEAR + rand() * (Z_FAR - Z_NEAR)
    const depthT = (z - Z_NEAR) / (Z_FAR - Z_NEAR) // 0 at Z_NEAR, 1 at Z_FAR
    const halfWidth =
      FIELD_HALF_WIDTH + (FAR_HALF_WIDTH - FIELD_HALF_WIDTH) * depthT
    const x = (rand() * 2 - 1) * halfWidth
    const inExclusionZone =
      Math.abs(x) < EXCLUDE_HALF_WIDTH &&
      z < EXCLUDE_Z_NEAR &&
      z > EXCLUDE_Z_FAR
    if (inExclusionZone) continue

    const { shards, isNode } = buildShardCluster(rand)

    // Biased toward smaller shards with occasional dramatic large ones, then
    // jittered +/-50% per site for extra size variety. The random-term
    // coefficient (the biggest-crystal ceiling) is 40% higher than the
    // original 1.85, scaled down overall by SIZE_SCALE.
    let baseScale = (0.45 + rand() ** 1.4 * 2.59) * SIZE_SCALE
    if (
      !isNode &&
      baseScale > LARGE_SINGLE_THRESHOLD &&
      largeSingleCount >= MAX_LARGE_SINGLE_CRYSTALS
    ) {
      baseScale = LARGE_SINGLE_THRESHOLD
    }
    const sizeJitter = 0.5 + rand() // 0.5x - 1.5x
    const scale = baseScale * sizeJitter

    const footprint = scale * footprintRadius(shards)

    let overlaps = false
    for (const p of placed) {
      const dx = x - p.x
      const dz = z - p.z
      if (Math.hypot(dx, dz) < footprint + p.footprint + MIN_GAP) {
        overlaps = true
        break
      }
    }
    if (overlaps) continue

    if (!isNode && baseScale > LARGE_SINGLE_THRESHOLD) largeSingleCount++

    sites.push({
      id: `c${sites.length}`,
      position: [x, 0, z],
      scale,
      timeOffset: rand() * 100,
      shards,
      glow: {
        value: 0,
        decayTau: 1,
        fading: false,
        fadeFrom: 0,
        fadeElapsed: 0,
      },
      isGlowing: false,
    })
    placed.push({ x, z, footprint })
  }

  return sites
}

export const CRYSTAL_SITES = buildCrystalSites()

// Exported so other glass objects (e.g. title.tsx's 3D wordmark) can reuse
// the exact same look rather than duplicating these values.
export const BASE_COLOR = new THREE.Color("#dbeeff")
export const EMISSIVE_COLOR = new THREE.Color("#3fc9ff")
export const EDGE_PULSE_COLOR = new THREE.Color("#c9f4ff")

// --- edge "snake" shader -------------------------------------------------
// A bright band loops along each edge (0 -> 1 -> 0 via the wrap-aware
// distance below), independently phased per edge via the baked attributes,
// and desynced per-crystal via each instance's own uTime offset. Only the
// lit band itself is drawn — the rest of the edge is fully transparent, so
// there's no dark/unlit line left visible.

const edgeVertexShader = /* glsl */ `
  attribute float aParam;
  attribute float aPhase;
  attribute float aSpeed;
  varying float vParam;
  varying float vPhase;
  varying float vSpeed;

  void main() {
    vParam = aParam;
    vPhase = aPhase;
    vSpeed = aSpeed;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`

const edgeFragmentShader = /* glsl */ `
  uniform float uTime;
  uniform vec3 uPulseColor;
  varying float vParam;
  varying float vPhase;
  varying float vSpeed;

  void main() {
    float pos = fract(uTime * vSpeed + vPhase);
    float d = abs(vParam - pos);
    d = min(d, 1.0 - d);
    float glow = smoothstep(0.22, 0.0, d);
    if (glow <= 0.0) discard;
    gl_FragColor = vec4(uPulseColor, glow);
  }
`

/** The edge "snake" outline shader — a bright band loops around `geometry`'s edges, independently phased per edge. Exported so any glass object (not just crystal shards) can grow the same outline: build its edges geometry via `buildEdgeGeometry`, pass it in here. */
export function EdgeSnake({
  geometry,
  timeOffset,
  reducedMotion,
}: {
  geometry: THREE.BufferGeometry
  timeOffset: number
  reducedMotion: boolean
}) {
  const materialRef = useRef<THREE.ShaderMaterial>(null)
  const uniforms = useMemo(
    () => ({
      uTime: { value: timeOffset },
      uPulseColor: { value: EDGE_PULSE_COLOR },
    }),
    [timeOffset],
  )

  useFrame((_, delta) => {
    if (reducedMotion || !materialRef.current) return
    materialRef.current.uniforms.uTime.value += delta
  })

  return (
    <lineSegments geometry={geometry}>
      <shaderMaterial
        ref={materialRef}
        uniforms={uniforms}
        vertexShader={edgeVertexShader}
        fragmentShader={edgeFragmentShader}
        transparent
        depthWrite={false}
      />
    </lineSegments>
  )
}

// Tiled a few times across each shard's UVs so the bump pattern reads as
// subtle small-scale surface detail rather than a dirty/grungy smear.
const NORMAL_SCALE = new THREE.Vector2(0.12, 0.12)
const CLEARCOAT_NORMAL_SCALE = new THREE.Vector2(0.08, 0.08)

// No crystal pulses on its own anymore — every visible brightening comes
// from triggerGlow, whether that's an ambient twinkle (AmbientGlow below)
// or an arc/resonance strike (sparks.tsx), and MAX_GLOWING_CRYSTALS caps
// how many can be doing that at once, whatever the cause. The rest of the
// field sits at IDLE_INTENSITY — dim, but never fully dark.
const IDLE_INTENSITY = 0.5
const GLOW_STRENGTH = 1.6
// A crystal counts as "faded out" below this and is dropped from
// glowingSites, freeing its slot back up.
const GLOW_EPSILON = 0.01
// How long an early-evicted glow takes to fade to 0, instead of the
// instant cutoff a plain `value = 0` would read as.
const GLOW_EVICTION_FADE_TIME = 0.4

// Caps how many crystals can be actively glowing at once — sparks.tsx's arc
// and resonance pools can fire far more often than this, so without a cap
// every crystal in the field could end up lit at the same time. Oldest
// glow first, tracked as a small FIFO: triggerGlow evicts the front entry
// (fading it out over GLOW_EVICTION_FADE_TIME, not an instant cutoff) to
// make room for a new one once the list is full.
const MAX_GLOWING_CRYSTALS = 6
const glowingSites: CrystalSite[] = []

/** Call instead of setting `site.glow.value` directly — enforces MAX_GLOWING_CRYSTALS. `decayTau` controls how fast this particular glow fades once triggered (fast/punchy for a strike, slower for an ambient twinkle). */
export function triggerGlow(site: CrystalSite, decayTau: number) {
  if (!site.isGlowing) {
    if (glowingSites.length >= MAX_GLOWING_CRYSTALS) {
      const evicted = glowingSites.shift()
      if (evicted) {
        evicted.isGlowing = false
        evicted.glow.fading = true
        evicted.glow.fadeFrom = evicted.glow.value
        evicted.glow.fadeElapsed = 0
      }
    }
    site.isGlowing = true
    glowingSites.push(site)
  }
  site.glow.value = 1
  site.glow.decayTau = decayTau
  site.glow.fading = false
}

function CrystalCluster({
  site,
  reducedMotion,
  envMap,
}: {
  site: CrystalSite
  reducedMotion: boolean
  envMap: THREE.Texture
}) {
  const shardMeshRefs = useRef<THREE.Mesh[]>([])

  useFrame((_, delta) => {
    if (!reducedMotion) {
      const glow = site.glow
      if (glow.fading) {
        // Forced eviction fade: linear to 0 over a fixed, predictable
        // window rather than however long decayTau happens to take.
        glow.fadeElapsed += delta
        const t = Math.min(1, glow.fadeElapsed / GLOW_EVICTION_FADE_TIME)
        glow.value = glow.fadeFrom * (1 - t)
        if (t >= 1) glow.fading = false
      } else {
        glow.value *= Math.exp(-delta / glow.decayTau)
      }
      if (site.isGlowing && !glow.fading && glow.value < GLOW_EPSILON) {
        site.isGlowing = false
        glow.value = 0
        const index = glowingSites.indexOf(site)
        if (index !== -1) glowingSites.splice(index, 1)
      }
    }
    const intensity = THREE.MathUtils.clamp(
      IDLE_INTENSITY + site.glow.value * GLOW_STRENGTH,
      0.15,
      3.2,
    )
    for (const mesh of shardMeshRefs.current) {
      const material = mesh.material as THREE.MeshPhysicalMaterial
      material.emissiveIntensity = intensity
    }
  })

  return (
    <group position={site.position} scale={site.scale}>
      {site.shards.map((shard, i) => (
        <group
          key={`${site.id}-${shard.id}`}
          position={shard.offset}
          rotation={[shard.tilt[0], shard.rotationY, shard.tilt[1]]}
          scale={shard.scale}
        >
          <mesh
            geometry={SHARD_GEOMETRY_VARIANTS[shard.variantId]}
            ref={(el) => {
              if (!el) return
              shardMeshRefs.current[i] = el
              // On the volumetric fog's shadow-caster layer, so crystals
              // actually block the sun and carve beams/gaps through the haze.
              el.layers.enable(FOG_OCCLUDER_LAYER)
            }}
          >
            <meshPhysicalMaterial
              color={BASE_COLOR}
              emissive={EMISSIVE_COLOR}
              emissiveIntensity={1}
              metalness={0}
              roughness={0.1}
              transmission={1}
              ior={1.5}
              thickness={0.6}
              envMap={envMap}
              envMapIntensity={2.5}
              clearcoat={1}
              clearcoatRoughness={0.08}
              normalMap={PROCEDURAL_NORMAL_MAP}
              normalScale={NORMAL_SCALE}
              clearcoatNormalMap={PROCEDURAL_NORMAL_MAP}
              clearcoatNormalScale={CLEARCOAT_NORMAL_SCALE}
              attenuationColor="#5fa9d6"
              attenuationDistance={3}
              fog={false}
            />
          </mesh>
          <EdgeSnake
            geometry={SHARD_EDGE_GEOMETRY_VARIANTS[shard.variantId]}
            timeOffset={site.timeOffset + i * 3.7}
            reducedMotion={reducedMotion}
          />
        </group>
      ))}
    </group>
  )
}

const AMBIENT_GLOW_DECAY_TAU = 1.4
const AMBIENT_INTERVAL_MIN = 8
const AMBIENT_INTERVAL_MAX = 20

/** Lights up a random non-glowing crystal every so often so the field still has some idle shimmer between arc strikes, instead of sitting flat at IDLE_INTENSITY whenever nothing's arcing. Shares the same MAX_GLOWING_CRYSTALS cap via triggerGlow (own local delta-accumulated clock — see the identical comment in sparks.tsx's Fizz component for why), so in practice it mostly just fills in whatever slots arcs aren't currently using. */
function AmbientGlow({ reducedMotion }: { reducedMotion: boolean }) {
  const rand = useMemo(() => mulberry32(0x1dee5), [])
  const timeRef = useRef(0)
  const nextTimeRef = useRef(0)

  useFrame((_, delta) => {
    if (reducedMotion) return
    timeRef.current += delta
    if (timeRef.current < nextTimeRef.current) return
    nextTimeRef.current =
      timeRef.current +
      AMBIENT_INTERVAL_MIN +
      rand() * (AMBIENT_INTERVAL_MAX - AMBIENT_INTERVAL_MIN)

    const candidate = CRYSTAL_SITES[Math.floor(rand() * CRYSTAL_SITES.length)]
    if (!candidate.isGlowing) triggerGlow(candidate, AMBIENT_GLOW_DECAY_TAU)
  })

  return null
}

/** Faceted glass crystal clusters scattered on the floor, each with an independently animated edge "snake" outline, a constant fizz of tiny surface sparks, and rare branching lightning arcs. */
export function Crystals({
  reducedMotion,
  groupRef,
}: {
  reducedMotion: boolean
  groupRef: RefObject<THREE.Group | null>
}) {
  const envMap = useCrystalEnvironmentMap()

  return (
    <group ref={groupRef}>
      {CRYSTAL_SITES.map((site) => (
        <CrystalCluster
          key={site.id}
          site={site}
          reducedMotion={reducedMotion}
          envMap={envMap}
        />
      ))}
      <AmbientGlow reducedMotion={reducedMotion} />
      <Sparks sites={CRYSTAL_SITES} reducedMotion={reducedMotion} />
    </group>
  )
}
