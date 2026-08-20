import { useThree } from "@react-three/fiber"
import { Effect, EffectAttribute } from "postprocessing"
import { type RefObject, useEffect, useMemo } from "react"
import * as THREE from "three"

// Screen-space raymarched volumetric fog: for each pixel, reconstructs the
// world-space ray from the depth buffer and marches it in fixed steps. At
// each step, a depth-from-the-sun "shadow map" is sampled to test whether
// that point is actually lit — only lit steps contribute sun in-scattering,
// so the crystals and grid genuinely occlude the light and carve visible
// beams/gaps through the haze, not just a uniform brightening.
const fragmentShader = /* glsl */ `
  uniform mat4 uInverseProjectionMatrix;
  uniform mat4 uInverseViewMatrix;
  uniform vec3 uCameraPosition;
  uniform vec3 uSunDirection;
  uniform vec3 uSunColor;
  uniform vec3 uFogColor;
  uniform float uFogDensity;
  uniform float uScatterPower;
  uniform float uScatterIntensity;
  uniform float uRayPower;
  uniform float uRayIntensity;
  uniform float uMaxDistance;
  uniform float uCameraNear;
  uniform float uCameraFar;
  uniform float uTime;
  uniform sampler2D uShadowMap;
  uniform mat4 uShadowMatrix;
  uniform float uShadowBias;

  const int STEPS = 28;

  // A sin()-based hash loses precision at larger inputs (visible streaking)
  // and wrapping the input to dodge that instead creates a hard seam right
  // where the wrap boundary falls. This multiplication/fract-based hash
  // ("Hash without Sine") has neither problem — no trig, so no precision
  // cliff, and no wrap, so no seam — across the whole range this shader
  // actually needs.
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

  // The cloud field itself stays put (large-scale shape doesn't drift) —
  // only a gentle domain warp slowly churns internally, so the texture
  // visibly moves without the whole sky panning past.
  float cloudFbm(vec2 p, float time) {
    vec2 drift = time * vec2(0.006, 0.0025);
    vec2 warp = vec2(
      valueNoise(p * 0.4 + drift),
      valueNoise(p * 0.4 - drift + vec2(5.2, 1.3))
    );
    p += (warp - 0.5) * 1.2;

    float value = 0.0;
    float amplitude = 0.55;
    for (int i = 0; i < 4; i++) {
      // A distinct shift per octave (rather than one repeated shift) breaks
      // up the grid-aligned repetition that reads as "too uniform" — a bit
      // more variety without adding more octaves/detail.
      vec2 shift = vec2(1.7 + float(i) * 4.1, 9.3 - float(i) * 2.7);
      value += amplitude * valueNoise(p);
      p = p * 2.1 + shift;
      amplitude *= 0.55;
    }
    return value;
  }

  // Nonlinear depth-buffer value -> straight-line camera distance. Doing it
  // this way (rather than reconstructing a world-space hit point and taking
  // its length) avoids the near-far-plane perspective-divide blowup that a
  // full unproject suffers right where depth approaches 1.0.
  float linearDistance(float depth) {
    float viewZ = (uCameraNear * uCameraFar) / ((uCameraFar - uCameraNear) * depth - uCameraFar);
    return -viewZ;
  }

  // 1.0 if this world-space point can see the sun (per the shadow map), 0.0
  // if something (floor/crystals) is between it and the light.
  float sampleShadow(vec3 worldPos) {
    vec4 shadowClip = uShadowMatrix * vec4(worldPos, 1.0);
    vec3 shadowCoord = shadowClip.xyz * 0.5 + 0.5;

    if (shadowCoord.z > 1.0) {
      return 1.0;
    }

    // Fade to "fully lit" smoothly near the shadow frustum's XY edges
    // instead of a hard cutoff — a low sun angle can put that boundary
    // right across the visible sky/floor, and a hard cutoff there reads as
    // a stark dark seam rather than just running out of shadow coverage.
    vec2 edgeDist = min(shadowCoord.xy, 1.0 - shadowCoord.xy);
    float edgeFade = smoothstep(0.0, 0.1, min(edgeDist.x, edgeDist.y));

    float occluderDepth = texture2D(uShadowMap, clamp(shadowCoord.xy, 0.0, 1.0)).r;
    float lit = shadowCoord.z - uShadowBias > occluderDepth ? 0.0 : 1.0;
    return mix(1.0, lit, edgeFade);
  }

  void mainImage(const in vec4 inputColor, const in vec2 uv, const in float depth, out vec4 outputColor) {
    // linearDistance() is well-behaved across the whole [0,1] depth range
    // (its only singularity falls outside it), so empty sky (depth == 1.0,
    // i.e. the far plane) just resolves to a large, finite distance here —
    // no special-casing needed, and light shafts stay visible against the
    // open night sky instead of only where they land on a real surface.
    float totalDist = min(linearDistance(depth), uMaxDistance);

    // Ray direction only needs uv, not depth, so it stays well-conditioned
    // right up to the far plane.
    vec4 viewDir4 = uInverseProjectionMatrix * vec4(uv * 2.0 - 1.0, 0.0, 1.0);
    vec3 viewDir = normalize(viewDir4.xyz / viewDir4.w);
    vec3 rayDir = normalize(mat3(uInverseViewMatrix) * viewDir);

    float stepSize = totalDist / float(STEPS);
    float jitter = hash(uv * 613.0 + uTime);
    vec3 pos = uCameraPosition + rayDir * stepSize * jitter;

    float directTerm = pow(clamp(dot(rayDir, uSunDirection), 0.0, 1.0), uScatterPower) * uScatterIntensity;

    // The moon-glow term above is deliberately tight around the sun
    // direction (that's what makes it read as a contained corona rather
    // than a wash). Light shafts are a different phenomenon visually: real
    // crepuscular rays stay visible across a wide swath of the sky, with
    // their shape defined by what's blocking the light (the shadow test
    // below) rather than by how close this pixel's view angle is to the
    // sun — so this term uses a much broader, gentler falloff and isn't
    // cloud-modulated, letting it read as distinct beams threading past
    // the crystals rather than another layer of glow.
    float rayTerm = pow(clamp(dot(rayDir, uSunDirection) * 0.5 + 0.5, 0.0, 1.0), uRayPower) * uRayIntensity;

    // Dome-project the ray direction into a 2D coordinate so clouds read as
    // a texture painted on the sky rather than something that swims with
    // the camera; cloudFbm's internal domain warp (see above) keeps it
    // gently churning over time without the cloud field itself panning.
    // The multiplier matters a lot here: rayDir only sweeps a small range
    // within the visible frustum, so it needs real magnification to span
    // more than a single noise cell — otherwise the whole sky lands inside
    // one cell and reads as a smooth gradient instead of textured cloud.
    vec2 cloudUV = rayDir.xz / (rayDir.y + 1.3) * 12.0;
    float cloudDensity = smoothstep(0.05, 0.7, cloudFbm(cloudUV, uTime));

    vec3 fogAccum = vec3(0.0);
    float transmittance = 1.0;

    for (int i = 0; i < STEPS; i++) {
      float density = uFogDensity * stepSize;
      float lit = sampleShadow(pos);
      vec3 inscatterColor = (uFogColor + uSunColor * (directTerm * lit)) * cloudDensity;
      vec3 rayColor = uSunColor * (rayTerm * lit);

      fogAccum += (inscatterColor + rayColor) * density * transmittance;
      transmittance *= exp(-density);
      pos += rayDir * stepSize;
    }

    // Additive only: the base scene (neon grid, crystal glow, stars) always
    // keeps its own full color/brightness — the march only ever adds
    // scattered light on top, like real light shafts do, instead of
    // physically-correct absorption dimming everything it crosses (which
    // reads as the whole scene being washed toward gray).
    outputColor = vec4(inputColor.rgb + fogAccum, inputColor.a);
  }
`

