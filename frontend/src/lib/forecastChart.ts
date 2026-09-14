// Helpers per il grafico di Forecasting: le tre linee (Code Freeze Deadline,
// Monte Carlo 85% Forecast, Traditional Forecasting) sono date, ma per
// disegnarle su un asse numerico (necessario per condividere il grafico con
// le barre impilate dei conteggi PBI) le convertiamo in "giorni da un
// epoch" e le riformattiamo come data per gli assi/etichette.

const EPOCH_UTC = Date.UTC(2020, 0, 1)
const MS_PER_DAY = 86_400_000

function toEpochDays(d: Date): number {
  return Math.round((Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) - EPOCH_UTC) / MS_PER_DAY)
}

function epochDaysToDate(days: number): Date {
  return new Date(EPOCH_UTC + days * MS_PER_DAY)
}

export function formatEpochDaysAsDate(days: number): string {
  const d = epochDaysToDate(days)
  const dd = String(d.getUTCDate()).padStart(2, '0')
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0')
  const yy = String(d.getUTCFullYear()).slice(-2)
  return `${dd}/${mm}/${yy}`
}

// I campi Date veri (code_freeze_deadline, completion_date_85pct...) sono
// sempre in ISO yyyy-mm-dd. "Traditional Forecasting" e' invece testo
// libero (puo' contenere "n.a."): accettiamo anche gg/mm/aaaa.
function parseFlexibleDate(value: string | null): Date | null {
  if (!value) return null
  const trimmed = value.trim()
  const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(trimmed)
  if (iso) return new Date(Date.UTC(Number(iso[1]), Number(iso[2]) - 1, Number(iso[3])))
  const eu = /^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/.exec(trimmed)
  if (eu) {
    let year = Number(eu[3])
    if (year < 100) year += 2000
    return new Date(Date.UTC(year, Number(eu[2]) - 1, Number(eu[1])))
  }
  return null
}

// null se il testo e' vuoto, "n.a." o non riconoscibile come data: il punto
// viene semplicemente omesso dalla linea (comportamento identico a una
// cella vuota in un grafico Excel).
export function dateStrToEpochDays(value: string | null): number | null {
  const d = parseFlexibleDate(value)
  return d ? toEpochDays(d) : null
}

// Solo per l'etichetta sull'asse X (simulation_date e' sempre ISO): niente
// Date/epoch, pura manipolazione di stringa per evitare insidie di fuso orario.
export function formatIsoDateShort(value: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value)
  if (!m) return value
  return `${m[3]}/${m[2]}/${m[1].slice(2)}`
}
