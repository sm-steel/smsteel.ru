import { useThree } from "@react-three/fiber"
import { useMemo } from "react"
import * as THREE from "three"

// A static, procedurally generated environment for the glass crystals to
// reflect, per the Codrops "glass in Three.js" technique
// (https://tympanus.net/codrops/2021/10/27/creating-the-effect-of-transparent-glass-and-plastic-in-three-js/),
// which relies on a real, bright, well-formed envMap (their demo uses an
// HDR photo) — a live-captured envMap of this scene's own mostly-black,
// sparse content never had enough signal to read as a reflection at any
// intensity. Rather than bundle an HDR asset, this builds a small on-theme
// (navy floor / cyan horizon / deep-blue sky, plus a few bright highlight
// spheres) offscreen scene once and bakes it through PMREMGenerator — a
// real, correctly roughness-blurred IBL map, generated once (no per-frame
// cost), not hand-rolled Fresnel shader trickery.

const skyVertexShader = /* glsl */ `
  varying vec3 vDirection;

  void main() {
    vDirection = normalize(position);
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`

const skyFragmentShader = /* glsl */ `
  uniform vec3 uFloorColor;
  uniform vec3 uHorizonColor;
  uniform vec3 uSkyColor;
  varying vec3 vDirection;

  void main() {
    vec3 direction = normalize(vDirection);
    float towardHorizon = 1.0 - abs(direction.y);
    vec3 base = direction.y > 0.0 ? uSkyColor : uFloorColor;
    vec3 color = mix(base, uHorizonColor, pow(towardHorizon, 2.0));
    gl_FragColor = vec4(color, 1.0);
  }
`

const HIGHLIGHT_POSITIONS: Array<[number, number, number]> = [
  [-20, 18, -10],
  [15, 10, 20],
  [0, 25, 15],
]

function buildEnvironmentScene(): THREE.Scene {
  const scene = new THREE.Scene()

  const skyGeometry = new THREE.SphereGeometry(50, 32, 32)
  const skyMaterial = new THREE.ShaderMaterial({
    side: THREE.BackSide,
    uniforms: {
      uFloorColor: { value: new THREE.Color("#0e2c45") },
      uHorizonColor: { value: new THREE.Color("#bff6ff") },
      uSkyColor: { value: new THREE.Color("#3d6f9c") },
    },
    vertexShader: skyVertexShader,
    fragmentShader: skyFragmentShader,
  })
  scene.add(new THREE.Mesh(skyGeometry, skyMaterial))

  // A few bright, unlit "star" highlight spheres so reflections show
  // distinct sharp highlights rather than only a smooth gradient. Sized up
  // relative to the 50-unit sky sphere so they still register after PMREM's
  // mip-chain blurring.
  const highlightGeometry = new THREE.SphereGeometry(3, 12, 12)
  for (const position of HIGHLIGHT_POSITIONS) {
    const highlightMaterial = new THREE.MeshBasicMaterial({
      color: "#eaf6ff",
    })
    const mesh = new THREE.Mesh(highlightGeometry, highlightMaterial)
    mesh.position.set(...position)
    scene.add(mesh)
  }

  return scene
}

function disposeScene(scene: THREE.Scene) {
  scene.traverse((object) => {
    if (!(object instanceof THREE.Mesh)) return
    object.geometry.dispose()
    const materials = Array.isArray(object.material)
      ? object.material
      : [object.material]
    for (const material of materials) material.dispose()
  })
}

/** The static, procedurally generated PMREM environment map for the crystals' glass material to reflect. Built once per renderer. */
export function useCrystalEnvironmentMap(): THREE.Texture {
  const { gl } = useThree()

  return useMemo(() => {
    const pmremGenerator = new THREE.PMREMGenerator(gl)
    const scene = buildEnvironmentScene()
    const renderTarget = pmremGenerator.fromScene(scene, 0, 0.1, 100)

    disposeScene(scene)
    pmremGenerator.dispose()

    return renderTarget.texture
  }, [gl])
}
