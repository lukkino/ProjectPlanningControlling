import { api } from '../api/client'
import type { ForecastSimulation, Team } from '../api/types'
import { dateStrToEpochDays } from './dates'
import { buildHistory, forecastIncrement, type HistoryOptions } from './monteCarlo'

// Parametri Monte Carlo di una riga del Forecasting (colonna mc_params, JSON):
// con questi, la data di inizio (simulation_date) e i PBI rimanenti della
// riga le previsioni legate alla deadline si possono ricalcolare quando la
// deadline cambia.
export type McParams = {
  team: Team
  options: HistoryOptions
  iterations: number
  // Estrazione dello storico usata alla creazione e, se la riga e' stata
  // ricalcolata, quella usata nell'ultimo ricalcolo (puo' essere piu' nuova).
  historyFetchedAt: string | null
  recalculatedAt?: string
  recalcHistoryFetchedAt?: string | null
}

export function parseMcParams(value: string | null): McParams | null {
  if (!value) return null
  try {
    return JSON.parse(value) as McParams
  } catch {
    return null
  }
}

// Nuova deadline di una riga: Chance to meet the deadline e 85% #PBI entro la
// deadline ricalcolati con gli stessi parametri, data di inizio e PBI
// rimanenti, sullo storico salvato adesso. Le date all'85% non dipendono
// dalla deadline e restano quelle. null se la riga non ha i parametri (righe
// a mano) o manca lo storico: allora cambia solo la data.
export async function recalcForDeadline(
  sim: ForecastSimulation,
  deadline: string | null,
): Promise<Partial<ForecastSimulation> | null> {
  const params = parseMcParams(sim.mc_params)
  const startDay = dateStrToEpochDays(sim.simulation_date)
  if (!params || startDay === null || sim.pbi_remaining == null) return null
  const history = await api.dashboard.cycleTimeCached(params.team)
  if (!history) return null
  // Finestra storica riferita al giorno della simulazione, come alla creazione.
  const samples = buildHistory(history.points, params.options, startDay)
  if (samples.itemCount === 0) return null
  const forecast = forecastIncrement({
    samples: samples.samples,
    remaining: sim.pbi_remaining,
    startDay,
    deadlineDay: dateStrToEpochDays(deadline),
    iterations: params.iterations,
    workingDaysOnly: params.options.workingDaysOnly,
    daysOff: new Set(),
  })
  return {
    code_freeze_deadline: deadline,
    completion_likelihood: forecast.likelihood == null ? null : Math.round(forecast.likelihood * 100) / 100,
    pbi_completed_by_deadline_85pct: forecast.howMany85,
    mc_params: JSON.stringify({
      ...params,
      recalculatedAt: new Date().toISOString(),
      recalcHistoryFetchedAt: history.fetched_at,
    } satisfies McParams),
  }
}
