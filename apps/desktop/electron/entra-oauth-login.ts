/**
 * entra-oauth-login.ts
 *
 * Electron-coupled driver for the mandatory ALTA Entra ID login gate: it
 * runs the loopback HTTP listener that catches Microsoft's browser redirect,
 * opens the system browser, redeems the one-time code for tokens, decodes
 * the signed-in user's identity, and hands both back. The PURE logic (PKCE,
 * URL building, callback parsing, token/claims normalization) lives in
 * entra-login.ts and is unit-tested separately; this module is the thin I/O
 * shell around it — mirrors native-oauth-login.ts's split for the (separate,
 * unrelated) gateway native-login flow.
 *
 * Dependencies are INJECTED (openExternal, a form-POST fn, an http-server
 * factory, a clock) so the orchestration is testable without booting
 * Electron or opening real sockets. main.ts supplies the real electron
 * shell.openExternal, a node:http/https POST, and node:http's server.
 *
 * Security posture (see entra-login.ts for the flow-level rationale):
 *   - the loopback server binds 127.0.0.1 on an EPHEMERAL port and shuts down
 *     the instant it receives the callback (or times out) — no long-lived
 *     local listener;
 *   - the `state` is verified before the code is redeemed (CSRF);
 *   - the PKCE verifier never leaves this process until the token POST, and
 *     Microsoft enforces SHA256(verifier)==challenge server-side;
 *   - the browser sees only a minimal "you can close this window" HTML page,
 *     never the tokens;
 *   - a malformed/unusable ID token fails the whole login rather than
 *     returning a session with no identity attached.
 */

import http from 'node:http'
import type { AddressInfo } from 'node:net'

import {
  buildAuthorizeUrl,
  buildTokenRequestBody,
  decodeIdTokenClaims,
  type EntraIdentity,
  type EntraSession,
  entraTokenEndpoint,
  generatePkcePair,
  generateState,
  parseLoopbackCallback,
  parseTokenResponse
} from './entra-login'

// Loopback login must complete inside this window (user opens browser,
// authenticates with ALTA's Microsoft account, gets redirected back).
const DEFAULT_LOGIN_TIMEOUT_MS = 5 * 60 * 1000

// The minimal page the browser lands on after the Entra ID redirect. No
// tokens, no secrets — just a close affordance. Served for any loopback
// request so a favicon probe doesn't look like a failure.
const DONE_HTML =
  '<!doctype html><meta charset="utf-8"><title>Signed in</title>' +
  '<body style="font:15px system-ui;margin:3rem;text-align:center">' +
  '<h2>&#10003; Signed in to Hermes</h2>' +
  '<p>You can close this window and return to the app.</p>' +
  '<script>setTimeout(()=>window.close(),800)</script>'

export interface EntraLoginDeps {
  tenantId: string
  clientId: string
  /** Open a URL in the user's system browser (shell.openExternal). */
  openExternal: (url: string) => Promise<void>
  /** POST an application/x-www-form-urlencoded body and resolve the parsed JSON response. */
  postForm: (url: string, body: Record<string, string>, opts?: { timeoutMs?: number }) => Promise<any>
  /** http.createServer, injectable for tests. */
  createServer?: typeof http.createServer
  /** Clock, injectable for tests. */
  now?: () => number
  timeoutMs?: number
  /** Optional logger for boot diagnostics. */
  rememberLog?: (line: string) => void
}

export interface EntraLoginResult {
  session: EntraSession
  identity: EntraIdentity
}

/**
 * Drive a full interactive Entra ID login and return the resulting session +
 * decoded identity.
 *
 * Steps: bind a loopback listener → open the system browser at Microsoft's
 * /oauth2/v2.0/authorize with our PKCE challenge + loopback redirect_uri →
 * await the ?code= redirect → verify state → POST /oauth2/v2.0/token with the
 * verifier → decode the ID token → return {session, identity}. Rejects on
 * timeout, state mismatch, an Entra error param, a token-exchange failure, or
 * an unusable ID token. Always tears the listener down.
 */
