// Utility data condivise da tutta l'app: formattazione in italiano
// (gg/mm/aaaa) e conversione data<->"giorni da un epoch" usata dai grafici
// (Forecasting, Fasi progetto) per poter disegnare le date su un asse
// numerico condiviso con valori non-data (conteggi PBI, ecc.).

const EPOCH_UTC = Date.UTC(2020, 0, 1)
const MS_PER_DAY = 86_400_000

// Esportate (oltre che usate internamente qui) per chi deve costruire tick
// di calendario (es. mesi) a partire dallo stesso asse epoch-days, come la
// Dashboard progetti.
export function toEpochDays(d: Date): number {
  return Math.round((Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) - EPOCH_UTC) / MS_PER_DAY)
}

export function epochDaysToDate(days: number): Date {
  return new Date(EPOCH_UTC + days * MS_PER_DAY)
}

// "2026-10-15" -> "15/10/2026". Pura manipolazione di stringa (niente
// Date/fuso orario) per i campi Date veri, sempre in ISO yyyy-mm-dd.
// Ritorna null se il valore e' vuoto o non in quel formato.
export function formatIsoDate(value: string | null | undefined): string | null {
  if (!value) return null
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value)
  return m ? `${m[3]}/${m[2]}/${m[1]}` : null
}

// Data+ora dal backend (created_at, last_synced_at...): salvate in UTC ma
// serializzate senza fuso ("2026-09-23T15:29:50"), che new Date() leggerebbe
// come ora locale - in Italia risulterebbero 1-2 ore indietro. Si aggiunge
// la Z se manca un fuso esplicito.
export function parseBackendDateTime(value: string): Date {
  return new Date(/(Z|[+-]\d{2}:?\d{2})$/.test(value) ? value : `${value}Z`)
}

export function formatEpochDaysAsDate(days: number): string {
  const d = epochDaysToDate(days)
  const dd = String(d.getUTCDate()).padStart(2, '0')
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0')
  const yyyy = d.getUTCFullYear()
  return `${dd}/${mm}/${yyyy}`
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
// viene semplicemente omesso dal grafico (comportamento identico a una
// cella vuota in un grafico Excel).
export function dateStrToEpochDays(value: string | null): number | null {
  const d = parseFlexibleDate(value)
  return d ? toEpochDays(d) : null
}

// Giorni lavorativi (lun-ven, festivita' escluse) tra due date, estremi
// inclusi: usata per la colonna "Durata (gg)" del Backlog e per il grafico
// Sizing vs Durata della Dashboard increment. Restituisce null se una delle
// due date manca o se fine < inizio.
export function workingDaysBetween(startStr: string | null, endStr: string | null): number | null {
  if (!startStr || !endStr) return null
  const start = new Date(`${startStr}T00:00:00`)
  const end = new Date(`${endStr}T00:00:00`)
  if (end < start) return null

  let count = 0
  const cursor = new Date(start)
  while (cursor <= end) {
    const day = cursor.getDay() // 0 = domenica, 6 = sabato
    if (day !== 0 && day !== 6) count++
    cursor.setDate(cursor.getDate() + 1)
  }
  return count
}
