import { useFrame } from "@react-three/fiber"
import { useEffect, useMemo, useRef } from "react"
import * as THREE from "three"
import { mulberry32 } from "./crystals"

// A handful of glowing gas clouds tucked into the upper sky — each modeled
// after real emission-nebula photos (a bright compact core plus a much
// wider, fainter halo of surrounding haze, some split by a dark dust-lane
// rift for structure), additive glow against the black sky rather than an
// opaque patch. Same dome-mesh pattern as Sky's starfield and
// crystal-environment.ts's baked reflection sky, not a postprocessing
// effect — this has no interaction with scene depth/occluders (pure sky
// dressing), so a mesh + cheap fragment shader per instance is the right
// size rather than duplicating VolumetricFog's per-pixel depth
// reconstruction.
//
// Each instance projects onto its own small local tangent plane centered
// on a fixed sky direction (this scene's camera never moves — see
// randomNebulaCenter below), rather than volumetric-fog.tsx's whole-dome
// projection: noise detail needs to resolve *within* the patch, not be
// stretched across the sky. One shared shader, driven entirely by
// per-instance uniforms, so each patch can vary in position, size, shape
// (rotation/stretch/lane), color, and animation speed/phase without
// duplicating the GLSL.

// Just inside Sky's SKY_RADIUS=300 (stars sit convincingly in front of it)
// and well inside camera.far=500. Shared by every instance — only where
// each one's small patch of sky sits (uCenter) differs.
const NEBULA_MESH_RADIUS = 390
const NEBULA_SEGMENTS: [number, number] = [32, 24]

function lerp(a: number, b: number, t: number) {
  return a + (b - a) * t
}

// This scene's camera never moves (CameraRig sets position/lookAt once, no
// orbit controls) — so nebula centers are scattered within its one fixed
// view cone (as azimuth/elevation offsets from its forward direction)
// rather than across the whole sky sphere, most of which this camera could
// never see.
const CAMERA_POSITION = new THREE.Vector3(0, 5, 12)
const CAMERA_LOOK_AT = new THREE.Vector3(0, -1, -20)
const CAMERA_FORWARD = CAMERA_LOOK_AT.clone().sub(CAMERA_POSITION).normalize()
const CAMERA_RIGHT = new THREE.Vector3()
  .crossVectors(CAMERA_FORWARD, new THREE.Vector3(0, 1, 0))
  .normalize()
const CAMERA_UP = new THREE.Vector3()
  .crossVectors(CAMERA_RIGHT, CAMERA_FORWARD)
  .normalize()

// Azimuth range is symmetric around forward; elevation is an offset
// *upward* from forward (never downward), so every patch lands well clear
// of the horizon regardless of camera's own downward tilt.
const NEBULA_AZIMUTH_RANGE = 0.55 // +/- radians (~31.5deg) off dead-ahead
const NEBULA_ELEVATION_MIN = 0.16 // radians (~9deg) above forward
const NEBULA_ELEVATION_MAX = 0.4 // radians (~23deg) above forward

function randomNebulaCenter(rand: () => number): THREE.Vector3 {
  const azimuth = (rand() * 2 - 1) * NEBULA_AZIMUTH_RANGE
  const elevation = lerp(NEBULA_ELEVATION_MIN, NEBULA_ELEVATION_MAX, rand())
  return CAMERA_FORWARD.clone()
    .addScaledVector(CAMERA_RIGHT, Math.tan(azimuth))
    .addScaledVector(CAMERA_UP, Math.tan(elevation))
    .normalize()
}

// Kept close to the original single-nebula palette (deep indigo -> vivid
// blue-violet -> near-white core) rather than the wide per-instance hues
// an earlier version used — each patch gets only a small hue/lightness
// jitter off these three anchors, so the field reads as "the same nebula
// family, naturally varied" rather than a rainbow of unrelated clouds.
const NEBULA_BASE_DEEP = new THREE.Color("#22308c")
const NEBULA_BASE_BRIGHT = new THREE.Color("#6f8bff")
const NEBULA_BASE_CORE = new THREE.Color("#eef3ff")
const NEBULA_HUE_JITTER = 0.045 // ~16 degrees of hue either way

