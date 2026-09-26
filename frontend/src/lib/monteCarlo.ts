// Simulazione Monte Carlo sul throughput storico (sezione Monte Carlo
// dell'increment). Metodo classico "alla Magennis": si campiona a caso,
// con reinserimento, il numero di item chiusi in un giorno qualsiasi dello
// storico e lo si ripete giorno per giorno nel futuro. Non serve alcuna
// stima degli item: conta solo quanti ne sono stati chiusi al giorno.
//
// Tutte le date sono in "epoch days" (vedi lib/dates), cosi' l'aritmetica
// sui giorni non risente di fuso orario/ora legale.

import { epochDaysToDate } from './dates'

// Limite di sicurezza della simulazione "When": con uno storico quasi vuoto
// una singola prova potrebbe non chiudere mai gli item richiesti.
const MAX_SIMULATED_DAYS = 3650

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
// itemCount item partendo da startDay (incluso). Ordinato crescente.
export function simulateWhen(
  samples: number[],
  itemCount: number,
  startDay: number,
  iterations: number,
  workingDaysOnly: boolean,
): number[] {
  const results: number[] = []
  for (let i = 0; i < iterations; i++) {
    let done = 0
    let day = startDay - 1
    while (done < itemCount && day - startDay < MAX_SIMULATED_DAYS) {
      day++
      if (workingDaysOnly && isWeekend(day)) continue
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
): number[] {
  let days = 0
  for (let d = startDay; d <= endDay; d++) {
    if (!(workingDaysOnly && isWeekend(d))) days++
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
