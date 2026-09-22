/**
 * Tests for electron/entra-login.ts — the pure Microsoft Entra ID (Azure AD)
 * login helpers backing the mandatory ALTA desktop login gate (PKCE + state
 * reuse, authorize-URL building, loopback callback parsing, token-response
 * normalization, ID-token claim decoding, refresh-timing).
 *
 * Run with: node --test electron/entra-login.test.ts
 * (Wired into the vitest `electron` project via electron/**\/*.test.ts.)
 */

import assert from 'node:assert/strict'

import { test } from 'vitest'

import {
  buildAuthorizeUrl,
  buildRefreshRequestBody,
  buildTokenRequestBody,
  decodeIdTokenClaims,
  ENTRA_CLIENT_ID,
  ENTRA_SCOPE,
  ENTRA_TENANT_ID,
  entraAuthorizeEndpoint,
  entraTokenEndpoint,
  generatePkcePair,
  generateState,
  parseLoopbackCallback,
  parseStoredEntraSession,
  parseTokenResponse,
  tokenNeedsRefresh
} from './entra-login'

// --- PKCE / state reuse ---
//
// generatePkcePair/generateState are re-exported from native-oauth.ts (RFC
// 7636 logic is generic, not gateway-specific) — full coverage of the
// algorithm already lives in native-oauth.test.ts. These are smoke tests
// confirming the re-export is wired, not a duplicate of that suite.

test('generatePkcePair/generateState are usable from this module', () => {
  const pair = generatePkcePair()

  assert.equal(pair.method, 'S256')
  assert.ok(pair.verifier.length >= 43)
  assert.doesNotMatch(pair.verifier, /[+/=]/)

  const state = generateState()

  assert.ok(state.length > 0)
})

// --- endpoints ---

test('entraAuthorizeEndpoint / entraTokenEndpoint build the v2.0 endpoints for a tenant', () => {
  assert.equal(
    entraAuthorizeEndpoint(ENTRA_TENANT_ID),
    `https://login.microsoftonline.com/${ENTRA_TENANT_ID}/oauth2/v2.0/authorize`
  )
  assert.equal(
    entraTokenEndpoint(ENTRA_TENANT_ID),
    `https://login.microsoftonline.com/${ENTRA_TENANT_ID}/oauth2/v2.0/token`
  )
})

// --- authorize URL ---

test('buildAuthorizeUrl encodes the required PKCE + OIDC params', () => {
  const url = buildAuthorizeUrl({
    tenantId: ENTRA_TENANT_ID,
    clientId: ENTRA_CLIENT_ID,
    redirectUri: 'http://127.0.0.1:51000/callback',
    challenge: 'CHAL',
    state: 'STATE'
  })

  const parsed = new URL(url)

  assert.equal(parsed.origin, 'https://login.microsoftonline.com')
  assert.equal(parsed.pathname, `/${ENTRA_TENANT_ID}/oauth2/v2.0/authorize`)
  assert.equal(parsed.searchParams.get('client_id'), ENTRA_CLIENT_ID)
  assert.equal(parsed.searchParams.get('redirect_uri'), 'http://127.0.0.1:51000/callback')
  assert.equal(parsed.searchParams.get('response_type'), 'code')
  assert.equal(parsed.searchParams.get('response_mode'), 'query')
  assert.equal(parsed.searchParams.get('scope'), ENTRA_SCOPE)
  assert.equal(parsed.searchParams.get('code_challenge'), 'CHAL')
  assert.equal(parsed.searchParams.get('code_challenge_method'), 'S256')
  assert.equal(parsed.searchParams.get('state'), 'STATE')
  assert.equal(parsed.searchParams.get('prompt'), 'select_account')
})

test('ENTRA_SCOPE requests offline_access so a refresh token comes back', () => {
  assert.match(ENTRA_SCOPE, /\bopenid\b/)
  assert.match(ENTRA_SCOPE, /\bprofile\b/)
  assert.match(ENTRA_SCOPE, /\bemail\b/)
  assert.match(ENTRA_SCOPE, /\boffline_access\b/)
})

test('ENTRA_SCOPE requests the exposed API scope so the access_token carries aud=ENTRA_CLIENT_ID (what oauth2-proxy checks for Bearer requests)', () => {
  assert.match(ENTRA_SCOPE, new RegExp(`api://${ENTRA_CLIENT_ID}/intranet\\.access`))
})

// --- loopback callback parsing ---

test('parseLoopbackCallback returns the code on a state match', () => {
  const { code } = parseLoopbackCallback('/callback?code=abc123&state=xyz', 'xyz')

  assert.equal(code, 'abc123')
})

test('parseLoopbackCallback throws on state mismatch (CSRF)', () => {
  assert.throws(() => parseLoopbackCallback('/callback?code=abc&state=attacker', 'expected'), /state mismatch/i)
})

test('parseLoopbackCallback surfaces an Entra error param', () => {
  assert.throws(
    () => parseLoopbackCallback('/callback?error=access_denied&error_description=AADSTS50105', 'xyz'),
    /access_denied.*AADSTS50105/i
  )
})

test('parseLoopbackCallback throws when the code is absent', () => {
  assert.throws(() => parseLoopbackCallback('/callback?state=xyz', 'xyz'), /missing authorization code/i)
})

// --- token request bodies ---

