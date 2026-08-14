/**
 * Health for the cloud preview.
 *
 * This is NOT the loopback proxy. `apps/proxy` holds every vendor key and binds
 * to 127.0.0.1 on the kiosk machine; putting that behind a public URL is a
 * different security posture and a separate decision. What lives here is the one
 * endpoint the kiosk actually calls.
 *
 * That is the whole reason this file is three lines of payload rather than a
 * port of server.js: `EnubotRuntime.#checkHealth` reads `response.ok` and
 * nothing else, and the only other proxy routes — /chat, /tts-sample, /session —
 * have no caller in the client. Both live-voice drivers still throw on
 * connect(), so a deployed /chat would be an unauthenticated relay to Anthropic
 * serving no traffic. It goes in when a driver needs it, not before.
 *
 * The shape mirrors the proxy's /health so the two can be diffed by eye.
 */
export default function handler(_request, response) {
  response.status(200).json({
    ok: true,
    surface: 'cloud-preview',
    // Null rather than a model id: nothing here talks to an LLM.
    model: null,
    eventMode: false,
    voiceRoute: process.env.ENUBOT_VOICE_ROUTE ?? 'assembled',
    // Always false, and it should stay that way. If this ever reads true,
    // somebody has put a vendor key on a public deployment.
    hasAnthropicKey: Boolean(process.env.ANTHROPIC_API_KEY),
    commit: process.env.VERCEL_GIT_COMMIT_SHA ?? null,
  })
}
