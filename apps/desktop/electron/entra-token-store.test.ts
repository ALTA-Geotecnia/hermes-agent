/**
 * Tests for electron/entra-token-store.ts — the encrypted-at-rest
 * persistence seam for the mandatory ALTA Entra ID login gate.
 *
 * Unlike native-token-store.ts (keyed by gateway base URL — many possible
 * remote gateways), this store holds exactly ONE session for the whole app:
 * there is only ever one signed-in Microsoft account per desktop install.
 *
 * "Fresh load" here means what it means after a restart: nothing survives
 * but the bytes of the store file, so every assertion below is served by
 * deserializing and decrypting that text — never by an in-memory object.
 *
 * (Wired into the vitest `electron` project via electron/**\/*.test.ts.)
 */

import assert from 'node:assert/strict'

import { test } from 'vitest'

import { type EntraSession, parseStoredEntraSession, parseTokenResponse } from './entra-login'
import { type EntraTokenStoreIo, loadEntraSession, persistEntraSession } from './entra-token-store'

const SESSION: EntraSession = {
  accessToken: 'AT-live-abc123',
  refreshToken: 'RT-live-xyz789',
  idToken: 'ID-live-header.payload.sig',
  expiresAt: 1_893_456_000
}

interface FakeDisk {
  io: EntraTokenStoreIo
  logs: string[]
  /** The store-file text as it would sit on disk; null when the file is absent. */
  fileText: () => string | null
}

/**
 * A stand-in for the userData store file plus safeStorage. Encryption is
 * base64 rather than the OS keychain — opaque-blob-in, same-plaintext-out is
 * the only property this seam depends on. `initialText` models a process
 * restart: the new "process" starts with nothing but the bytes the previous
 * one wrote.
 */
function createFakeDisk(initialText: string | null = null, overrides: Partial<EntraTokenStoreIo> = {}): FakeDisk {
  let text = initialText
  const logs: string[] = []

  const io: EntraTokenStoreIo = {
    encrypt: plaintext => ({ encoding: 'safeStorage', value: Buffer.from(plaintext, 'utf8').toString('base64') }),
    decrypt: secret =>
      secret?.encoding === 'safeStorage' ? Buffer.from(String(secret.value), 'base64').toString('utf8') : '',
    readStoreText: () => {
      if (text === null) {
        // Matches fs.readFileSync on a missing file: throws, not empty string.
        throw Object.assign(new Error('ENOENT: no such file or directory'), { code: 'ENOENT' })
      }

      return text
    },
    writeStoreText: next => {
      text = next
    },
    rememberLog: message => logs.push(message),
    ...overrides
  }

  return { io, logs, fileText: () => text }
}

// --- the restart round trip ---

test('a session survives store then a fresh load', () => {
  const first = createFakeDisk()

  persistEntraSession(SESSION, first.io)

  const onDisk = first.fileText()

  assert.ok(onDisk, 'persisting must write the store file')

  // Nothing may survive the "restart" except those bytes.
  const restarted = createFakeDisk(onDisk)
  const loaded = loadEntraSession(restarted.io)

  assert.ok(loaded, 'a stored session must reload after a restart')
  // Reconstructed from the payload, not handed back the object we stored.
  assert.notEqual(loaded, SESSION)
  assert.deepEqual(loaded, SESSION)
  assert.deepEqual(restarted.logs, [])
})

test('a fresh load restores the access token, refresh token, id token and expiry', () => {
  const first = createFakeDisk()

  persistEntraSession(SESSION, first.io)

  const loaded = loadEntraSession(createFakeDisk(first.fileText()).io)!

  assert.equal(loaded.accessToken, 'AT-live-abc123')
  assert.equal(loaded.refreshToken, 'RT-live-xyz789')
  assert.equal(loaded.idToken, 'ID-live-header.payload.sig')
  // Still a number after the JSON round trip, not a string.
  assert.equal(loaded.expiresAt, 1_893_456_000)
  assert.equal(typeof loaded.expiresAt, 'number')
})

test('the loaded session is accepted by the stored-session parsing boundary', () => {
  const first = createFakeDisk()

  persistEntraSession(SESSION, first.io)

  const loaded = loadEntraSession(createFakeDisk(first.fileText()).io)!

  // What comes back out of the store is itself a valid stored session — a
  // second parse is a no-op, so callers can hand it straight to the refresh
  // path.
  assert.deepEqual(parseStoredEntraSession(loaded), loaded)
})

test('the login-to-restart sequence keeps the two parser boundaries apart', () => {
  // Login: Microsoft answers /oauth2/v2.0/token in snake_case, and only
  // parseTokenResponse() understands that shape (mirrors the #73271 guard in
  // native-token-store.test.ts).
  const fromEntra = parseTokenResponse(
    { access_token: 'AT-fresh', refresh_token: 'RT-fresh', id_token: 'ID-fresh', expires_in: 3600 },
    1_000_000
  )

  const first = createFakeDisk()

  persistEntraSession(fromEntra, first.io)

  // Restart: what was stored is normalized, so the store's own boundary reads
  // it back unchanged.
  assert.deepEqual(loadEntraSession(createFakeDisk(first.fileText()).io), fromEntra)
})

// --- storage hygiene ---

