/**
 * entra-token-store.ts
 *
 * The encrypted-at-rest persistence seam for the mandatory ALTA Entra ID
 * login gate: EntraSession → JSON → safeStorage blob → one store file, and
 * back again on the next launch.
 *
 * Unlike native-token-store.ts (a map of gateway base URL → token set — the
 * desktop can be pointed at many different self-hosted gateways over time),
 * there is exactly ONE Entra session for the whole app: one desktop install,
 * one signed-in Microsoft account. So the store file holds a single
 * encrypted blob directly, not a map keyed by anything.
 *
 * Kept standalone (no `import 'electron'`) so the whole restart path
 * unit-tests with plain vitest — same pattern as native-token-store.ts.
 * main.ts owns the electron-coupled halves and injects them: the safeStorage
 * encrypt/decrypt pair and the userData store-file read/write.
 *
 * The parser direction is the load-bearing detail, exactly as in
 * native-token-store.ts (see its #73271 comment): what lands on disk is the
 * *normalized* camelCase EntraSession, so the reload boundary is
 * parseStoredEntraSession(), never parseTokenResponse().
 */

import { type EntraSession, parseStoredEntraSession } from './entra-login'

/** The single encrypted blob as written to the store file. */
export interface EntraStoredSecret {
  encoding?: string
  value?: string
}

/**
 * The narrow set of side effects main.ts owns. Everything here is injected so
 * the store/load round trip can be exercised without an Electron runtime, and
 * so production keeps using safeStorage unchanged.
 */
export interface EntraTokenStoreIo {
  /**
   * Encrypt one plaintext blob. main.ts passes the strict safeStorage helper,
   * which THROWS when the OS keychain is unavailable — that must stay loud.
   * A `null` return is treated as the same authoritative failure: the caller
   * throws rather than persisting an empty entry over a good session.
   */
  encrypt: (plaintext: string) => EntraStoredSecret | null
  /** Decrypt a stored payload; returns '' when it cannot be read. */
  decrypt: (secret: any) => string
  /** Raw store-file text. Throws when the file is absent — treated as empty. */
  readStoreText: () => string
  /** Persist the store-file text (main.ts writes mode 0600 under userData). */
  writeStoreText: (text: string) => void
  rememberLog?: (message: string) => void
}

/**
 * The store-file text, or '' when it is missing/unreadable. A failed *read*
 * reads as empty rather than throwing — matches readStore() in
 * native-token-store.ts.
 */
function readRawStoreText(io: EntraTokenStoreIo): string {
  try {
    return io.readStoreText()
  } catch {
    return ''
  }
}

/**
 * Write (or, with `session === null`, clear) the one stored Entra session.
 */
export function persistEntraSession(session: EntraSession | null, io: EntraTokenStoreIo): void {
  if (!session) {
    try {
      io.writeStoreText('')
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)

      io.rememberLog?.(`[entra-login] failed to clear stored entra session: ${detail}`)
    }

    return
  }

  // Encrypt the whole session as one blob so the refresh token never lands in
  // plaintext on disk. Deliberately outside the try below: an unusable
  // keychain is an authoritative write failure and must surface to the
  // caller, not be logged away as if the session were saved.
  const secret = io.encrypt(JSON.stringify(session))

  if (!secret) {
    // A null blob is the same failure as a throw, only quieter. Storing it
    // would replace a good entry with nothing: the write would report
    // success, the next launch would show signed out, and the refresh token
    // would be unrecoverable. Fail before touching the store.
    throw new Error(
      'Secure token storage returned no encrypted payload; refusing to overwrite the stored entra session.'
    )
  }

  try {
    io.writeStoreText(JSON.stringify(secret))
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)

    io.rememberLog?.(`[entra-login] failed to persist entra session: ${detail}`)
  }
}

/**
 * Reconstruct the stored Entra session from the encrypted payload. Returns
 * null when nothing is stored, when the blob cannot be decrypted, or when it
 * does not parse — never a partially-populated session.
 */
export function loadEntraSession(io: EntraTokenStoreIo): EntraSession | null {
  const raw = readRawStoreText(io)

  if (!raw) {
    return null
  }

  let secret: any

  try {
    secret = JSON.parse(raw)
  } catch {
    return null
  }

  if (!secret || typeof secret !== 'object' || Array.isArray(secret)) {
    return null
  }

  try {
    const plaintext = io.decrypt(secret)

    if (!plaintext) {
      // A keychain that is merely locked/unavailable right now must not cost
      // the user their refresh token — leave the entry for the next attempt.
      io.rememberLog?.('[entra-login] failed to decrypt stored entra session; keeping stored entry for retry')

      return null
    }

    // The stored blob is a normalized camelCase session, never a raw Entra
    // token-endpoint response.
    return parseStoredEntraSession(JSON.parse(plaintext))
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)

    io.rememberLog?.(`[entra-login] failed to load stored entra session: ${detail}`)

    return null
  }
}
