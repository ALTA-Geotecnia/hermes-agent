/**
 * entra-login.ts
 *
 * Pure, electron-free helpers for the mandatory ALTA desktop login gate: a
 * Microsoft Entra ID (Azure AD) OAuth 2.0 Authorization Code + PKCE login via
 * the system browser and a loopback redirect (RFC 8252), required before the
 * app is usable at all.
 *
 * This is intentionally a SEPARATE, standalone flow from native-oauth.ts /
 * native-oauth-login.ts, which log the desktop into a self-hosted remote
 * Hermes *gateway* (a different server, itself possibly OAuth-gated). This
 * module instead talks directly to Microsoft's identity platform — there is
 * no gateway brokering the flow, so the authorize/token endpoints, request
 * bodies, and claim shapes are Microsoft's, not a Hermes gateway's. See
 * PLANO-ADAPTACAO-HERMES.md and beads issue hermes-agent-bau.
 *
 * Kept standalone (no `import 'electron'`) so it unit-tests with plain
 * vitest — same pattern as native-oauth.ts. main.ts owns the electron-coupled
 * parts (the loopback http.Server, shell.openExternal, the token-endpoint
 * POST) via entra-oauth-login.ts and calls these helpers for the pure logic.
 *
 * App registration: this reuses the SAME Entra App Registration ALTA's
 * oauth2-proxy already uses for the intranet (per ALTA IT decision — one
 * registration, not a new one per app). client_id/tenant_id are not secrets
 * (confirmed by ALTA's own infra-server .env.example comment). There is NO
 * client secret: this MUST stay a public-client (PKCE-only) flow, since a
 * secret embedded in a distributed desktop binary would not be a secret.
 */

import { generatePkcePair, generateState } from './native-oauth'

// Non-secret Entra App Registration identifiers (see module docstring).
export const ENTRA_TENANT_ID = 'eb0548a2-8962-4391-b1f7-9abcf798d345'
export const ENTRA_CLIENT_ID = 'bda7505d-5d70-4370-b21c-98c0da93ecdd'

// offline_access is required to get a refresh_token back so the app doesn't
// force an interactive login every launch. The api://<client-id>/intranet.access
// scope (already exposed by this App Registration for the MindsHub/intranet
// pattern) is what makes the returned access_token carry aud=ENTRA_CLIENT_ID,
// which is what oauth2-proxy validates (OAUTH2_PROXY_SKIP_JWT_BEARER_TOKENS)
// when the desktop backend calls the ALTA Hermes Server with an
// Authorization: Bearer header instead of a browser session cookie.
export const ENTRA_SCOPE = `openid profile email offline_access api://${ENTRA_CLIENT_ID}/intranet.access`

/** The Microsoft identity platform v2.0 authorize endpoint for a tenant. */
export function entraAuthorizeEndpoint(tenantId: string): string {
  return `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/authorize`
}

/** The Microsoft identity platform v2.0 token endpoint for a tenant. */
export function entraTokenEndpoint(tenantId: string): string {
  return `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`
}

/**
 * Build the Microsoft identity platform `/oauth2/v2.0/authorize` URL the
 * system browser opens. `redirectUri` is the desktop's loopback callback
 * (`http://127.0.0.1:<port>/callback` — Microsoft's public-client loopback
 * match ignores the port at runtime, but the registration must list
 * `http://localhost` under a "Mobile and desktop applications" platform).
 * `prompt=select_account` avoids silently reusing a stale browser session
 * from a different Microsoft account on a shared machine.
 */
export function buildAuthorizeUrl(params: {
  tenantId: string
  clientId: string
  redirectUri: string
  challenge: string
  state: string
}): string {
  const q = new URLSearchParams({
    client_id: params.clientId,
    redirect_uri: params.redirectUri,
    response_type: 'code',
    response_mode: 'query',
    scope: ENTRA_SCOPE,
    code_challenge: params.challenge,
    code_challenge_method: 'S256',
    state: params.state,
    prompt: 'select_account'
  })

  return `${entraAuthorizeEndpoint(params.tenantId)}?${q.toString()}`
}

/**
 * Parse the loopback redirect the browser lands on after Entra ID finishes.
 * Returns the `code` on a `state` match, or throws with Entra's `error` /
 * `error_description` (e.g. AADSTS codes) if the flow failed.
 *
 * Kept as its own implementation rather than reusing native-oauth.ts's
 * parseLoopbackCallback: the two loopback flows talk to different identity
 * providers (Microsoft directly here, vs. a Hermes gateway there) and may
 * grow provider-specific error handling independently.
 */
export function parseLoopbackCallback(requestUrl: string, expectedState: string): { code: string } {
  // requestUrl is the path+query the loopback server received, e.g.
  // "/callback?code=...&state=...". Resolve against a dummy origin to parse.
  const parsed = new URL(requestUrl, 'http://127.0.0.1')
  const error = parsed.searchParams.get('error')

  if (error) {
    const desc = parsed.searchParams.get('error_description') || ''

    throw new Error(`Entra ID login failed: ${error}${desc ? ` (${desc})` : ''}`)
  }

  const code = parsed.searchParams.get('code') || ''
  const state = parsed.searchParams.get('state') || ''

  if (!code) {
    throw new Error('Loopback callback missing authorization code')
  }

  if (!expectedState || state !== expectedState) {
    // Never redeem a code that arrived with a mismatched state — it may be a
    // forged callback trying to inject an attacker's code (RFC 6749 §10.12).
    throw new Error('Loopback callback state mismatch (possible CSRF)')
  }

  return { code }
}

