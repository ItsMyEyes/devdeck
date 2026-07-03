// React-query hooks for authentication endpoints.

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { fetchMe, login, logout, register, setupTotp, verifyTotp, verifyTotpSetup } from '@/lib/api'
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

export function useLogout() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: logout,
    onSuccess: () => queryClient.setQueryData(qk.me, undefined),
  })
}
