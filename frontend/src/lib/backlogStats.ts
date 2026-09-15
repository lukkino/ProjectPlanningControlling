import type { BacklogItem } from '../api/types'

// Conteggi condivisi tra BacklogPage (riga di stat in cima), ForecastingPage
// (default di #PBI Remaining su una nuova simulazione) e SnapshotsPage
// (default di PBI totali/Done/ore loggate su un nuovo snapshot).
export function countBacklogStats(items: BacklogItem[]) {
  // Due totali distinti perche' si usano per scopi diversi: "in scope" e'
  // l'intero perimetro del progetto, "code freeze" e' il sottoinsieme che
  // impatta davvero il team di sviluppo (in scope, ma non escluso col
  // flag "Incluso in codefreeze"). Done/Rimanenti si basano sul secondo,
  // perche' e' quello rilevante per l'avanzamento del team.
  const totalInScopeCount = items.filter((i) => i.in_scope).length
  const codefreezeItems = items.filter((i) => i.in_scope && i.included_in_codefreeze)
  const doneCount = codefreezeItems.filter((i) => i.status === 'Done').length
  const remainingCount = codefreezeItems.length - doneCount
  // Somma su TUTTI gli item (non solo in-scope), coerente con la stat "Ore
  // loggate" della Dashboard (backend/app/services/metrics.py).
  const loggedHoursTotal = items.reduce((sum, i) => sum + (i.logged_hours ?? 0), 0)
  return {
    totalInScopeCount,
    codefreezeCount: codefreezeItems.length,
    doneCount,
    remainingCount,
    loggedHoursTotal,
  }
}

function hasLabel(labels: string | null, label: string): boolean {
  if (!labels) return false
  return labels
    .split(';')
    .map((l) => l.trim().toLowerCase())
    .includes(label)
}

// Per una nuova simulazione di Forecasting: PBI Done IN SCOPE dalla data di
// inizio sviluppi effettivo in poi, divisi per label (stesso filtro in_scope
// di countBacklogStats, cosi' i due conteggi restano coerenti). Se un item
// ha sia "oos" che "planned" vince "oos" (e' comunque lavoro non
// pianificato); un item senza nessuna delle due label non viene contato in
// nessuna delle due colonne.
export function countPlannedUnplannedDone(items: BacklogItem[], sinceDate: string | null) {
  const plannedKeys: string[] = []
  const unplannedKeys: string[] = []
  for (const item of items) {
    if (!item.in_scope || !item.included_in_codefreeze || item.status !== 'Done' || !item.actual_finish) continue
    if (sinceDate && item.actual_finish < sinceDate) continue
    if (hasLabel(item.labels, 'oos')) unplannedKeys.push(item.jira_key)
    else if (hasLabel(item.labels, 'planned')) plannedKeys.push(item.jira_key)
  }
  return { planned: plannedKeys.length, unplanned: unplannedKeys.length, plannedKeys, unplannedKeys }
}
