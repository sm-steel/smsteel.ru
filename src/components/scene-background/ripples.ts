import { useThree } from "@react-three/fiber"
import { type RefObject, useEffect } from "react"
import * as THREE from "three"

/** Small fixed-size ripple pool — clicks write into it round-robin, so several ripples can be in flight and expanding simultaneously without overriding each other. */
export const MAX_RIPPLES = 8

export interface RippleState {
  origins: THREE.Vector3[]
  /** Shader-clock time each ripple started at (same clock `floor.tsx`'s `uTime` uses), so age math lines up. Far in the past means "not triggered yet". */
  startTimes: Float32Array
  nextSlot: number
  /** Mirrored by `floor.tsx` every frame so a click can stamp a ripple with the current shader time. */
  currentTime: number
}

export function createRippleState(): RippleState {
  return {
    origins: Array.from({ length: MAX_RIPPLES }, () => new THREE.Vector3()),
    startTimes: new Float32Array(MAX_RIPPLES).fill(-9999),
    nextSlot: 0,
    currentTime: 0,
  }
}

function triggerRipple(state: RippleState, worldPos: THREE.Vector3) {
  const slot = state.nextSlot
  state.origins[slot].copy(worldPos)
  state.startTimes[slot] = state.currentTime
  state.nextSlot = (slot + 1) % MAX_RIPPLES
}

const FLOOR_PLANE = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0)

/** Listens for clicks on the canvas and raycasts them onto the floor plane to spawn a new ripple. Skipped entirely under reduced motion, same as the flashlight. */
export function RippleTrigger({
  reducedMotion,
  rippleRef,
}: {
  reducedMotion: boolean
  rippleRef: RefObject<RippleState>
}) {
  const { camera, raycaster, gl } = useThree()

  useEffect(() => {
    if (reducedMotion) return

    const canvasEl = gl.domElement
    const hit = new THREE.Vector3()

    function handlePointerDown(event: PointerEvent) {
      const rect = canvasEl.getBoundingClientRect()
      const ndc = new THREE.Vector2(
        ((event.clientX - rect.left) / rect.width) * 2 - 1,
        -((event.clientY - rect.top) / rect.height) * 2 + 1,
      )
      raycaster.setFromCamera(ndc, camera)
      if (raycaster.ray.intersectPlane(FLOOR_PLANE, hit)) {
        triggerRipple(rippleRef.current, hit)
      }
    }

    canvasEl.addEventListener("pointerdown", handlePointerDown)
    return () => canvasEl.removeEventListener("pointerdown", handlePointerDown)
  }, [reducedMotion, camera, raycaster, gl, rippleRef])

  return null
}