interface VolumetricFogOptions {
  sunColor?: THREE.ColorRepresentation
  fogColor?: THREE.ColorRepresentation
  fogDensity?: number
  scatterPower?: number
  scatterIntensity?: number
  rayPower?: number
  rayIntensity?: number
  maxDistance?: number
}

// Occluders (floor + crystals) are put on this layer so the shadow camera
// can see only them — Sky/HeroStar/etc. stay off it and are automatically
// excluded, no visibility toggling required.
export const FOG_OCCLUDER_LAYER = 1

const SHADOW_MAP_SIZE = 1024
const SHADOW_TARGET = new THREE.Vector3(0, 2, -20)
// Must cover at least as far as the floor's own visible extent (it fades to
// base color between 18-85 world units in floor.tsx) — otherwise the
// shadow frustum's edge (softened by sampleShadow's edgeFade, but still
// finite) falls inside the visible sky/floor instead of past the horizon
// fade. Exactly where that edge lands on screen shifts with the viewing
// camera's aspect ratio, which itself shifts with browser zoom (fixed
// browser chrome doesn't scale with page zoom, so it skews the aspect
// ratio) — so an undersized frustum here reads as a "flat seam that
// changes with zoom" even though the fog itself has no zoom dependency.
const SHADOW_ORTHO_HALF_SIZE = 100
const SHADOW_CAMERA_DISTANCE = 80
const SHADOW_UPDATE_INTERVAL = 1 / 12 // throttled: the occluders barely move frame to frame

