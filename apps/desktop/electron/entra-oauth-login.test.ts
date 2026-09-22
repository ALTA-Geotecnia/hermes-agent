/**
 * Tests for electron/entra-oauth-login.ts — the loopback-listener
 * orchestration of the mandatory Entra ID login gate, with all I/O injected
 * (fake http server, fake openExternal, fake token POST) so no real socket
 * or browser is needed.
 *
 * Run with: node --test electron/entra-oauth-login.test.ts
 */

import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'

import { test } from 'vitest'

import { ENTRA_CLIENT_ID, ENTRA_TENANT_ID } from './entra-login'
import { runEntraLogin } from './entra-oauth-login'

// A fake http.Server: captures the request handler, lets the test drive a
// synthetic browser callback, and records listen/close lifecycle. Mirrors
// native-oauth-login.test.ts's fake server factory.
function makeFakeServerFactory(port = 51235) {
  const state: any = { handler: null, listening: false, closed: false }

  const createServer: any = (handler: any) => {
    state.handler = handler
    const server: any = new EventEmitter()

    server.listen = (_port: number, _host: string, cb: () => void) => {
      state.listening = true
      cb()
    }

    server.address = () => ({ address: '127.0.0.1', family: 'IPv4', port })

    server.close = () => {
      state.closed = true
    }

    state.server = server

    return server
  }

  // Drive a synthetic browser hit to the loopback callback.
  state.hitCallback = (query: string) => {
    const res: any = { writeHead: () => undefined, end: () => undefined }

    state.handler({ url: `/callback?${query}` }, res)
  }

  return { createServer, state }
}

function fakeIdToken(claims: Record<string, unknown>): string {
  const b64url = (obj: unknown) =>
    Buffer.from(JSON.stringify(obj)).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')

  return `${b64url({ alg: 'RS256' })}.${b64url(claims)}.SIG`
}

test('runEntraLogin completes the loopback round trip and returns a session + identity', async () => {
  const { createServer, state } = makeFakeServerFactory()
  let capturedAuthorizeUrl = ''
  let tokenPostBody: any = null

  const idToken = fakeIdToken({ email: 'breno.manhaes@altageotecnia.com', oid: 'oid-1', name: 'Breno' })

  const promise = runEntraLogin({
    tenantId: ENTRA_TENANT_ID,
    clientId: ENTRA_CLIENT_ID,
    openExternal: async url => {
      capturedAuthorizeUrl = url
    },
    postForm: async (_url, body) => {
      tokenPostBody = body

      return { access_token: 'AT-entra', refresh_token: 'RT-entra', id_token: idToken, expires_in: 3600 }
    },
    createServer,
    timeoutMs: 5_000
  })

  // Give the listen callback a tick to open the browser + capture the URL.
  await new Promise(r => setTimeout(r, 5))

  const authorize = new URL(capturedAuthorizeUrl)

  assert.equal(authorize.hostname, 'login.microsoftonline.com')
  assert.equal(authorize.pathname, `/${ENTRA_TENANT_ID}/oauth2/v2.0/authorize`)
  assert.equal(authorize.searchParams.get('client_id'), ENTRA_CLIENT_ID)
  const stateParam = authorize.searchParams.get('state')
  assert.ok(stateParam)
  // Must be exactly `http://localhost:<port>` with no path — Entra ID's public-client
  // loopback exception (AADSTS50011 otherwise) only matches a redirect URI registered
  // as the literal `http://localhost`, ignoring the port; it does NOT extend that
  // leniency to `127.0.0.1` or to any path suffix.
  assert.match(authorize.searchParams.get('redirect_uri') || '', /^http:\/\/localhost:\d+$/)

  // Synthetic browser redirect back with the matching state + a code.
  state.hitCallback(`code=entra-code-1&state=${encodeURIComponent(stateParam!)}`)

  const { session, identity } = await promise

  assert.equal(session.accessToken, 'AT-entra')
  assert.equal(session.refreshToken, 'RT-entra')
  assert.equal(session.idToken, idToken)
  assert.equal(identity.email, 'breno.manhaes@altageotecnia.com')
  assert.equal(identity.oid, 'oid-1')
  // Token POST carried the code + a verifier whose hash matches the challenge
  // sent in the authorize URL.
  assert.equal(tokenPostBody.code, 'entra-code-1')
  assert.ok(tokenPostBody.code_verifier && tokenPostBody.code_verifier.length >= 43)
  assert.equal(tokenPostBody.grant_type, 'authorization_code')
  // Listener was cleaned up.
  assert.equal(state.closed, true)
})