export async function runEntraLogin(deps: EntraLoginDeps): Promise<EntraLoginResult> {
  const createServer = deps.createServer || http.createServer
  const timeoutMs = deps.timeoutMs ?? DEFAULT_LOGIN_TIMEOUT_MS
  const now = deps.now || Date.now
  const log = deps.rememberLog || (() => undefined)

  const { verifier, challenge } = generatePkcePair()
  const state = generateState()

  return new Promise<EntraLoginResult>((resolve, reject) => {
    let settled = false
    let timer: NodeJS.Timeout | null = null
    // Set once the loopback listener is bound, before the browser opens — the
    // request handler below only runs after that, so it always sees the real
    // value by the time it reads it.
    let redirectUri = ''

    const server = createServer((req, res) => {
      // Only the callback path carries the code; any other path (favicon,
      // etc.) still gets the friendly page so the browser tab looks sane.
      const url = req.url || '/'

      // Always answer the browser with the close page — we never surface the
      // outcome to the browser, only to the app.
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      res.end(DONE_HTML)

      if (settled) {
        return
      }

      // Ignore non-callback noise (e.g. /favicon.ico) — wait for the ?code=.
      if (!/[?&](code|error)=/.test(url)) {
        return
      }

      try {
        const { code } = parseLoopbackCallback(url, state)

        finishWith(async () => {
          const tokenBody = await deps.postForm(
            entraTokenEndpoint(deps.tenantId),
            buildTokenRequestBody({
              clientId: deps.clientId,
              code,
              redirectUri,
              codeVerifier: verifier
            }),
            { timeoutMs: 15_000 }
          )

          const session = parseTokenResponse(tokenBody, Math.floor(now() / 1000))
          // A session without a decodable identity defeats the whole point of
          // this gate (no local UI identity, no future relay header) — fail
          // the login rather than handing back a half-formed result.
          const identity = decodeIdTokenClaims(session.idToken)

          return { session, identity }
        })
      } catch (error) {
        fail(error instanceof Error ? error : new Error(String(error)))
      }
    })

    const cleanup = () => {
      if (timer) {
        clearTimeout(timer)
      }

      try {
        server.close()
      } catch {
        // already closed
      }
    }

    const fail = (error: Error) => {
      if (settled) {
        return
      }

      settled = true
      cleanup()
      reject(error)
    }

    const finishWith = (produce: () => Promise<EntraLoginResult>) => {
      if (settled) {
        return
      }

      settled = true
      // Keep the listener up just long enough to have answered the browser,
      // then redeem the code out-of-band.
      produce()
        .then(result => {
          cleanup()
          resolve(result)
        })
        .catch(error => {
          cleanup()
          reject(error instanceof Error ? error : new Error(String(error)))
        })
    }

    server.on('error', err => fail(err instanceof Error ? err : new Error(String(err))))

    // Bind an ephemeral loopback port, then open the browser.
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as AddressInfo | null

      if (!addr || typeof addr === 'string') {
        fail(new Error('Failed to bind loopback listener for Entra ID login'))

        return
      }

      // Must be exactly `http://localhost:<port>` with no path: Entra ID's public-client
      // loopback exception (otherwise AADSTS50011) only matches a redirect URI registered
      // as the literal `http://localhost`, ignoring the port — it does NOT extend that
      // leniency to `127.0.0.1` or to any path suffix. The listener still binds 127.0.0.1
      // (which is what `localhost` resolves to); only the redirect_uri string changes.
      redirectUri = `http://localhost:${addr.port}`

      const authorizeUrl = buildAuthorizeUrl({
        tenantId: deps.tenantId,
        clientId: deps.clientId,
        redirectUri,
        challenge,
        state
      })

      timer = setTimeout(() => {
        fail(
          new Error(
            'Entra ID sign-in timed out. The browser window may not have completed sign-in; relaunch Hermes to try again.'
          )
        )
      }, timeoutMs)

      log(`[entra-login] loopback listening on 127.0.0.1:${addr.port}; opening system browser`)

      deps.openExternal(authorizeUrl).catch(error => {
        fail(
          new Error(
            `Could not open the system browser for Entra ID sign-in: ${
              error instanceof Error ? error.message : String(error)
            }`
          )
        )
      })
    })
  })
}

export { DEFAULT_LOGIN_TIMEOUT_MS }