class VolumetricFogEffect extends Effect {
  private readonly camera: THREE.Camera
  private readonly scene: THREE.Scene
  private readonly sunRef: RefObject<THREE.Object3D | null>
  private readonly sunWorldPosition = new THREE.Vector3()
  private readonly reducedMotion: boolean

  private readonly shadowCamera: THREE.OrthographicCamera
  private readonly shadowTarget: THREE.WebGLRenderTarget
  private readonly depthMaterial: THREE.MeshDepthMaterial
  private shadowElapsed = Number.POSITIVE_INFINITY // force a render on the first frame

  constructor(
    camera: THREE.Camera,
    scene: THREE.Scene,
    sunRef: RefObject<THREE.Object3D | null>,
    reducedMotion: boolean,
    options: VolumetricFogOptions = {},
  ) {
    const {
      sunColor = "#7f99a6",
      fogColor = "#03070a",
      // fogColor = "#99070a",
      fogDensity = 0.008,
      scatterPower = 16,
      scatterIntensity = 0.24,
      rayPower = 270,
      rayIntensity = 0.331,
      maxDistance = 70,
    } = options

    const shadowTarget = new THREE.WebGLRenderTarget(
      SHADOW_MAP_SIZE,
      SHADOW_MAP_SIZE,
    )
    shadowTarget.depthTexture = new THREE.DepthTexture(
      SHADOW_MAP_SIZE,
      SHADOW_MAP_SIZE,
    )
    shadowTarget.depthTexture.minFilter = THREE.NearestFilter
    shadowTarget.depthTexture.magFilter = THREE.NearestFilter

    super("VolumetricFogEffect", fragmentShader, {
      attributes: EffectAttribute.DEPTH,
      uniforms: new Map<string, THREE.Uniform>([
        ["uInverseProjectionMatrix", new THREE.Uniform(new THREE.Matrix4())],
        ["uInverseViewMatrix", new THREE.Uniform(new THREE.Matrix4())],
        ["uCameraPosition", new THREE.Uniform(new THREE.Vector3())],
        ["uSunDirection", new THREE.Uniform(new THREE.Vector3(0, 1, 0))],
        ["uSunColor", new THREE.Uniform(new THREE.Color(sunColor))],
        ["uFogColor", new THREE.Uniform(new THREE.Color(fogColor))],
        ["uFogDensity", new THREE.Uniform(fogDensity)],
        ["uScatterPower", new THREE.Uniform(scatterPower)],
        ["uScatterIntensity", new THREE.Uniform(scatterIntensity)],
        ["uRayPower", new THREE.Uniform(rayPower)],
        ["uRayIntensity", new THREE.Uniform(rayIntensity)],
        ["uMaxDistance", new THREE.Uniform(maxDistance)],
        [
          "uCameraNear",
          new THREE.Uniform((camera as THREE.PerspectiveCamera).near ?? 0.1),
        ],
        [
          "uCameraFar",
          new THREE.Uniform((camera as THREE.PerspectiveCamera).far ?? 1000),
        ],
        ["uTime", new THREE.Uniform(0)],
        ["uShadowMap", new THREE.Uniform(shadowTarget.depthTexture)],
        ["uShadowMatrix", new THREE.Uniform(new THREE.Matrix4())],
        ["uShadowBias", new THREE.Uniform(0.0015)],
      ]),
    })

    this.camera = camera
    this.scene = scene
    this.sunRef = sunRef
    this.reducedMotion = reducedMotion

    this.shadowTarget = shadowTarget
    this.depthMaterial = new THREE.MeshDepthMaterial()
    this.shadowCamera = new THREE.OrthographicCamera(
      -SHADOW_ORTHO_HALF_SIZE,
      SHADOW_ORTHO_HALF_SIZE,
      SHADOW_ORTHO_HALF_SIZE,
      -SHADOW_ORTHO_HALF_SIZE,
      1,
      SHADOW_CAMERA_DISTANCE * 2,
    )
    this.shadowCamera.layers.set(FOG_OCCLUDER_LAYER)
  }

