import type { ModelOptionsResult } from '@hermes/shared'
import { QueryClient, type QueryKey } from '@tanstack/react-query'

import { mergeModelLabels } from '@/lib/model-status-label'

// Shared React Query client. Lives in its own module (not main.tsx) so non-React
// code — e.g. the profile store on a gateway swap — can invalidate cached,
// profile-scoped settings without importing the app entry point.
export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      refetchOnWindowFocus: false,
      staleTime: 60_000
    }
  }
})

// Whichever surface happens to fetch `model-options` first (the catalog menu, the
// composer pill's own read, onboarding, …) feeds every OTHER surface a provider's
// display names via the shared registry in model-status-label.ts — one subscription
// here beats threading `model_labels` through every consumer of displayModelName.
queryClient.getQueryCache().subscribe(event => {
  if (event.type !== 'updated' && event.type !== 'added') {
    return
  }

  if (event.query.queryKey[0] !== 'model-options') {
    return
  }

  const data = event.query.state.data as ModelOptionsResult | undefined
  const labels: Record<string, string> = {}

  for (const provider of data?.providers ?? []) {
    Object.assign(labels, provider.model_labels ?? {})
  }

  mergeModelLabels(labels)
})

// Curried, setState-shaped cache writer for optimistic write-through: keeps
// mutation sites terse (`setX(next)` or `setX(prev => …)`) over one query key.
export const writeCache =
  <T>(key: QueryKey) =>
  (next: T | undefined | ((prev: T | undefined) => T | undefined)): void =>
    void queryClient.setQueryData<T>(key, next)

// Query-key roots that are NOT profile-scoped: account/billing, the theme
// marketplace, onboarding, and contrib log tails all read global or
// account-level state, so a profile/gateway swap must not refetch them. Any
// other key is treated as profile-scoped and invalidated -- a denylist is
// correctness-safe here: a root we forget to list just gets refetched (a small
// cost), whereas an allowlist that misses a profile-scoped key would paint the
// previous profile's data (a bug).
const PROFILE_INDEPENDENT_QUERY_ROOTS = new Set<string>([
  'billing',
  'public-catalog',
  'marketplace-themes',
  'marketplace-themes-settings',
  'onboarding-model-options',
  'contrib-logs-tail'
])

// Invalidate profile-scoped query caches on a profile / gateway switch, leaving
// account/global caches intact. Replaces a keyless invalidateQueries() that
// refetched everything (billing, marketplace, onboarding) on every switch.
export function invalidateProfileScopedQueries(): void {
  void queryClient.invalidateQueries({
    predicate: query => {
      const root = query.queryKey[0]

      return typeof root !== 'string' || !PROFILE_INDEPENDENT_QUERY_ROOTS.has(root)
    }
  })
}