test('the session is encrypted at rest, never plaintext in the store file', () => {
  const disk = createFakeDisk()

  persistEntraSession(SESSION, disk.io)

  const onDisk = disk.fileText()!

  assert.doesNotMatch(onDisk, /AT-live-abc123/)
  assert.doesNotMatch(onDisk, /RT-live-xyz789/)
  assert.equal(JSON.parse(onDisk).encoding, 'safeStorage')
})

test('clearing the session (null) removes it and a fresh load reads as signed out', () => {
  const disk = createFakeDisk()

  persistEntraSession(SESSION, disk.io)
  assert.ok(loadEntraSession(createFakeDisk(disk.fileText()).io))

  persistEntraSession(null, disk.io)

  const restarted = createFakeDisk(disk.fileText())

  assert.equal(loadEntraSession(restarted.io), null)
  assert.deepEqual(restarted.logs, [])
})

test('an absent store file loads as signed out without logging a failure', () => {
  const disk = createFakeDisk()

  assert.equal(loadEntraSession(disk.io), null)
  assert.deepEqual(disk.logs, [])
})

test('a corrupt store file loads as signed out instead of throwing', () => {
  const disk = createFakeDisk('{not json')

  assert.equal(loadEntraSession(disk.io), null)
  assert.deepEqual(disk.logs, [])
})

test('an array store file loads as signed out instead of throwing', () => {
  const disk = createFakeDisk('[]')

  assert.equal(loadEntraSession(disk.io), null)
  assert.deepEqual(disk.logs, [])
})

// --- failure paths ---

test('a locked keychain keeps the stored entry for a later retry', () => {
  const first = createFakeDisk()

  persistEntraSession(SESSION, first.io)

  // safeStorage unavailable at load time ⇒ decryptDesktopSecret returns ''.
  const locked = createFakeDisk(first.fileText(), { decrypt: () => '' })

  assert.equal(loadEntraSession(locked.io), null)
  assert.match(locked.logs[0], /failed to decrypt stored entra session/i)
  assert.match(locked.logs[0], /keeping stored entry for retry/i)
  // The refresh token must NOT be dropped just because the keychain was locked.
  assert.equal(locked.fileText(), first.fileText())
})

test('a corrupt decrypted blob is reported and loads as signed out', () => {
  const disk = createFakeDisk(JSON.stringify({ encoding: 'safeStorage', value: 'bm90LWpzb24=' }))

  assert.equal(loadEntraSession(disk.io), null)
  assert.match(disk.logs[0], /failed to load stored entra session/i)
})

test('a decrypted blob missing accessToken is rejected, not half-restored', () => {
  const plaintext = JSON.stringify({ refreshToken: 'RT-only', idToken: 'ID-only' })

  const disk = createFakeDisk(
    JSON.stringify({ encoding: 'safeStorage', value: Buffer.from(plaintext).toString('base64') })
  )

  assert.equal(loadEntraSession(disk.io), null)
  assert.match(disk.logs[0], /missing accessToken/i)
})

test('a non-Error decryption failure keeps its detail in the log', () => {
  const disk = createFakeDisk(JSON.stringify({ encoding: 'safeStorage', value: 'AAAA' }), {
    decrypt: () => {
      throw 'keychain exploded'
    }
  })

  assert.equal(loadEntraSession(disk.io), null)
  assert.match(disk.logs[0], /keychain exploded/)
})

test('an unwritable store file is logged rather than thrown', () => {
  const disk = createFakeDisk(null, {
    writeStoreText: () => {
      throw new Error('EACCES: permission denied')
    }
  })

  assert.doesNotThrow(() => persistEntraSession(SESSION, disk.io))
  assert.match(disk.logs[0], /failed to persist entra session: EACCES/i)
})

test('an unusable keychain fails the write loudly and writes nothing', () => {
  const existing = createFakeDisk()

  persistEntraSession(SESSION, existing.io)

  const before = existing.fileText()

  const broken = createFakeDisk(before, {
    encrypt: () => {
      throw new Error('Secure token storage is unavailable')
    }
  })

  // Storing must not pretend to succeed when the session cannot be encrypted...
  assert.throws(() => persistEntraSession({ ...SESSION, accessToken: 'AT-new' }, broken.io), /unavailable/)
  // ...and must not clobber the session already on disk.
  assert.equal(broken.fileText(), before)
})

test('an encrypt that returns null is refused rather than blanking the stored session', () => {
  const existing = createFakeDisk()

  persistEntraSession(SESSION, existing.io)

  const before = existing.fileText()
  const nulled = createFakeDisk(before, { encrypt: () => null })
  let writes = 0

  // Spy that still delegates, so a stray write would show up in BOTH the
  // counter and the file text.
  const io = {
    ...nulled.io,
    writeStoreText: (text: string) => {
      writes += 1
      nulled.io.writeStoreText(text)
    }
  }

  // A quiet null is the same failure as a throw and must be just as loud.
  assert.throws(
    () => persistEntraSession({ ...SESSION, accessToken: 'AT-new' }, io),
    /refusing to overwrite the stored entra session/i
  )
  assert.equal(writes, 0, 'the store file must not be written at all')
  assert.equal(nulled.fileText(), before)
  // ...and the original session still loads, refresh token intact.
  assert.deepEqual(loadEntraSession(createFakeDisk(before).io), SESSION)
})