  /** All uniforms declared in the constructor are always present; this just avoids repeating the cast. */
  private uniform<T>(name: string): T {
    // biome-ignore lint/style/noNonNullAssertion: uniform is always declared in the constructor
    return this.uniforms.get(name)!.value as T
  }

  private renderShadowMap(renderer: THREE.WebGLRenderer) {
    const previousTarget = renderer.getRenderTarget()
    const previousOverrideMaterial = this.scene.overrideMaterial
    // Rendering to a differently-sized target changes the GL viewport;
    // restoring the target alone doesn't guarantee the viewport comes back
    // with it, and a leftover 1024x1024 viewport during the composer's own
    // fullscreen draws would leave most of the frame unwritten (and, with
    // ping-pong buffers never fully overwritten, effectively accumulating
    // frame over frame — exactly the "gets brighter over time" symptom).
    const previousViewport = renderer.getViewport(new THREE.Vector4())

    this.scene.overrideMaterial = this.depthMaterial
    renderer.setRenderTarget(this.shadowTarget)
    renderer.setViewport(0, 0, SHADOW_MAP_SIZE, SHADOW_MAP_SIZE)
    renderer.clear()
    renderer.render(this.scene, this.shadowCamera)

    this.scene.overrideMaterial = previousOverrideMaterial
    renderer.setRenderTarget(previousTarget)
    renderer.setViewport(previousViewport)
  }

  override update(
    renderer: THREE.WebGLRenderer,
    _inputBuffer: THREE.WebGLRenderTarget,
    deltaTime = 0,
  ) {
    const camera = this.camera
    const sun = this.sunRef.current

    const sunDirection = this.uniform<THREE.Vector3>("uSunDirection")
    if (sun) {
      sun.getWorldPosition(this.sunWorldPosition)
      sunDirection
        .subVectors(this.sunWorldPosition, camera.position)
        .normalize()
    }

    this.uniform<THREE.Matrix4>("uInverseProjectionMatrix").copy(
      (camera as THREE.PerspectiveCamera).projectionMatrixInverse,
    )
    this.uniform<THREE.Matrix4>("uInverseViewMatrix").copy(camera.matrixWorld)
    this.uniform<THREE.Vector3>("uCameraPosition").copy(camera.position)

    this.shadowCamera.position
      .copy(SHADOW_TARGET)
      .addScaledVector(sunDirection, SHADOW_CAMERA_DISTANCE)
    this.shadowCamera.lookAt(SHADOW_TARGET)
    this.shadowCamera.updateMatrixWorld(true)
    this.uniform<THREE.Matrix4>("uShadowMatrix")
      .copy(this.shadowCamera.projectionMatrix)
      .multiply(this.shadowCamera.matrixWorldInverse)

    this.shadowElapsed += deltaTime
    if (this.shadowElapsed >= SHADOW_UPDATE_INTERVAL) {
      this.shadowElapsed = 0
      this.renderShadowMap(renderer)
    }

    if (!this.reducedMotion) {
      const time = this.uniforms.get("uTime")
      // biome-ignore lint/style/noNonNullAssertion: declared in the constructor
      time!.value += deltaTime
    }
  }

  override dispose() {
    this.shadowTarget.dispose()
    this.depthMaterial.dispose()
    super.dispose()
  }
}

/** Raymarched volumetric fog with cloud-textured in-scattering toward the hero star/moon, so its light reads as diffuse glow through drifting mist. */
export function VolumetricFog({
  sunRef,
  reducedMotion,
}: {
  sunRef: RefObject<THREE.Object3D | null>
  reducedMotion: boolean
}) {
  // @react-three/postprocessing never calls Effect#mainCamera on its
  // children (only GodRaysEffect-style constructor injection works) — so
  // the camera has to come from here, same as their own built-in effects do.
  const camera = useThree((state) => state.camera)
  const scene = useThree((state) => state.scene)
  const effect = useMemo(
    () => new VolumetricFogEffect(camera, scene, sunRef, reducedMotion),
    [camera, scene, sunRef, reducedMotion],
  )

  useEffect(() => {
    return () => effect.dispose()
  }, [effect])

  return <primitive object={effect} />
}
