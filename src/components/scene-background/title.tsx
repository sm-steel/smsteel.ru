import { useFrame } from "@react-three/fiber"
import * as opentype from "opentype.js"
import { useMemo, useRef } from "react"
import * as THREE from "three"
import { BASE_COLOR, EMISSIVE_COLOR, mulberry32 } from "./crystals"
import { PROCEDURAL_NORMAL_MAP } from "./procedural-normal-map"
import {
  ARC_BRANCH_COUNT_MAX,
  ARC_BRANCH_COUNT_MIN,
  ARC_BRANCH_SEGMENTS_MAX,
  ARC_BRANCH_SEGMENTS_MIN,
  ARC_HARD_ANGLE,
  ARC_MAIN_DURATION_MAX,
  ARC_MAIN_DURATION_MIN,
  ARC_MAIN_SEGMENTS_MAX,
  ARC_MAIN_SEGMENTS_MIN,
  type ArcPool,
  ArcPoolMeshes,
  buildBranch,
  createArcPool,
  createFizzPool,
  FIZZ_COLOR,
  FizzPoints,
  type FizzPool,
  lerp,
  randInt,
  updateSlotEnvelopes,
  walkBolt,
  writeArcGeometry,
  writeFizzSlot,
} from "./sparks"
import { useTitleEnvironmentMap } from "./title-environment"

// The site name as real extruded 3D letters, rendered with the exact same
// glass material as the crystal shards (BASE_COLOR/EMISSIVE_COLOR/
// PROCEDURAL_NORMAL_MAP/env map all reused from crystals.tsx — nothing in
// that recipe is shape-specific), plus the same edge "snake" outline
// (EdgeSnake, crystals.tsx) and a small arc pool built from the exact same
// geometry-generation/shader code the crystal field's sparks.tsx arcs use
// — rather than a flat logo pasted on top.
//
// three.js 0.185 no longer ships the typeface.json fonts TextGeometry
// expects, and none exist elsewhere in this project — so this bypasses
// TextGeometry/FontLoader entirely and uses opentype.js to parse a real
// .otf directly into glyph outlines, converts those to THREE.Shapes, and
// extrudes them via THREE.ExtrudeGeometry. The font itself
// (public/fonts/Geist-Bold.otf, SIL OFL-1.1) is a static weight fetched
// from the Geist font's own source repo — the version installed via
// @fontsource-variable/geist is WOFF2-only and variable-weight, which
// would need WOFF2 decompression *and* variable-font instancing to use
// here, both real risk with no simple way to verify.

const TITLE_TEXT = "smsteel.ru"
const FONT_URL = "/fonts/Geist-Bold.otf"
// opentype.js's own letterSpacing option (a fraction of FONT_SIZE added
// between every glyph pair) — simpler and less error-prone than manually
// re-deriving per-glyph advance widths just to widen the gaps.
const LETTER_SPACING = 0.02

