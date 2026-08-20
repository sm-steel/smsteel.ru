import { useFrame } from "@react-three/fiber"
import { type RefObject, useMemo, useRef } from "react"
import * as THREE from "three"
import type { FlashlightState } from "./flashlight"
import { MAX_RIPPLES, type RippleState } from "./ripples"
import { FOG_OCCLUDER_LAYER } from "./volumetric-fog"

const vertexShader = /* glsl */ `
  uniform float uTime;
  uniform vec3 uRippleOrigins[${MAX_RIPPLES}];
  uniform float uRippleStartTimes[${MAX_RIPPLES}];
  uniform float uRippleAmplitude;
  uniform float uRippleFreq;
  uniform float uRippleSpeed;
  uniform float uRippleWidth;
  uniform float uRippleAttack;
  uniform float uRippleMaxAge;
  varying vec3 vWorldPosition;
  varying float vRipple;

  // Each click-spawned ripple is a ring whose radius grows with age
  // (ringRadius = age * speed) — displacement is localized to a band around
  // that radius (via the Gaussian falloff on distance-from-ring), so it
  // reads as an expanding wavefront instead of the whole spatial pattern
  // appearing at once. Summing several lets multiple ripples be in flight
  // and pass through (interfere with) each other rather than overriding.
  float ripples(vec2 worldXZ) {
    float total = 0.0;
    for (int r = 0; r < ${MAX_RIPPLES}; r++) {
      float age = uTime - uRippleStartTimes[r];
      float inRange = step(0.0, age) * step(age, uRippleMaxAge);
      float dist = distance(worldXZ, uRippleOrigins[r].xz);

      float ringRadius = age * uRippleSpeed;
      float offset = dist - ringRadius;
      float band = exp(-(offset * offset) / (uRippleWidth * uRippleWidth));
      float wave = sin(offset * uRippleFreq) * band;

      // Attack-decay envelope: ramps 0 -> 1 over the first uRippleAttack
      // seconds (the "splash" building up) rather than starting at full
      // strength the instant it's triggered, then eases back down to 0 by
      // uRippleMaxAge.
      float attack = smoothstep(0.0, uRippleAttack, age);
      float decay = 1.0 - smoothstep(uRippleAttack, uRippleMaxAge, age);
      float envelope = attack * decay;

      total += wave * envelope * inRange;
    }
    return total * uRippleAmplitude;
  }

  void main() {
    vec4 basePosition = modelMatrix * vec4(position, 1.0);
    float displacement = ripples(basePosition.xz);
    vRipple = displacement;

    // Local +Z maps to world +Y after this mesh's -90deg X rotation, so
    // nudging it here is what actually makes the floor bounce vertically.
    vec3 displaced = position;
    displaced.z += displacement;

    vec4 worldPosition = modelMatrix * vec4(displaced, 1.0);
    vWorldPosition = worldPosition.xyz;
    gl_Position = projectionMatrix * viewMatrix * worldPosition;
  }
`

const fragmentShader = /* glsl */ `
  uniform float uTime;
  uniform vec3 uGridColor;
  uniform vec3 uBaseColor;
  uniform float uCellSize;
  uniform vec3 uFlashPos;
  uniform float uFlashRadius;
  uniform vec3 uFlashColor;
  uniform float uFlashIntensity;
  uniform float uHorizonCutoff;
  varying vec3 vWorldPosition;
  varying float vRipple;

  float gridLines(vec2 coord, float cell) {
    vec2 scaled = coord / cell;
    vec2 grid = abs(fract(scaled - 0.5) - 0.5) / fwidth(scaled);
    float line = min(grid.x, grid.y);
    return 1.0 - clamp(line, 0.0, 1.0);
  }

  void main() {
    vec2 coord = vWorldPosition.xz;
    float line = gridLines(coord, uCellSize);
    float pulse = 0.8 + 0.2 * sin(uTime * 0.5 + coord.x * 0.02 + coord.y * 0.02);

    vec3 color = mix(uBaseColor, uGridColor * pulse, line);

    float dist = length(coord);

    // The floor plane is 400x400 so it geometrically extends well past
    // where it visually should end — without this, its own (very dark but
    // not quite background-matching) base color remains faintly visible
    // as a seam reaching up toward where the nebulae sit. The horizon glow
    // itself lives in a separate layer now (horizon-glow.tsx) precisely so
    // tuning this cutoff can't clip it — see that file.
    if (dist > uHorizonCutoff) discard;

    float fade = 1.0 - smoothstep(18.0, 85.0, dist);
    color = mix(uBaseColor, color, fade);

    float distToFlash = length(coord - uFlashPos.xz);
    float flashGlow = smoothstep(uFlashRadius, 0.0, distToFlash) * uFlashIntensity;
    color += uFlashColor * flashGlow * (0.3 + 0.7 * line);

    color += uGridColor * abs(vRipple) * 0.6;

    gl_FragColor = vec4(color, 1.0);
  }
`