function jitterColor(
  base: THREE.Color,
  rand: () => number,
  hueJitter: number,
): THREE.Color {
  const hsl = { h: 0, s: 0, l: 0 }
  base.getHSL(hsl)
  const h = (hsl.h + (rand() - 0.5) * hueJitter * 2 + 1) % 1
  const s = THREE.MathUtils.clamp(hsl.s + (rand() - 0.5) * 0.12, 0, 1)
  const l = THREE.MathUtils.clamp(hsl.l + (rand() - 0.5) * 0.08, 0, 1)
  return new THREE.Color().setHSL(h, s, l)
}

interface NebulaConfig {
  /** Fixed sky direction this patch sits at — this scene has no orbit controls (CameraRig sets position/lookAt once), so each only needs to land inside the one fixed view cone, well above the horizon fade band. */
  center: THREE.Vector3
  /** Local-projection scale, in radians — smaller reads as a more compact cloud. */
  coreScale: number
  /** Discard cutoff, as cos(half-angle) — bigger patches (wider halo) need a more generous cutoff. */
  cutoffCos: number
  /** Radians; rotates the elongation axis so patches don't all lean the same way. */
  rotation: number
  /** How much the silhouette is stretched along its rotated Y axis — 1 = round, higher = more elongated/streaky. */
  stretchY: number
  /** 0 disables the dust-lane rift entirely (a softer, uncracked wisp); 1 is a strong dark crack. */
  laneStrength: number
  /** Unit direction of the dust lane in the patch's local space (ignored if laneStrength is 0). */
  laneDir: THREE.Vector2
  colorDeep: THREE.Color
  colorBright: THREE.Color
  colorCore: THREE.Color
  intensity: number
  /** Per-instance domain-warp drift speed — deliberately different per patch so they don't all churn in lockstep. */
  driftSpeed: THREE.Vector2
  /** Offsets the noise sampling coordinates so instances with similar coreScale/stretch don't read as the exact same cloud copy-pasted. */
  noiseSeed: THREE.Vector2
}

const NEBULA_COUNT = 4
// coreScale and cutoffCos are randomized together, at a fixed ratio (see
// buildNebulaConfigs) tuned from the original hand-placed patch so a
// patch's faint outer halo always fully resolves before the discard cutoff
// regardless of how big that particular instance rolled.
const NEBULA_CORE_SCALE_MIN = 0.09
const NEBULA_CORE_SCALE_MAX = 0.24
const NEBULA_CUTOFF_RATIO = 2.6 // radians of cutoff angle per radian of coreScale

function buildNebulaConfigs(): NebulaConfig[] {
  // Reseed each load, same as the crystal field, so the sky's nebula
  // arrangement differs run to run rather than being fixed.
  const rand = mulberry32(Date.now() ^ 0x9eb1a3)
  const configs: NebulaConfig[] = []

  for (let i = 0; i < NEBULA_COUNT; i++) {
    const coreScale = lerp(NEBULA_CORE_SCALE_MIN, NEBULA_CORE_SCALE_MAX, rand())
    const cutoffAngle = coreScale * NEBULA_CUTOFF_RATIO
    const laneAngle = rand() * Math.PI * 2

    configs.push({
      center: randomNebulaCenter(rand),
      coreScale,
      cutoffCos: Math.cos(cutoffAngle),
      rotation: rand() * Math.PI * 2,
      stretchY: lerp(1.0, 1.8, rand()),
      // ~30% of patches read as a soft uncracked wisp instead of a
      // structured cloud, matching the original's silhouette variety.
      laneStrength: rand() < 0.3 ? 0 : lerp(0.4, 1.0, rand()),
      laneDir: new THREE.Vector2(Math.cos(laneAngle), Math.sin(laneAngle)),
      colorDeep: jitterColor(NEBULA_BASE_DEEP, rand, NEBULA_HUE_JITTER),
      colorBright: jitterColor(NEBULA_BASE_BRIGHT, rand, NEBULA_HUE_JITTER),
      colorCore: jitterColor(NEBULA_BASE_CORE, rand, NEBULA_HUE_JITTER * 0.5),
      intensity: lerp(0.32, 0.48, rand()),
      driftSpeed: new THREE.Vector2(
        (rand() - 0.5) * 0.024,
        (rand() - 0.5) * 0.024,
      ),
      noiseSeed: new THREE.Vector2((rand() - 0.5) * 100, (rand() - 0.5) * 100),
    })
  }

  return configs
}