// Kept in the same local-unit magnitude as the crystal shard's own geometry
// (~0.3-1.6 units) rather than a large FONT_SIZE with a tiny compensating
// scale — the arc pool reused from sparks.tsx bakes its core/glow
// half-widths in as fixed absolute units tuned for that magnitude, so a
// geometry using a wildly different local scale would make the reused arcs
// render either invisibly thin or absurdly thick relative to the letters.
const FONT_SIZE = 3 // opentype.js em-space size the glyph paths are generated at
// Raised alongside the bigger bevel below — bevelThickness on each end
// (front/back) needs to stay under half of this or the two bevels collide
// and pinch the middle of the extrusion into a degenerate seam instead of
// a clean rounded gem cross-section.
const EXTRUDE_DEPTH = 0.7
// Deliberately large relative to FONT_SIZE=3 (a crystal-scale bevel would
// be a thin sliver here) — diagnosed via a temporary emissiveIntensity=0
// screenshot that the letters still looked like a flat, uniformly bright
// plaque even with zero self-glow. Root cause: ExtrudeGeometry's bevel only
// rounds the outer perimeter of each shape — a modest bevel size relative
// to stroke width still leaves most of a letter stroke's cross-section
// flat, which is why the material kept reading as a plaque rather than
// glass even after the first (moderate) bevel increase. Pushed further
// here, close to half the Bold weight's own stroke width, so most stroke
// cross-sections round out into a full convex tube/lens shape (the same
// "gel/glass letter" technique used for glossy 3D text) instead of a flat
// cap with a rounded rim — that's what actually gives the crystal shards
// their faceted-highlight look, and what a thin rim alone couldn't.
//
// First attempt (0.42/0.27) went too far: the bevel exceeded half the
// width of some letters' thinner strokes/counters, self-intersecting and
// visibly mangling letterforms (the second "s" rounded into an "o").
// Backed off to stay under that per-letter stroke-width ceiling.
const BEVEL_THICKNESS = 0.18
const BEVEL_SIZE = 0.06

// TITLE_SCALE is 100x the old FONT_SIZE=300 version's 0.012 to compensate
// for FONT_SIZE dropping 100x — same final world-space size, different
// local-unit magnitude (see above).
const TITLE_SCALE = 1.2
const TITLE_AZIMUTH = 0 // dead-center horizontally, unlike the nebula's deliberately off-axis patches
// Vertically centered between the horizon and the top of the screen —
// not a linear angle average, since screen position is tan(elevation)
// (a perspective camera's projection), not elevation itself. Derived from
// this scene's fixed camera (position (0,5,12), lookAt (0,-1,-20), 55deg
// vertical fov, all set once in CameraRig): the horizon is the direction
// with zero world-Y component (where the floor plane recedes to infinity),
// which sits at elevation ~0.1857rad above camera-forward here since the
// camera itself already looks down at the floor; the top of the screen is
// elevation = halfFov = 27.5deg = ~0.48rad. Averaging their tangents (not
// the raw angles) and converting back gives the angle whose on-screen
// position is exactly midway between those two, ~0.34rad (~19.5deg).
// Recompute this the same way if the camera's position/lookAt/fov ever
// change — it's derived from those three values, not independent of them.
const TITLE_ELEVATION = 0.34
const TITLE_DISTANCE = 40 // world units from the camera along that direction

// Same camera-basis technique nebula.tsx uses to place things within this
// scene's one fixed view cone (CameraRig sets position/lookAt once, no
// orbit controls, so this only ever needs to be computed once).
const CAMERA_POSITION = new THREE.Vector3(0, 5, 12)
const CAMERA_LOOK_AT = new THREE.Vector3(0, -1, -20)
const CAMERA_FORWARD = CAMERA_LOOK_AT.clone().sub(CAMERA_POSITION).normalize()
const CAMERA_RIGHT = new THREE.Vector3()
  .crossVectors(CAMERA_FORWARD, new THREE.Vector3(0, 1, 0))
  .normalize()
const CAMERA_UP = new THREE.Vector3()
  .crossVectors(CAMERA_RIGHT, CAMERA_FORWARD)
  .normalize()

// Reused across calls purely as scratch state for THREE.Object3D.lookAt()
// below — never added to the scene itself.
const lookAtDummy = new THREE.Object3D()

function computeTitleTransform() {
  const direction = CAMERA_FORWARD.clone()
    .addScaledVector(CAMERA_RIGHT, Math.tan(TITLE_AZIMUTH))
    .addScaledVector(CAMERA_UP, Math.tan(TITLE_ELEVATION))
    .normalize()
  const position = CAMERA_POSITION.clone().addScaledVector(
    direction,
    TITLE_DISTANCE,
  )

  // Faces the camera directly, computed once rather than a per-frame
  // lookAt() — nothing needs to track anything since the camera never
  // moves. Uses three.js's own Object3D.lookAt() (orients local -Z toward
  // the target, matching ExtrudeGeometry's flat z=0 cap, whose outward
  // normal already points -Z) instead of a hand-built rotation matrix —
  // a hand-rolled basis got the handedness wrong twice in a row here, so
  // this leans on three.js's own well-tested implementation instead.
  lookAtDummy.position.copy(position)
  lookAtDummy.lookAt(CAMERA_POSITION)

  return { position, quaternion: lookAtDummy.quaternion.clone() }
}

