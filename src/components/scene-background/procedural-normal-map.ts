import * as THREE from "three"

// A tileable normal map generated once at import time, so the glass
// crystals have surface micro-detail to break up transmission/reflection
// into recognizable facets/ripples (per the Codrops "glass in Three.js"
// technique: https://tympanus.net/codrops/2021/10/27/creating-the-effect-of-transparent-glass-and-plastic-in-three-js/),
// without bundling a binary texture asset.

const SIZE = 256

// Sum of sinusoids with integer frequencies over the [0,1) tile — this is
// exactly periodic at the tile boundary (sin(2*pi*f*(u+1)) === sin(2*pi*f*u)
// for integer f), so the resulting heightfield tiles seamlessly with no
// wrap-blending tricks needed.
const NOISE_LAYERS: Array<{
  freqX: number
  freqY: number
  phaseX: number
  phaseY: number
  amplitude: number
}> = [
  { freqX: 3, freqY: 2, phaseX: 0.0, phaseY: 1.3, amplitude: 1.0 },
  { freqX: 5, freqY: 4, phaseX: 2.1, phaseY: 0.4, amplitude: 0.3 },
  { freqX: 8, freqY: 7, phaseX: 1.7, phaseY: 3.0, amplitude: 0.1 },
]

function height(u: number, v: number): number {
  let h = 0
  for (const layer of NOISE_LAYERS) {
    h +=
      layer.amplitude *
      Math.sin((u * layer.freqX + layer.phaseX) * Math.PI * 2) *
      Math.sin((v * layer.freqY + layer.phaseY) * Math.PI * 2)
  }
  return h
}

function buildNormalMapCanvas(): HTMLCanvasElement {
  const heights = new Float32Array(SIZE * SIZE)
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      heights[y * SIZE + x] = height(x / SIZE, y / SIZE)
    }
  }

  const canvas = document.createElement("canvas")
  canvas.width = SIZE
  canvas.height = SIZE
  const ctx = canvas.getContext("2d")
  if (!ctx) return canvas
  const imageData = ctx.createImageData(SIZE, SIZE)

  const strength = 1.2
  const normal = new THREE.Vector3()
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      // Wrap-around central difference — consistent with the tileable
      // heightfield, so the normal map itself tiles seamlessly too.
      const left = heights[y * SIZE + ((x - 1 + SIZE) % SIZE)]
      const right = heights[y * SIZE + ((x + 1) % SIZE)]
      const up = heights[((y - 1 + SIZE) % SIZE) * SIZE + x]
      const down = heights[((y + 1) % SIZE) * SIZE + x]

      const dx = (right - left) * strength
      const dy = (down - up) * strength
      normal.set(-dx, -dy, 1).normalize()

      const i = (y * SIZE + x) * 4
      imageData.data[i] = Math.round((normal.x * 0.5 + 0.5) * 255)
      imageData.data[i + 1] = Math.round((normal.y * 0.5 + 0.5) * 255)
      imageData.data[i + 2] = Math.round((normal.z * 0.5 + 0.5) * 255)
      imageData.data[i + 3] = 255
    }
  }

  ctx.putImageData(imageData, 0, 0)
  return canvas
}

/** A tileable, procedurally generated normal map for glass surface detail. Built once at import time — normal maps are non-color data, so colorSpace is left un-decoded. */
export const PROCEDURAL_NORMAL_MAP = new THREE.CanvasTexture(
  buildNormalMapCanvas(),
)
PROCEDURAL_NORMAL_MAP.wrapS = THREE.RepeatWrapping
PROCEDURAL_NORMAL_MAP.wrapT = THREE.RepeatWrapping
PROCEDURAL_NORMAL_MAP.colorSpace = THREE.NoColorSpace
PROCEDURAL_NORMAL_MAP.needsUpdate = true
