import { useFrame } from "@react-three/fiber"
import { useRef } from "react"
import * as THREE from "three"

// The horizon glow band, split out of floor.tsx into its own layer so the
// floor's own visible extent (uHorizonCutoff there) can be tuned freely
// without clipping the glow — the two used to be coupled (same mesh, same
// discard), which meant tightening how far the grid renders also cut the
// glow's tail off mid-fade. This mesh renders only the glow, nothing else,
// on a plane sized generously past its own falloff so it never needs a
// cutoff of its own.

const HORIZON_PLANE_SIZE = 400 // matches floor.tsx's own plane size
// Same coordinate space as floor.tsx's fade (dist = radial XZ distance
// from world origin) — kept in sync by eye, not by sharing code, since
// this is now a deliberately separate, independently-tunable layer.
const HORIZON_RADIUS = 80
const HORIZON_WIDTH = 30
const HORIZON_INTENSITY = 0.8
// Midpoint between the floor grid's cyan (#1fd7ff) and the crystals'
// emissive cyan (EMISSIVE_COLOR in crystals.tsx, #3fc9ff) — reads as the
// same light family as the rest of the scene instead of an unrelated hue.
const HORIZON_COLOR = new THREE.Color("#2fd0ff")

const vertexShader = /* glsl */ `
  varying vec3 vWorldPosition;

  void main() {
    vec4 worldPosition = modelMatrix * vec4(position, 1.0);
    vWorldPosition = worldPosition.xyz;
    gl_Position = projectionMatrix * viewMatrix * worldPosition;
  }
`

const fragmentShader = /* glsl */ `
  uniform float uTime;
  uniform vec3 uColor;
  uniform float uRadius;
  uniform float uWidth;
  uniform float uIntensity;
  varying vec3 vWorldPosition;

  void main() {
    vec2 coord = vWorldPosition.xz;
    float dist = length(coord);

    // Gaussian falloff (not a hard ring) so it reads as atmospheric light
    // gathering at the horizon, not a decal. Negligible well before the
    // plane's own edge, so no cutoff/discard is needed here.
    float band = exp(-pow((dist - uRadius) / uWidth, 2.0));
    // Slow angular drift so it reads as independent atmospheric shimmer
    // rather than a static ring.
    float shimmer = 0.85 + 0.15 * sin(uTime * 0.15 + atan(coord.y, coord.x) * 3.0);
    float alpha = band * shimmer * uIntensity;
    if (alpha <= 0.001) discard;

    gl_FragColor = vec4(uColor, alpha);
  }
`

/** A soft, slowly shimmering glow band at the horizon — a separate layer from the floor's own grid/fade so the floor's visible extent and the glow's extent can be tuned independently. */
export function HorizonGlow({ reducedMotion }: { reducedMotion: boolean }) {
  const materialRef = useRef<THREE.ShaderMaterial>(null)

  useFrame((_, delta) => {
    if (reducedMotion || !materialRef.current) return
    materialRef.current.uniforms.uTime.value += delta
  })

  return (
    <mesh rotation={[-Math.PI / 2, 0, 0]} renderOrder={-1}>
      <planeGeometry args={[HORIZON_PLANE_SIZE, HORIZON_PLANE_SIZE]} />
      <shaderMaterial
        ref={materialRef}
        uniforms={{
          uTime: { value: 0 },
          uColor: { value: HORIZON_COLOR },
          uRadius: { value: HORIZON_RADIUS },
          uWidth: { value: HORIZON_WIDTH },
          uIntensity: { value: HORIZON_INTENSITY },
        }}
        vertexShader={vertexShader}
        fragmentShader={fragmentShader}
        transparent
        depthWrite={false}
        blending={THREE.AdditiveBlending}
        fog={false}
      />
    </mesh>
  )
}
