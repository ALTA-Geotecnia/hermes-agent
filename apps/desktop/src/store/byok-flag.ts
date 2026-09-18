import { atom } from 'nanostores'

/**
 * Launch-flag gate for every bring-your-own-key surface in the GUI (the Keys
 * tab and the Custom Endpoints tab under Settings → Providers).
 *
 * Inverted from `$localModelsEnabled`: BYOK ships enabled everywhere by
 * default, and only the ALTA corporate desktop build's main process reports
 * `byokEnabled: false` (see `hermes:launch-flags` in electron/main.ts). An
 * older preload, the web dashboard, or any non-Electron host therefore keeps
 * every BYOK surface. Read once from the preload bridge at module load; a
 * launch flag can't change mid-session, so nothing rewrites it outside tests.
 */
export const $byokEnabled = atom<boolean>(
  typeof window === 'undefined' || window.hermesDesktop?.byokEnabled !== false
)