/** Very dark floor plane with a procedural, gently pulsing neon grid that fades to black toward the horizon, brightens under the flashlight, and ripples outward from wherever it's clicked. */
export function Floor({
  reducedMotion,
  flashlightRef,
  rippleRef,
}: {
  reducedMotion: boolean
  flashlightRef: RefObject<FlashlightState>
  rippleRef: RefObject<RippleState>
}) {
  const materialRef = useRef<THREE.ShaderMaterial>(null)
  const uniforms = useMemo(
    () => ({
      uTime: { value: 0 },
      uGridColor: { value: new THREE.Color("#1fd7ff") },
      uBaseColor: { value: new THREE.Color("#020104") },
      uCellSize: { value: 2 },
      uFlashPos: { value: new THREE.Vector3(0, 0, -16) },
      uFlashRadius: { value: 4 },
      uFlashColor: { value: new THREE.Color("#1fd7ff") },
      uFlashIntensity: { value: 0 },
      // Where the plane stops rendering — tuned independently from the
      // horizon glow's own extent now that the glow lives in its own layer
      // (horizon-glow.tsx), so this can be moved freely without clipping it.
      uHorizonCutoff: { value: 80 },
      uRippleOrigins: {
        value: Array.from({ length: MAX_RIPPLES }, () => new THREE.Vector3()),
      },
      uRippleStartTimes: { value: new Float32Array(MAX_RIPPLES).fill(-9999) },
      uRippleAmplitude: { value: 0.42 },
      uRippleFreq: { value: 0.5 },
      uRippleSpeed: { value: 13.5 },
      uRippleWidth: { value: 4.2 },
      uRippleAttack: { value: 0.5 },
      uRippleMaxAge: { value: 1.8 },
    }),
    [],
  )

  useFrame((_, delta) => {
    const material = materialRef.current
    if (!material) return

    if (!reducedMotion) material.uniforms.uTime.value += delta

    const flashlight = flashlightRef.current
    material.uniforms.uFlashPos.value.copy(flashlight.position)
    material.uniforms.uFlashIntensity.value = 0.9 * flashlight.active

    const ripples = rippleRef.current
    ripples.currentTime = material.uniforms.uTime.value
    const origins = material.uniforms.uRippleOrigins.value as THREE.Vector3[]
    const startTimes = material.uniforms.uRippleStartTimes.value as Float32Array
    for (let i = 0; i < MAX_RIPPLES; i++) {
      origins[i].copy(ripples.origins[i])
      startTimes[i] = ripples.startTimes[i]
    }
  })

  return (
    <mesh
      rotation={[-Math.PI / 2, 0, 0]}
      ref={(mesh) => {
        // Also on the volumetric fog's shadow-caster layer, so its own
        // light shafts are correctly occluded by the floor.
        mesh?.layers.enable(FOG_OCCLUDER_LAYER)
      }}
    >
      <planeGeometry args={[400, 400, 200, 200]} />
      <shaderMaterial
        ref={materialRef}
        uniforms={uniforms}
        vertexShader={vertexShader}
        fragmentShader={fragmentShader}
        fog={false}
      />
    </mesh>
  )
}