/** Build the `/oauth2/v2.0/token` authorization_code grant request body. */
export function buildTokenRequestBody(params: {
  clientId: string
  code: string
  redirectUri: string
  codeVerifier: string
}): Record<string, string> {
  return {
    grant_type: 'authorization_code',
    code: params.code,
    redirect_uri: params.redirectUri,
    client_id: params.clientId,
    code_verifier: params.codeVerifier
  }
}

/** Build the `/oauth2/v2.0/token` refresh_token grant request body. */
export function buildRefreshRequestBody(params: {
  clientId: string
  refreshToken: string
  scope?: string
}): Record<string, string> {
  return {
    grant_type: 'refresh_token',
    refresh_token: params.refreshToken,
    client_id: params.clientId,
    scope: params.scope || ENTRA_SCOPE
  }
}

/** One normalized Entra ID session, as returned by a token/refresh exchange or reloaded from disk. */
export interface EntraSession {
  accessToken: string
  refreshToken: string
  idToken: string
  expiresAt: number
}

/**
 * Normalize a `/oauth2/v2.0/token` (or refresh) JSON response into an
 * EntraSession. `nowSeconds` is injected (not `Date.now()`) so the absolute
 * `expiresAt` this produces stays deterministic in tests — mirrors the
 * NativeTokenSet normalization in native-oauth.ts, but Microsoft returns a
 * relative `expires_in` rather than an absolute `expires_at`.
 *
 * Throws on a missing/empty access token so a malformed response fails
 * loudly rather than storing junk.
 */
export function parseTokenResponse(body: any, nowSeconds: number): EntraSession {
  const accessToken = String(body?.access_token || '')

  if (!accessToken) {
    throw new Error('Entra token response missing access_token')
  }

  const expiresIn = Number(body?.expires_in)

  return {
    accessToken,
    refreshToken: String(body?.refresh_token || ''),
    idToken: String(body?.id_token || ''),
    expiresAt: nowSeconds + (Number.isFinite(expiresIn) ? expiresIn : 0)
  }
}

/**
 * Validate a session loaded from the encrypted local store — the reload
 * boundary, kept separate from parseTokenResponse() for the same reason
 * native-oauth.ts splits parseStoredTokenSet() from parseTokenResponse()
 * (see native-token-store.ts's #73271 comment): what lands on disk is
 * already the normalized camelCase EntraSession, not a raw snake_case
 * Microsoft response.
 */
export function parseStoredEntraSession(body: any): EntraSession {
  const accessToken = String(body?.accessToken || '')

  if (!accessToken) {
    throw new Error('Stored Entra session missing accessToken')
  }

  const expiresAt = Number(body?.expiresAt)

  return {
    accessToken,
    refreshToken: String(body?.refreshToken || ''),
    idToken: String(body?.idToken || ''),
    expiresAt: Number.isFinite(expiresAt) ? expiresAt : 0
  }
}

/** The identity claims this app cares about, decoded from an Entra ID token. */
export interface EntraIdentity {
  email: string
  oid: string
  name: string
}

/** base64url (no padding) -> utf8 decode of one JWT segment. */
function base64UrlDecodeSegment(segment: string): string {
  const normalized = segment.replace(/-/g, '+').replace(/_/g, '/')
  const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4)

  return Buffer.from(padded, 'base64').toString('utf8')
}

/**
 * Decode an Entra ID token's claims (email, oid, name) WITHOUT verifying its
 * signature.
 *
 * This is deliberate, not an oversight: the ID token is only ever used here
 * for local UI identity display and — per the usage-tracking groundwork this
 * gate lays — to attach an identity header to a *future* outbound call to
 * ALTA's own relay server. It is never accepted back as a bearer credential
 * to authorize anything by itself. The credential that actually gates access
 * (the access token) is validated server-side where it matters: at ALTA's
 * relay via oauth2-proxy's `aud`/`iss` check (see cowork.yml in the
 * infra-server repo) — out of scope for this desktop-side gate.
 */
export function decodeIdTokenClaims(idToken: string): EntraIdentity {
  const parts = String(idToken || '').split('.')

  if (parts.length < 2 || !parts[1]) {
    throw new Error('Malformed ID token: missing claims segment')
  }

  let claims: any

  try {
    claims = JSON.parse(base64UrlDecodeSegment(parts[1]))
  } catch {
    throw new Error('Malformed ID token: claims segment is not valid base64url JSON')
  }

  const email = String(claims?.email || claims?.preferred_username || '')
  const oid = String(claims?.oid || '')
  const name = String(claims?.name || '')

  if (!email && !oid) {
    throw new Error('ID token claims missing both email and oid')
  }

  return { email, oid, name }
}

/**
 * True when a stored Entra session is at/near expiry and should be refreshed
 * before use. `skewSeconds` refreshes slightly early to avoid a race where
 * the token expires in flight (mirrors tokenNeedsRefresh in native-oauth.ts).
 */
export function tokenNeedsRefresh(
  session: Pick<EntraSession, 'expiresAt'>,
  nowSeconds: number,
  skewSeconds = 60
): boolean {
  if (!session || !Number.isFinite(session.expiresAt) || session.expiresAt <= 0) {
    // Unknown expiry ⇒ treat as needing refresh so we validate before use.
    return true
  }

  return nowSeconds >= session.expiresAt - skewSeconds
}

// RFC 7636 PKCE + CSRF-state generation is generic, not gateway-specific —
// reused from native-oauth.ts rather than duplicated.
export { generatePkcePair, generateState }
