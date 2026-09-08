// React-query hooks for authentication endpoints.

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  fetchAuthConfig,
  fetchMe,
  login,
  logout,
  register,
  setupTotp,
  updateAccount,
  verifyTotp,
  verifyTotpSetup,
} from '@/lib/api'
import { qk } from '@/features/data/keys'

/** Shared so the root route guard's ensureQueryData and useMe() behave identically. */
export const meQueryOptions = {
  queryKey: qk.me,
  queryFn: fetchMe,
  retry: false,
} as const

export function useMe() {
  return useQuery(meQueryOptions)
}

/** Public flow flags (e.g. whether the server requires TOTP; see --2fa). */
export function useAuthConfig() {
  return useQuery({ queryKey: qk.authConfig, queryFn: fetchAuthConfig, staleTime: Infinity })
}

export function useRegister() {
  return useMutation({ mutationFn: register })
}

export function useLogin() {
  return useMutation({ mutationFn: login })
}

export function useSetupTotp() {
  return useMutation({ mutationFn: setupTotp })
}

export function useVerifyTotpSetup() {
  return useMutation({ mutationFn: verifyTotpSetup })
}

export function useVerifyTotp() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: verifyTotp,
    onSuccess: (user) => queryClient.setQueryData(qk.me, user),
  })
}

/** Changes the operator's own sign-in email and/or password. The response is
 *  the updated account, so it seeds the cache directly rather than re-fetching
 *  — a password change has just revoked every *other* session, and this one
 *  stays valid. */
export function useUpdateAccount() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: updateAccount,
    onSuccess: (user) => queryClient.setQueryData(qk.me, user),
  })
}

export function useLogout() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: logout,
    onSuccess: () => queryClient.setQueryData(qk.me, undefined),
  })
}