const NEBULA_CONFIGS = buildNebulaConfigs()

const vertexShader = /* glsl */ `
  varying vec3 vDirection;

  void main() {
    vDirection = normalize(position);
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`

const fragmentShader = /* glsl */ `
  uniform float uTime;
  uniform vec3 uColorDeep;
  uniform vec3 uColorBright;
  uniform vec3 uColorCore;
  uniform float uIntensity;
  uniform vec3 uCenter;
  uniform float uCoreScale;
  uniform float uCutoffCos;
  uniform float uRotation;
  uniform float uStretchY;
  uniform float uLaneStrength;
  uniform vec2 uLaneDir;
  uniform vec2 uDriftSpeed;
  uniform vec2 uNoiseSeed;
  varying vec3 vDirection;

  float hash(vec2 p) {
    vec3 p3 = fract(vec3(p.xyx) * 0.1031);
    p3 += dot(p3, p3.yzx + 33.33);
    return fract((p3.x + p3.y) * p3.z);
  }

  float valueNoise(vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    float a = hash(i);
    float b = hash(i + vec2(1.0, 0.0));
    float c = hash(i + vec2(0.0, 1.0));
    float d = hash(i + vec2(1.0, 1.0));
    vec2 u = f * f * (3.0 - 2.0 * f);
    return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
  }

  float fbm(vec2 p) {
    float value = 0.0;
    float amplitude = 0.5;
    for (int i = 0; i < 5; i++) {
      value += amplitude * valueNoise(p);
      p = p * 2.03 + vec2(3.7, 1.9);
      amplitude *= 0.55;
    }
    return value;
  }

  void main() {
    vec3 dir = normalize(vDirection);
    float cosAngle = dot(dir, uCenter);
    if (cosAngle < uCutoffCos) discard;

    // Local tangent-plane projection centered on uCenter, so noise detail
    // resolves within this patch instead of being stretched across the
    // whole sky dome.
    vec3 tangentX = normalize(cross(vec3(0.0, 1.0, 0.0), uCenter));
    vec3 tangentY = cross(uCenter, tangentX);
    vec2 local = vec2(
      dot(dir - uCenter, tangentX),
      dot(dir - uCenter, tangentY)
    );

    // Rotated and stretched (not a plain radius) so the cloud reads as an
    // irregular silhouette rather than a perfect circle — real nebulae are
    // elongated, not round.
    float ca = cos(uRotation);
    float sa = sin(uRotation);
    vec2 rotated = vec2(local.x * ca - local.y * sa, local.x * sa + local.y * ca);
    vec2 stretched = rotated * vec2(1.0, uStretchY);
    float r = length(stretched) / uCoreScale;

    vec2 drift = uTime * uDriftSpeed;
    vec2 detailUV = local / uCoreScale * 3.0 + uNoiseSeed;
    float wisps = fbm(detailUV + drift);
    // A second, coarser layer shapes the cloud's overall silhouette
    // independent of the fine wisping.
    float shape = fbm(detailUV * 0.3 - drift * 0.4 + 12.0);

    // Two-tier falloff: a brighter compact core plus a much wider, fainter
    // halo (the max of the two), so the cloud reads as filling a real
    // chunk of sky with soft surrounding haze instead of one hard-edged
    // boundary.
    float coreFalloff = exp(-r * r * 2.2);
    float haloFalloff = exp(-r * r * 0.35) * 0.35;
    float falloff = max(coreFalloff, haloFalloff);

    float density = clamp((wisps * 0.5 + shape * 0.65) * falloff - 0.16, 0.0, 1.0);

    // A dark dust lane cutting through the cloud, wobbled by noise so it
    // isn't a straight line. uLaneStrength=0 disables it entirely (some
    // patches read as a soft uncracked wisp instead) — a bigger source of
    // silhouette variety between patches than any other single knob.
    vec2 lanePerp = vec2(-uLaneDir.y, uLaneDir.x);
    float wobble = (fbm(local / uCoreScale * 1.6 + uNoiseSeed + 40.0) - 0.5) * 0.12;
    float laneCoord = dot(local, lanePerp) + wobble;
    float laneMask = mix(1.0, smoothstep(0.0, 0.05, abs(laneCoord)), uLaneStrength);
    density *= mix(0.1, 1.0, laneMask);

    if (density <= 0.001) discard;

    // Small, bright hot core near the center, flickering faintly with the
    // fine wisp noise and dimmed by the dust lane like the rest of the
    // cloud, so it doesn't read as a flat disc sitting on top of the rift.
    float core = exp(-r * r * 12.0) * (0.6 + 0.5 * wisps) * laneMask;

    vec3 gasColor = mix(uColorDeep, uColorBright, clamp(wisps * 1.3, 0.0, 1.0));
    gasColor = mix(gasColor, uColorCore, clamp(core * 1.4, 0.0, 1.0));

    gl_FragColor = vec4(gasColor * uIntensity * (0.5 + density), density * 0.8);
  }
`

