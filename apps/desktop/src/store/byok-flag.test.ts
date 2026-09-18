import { beforeEach, describe, expect, it, vi } from 'vitest'

describe('$byokEnabled', () => {
  beforeEach(() => {
    vi.resetModules()
  })

  it('defaults to true when the bridge omits the flag (older preload, web)', async () => {
    Object.defineProperty(window, 'hermesDesktop', {
      configurable: true,
      value: {}
    })

    const { $byokEnabled } = await import('./byok-flag')

    expect($byokEnabled.get()).toBe(true)
  })

  it('defaults to true with no bridge at all', async () => {
    Object.defineProperty(window, 'hermesDesktop', {
      configurable: true,
      value: undefined
    })

    const { $byokEnabled } = await import('./byok-flag')

    expect($byokEnabled.get()).toBe(true)
  })

  it('reads false when the ALTA desktop build reports byokEnabled: false', async () => {
    Object.defineProperty(window, 'hermesDesktop', {
      configurable: true,
      value: { byokEnabled: false }
    })

    const { $byokEnabled } = await import('./byok-flag')

    expect($byokEnabled.get()).toBe(false)
  })

  it('stays true when the bridge explicitly reports byokEnabled: true', async () => {
    Object.defineProperty(window, 'hermesDesktop', {
      configurable: true,
      value: { byokEnabled: true }
    })

    const { $byokEnabled } = await import('./byok-flag')

    expect($byokEnabled.get()).toBe(true)
  })
})
