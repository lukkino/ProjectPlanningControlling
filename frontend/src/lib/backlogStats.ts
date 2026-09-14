import type { BacklogItem } from '../api/types'

// Conteggi condivisi tra BacklogPage (riga di stat in cima) e
// ForecastingPage (default di #PBI Remaining su una nuova simulazione).
export function countBacklogStats(items: BacklogItem[]) {
  const inScopeItems = items.filter((i) => i.in_scope)
  const doneCount = inScopeItems.filter((i) => i.status === 'Done').length
  const remainingCount = inScopeItems.length - doneCount
  return { inScopeCount: inScopeItems.length, doneCount, remainingCount }
}
