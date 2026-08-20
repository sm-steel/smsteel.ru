import { useFrame, useThree } from "@react-three/fiber"
import { type RefObject, useEffect, useRef } from "react"
import * as THREE from "three"

/** Shared, mutable flashlight state — read by `floor.tsx` each frame to drive its brightening/ripple uniforms without prop-driven re-renders. */
export interface FlashlightState {
  /** Eased world-space point where the flashlight is aimed on the floor plane. */
  position: THREE.Vector3
  /** 0..1 eased activation — 0 until the pointer is actually in play. */
  active: number
}

export function createFlashlightState(): FlashlightState {
  return { position: new THREE.Vector3(0, 0, -16), active: 0 }
}

const FLOOR_PLANE = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0)
const POSITION_EASE = 0.14
const ACTIVE_EASE = 0.08
const MAX_INTENSITY = 6

/** A real, dim spotlight that follows the mouse across the floor (raycast onto y=0) — genuinely lights crystal facets, and feeds `stateRef` for the floor shader's brightening/ripple. */
export function Flashlight({
  reducedMotion,
  stateRef,
}: {
  reducedMotion: boolean
  stateRef: RefObject<FlashlightState>
}) {
  const { camera, raycaster, pointer } = useThree()
  const spotRef = useRef<THREE.SpotLight>(null)
  const targetRef = useRef<THREE.Object3D>(null)
  const enabled = useRef(false)
  const hasAimed = useRef(false)
  const hitPoint = useRef(new THREE.Vector3())

  useEffect(() => {
    if (spotRef.current && targetRef.current) {
      spotRef.current.target = targetRef.current
    }
  }, [])

  useEffect(() => {
    enabled.current =
      !reducedMotion &&
      typeof window !== "undefined" &&
      window.matchMedia("(hover: hover) and (pointer: fine)").matches
    if (!enabled.current) hasAimed.current = false
  }, [reducedMotion])

  useFrame(() => {
    const state = stateRef.current

    if (enabled.current) {
      raycaster.setFromCamera(pointer, camera)
      if (raycaster.ray.intersectPlane(FLOOR_PLANE, hitPoint.current)) {
        hasAimed.current = true
        state.position.lerp(hitPoint.current, POSITION_EASE)
      }
    }

    state.active = THREE.MathUtils.lerp(
      state.active,
      enabled.current && hasAimed.current ? 1 : 0,
      ACTIVE_EASE,
    )

    if (spotRef.current) {
      spotRef.current.position.copy(camera.position)
      spotRef.current.intensity = MAX_INTENSITY * state.active
    }
    if (targetRef.current) {
      targetRef.current.position.set(state.position.x, 0, state.position.z)
    }
  })

  return (
    <>
      <object3D ref={targetRef} position={[0, 0, -16]} />
      <spotLight
        ref={spotRef}
        color="#bfe6ff"
        intensity={0}
        angle={0.32}
        penumbra={0.65}
        distance={40}
        decay={2}
      />
    </>
  )
}
