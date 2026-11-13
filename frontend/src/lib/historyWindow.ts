// Finestra storica del throughput (Monte Carlo e "Aggiungi simulazione" del
// Forecasting): ultimi N giorni, oppure da una data fissa a ieri (come in
// Actionable Agile: i dati piu' vecchi sono poco attendibili). L'ultima
// scelta resta nel browser, insieme agli altri parametri dello storico (tipi
// di item, CVE, giorni lavorativi): le due pagine usano sempre gli stessi.
import type { CycleTimeMetrics } from '../api/types'
import { formatIsoDate } from './dates'
import type { HistoryOptions } from './monteCarlo'

export const HISTORY_WINDOWS = [
  { days: 90, label: 'Ultimi 3 mesi' },
  { days: 180, label: 'Ultimi 6 mesi' },
  { days: 365, label: 'Ultimo anno' },
]

export type HistoryWindow = Pick<HistoryOptions, 'historyDays' | 'historyFrom'>

const STORAGE_KEY = 'mc-history-window-v1'

export function readStoredWindow(fallback: HistoryWindow): HistoryWindow {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null')
    if (parsed && typeof parsed === 'object') {
      const { historyDays, historyFrom } = parsed as Record<string, unknown>
      return {
        historyDays: typeof historyDays === 'number' && historyDays > 0 ? historyDays : fallback.historyDays,
        historyFrom: typeof historyFrom === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(historyFrom) ? historyFrom : null,
      }
    }
  } catch {
    // localStorage non disponibile o dato corrotto: default.
  }
  return fallback
}

const OPTIONS_KEY = 'mc-history-options-v1'

// Tutti i parametri dello storico, condivisi tra Monte Carlo e Forecasting.
export function readStoredOptions(fallback: HistoryOptions): HistoryOptions {
  const window = readStoredWindow(fallback)
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(OPTIONS_KEY) ?? 'null')
    if (parsed && typeof parsed === 'object') {
      const o = parsed as Record<string, unknown>
      return {
        issueTypes:
          Array.isArray(o.issueTypes) && o.issueTypes.every((t) => typeof t === 'string')
            ? (o.issueTypes as string[])
            : fallback.issueTypes,
        excludeCve: typeof o.excludeCve === 'boolean' ? o.excludeCve : fallback.excludeCve,
        workingDaysOnly: typeof o.workingDaysOnly === 'boolean' ? o.workingDaysOnly : fallback.workingDaysOnly,
        ...window,
      }
    }
  } catch {
    // localStorage non disponibile o dato corrotto: default.
  }
  return { ...fallback, ...window }
}

export function storeOptions(options: HistoryOptions) {
  storeWindow({ historyDays: options.historyDays, historyFrom: options.historyFrom ?? null })
  try {
    localStorage.setItem(
      OPTIONS_KEY,
      JSON.stringify({
        issueTypes: options.issueTypes,
        excludeCve: options.excludeCve,
        workingDaysOnly: options.workingDaysOnly,
      }),
    )
  } catch {
    // localStorage non disponibile: la scelta vale fino al ricaricamento.
  }
}

export function storeWindow(window: HistoryWindow) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(window))
  } catch {
    // localStorage non disponibile: la scelta vale fino al ricaricamento.
  }
}

export function windowLabel(window: HistoryWindow): string {
  if (window.historyFrom) return `dal ${formatIsoDate(window.historyFrom)}`
  return HISTORY_WINDOWS.find((w) => w.days === window.historyDays)?.label.toLowerCase() ?? `${window.historyDays} giorni`
}

// Avviso se i dati caricati non coprono l'inizio della finestra: es.
// estrazione Jira degli ultimi 12 mesi con la finestra dal 01/09/2025.
export function coverageWarning(data: CycleTimeMetrics | undefined, windowStartIso: string): string | null {
  if (!data) return null
  // Dati salvati prima che si registrasse data_from: la prima chiusura.
  const from =
    data.data_from ?? data.points.reduce<string | null>((min, p) => (!min || p.finish_date < min ? p.finish_date : min), null)
  if (!from || from <= windowStartIso) return null
  return (
    `I dati caricati partono dal ${formatIsoDate(from)}, la finestra dal ${formatIsoDate(windowStartIso)}: ` +
    (data.source
      ? 'carica un file che copra tutta la finestra, oppure aggiorna da Jira.'
      : 'premi "Aggiorna da Jira" per estrarre anche il periodo mancante.')
  )
}