/** One nebula patch — a mesh + shader material entirely driven by `config`, so the same GLSL renders every visually distinct instance. */
function NebulaPatch({
  config,
  geometry,
  reducedMotion,
}: {
  config: NebulaConfig
  geometry: THREE.SphereGeometry
  reducedMotion: boolean
}) {
  const materialRef = useRef<THREE.ShaderMaterial>(null)

  const uniforms = useMemo(
    () => ({
      uTime: { value: 0 },
      uColorDeep: { value: config.colorDeep },
      uColorBright: { value: config.colorBright },
      uColorCore: { value: config.colorCore },
      uIntensity: { value: config.intensity },
      uCenter: { value: config.center },
      uCoreScale: { value: config.coreScale },
      uCutoffCos: { value: config.cutoffCos },
      uRotation: { value: config.rotation },
      uStretchY: { value: config.stretchY },
      uLaneStrength: { value: config.laneStrength },
      uLaneDir: { value: config.laneDir },
      uDriftSpeed: { value: config.driftSpeed },
      uNoiseSeed: { value: config.noiseSeed },
    }),
    [config],
  )

  useFrame((_, delta) => {
    if (reducedMotion || !materialRef.current) return
    materialRef.current.uniforms.uTime.value += delta
  })

  return (
    // renderOrder forces every patch to draw before Sky's <points> — all
    // sit at local origin, so three.js's default back-to-front transparent
    // sort (by distance to object.position) would tie between them.
    <mesh geometry={geometry} renderOrder={-10} frustumCulled={false}>
      <shaderMaterial
        ref={materialRef}
        uniforms={uniforms}
        vertexShader={vertexShader}
        fragmentShader={fragmentShader}
        transparent
        depthWrite={false}
        side={THREE.BackSide}
        blending={THREE.AdditiveBlending}
        fog={false}
      />
    </mesh>
  )
}

/** A handful of glowing nebula patches tucked into the upper sky, each with its own position, size, elongation, and color — some split by a dark dust-lane rift, others soft uncracked wisps — modeled after real emission-nebula photos. */
export function Nebula({ reducedMotion }: { reducedMotion: boolean }) {
  // One geometry shared by every patch — only the shader/uniforms differ.
  const geometry = useMemo(
    () => new THREE.SphereGeometry(NEBULA_MESH_RADIUS, ...NEBULA_SEGMENTS),
    [],
  )

  useEffect(() => () => geometry.dispose(), [geometry])

  return (
    <>
      {NEBULA_CONFIGS.map((config, i) => (
        <NebulaPatch
          // biome-ignore lint/suspicious/noArrayIndexKey: fixed, never-reordered config list
          key={i}
          config={config}
          geometry={geometry}
          reducedMotion={reducedMotion}
        />
      ))}
    </>
  )
}
