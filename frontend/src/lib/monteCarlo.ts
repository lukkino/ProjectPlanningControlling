// Simulazione Monte Carlo sul throughput storico (sezione Monte Carlo
// dell'increment). Metodo classico "alla Magennis": si campiona a caso,
// con reinserimento, il numero di item chiusi in un giorno qualsiasi dello
// storico e lo si ripete giorno per giorno nel futuro. Non serve alcuna
// stima degli item: conta solo quanti ne sono stati chiusi al giorno.
//
// Tutte le date sono in "epoch days" (vedi lib/dates), cosi' l'aritmetica
// sui giorni non risente di fuso orario/ora legale.

import type { CycleTimePoint } from '../api/types'
import { dateStrToEpochDays, epochDaysToDate } from './dates'

// Limite di sicurezza della simulazione "When": con uno storico quasi vuoto
// una singola prova potrebbe non chiudere mai gli item richiesti.
const MAX_SIMULATED_DAYS = 3650

// Giorni futuri in cui il team non lavora (ferie, chiusure: i NonWorkingDay
// dell'increment), in epoch days: la simulazione li salta come i weekend.
export type EpochDaysOff = ReadonlySet<number>
const NO_DAYS_OFF: EpochDaysOff = new Set()

// Parametri dello storico su cui si campiona il throughput. I default sono
// quelli della pagina Monte Carlo, usati anche da "Aggiungi simulazione" del
// Forecasting.
export type HistoryOptions = {
  issueTypes: string[]
  excludeCve: boolean
  historyDays: number
  workingDaysOnly: boolean
}
export const DEFAULT_HISTORY_OPTIONS: HistoryOptions = {
  issueTypes: ['Story', 'Bug'],
  excludeCve: true,
  historyDays: 365,
  workingDaysOnly: true,
}
export const DEFAULT_ITERATIONS = 10000

export type History = {
  itemCount: number
  samples: number[]
  perWeek: number
  p50: number | null
  p85: number | null
  p95: number | null
}

// Storico del throughput: i PBI Done (estrazione Cycle Time) dei tipi scelti
// chiusi negli historyDays giorni prima di oggi (today escluso).
export function buildHistory(points: CycleTimePoint[], options: HistoryOptions, today: number): History {
  const { issueTypes, excludeCve, historyDays, workingDaysOnly } = options
  const fromDay = today - historyDays
  const toDay = today - 1
  const inWindow = points.filter((p) => {
    if (!issueTypes.includes(p.issue_type) || (excludeCve && p.is_cve)) return false
    const d = dateStrToEpochDays(p.finish_date)
    return d !== null && d >= fromDay && d <= toDay
  })
  const finishDays = inWindow.map((p) => dateStrToEpochDays(p.finish_date) as number)
  const cycleTimes = inWindow.map((p) => p.cycle_time_days).sort((a, b) => a - b)
  return {
    itemCount: inWindow.length,
    samples: dailyThroughputSamples(finishDays, fromDay, toDay, workingDaysOnly),
    perWeek: (inWindow.length / historyDays) * 7,
    p50: interpolatedPercentile(cycleTimes, 50),
    p85: interpolatedPercentile(cycleTimes, 85),
    p95: interpolatedPercentile(cycleTimes, 95),
  }
}

// Previsione di un increment per la tabella Forecasting, partendo da startDay
// con remaining PBI ancora da chiudere e la scadenza del code freeze:
// - likelihood: % di prove "When" che chiudono tutto entro la scadenza;
// - date85: data "When" all'85% di confidenza;
// - date85WithHolidays: idem saltando anche i giorni non lavorativi del team;
// - howMany85: PBI chiusi entro la scadenza all'85% (cioe' "almeno N": il
//   15° percentile della distribuzione "How Many").
// Valori null quando non calcolabili (niente scadenza, nulla da chiudere...).
export type IncrementForecast = {
  likelihood: number | null
  date85: number | null
  date85WithHolidays: number | null
  howMany85: number | null
}