test('runEntraLogin rejects on a state mismatch (CSRF) without redeeming', async () => {
  const { createServer, state } = makeFakeServerFactory()
  let tokenPostCalled = false

  const promise = runEntraLogin({
    tenantId: ENTRA_TENANT_ID,
    clientId: ENTRA_CLIENT_ID,
    openExternal: async () => undefined,
    postForm: async () => {
      tokenPostCalled = true

      return {}
    },
    createServer,
    timeoutMs: 5_000
  })

  await new Promise(r => setTimeout(r, 5))
  // Wrong state — must not redeem the code.
  state.hitCallback('code=evil&state=not-the-real-state')

  await assert.rejects(promise, /state mismatch/i)
  assert.equal(tokenPostCalled, false)
  assert.equal(state.closed, true)
})

test('runEntraLogin surfaces an Entra error param (e.g. user closed the browser mid-flow)', async () => {
  const { createServer, state } = makeFakeServerFactory()

  const promise = runEntraLogin({
    tenantId: ENTRA_TENANT_ID,
    clientId: ENTRA_CLIENT_ID,
    openExternal: async () => undefined,
    postForm: async () => ({}),
    createServer,
    timeoutMs: 5_000
  })

  await new Promise(r => setTimeout(r, 5))
  state.hitCallback('error=access_denied&error_description=user_declined')

  await assert.rejects(promise, /access_denied/i)
})

test('runEntraLogin rejects when the token exchange fails', async () => {
  const { createServer, state } = makeFakeServerFactory()
  let capturedState = ''

  const promise = runEntraLogin({
    tenantId: ENTRA_TENANT_ID,
    clientId: ENTRA_CLIENT_ID,
    openExternal: async url => {
      capturedState = new URL(url).searchParams.get('state') || ''
    },
    postForm: async () => {
      throw new Error('Entra token endpoint returned 400: invalid_grant')
    },
    createServer,
    timeoutMs: 5_000
  })

  await new Promise(r => setTimeout(r, 5))
  state.hitCallback(`code=c&state=${encodeURIComponent(capturedState)}`)

  await assert.rejects(promise, /invalid_grant/i)
})

test('runEntraLogin rejects a malformed id_token instead of returning a half-formed identity', async () => {
  const { createServer, state } = makeFakeServerFactory()
  let capturedState = ''

  const promise = runEntraLogin({
    tenantId: ENTRA_TENANT_ID,
    clientId: ENTRA_CLIENT_ID,
    openExternal: async url => {
      capturedState = new URL(url).searchParams.get('state') || ''
    },
    postForm: async () => ({ access_token: 'AT', id_token: 'not-a-jwt', expires_in: 3600 }),
    createServer,
    timeoutMs: 5_000
  })

  await new Promise(r => setTimeout(r, 5))
  state.hitCallback(`code=c&state=${encodeURIComponent(capturedState)}`)

  await assert.rejects(promise, /malformed id token/i)
})

test('runEntraLogin times out when no callback arrives', async () => {
  const { createServer } = makeFakeServerFactory()

  await assert.rejects(
    runEntraLogin({
      tenantId: ENTRA_TENANT_ID,
      clientId: ENTRA_CLIENT_ID,
      openExternal: async () => undefined,
      postForm: async () => ({}),
      createServer,
      timeoutMs: 20
    }),
    /timed out/i
  )
})

test('runEntraLogin fails if the browser cannot be opened', async () => {
  const { createServer } = makeFakeServerFactory()

  await assert.rejects(
    runEntraLogin({
      tenantId: ENTRA_TENANT_ID,
      clientId: ENTRA_CLIENT_ID,
      openExternal: async () => {
        throw new Error('no browser')
      },
      postForm: async () => ({}),
      createServer,
      timeoutMs: 5_000
    }),
    /could not open the system browser/i
  )
})