// --- font loading, Suspense-integrated -------------------------------------
// The scene mounts this inside its own <Suspense fallback={null}> (see
// scene-background.tsx) so a slow font fetch only blanks the title, not
// the whole background — the standard "throw a promise until resolved"
// pattern React/R3F Suspense expects.

let fontPromise: Promise<opentype.Font> | null = null
let fontResult: opentype.Font | null = null

function useGeistFont(): opentype.Font {
  if (fontResult) return fontResult
  fontPromise ??= fetch(FONT_URL)
    .then((res) => res.arrayBuffer())
    .then((buffer) => {
      fontResult = opentype.parse(buffer)
      return fontResult
    })
  throw fontPromise
}

// --- glyph outlines -> THREE.Shapes -----------------------------------------

function hasCoords(
  cmd: opentype.PathCommand,
): cmd is Exclude<opentype.PathCommand, { type: "Z" }> {
  return cmd.type !== "Z"
}

function splitIntoContours(
  commands: opentype.PathCommand[],
): opentype.PathCommand[][] {
  const contours: opentype.PathCommand[][] = []
  let current: opentype.PathCommand[] = []
  for (const cmd of commands) {
    if (cmd.type === "M" && current.length > 0) {
      contours.push(current)
      current = []
    }
    current.push(cmd)
  }
  if (current.length > 0) contours.push(current)
  return contours
}

// opentype.js path commands are in canvas-style Y-down space (drawn with
// ascenders at negative y, matching how font.draw() expects a 2D canvas
// context) — feeding that straight into THREE's Y-up convention renders
// every glyph upside down (confirmed: order/left-right came out correct,
// only vertical orientation was flipped — an "m" rendered as a "w", the
// textbook symptom of this exact mismatch). Negate y once here, at the
// source, rather than fighting it with an extra mesh-level flip later.
function negateCommandY(cmd: opentype.PathCommand): opentype.PathCommand {
  switch (cmd.type) {
    case "M":
    case "L":
      return { ...cmd, y: -cmd.y }
    case "C":
      return { ...cmd, y: -cmd.y, y1: -cmd.y1, y2: -cmd.y2 }
    case "Q":
      return { ...cmd, y: -cmd.y, y1: -cmd.y1 }
    default:
      return cmd
  }
}

function negateY(commands: opentype.PathCommand[]): opentype.PathCommand[] {
  return commands.map(negateCommandY)
}

function applyCommands(path: THREE.Path, commands: opentype.PathCommand[]) {
  for (const cmd of commands) {
    switch (cmd.type) {
      case "M":
        path.moveTo(cmd.x, cmd.y)
        break
      case "L":
        path.lineTo(cmd.x, cmd.y)
        break
      case "C":
        path.bezierCurveTo(cmd.x1, cmd.y1, cmd.x2, cmd.y2, cmd.x, cmd.y)
        break
      case "Q":
        path.quadraticCurveTo(cmd.x1, cmd.y1, cmd.x, cmd.y)
        break
      case "Z":
        path.closePath()
        break
    }
  }
}