export function forecastIncrement(params: {
  samples: number[]
  remaining: number
  startDay: number
  deadlineDay: number | null
  iterations: number
  workingDaysOnly: boolean
  daysOff: EpochDaysOff
}): IncrementForecast {
  const { samples, remaining, startDay, deadlineDay, iterations, workingDaysOnly, daysOff } = params
  const hasDeadline = deadlineDay !== null && deadlineDay >= startDay
  let likelihood: number | null = null
  let date85: number | null = null
  let date85WithHolidays: number | null = null
  if (remaining > 0) {
    const when = simulateWhen(samples, remaining, startDay, iterations, workingDaysOnly)
    date85 = nearestRank(when, 85)
    date85WithHolidays = nearestRank(simulateWhen(samples, remaining, startDay, iterations, workingDaysOnly, daysOff), 85)
    if (deadlineDay !== null) likelihood = (when.filter((d) => d <= deadlineDay).length / when.length) * 100
  } else if (deadlineDay !== null) {
    likelihood = 100
  }
  const howMany85 = hasDeadline
    ? nearestRank(simulateHowMany(samples, startDay, deadlineDay, iterations, workingDaysOnly), 15)
    : null
  return { likelihood, date85, date85WithHolidays, howMany85 }
}

export function isWeekend(epochDay: number): boolean {
  const day = epochDaysToDate(epochDay).getUTCDay()
  return day === 0 || day === 6
}

// Item chiusi per ogni giorno della finestra [fromDay, toDay] (estremi
// inclusi), zeri compresi: i giorni senza chiusure sono parte essenziale
// della distribuzione. Con workingDaysOnly i weekend vengono esclusi, e la
// simulazione poi avanza solo sui giorni lavorativi.
export function dailyThroughputSamples(
  finishDays: number[],
  fromDay: number,
  toDay: number,
  workingDaysOnly: boolean,
): number[] {
  const counts = new Map<number, number>()
  for (const d of finishDays) counts.set(d, (counts.get(d) ?? 0) + 1)
  const samples: number[] = []
  for (let d = fromDay; d <= toDay; d++) {
    if (workingDaysOnly && isWeekend(d)) continue
    samples.push(counts.get(d) ?? 0)
  }
  return samples
}

function pick(samples: number[]): number {
  return samples[Math.floor(Math.random() * samples.length)]
}

// "When": per ogni prova, giorno (epoch day) in cui si chiude l'ultimo dei
// itemCount item partendo da startDay (incluso). Ordinato crescente. I
// daysOff non producono nulla, come i weekend.
export function simulateWhen(
  samples: number[],
  itemCount: number,
  startDay: number,
  iterations: number,
  workingDaysOnly: boolean,
  daysOff: EpochDaysOff = NO_DAYS_OFF,
): number[] {
  const results: number[] = []
  for (let i = 0; i < iterations; i++) {
    let done = 0
    let day = startDay - 1
    while (done < itemCount && day - startDay < MAX_SIMULATED_DAYS) {
      day++
      if ((workingDaysOnly && isWeekend(day)) || daysOff.has(day)) continue
      done += pick(samples)
    }
    results.push(day)
  }
  return results.sort((a, b) => a - b)
}

// "How Many": per ogni prova, item chiusi da startDay a endDay (inclusi).
// Ordinato crescente.
export function simulateHowMany(
  samples: number[],
  startDay: number,
  endDay: number,
  iterations: number,
  workingDaysOnly: boolean,
  daysOff: EpochDaysOff = NO_DAYS_OFF,
): number[] {
  let days = 0
  for (let d = startDay; d <= endDay; d++) {
    if (!(workingDaysOnly && isWeekend(d)) && !daysOff.has(d)) days++
  }
  const results: number[] = []
  for (let i = 0; i < iterations; i++) {
    let total = 0
    for (let d = 0; d < days; d++) total += pick(samples)
    results.push(total)
  }
  return results.sort((a, b) => a - b)
}

// Percentile "nearest rank" su valori gia' ordinati: restituisce sempre un
// valore realmente uscito dalla simulazione (una data o un conteggio
// intero), mai un'interpolazione.
export function nearestRank(sorted: number[], p: number): number {
  const rank = Math.ceil((p / 100) * sorted.length)
  return sorted[Math.min(sorted.length - 1, Math.max(0, rank - 1))]
}

// Percentile con interpolazione lineare, stesso metodo del backend
// (metrics._percentile), per i percentili del cycle time.
export function interpolatedPercentile(sorted: number[], p: number): number | null {
  if (sorted.length === 0) return null
  const k = (sorted.length - 1) * (p / 100)
  const f = Math.floor(k)
  const c = Math.ceil(k)
  if (f === c) return sorted[k]
  return sorted[f] * (c - k) + sorted[c] * (k - f)
}
