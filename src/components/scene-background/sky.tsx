import { useFrame } from "@react-three/fiber"
import { useEffect, useMemo, useRef } from "react"
import * as THREE from "three"

const STAR_COUNT = 6000
const SKY_RADIUS = 300

// Roughly the color-temperature spread of real naked-eye stars: mostly white
// and blue-white, with occasional warm white and pale orange outliers.
const STAR_PALETTE: Array<[number, number, number]> = [
  [1, 1, 1],
  [1, 1, 1],
  [0.78, 0.86, 1],
  [1, 0.95, 0.85],
  [1, 0.86, 0.63],
]

const vertexShader = /* glsl */ `
  attribute float aSize;
  attribute vec3 aColor;
  attribute float aPhase;
  attribute float aSpeed;
  uniform float uTime;
  uniform float uPixelRatio;
  varying vec3 vColor;
  varying float vTwinkle;

  void main() {
    vColor = aColor;
    vTwinkle = 0.55 + 0.45 * sin(uTime * aSpeed + aPhase);
    vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
    gl_PointSize = aSize * uPixelRatio * vTwinkle;
    gl_Position = projectionMatrix * mvPosition;
  }
`

const fragmentShader = /* glsl */ `
  varying vec3 vColor;
  varying float vTwinkle;

  void main() {
    vec2 centered = gl_PointCoord - 0.5;
    float dist = length(centered);
    float alpha = smoothstep(0.5, 0.0, dist) * vTwinkle;
    if (alpha <= 0.001) discard;
    gl_FragColor = vec4(vColor, alpha);
  }
`

function buildStarGeometry() {
  const positions = new Float32Array(STAR_COUNT * 3)
  const sizes = new Float32Array(STAR_COUNT)
  const colors = new Float32Array(STAR_COUNT * 3)
  const phases = new Float32Array(STAR_COUNT)
  const speeds = new Float32Array(STAR_COUNT)

  for (let i = 0; i < STAR_COUNT; i++) {
    // Uniform sampling over a spherical cap (slightly past the horizon) so
    // star density doesn't clump near the zenith.
    const theta = Math.random() * Math.PI * 2
    const phi = Math.acos(1 - Math.random() * 1.1)
    const x = SKY_RADIUS * Math.sin(phi) * Math.cos(theta)
    const y = SKY_RADIUS * Math.cos(phi)
    const z = SKY_RADIUS * Math.sin(phi) * Math.sin(theta)

    positions[i * 3] = x
    positions[i * 3 + 1] = y
    positions[i * 3 + 2] = z

    // Cubed distribution: most stars stay small/dim, a few read as bright.
    sizes[i] = 1 + Math.random() ** 3 * 3.5

    const [r, g, b] =
      STAR_PALETTE[Math.floor(Math.random() * STAR_PALETTE.length)]
    colors[i * 3] = r
    colors[i * 3 + 1] = g
    colors[i * 3 + 2] = b

    phases[i] = Math.random() * Math.PI * 2
    speeds[i] = 0.4 + Math.random() * 1.6
  }

  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3))
  geometry.setAttribute("aSize", new THREE.BufferAttribute(sizes, 1))
  geometry.setAttribute("aColor", new THREE.BufferAttribute(colors, 3))
  geometry.setAttribute("aPhase", new THREE.BufferAttribute(phases, 1))
  geometry.setAttribute("aSpeed", new THREE.BufferAttribute(speeds, 1))
  return geometry
}

/** A realistic-feeling starfield: varied size/brightness/color per star, each twinkling on its own phase. */
export function Sky({ reducedMotion }: { reducedMotion: boolean }) {
  const materialRef = useRef<THREE.ShaderMaterial>(null)
  const geometry = useMemo(() => buildStarGeometry(), [])

  useEffect(() => () => geometry.dispose(), [geometry])

  const uniforms = useMemo(
    () => ({
      uTime: { value: 0 },
      uPixelRatio: {
        value:
          typeof window === "undefined"
            ? 1
            : Math.min(window.devicePixelRatio, 2),
      },
    }),
    [],
  )

  useFrame((_, delta) => {
    if (reducedMotion || !materialRef.current) return
    materialRef.current.uniforms.uTime.value += delta
  })

  return (
    <points geometry={geometry} frustumCulled={false}>
      <shaderMaterial
        ref={materialRef}
        uniforms={uniforms}
        vertexShader={vertexShader}
        fragmentShader={fragmentShader}
        transparent
        depthWrite={false}
        blending={THREE.AdditiveBlending}
        fog={false}
      />
    </points>
  )
}