// Font contours wind outer glyph outlines and inner counters (e.g. the
// hole inside "e"/"o") in opposite directions. Confirmed empirically for
// Geist-Bold.otf (outer contours come out counter-clockwise here) by
// logging contour count vs. resulting shape count: `true` produced only 2
// shapes from smsteel.ru's 12 contours (most letters were misclassified as
// holes and silently dropped — several letters didn't render at all),
// `false` produced the expected 10 (one per letter, since only the two
// "e"s have a counter/hole). Not guaranteed to hold for every font/tool,
// so this is the first thing to re-check (flip and re-measure the same
// way) if letters ever render as solid blobs or start disappearing again.
const OUTER_CONTOUR_IS_CLOCKWISE = false

function glyphPathToShapes(commands: opentype.PathCommand[]): THREE.Shape[] {
  const shapes: THREE.Shape[] = []
  let currentShape: THREE.Shape | null = null

  for (const contourCommands of splitIntoContours(commands)) {
    const points = contourCommands
      .filter(hasCoords)
      .map((cmd) => new THREE.Vector2(cmd.x, cmd.y))
    const isClockwise = THREE.ShapeUtils.isClockWise(points)

    if (isClockwise === OUTER_CONTOUR_IS_CLOCKWISE) {
      currentShape = new THREE.Shape()
      applyCommands(currentShape, contourCommands)
      shapes.push(currentShape)
    } else if (currentShape) {
      const hole = new THREE.Path()
      applyCommands(hole, contourCommands)
      currentShape.holes.push(hole)
    }
  }

  return shapes
}

function buildTitleGeometry(font: opentype.Font): THREE.BufferGeometry {
  const path = font.getPath(TITLE_TEXT, 0, 0, FONT_SIZE, {
    letterSpacing: LETTER_SPACING,
  })
  const shapes = glyphPathToShapes(negateY(path.commands))
  const geometry = new THREE.ExtrudeGeometry(shapes, {
    depth: EXTRUDE_DEPTH,
    bevelEnabled: true,
    bevelThickness: BEVEL_THICKNESS,
    bevelSize: BEVEL_SIZE,
    // More segments than the old flat-plaque bevel needed — a bigger bevel
    // (see BEVEL_THICKNESS/BEVEL_SIZE comment) needs enough segments to
    // round smoothly rather than facet into a visible chamfer ring.
    bevelSegments: 6,
    steps: 1,
  })
  geometry.center()
  return geometry
}

// Tuned for the wordmark's own UV scale — separate from crystals.tsx's
// NORMAL_SCALE/CLEARCOAT_NORMAL_SCALE since letterforms have very
// different surface proportions than the hex-prism shard. A first pass
// pushed this well above the crystal's own scale (~0.12) to break up the
// old flat-plaque brightness — that also scattered the transmission
// sampling so heavily the letters read as frosted/opaque instead of clear
// glass. The bigger bevel geometry above already does most of the work of
// breaking up the flat cap, so this only needs a modest boost over the
// crystal's own scale, not a 3-4x one.
const NORMAL_SCALE = new THREE.Vector2(0.2, 0.2)
const CLEARCOAT_NORMAL_SCALE = new THREE.Vector2(0.12, 0.12)
// No emissive glow at all — a diagnostic pass (temporarily zeroing this
// entirely) showed the earlier "too much glow" complaint wasn't coming
// from emissive in the first place (the letters stayed just as bright/flat
// at emissiveIntensity=0; the fix was the bevel/normalScale/envMapIntensity
// changes above). The pulsing glow added on top of that was reintroducing
// the same over-lit look via a different knob, so it's removed rather than
// re-tuned again.
const EMISSIVE_INTENSITY = 0

// --- sparks: a small arc pool reusing sparks.tsx's arc machinery wholesale -
// Every piece here (walkBolt, buildBranch, writeArcGeometry, createArcPool,
// updateSlotEnvelopes, ArcPoolMeshes, and the ARC_* shape/timing constants)
// is imported as-is from sparks.tsx — none of it is crystal-specific, only
// *where* a bolt spawns is (pickSurfacePoint there samples the hex-prism
// shard's curvature). This is the title's own equivalent of that one piece:
// sample a random vertex of the title geometry itself and aim outward from
// center, rather than trying to force-fit the crystal's apex/edge bias onto
// letterforms that don't have an analogous shape.

