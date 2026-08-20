import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { qk } from '@/features/data/keys'
import { fetchCompletionsConfig, updateCompletionsConfig, type CompletionsConfigPatch } from '@/lib/api'

export function useCompletionsConfig() {
  return useQuery({ queryKey: qk.completions, queryFn: fetchCompletionsConfig })
}

export function useUpdateCompletionsConfig() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (patch: CompletionsConfigPatch) => updateCompletionsConfig(patch),
    onSuccess: (data) => {
      queryClient.setQueryData(qk.completions, data)
    },
  })
}