test('buildTokenRequestBody builds the authorization_code grant', () => {
  const body = buildTokenRequestBody({
    clientId: ENTRA_CLIENT_ID,
    code: 'CODE',
    redirectUri: 'http://127.0.0.1:1/cb',
    codeVerifier: 'VERIFIER'
  })

  assert.deepEqual(body, {
    grant_type: 'authorization_code',
    code: 'CODE',
    redirect_uri: 'http://127.0.0.1:1/cb',
    client_id: ENTRA_CLIENT_ID,
    code_verifier: 'VERIFIER'
  })
})

test('buildRefreshRequestBody builds the refresh_token grant', () => {
  const body = buildRefreshRequestBody({ clientId: ENTRA_CLIENT_ID, refreshToken: 'RT' })

  assert.deepEqual(body, {
    grant_type: 'refresh_token',
    refresh_token: 'RT',
    client_id: ENTRA_CLIENT_ID,
    scope: ENTRA_SCOPE
  })
})

test('buildRefreshRequestBody honours an explicit scope override', () => {
  const body = buildRefreshRequestBody({ clientId: ENTRA_CLIENT_ID, refreshToken: 'RT', scope: 'openid' })

  assert.equal(body.scope, 'openid')
})

// --- token response normalization ---

test('parseTokenResponse maps a well-formed body and computes an absolute expiresAt', () => {
  const now = 1_893_000_000

  const t = parseTokenResponse(
    { access_token: 'AT', refresh_token: 'RT', id_token: 'ID', token_type: 'Bearer', expires_in: 3600 },
    now
  )

  assert.equal(t.accessToken, 'AT')
  assert.equal(t.refreshToken, 'RT')
  assert.equal(t.idToken, 'ID')
  assert.equal(t.expiresAt, now + 3600)
})

test('parseTokenResponse throws on a missing access token', () => {
  assert.throws(() => parseTokenResponse({ refresh_token: 'RT' }, 0), /missing access_token/i)
})

test('parseTokenResponse tolerates an absent refresh token / id token / expiry', () => {
  const t = parseTokenResponse({ access_token: 'AT' }, 1000)

  assert.equal(t.refreshToken, '')
  assert.equal(t.idToken, '')
  assert.equal(t.expiresAt, 1000)
})

// --- stored-session parsing (the reload boundary) ---

test('parseStoredEntraSession maps the normalized on-disk camelCase shape', () => {
  const s = parseStoredEntraSession({
    accessToken: 'AT-stored',
    refreshToken: 'RT-stored',
    idToken: 'ID-stored',
    expiresAt: 1_893_456_000
  })

  assert.equal(s.accessToken, 'AT-stored')
  assert.equal(s.refreshToken, 'RT-stored')
  assert.equal(s.idToken, 'ID-stored')
  assert.equal(s.expiresAt, 1_893_456_000)
})

test('parseStoredEntraSession rejects a non-normalized (snake_case) shape', () => {
  assert.throws(() => parseStoredEntraSession({ access_token: 'AT-server' }), /missing accessToken/i)
})

// --- ID token claim decoding ---

function fakeIdToken(claims: Record<string, unknown>): string {
  const b64url = (obj: unknown) =>
    Buffer.from(JSON.stringify(obj)).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')

  return `${b64url({ alg: 'RS256' })}.${b64url(claims)}.SIGNATURE-NOT-VERIFIED`
}

test('decodeIdTokenClaims extracts email, oid and name', () => {
  const idToken = fakeIdToken({ email: 'breno.manhaes@altageotecnia.com', oid: 'oid-123', name: 'Breno Manhães' })

  const claims = decodeIdTokenClaims(idToken)

  assert.equal(claims.email, 'breno.manhaes@altageotecnia.com')
  assert.equal(claims.oid, 'oid-123')
  assert.equal(claims.name, 'Breno Manhães')
})

test('decodeIdTokenClaims falls back to preferred_username when email is absent', () => {
  const idToken = fakeIdToken({ preferred_username: 'breno.manhaes@altageotecnia.com', oid: 'oid-123' })

  const claims = decodeIdTokenClaims(idToken)

  assert.equal(claims.email, 'breno.manhaes@altageotecnia.com')
})

test('decodeIdTokenClaims does not verify the signature (accepts any trailing segment)', () => {
  // Deliberate: this token is only used for local UI identity + a future
  // outbound header, never as a bearer credential — see the comment on the
  // function itself for the full rationale.
  const idToken = fakeIdToken({ email: 'x@example.com', oid: 'o' })
  const tampered = `${idToken.split('.')[0]}.${idToken.split('.')[1]}.totally-different-signature`

  assert.doesNotThrow(() => decodeIdTokenClaims(tampered))
})

test('decodeIdTokenClaims throws on a malformed token (not enough segments)', () => {
  assert.throws(() => decodeIdTokenClaims('not-a-jwt'), /malformed id token/i)
})

test('decodeIdTokenClaims throws when the claims segment is not valid base64url JSON', () => {
  assert.throws(() => decodeIdTokenClaims('header.%%%not-base64%%%.sig'), /malformed id token/i)
})

test('decodeIdTokenClaims throws when both email and oid are missing', () => {
  const idToken = fakeIdToken({ name: 'No Identity Claims' })

  assert.throws(() => decodeIdTokenClaims(idToken), /missing both email and oid/i)
})

// --- refresh timing ---

test('tokenNeedsRefresh respects the skew window', () => {
  const now = 1_000_000

  assert.equal(tokenNeedsRefresh({ expiresAt: now + 3600 }, now), false)
  assert.equal(tokenNeedsRefresh({ expiresAt: now + 30 }, now), true)
  assert.equal(tokenNeedsRefresh({ expiresAt: now - 10 }, now), true)
  assert.equal(tokenNeedsRefresh({ expiresAt: 0 }, now), true)
})