const TITLE_ARC_SLOT_COUNT = 32
const TITLE_ARC_INTERVAL_MIN = 0.3
const TITLE_ARC_INTERVAL_MAX = 0.6
const TITLE_ARC_REACH_MIN = 0.3
const TITLE_ARC_REACH_MAX = 0.45

function pickTitleSurfacePoint(
  rand: () => number,
  geometry: THREE.BufferGeometry,
): { position: THREE.Vector3; direction: THREE.Vector3 } {
  const positionAttr = geometry.attributes.position
  const vertexIndex = Math.floor(rand() * positionAttr.count)
  const position = new THREE.Vector3().fromBufferAttribute(
    positionAttr,
    vertexIndex,
  )

  // geometry.center() means the origin is roughly the wordmark's own
  // center, so "away from origin" is a reasonable outward direction —
  // falls back to a random direction for the rare vertex landing right
  // on/near center (e.g. a "t" crossbar), where normalizing a near-zero
  // vector would otherwise produce garbage.
  const direction = position.clone()
  if (direction.lengthSq() < 1e-6) {
    direction.set(rand() - 0.5, rand() - 0.5, rand() - 0.5)
  }
  direction.normalize()

  return { position, direction }
}

function fireTitleArc(
  pool: ArcPool,
  now: number,
  geometry: THREE.BufferGeometry,
  titleSize: number,
  rand: () => number,
) {
  const slotIndex = pool.nextSlot
  pool.nextSlot = (pool.nextSlot + 1) % pool.slots.length

  const { position: origin, direction } = pickTitleSurfacePoint(rand, geometry)

  const segments = randInt(rand, ARC_MAIN_SEGMENTS_MIN, ARC_MAIN_SEGMENTS_MAX)
  const totalLength =
    titleSize * lerp(TITLE_ARC_REACH_MIN, TITLE_ARC_REACH_MAX, rand())
  const mainPoints = walkBolt(
    rand,
    origin,
    direction,
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
}

function TitleSparks({
  geometry,
  reducedMotion,
}: {
  geometry: THREE.BufferGeometry
  reducedMotion: boolean
}) {
  const rand = useMemo(() => mulberry32(0x71e5), [])
  const pool = useMemo(() => createArcPool(TITLE_ARC_SLOT_COUNT), [])
  const titleSize = useMemo(() => {
    geometry.computeBoundingBox()
    const box = geometry.boundingBox
    return box ? box.max.y - box.min.y : 1
  }, [geometry])

  // Own local delta-accumulated clock — see the identical comment on
  // Fizz's timeRef in sparks.tsx for why (clock.elapsedTime resets to ~0
  // whenever the tab is hidden and R3F's render loop pauses).
  const timeRef = useRef(0)
  useFrame((_, delta) => {
    if (reducedMotion) return
    timeRef.current += delta
    const now = timeRef.current

    if (now >= pool.nextArcTime) {
      fireTitleArc(pool, now, geometry, titleSize, rand)
      pool.nextArcTime =
        now + lerp(TITLE_ARC_INTERVAL_MIN, TITLE_ARC_INTERVAL_MAX, rand())
    }

    updateSlotEnvelopes(pool, now)
  })

  if (reducedMotion) return null

  return <ArcPoolMeshes pool={pool} />
}

// --- fizz: the same constant surface-hugging speck cloud as the crystals ---
// Reuses createFizzPool/writeFizzSlot/FizzPoints wholesale from sparks.tsx
// (none of that is crystal-specific) — only the spawn point is title-
// specific, and pickTitleSurfacePoint above already does that job for the
// arc pool too, so it's reused here rather than duplicated.

const TITLE_FIZZ_COUNT = 40 // a small fraction of the crystal field's 1240 — one object, not 110
const TITLE_FIZZ_LIFETIME_MIN = 0.08
const TITLE_FIZZ_LIFETIME_MAX = 0.22
const TITLE_FIZZ_GAP_MIN = 0.05
const TITLE_FIZZ_GAP_MAX = 0.3
const TITLE_FIZZ_SIZE_MIN = 3
const TITLE_FIZZ_SIZE_MAX = 4

function respawnTitleFizzSlot(
  pool: FizzPool,
  i: number,
  now: number,
  geometry: THREE.BufferGeometry,
  rand: () => number,
) {
  const { position } = pickTitleSurfacePoint(rand, geometry)
  writeFizzSlot(
    pool,
    i,
    now,
    position,
    lerp(TITLE_FIZZ_SIZE_MIN, TITLE_FIZZ_SIZE_MAX, rand()),
    lerp(TITLE_FIZZ_LIFETIME_MIN, TITLE_FIZZ_LIFETIME_MAX, rand()),
    lerp(TITLE_FIZZ_GAP_MIN, TITLE_FIZZ_GAP_MAX, rand()),
  )
}

function TitleFizz({
  geometry,
  reducedMotion,
}: {
  geometry: THREE.BufferGeometry
  reducedMotion: boolean
}) {
  const rand = useMemo(() => mulberry32(0x9c31), [])
  const pool = useMemo(() => createFizzPool(TITLE_FIZZ_COUNT), [])
  const respawn = useMemo(
    () => (p: FizzPool, i: number, now: number) =>
      respawnTitleFizzSlot(p, i, now, geometry, rand),
    [geometry, rand],
  )

  return (
    <FizzPoints
      pool={pool}
      count={TITLE_FIZZ_COUNT}
      color={FIZZ_COLOR}
      reducedMotion={reducedMotion}
      respawn={respawn}
    />
  )
}

/** The site name as real extruded 3D glass letters, top-center, with the same fizz+arc sparks as the crystal shards — no emissive glow or edge outline, just the glass material itself. */
export function Title({ reducedMotion }: { reducedMotion: boolean }) {
  const font = useGeistFont()
  const envMap = useTitleEnvironmentMap()
  const geometry = useMemo(() => buildTitleGeometry(font), [font])
  const { position, quaternion } = useMemo(() => computeTitleTransform(), [])

  return (
    <group position={position} quaternion={quaternion} scale={TITLE_SCALE}>
      <mesh geometry={geometry}>
        <meshPhysicalMaterial
          color={BASE_COLOR}
          emissive={EMISSIVE_COLOR}
          emissiveIntensity={EMISSIVE_INTENSITY}
          metalness={0}
          roughness={0.1}
          transmission={1}
          ior={1.5}
          thickness={0.6}
          envMap={envMap}
          // Title-local prop, not shared with crystals.tsx. Lower than the
          // crystals' 2.5 for the same reason noted above (bigger flat-ish
          // surfaces concentrate reflection into a bigger patch), but not
          // dropped so low it goes flat/matte and loses the glass read —
          // the bevel + moderate normalScale now break the reflection up
          // into distinct highlights rather than one uniform sheen, so
          // this can sit higher than the first (too-conservative) pass.
          envMapIntensity={1.6}
          clearcoat={1}
          clearcoatRoughness={0.08}
          normalMap={PROCEDURAL_NORMAL_MAP}
          normalScale={NORMAL_SCALE}
          clearcoatNormalMap={PROCEDURAL_NORMAL_MAP}
          clearcoatNormalScale={CLEARCOAT_NORMAL_SCALE}
          attenuationColor="#5fa9d6"
          attenuationDistance={3}
          side={THREE.DoubleSide}
          fog={false}
        />
      </mesh>
      <TitleFizz geometry={geometry} reducedMotion={reducedMotion} />
      <TitleSparks geometry={geometry} reducedMotion={reducedMotion} />
    </group>
  )
}
