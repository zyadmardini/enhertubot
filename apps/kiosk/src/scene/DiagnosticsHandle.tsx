import { useEffect } from 'react'
import { useThree } from '@react-three/fiber'
import type { EnubotRuntime } from '../runtime/EnubotRuntime.ts'

interface DiagnosticsHandleProps {
  runtime: EnubotRuntime
}

/**
 * Puts the runtime, renderer, scene and camera on `window.__enubot` in debug mode.
 *
 * Three uses, all real. On the event machine it is the only way to interrogate a
 * misbehaving kiosk through a browser with no devtools. `renderStill()` draws a
 * frame synchronously rather than waiting on the render loop, which is how review
 * stills get captured — the loop is throttled the moment the window loses focus,
 * so anything that waits for a frame hangs instead of capturing. And `step()`
 * advances the per-frame clock by hand for the same reason: a backgrounded tab
 * gets no rAF, so mouth, gaze and gestures freeze and cannot be observed at all.
 */
export function DiagnosticsHandle({ runtime }: DiagnosticsHandleProps) {
  const { gl, scene, camera } = useThree()

  useEffect(() => {
    const handle = {
      runtime,
      gl,
      scene,
      camera,
      /** Force one frame at an explicit size and return it as a PNG data URL. */
      renderStill(width = 720, height = 1280, pixelRatio = 2): string {
        gl.setPixelRatio(pixelRatio)
        gl.setSize(width, height, false)
        if ('aspect' in camera) {
          camera.aspect = width / height
          camera.updateProjectionMatrix()
        }
        gl.render(scene, camera)
        return gl.domElement.toDataURL('image/png')
      },
      /** Advance the per-frame clock by hand when rAF isn't running. */
      step(seconds = 0.016, frames = 1): void {
        for (let i = 0; i < frames; i++) runtime.frame(seconds)
      },
    }
    const target = window as unknown as Record<string, unknown>
    target.__enubot = handle
    return () => {
      // Only clear it if we still own it. StrictMode mounts this twice, and a
      // cleanup that lands after the next setup would otherwise delete the handle
      // the live component just installed — leaving `?debug=1` with no
      // `window.__enubot` and no obvious reason why.
      if (target.__enubot === handle) delete target.__enubot
    }
  }, [runtime, gl, scene, camera])

  return null
}
