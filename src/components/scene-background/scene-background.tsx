import { Canvas, useThree } from "@react-three/fiber"
import { Bloom, EffectComposer } from "@react-three/postprocessing"
import { type RefObject, Suspense, useEffect, useRef, useState } from "react"
import type * as THREE from "three"
import { useReducedMotion } from "@/hooks/use-reduced-motion"
import { Crystals } from "./crystals"
import {
  createFlashlightState,
  Flashlight,
  type FlashlightState,
} from "./flashlight"
import { Floor } from "./floor"
import { HorizonGlow } from "./horizon-glow"
import { Nebula } from "./nebula"
import { createRippleState, type RippleState, RippleTrigger } from "./ripples"
import { Sky } from "./sky"
import { Title } from "./title"
import { VolumetricFog } from "./volumetric-fog"

/** Points the default camera down at the floor once on mount; the scene has no orbit controls. */
function CameraRig() {
  const { camera } = useThree()

  useEffect(() => {
    camera.position.set(0, 5, 12)
    camera.lookAt(0, -1, -20)
  }, [camera])

  return null
}

/** A single distinctly bright "star" far in the sky, dedicated as the volumetric fog's light source. */
function HeroStar({ starRef }: { starRef: RefObject<THREE.Mesh | null> }) {
  return (
    <mesh ref={starRef} position={[-67, 15, -160]}>
      <sphereGeometry args={[2.6, 16, 16]} />
      <meshBasicMaterial color="#eaf6ff" toneMapped={false} />
    </mesh>
  )
}

function SceneContents({
  reducedMotion,
  flashlightRef,
  rippleRef,
  crystalsGroupRef,
  starRef,
}: {
  reducedMotion: boolean
  flashlightRef: RefObject<FlashlightState>
  rippleRef: RefObject<RippleState>
  crystalsGroupRef: RefObject<THREE.Group | null>
  starRef: RefObject<THREE.Mesh | null>
}) {
  return (
    <>
      <CameraRig />
      <hemisphereLight args={["#1a2f52", "#020103", 0.15]} />
      <directionalLight
        position={[10, 20, 10]}
        intensity={0.08}
        color="#4d7fff"
      />
      <HeroStar starRef={starRef} />
      <Floor
        reducedMotion={reducedMotion}
        flashlightRef={flashlightRef}
        rippleRef={rippleRef}
      />
      <HorizonGlow reducedMotion={reducedMotion} />
      <Nebula reducedMotion={reducedMotion} />
      <Sky reducedMotion={reducedMotion} />
      <Crystals reducedMotion={reducedMotion} groupRef={crystalsGroupRef} />
      {/* Own nested Suspense boundary — a slow font fetch should only
      blank the title, not the rest of the already-loaded background. */}
      <Suspense fallback={null}>
        <Title reducedMotion={reducedMotion} />
      </Suspense>
      <Flashlight reducedMotion={reducedMotion} stateRef={flashlightRef} />
      <RippleTrigger reducedMotion={reducedMotion} rippleRef={rippleRef} />
    </>
  )
}

function supportsWebGL() {
  try {
    const canvas = document.createElement("canvas")
    return !!(canvas.getContext("webgl2") || canvas.getContext("webgl"))
  } catch {
    return false
  }
}

/** Full-viewport, fixed background: dark scene, rippling neon grid floor, starfield with light shafts, glass crystals, mouse-driven flashlight. */
export function SceneBackground() {
  const reducedMotion = useReducedMotion()
  const [webglOk] = useState(
    () => typeof window !== "undefined" && supportsWebGL(),
  )
  const [tabVisible, setTabVisible] = useState(true)

  const flashlightRef = useRef<FlashlightState>(createFlashlightState())
  const rippleRef = useRef<RippleState>(createRippleState())
  const crystalsGroupRef = useRef<THREE.Group | null>(null)
  const starRef = useRef<THREE.Mesh | null>(null)

  useEffect(() => {
    const handleVisibility = () =>
      setTabVisible(document.visibilityState === "visible")
    document.addEventListener("visibilitychange", handleVisibility)
    return () =>
      document.removeEventListener("visibilitychange", handleVisibility)
  }, [])

  if (!webglOk) {
    return <div className="-z-10 fixed inset-0 bg-[#020103]" aria-hidden />
  }

  return (
    <div
      className="-z-10 fixed inset-0 overflow-hidden bg-[#020103]"
      aria-hidden
    >
      <Canvas
        dpr={[1, 2]}
        gl={{ antialias: true, powerPreference: "low-power" }}
        camera={{ fov: 55, near: 0.1, far: 500 }}
        frameloop={tabVisible ? "always" : "never"}
      >
        <Suspense fallback={null}>
          <SceneContents
            reducedMotion={reducedMotion}
            flashlightRef={flashlightRef}
            rippleRef={rippleRef}
            crystalsGroupRef={crystalsGroupRef}
            starRef={starRef}
          />
          <EffectComposer>
            <VolumetricFog sunRef={starRef} reducedMotion={reducedMotion} />
            <Bloom
              mipmapBlur
              intensity={1.8}
              luminanceThreshold={0.15}
              luminanceSmoothing={0.5}
            />
          </EffectComposer>
        </Suspense>
      </Canvas>
    </div>
  )
}
