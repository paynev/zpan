/**
 * Single-admin builds have no licensing or feature gating: every capability is
 * available. The hook keeps its original shape so feature panels still compile.
 */

export const entitlementQueryKey = ['licensing', 'entitlements'] as const
export const licenseBindingQueryKey = ['licensing', 'binding'] as const

export interface EntitlementState {
  bound: boolean
  active: boolean
  edition: 'pro' | 'business' | null
  licenseId: string | null
  cloudDashboardUrl: string | null
  hasFeature: (name: string) => boolean
  isLoading: boolean
  isError: boolean
}

export function useEntitlement(): EntitlementState {
  return {
    bound: false,
    active: false,
    edition: null,
    licenseId: null,
    cloudDashboardUrl: null,
    hasFeature: () => true,
    isLoading: false,
    isError: false,
  }
}
