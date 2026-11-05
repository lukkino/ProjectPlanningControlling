import { useMutation, useQueryClient } from '@tanstack/react-query'
import { api } from '../api/client'

// Elementi da mostrare nella sidebar: quelli fissati (📌 dalle pagine
// elenco Progetti e Increment), altrimenti i piu' recenti modificati. Quello
// aperto in questo momento resta sempre visibile.
export const SIDEBAR_RECENT_COUNT = 5

export function sidebarItems<T extends { id: number; code: string; sidebar_pinned: boolean; updated_at: string }>(
  items: T[] | undefined,
  activeId: number | null,
): { shown: T[]; pinnedMode: boolean } {
  if (!items) return { shown: [], pinnedMode: false }
  const pinned = items.filter((i) => i.sidebar_pinned).sort((a, b) => a.code.localeCompare(b.code))
  const pinnedMode = pinned.length > 0
  const shown = pinnedMode
    ? pinned
    : [...items].sort((a, b) => b.updated_at.localeCompare(a.updated_at)).slice(0, SIDEBAR_RECENT_COUNT)
  const active = activeId === null ? undefined : items.find((i) => i.id === activeId)
  if (active && !shown.includes(active)) shown.push(active)
  return { shown, pinnedMode }
}

// Fissa/sgancia nella sidebar, con aggiornamento immediato della lista.
export function usePinMutation(kind: 'projects' | 'increments') {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ id, pinned }: { id: number; pinned: boolean }) =>
      kind === 'projects' ? api.projects.setPinned(id, pinned) : api.increments.setPinned(id, pinned),
    onMutate: ({ id, pinned }) => {
      queryClient.setQueryData<{ id: number; sidebar_pinned: boolean }[]>([kind], (old) =>
        old?.map((i) => (i.id === id ? { ...i, sidebar_pinned: pinned } : i)),
      )
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: [kind] }),
  })
}
