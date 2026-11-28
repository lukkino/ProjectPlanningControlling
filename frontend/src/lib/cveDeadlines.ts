import type { CveIssue } from '../api/types'
import { parseBackendDateTime } from './dates'

// Scadenze di risoluzione delle CVE in stato Confirmed, dalla data di
// conferma (ultimo passaggio a Confirmed in Jira) e dal CVSS Inpeco:
// - CVSS >= 9: entro 4 settimane;
// - CVSS > 7 e < 9: entro 24 settimane;
// - le altre Confirmed: da pianificare (nessuna scadenza).
// Le CVE non Confirmed (Done, Rejected...) non hanno scadenza.

export type CveTier = 'critical' | 'high' | 'plan'

export const CVE_TIERS: Record<CveTier, { label: string; weeks: number | null }> = {
  critical: { label: 'CVSS ≥ 9 · entro 4 settimane', weeks: 4 },
  high: { label: 'CVSS > 7 e < 9 · entro 24 settimane', weeks: 24 },
  plan: { label: 'Da pianificare', weeks: null },
}

export const CONFIRMED_STATUS = 'Confirmed'

// Punteggio usato per le regole: il CVSS Inpeco, o il base se manca.
export const cveScore = (c: CveIssue) => c.cvss_inpeco ?? c.cvss_base

export function cveTier(c: CveIssue): CveTier | null {
  if (c.status !== CONFIRMED_STATUS) return null
  const score = cveScore(c)
  if (score == null) return 'plan'
  if (score >= 9) return 'critical'
  if (score > 7) return 'high'
  return 'plan'
}

const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate())

// Scadenza (giorno locale) o null: non Confirmed, da pianificare o senza
// data di conferma (CVE lette prima che l'app la salvasse).
export function cveDueDate(c: CveIssue): Date | null {
  const tier = cveTier(c)
  const weeks = tier ? CVE_TIERS[tier].weeks : null
  if (weeks == null || !c.confirmed_at) return null
  const confirmed = startOfDay(parseBackendDateTime(c.confirmed_at))
  confirmed.setDate(confirmed.getDate() + weeks * 7)
  return confirmed
}

export const today = () => startOfDay(new Date())

export const formatDay = (d: Date) => d.toLocaleDateString('it-IT')

// Fasce di urgenza per l'ordinamento "per urgenza" della tabella: dalla
// piu' urgente (0) a quella senza scadenza. Ogni fascia ha il suo colore di
// riga (classe CSS cve-row-<key>).
export const CVE_URGENCY = [
  { key: 'overdue', label: 'Scadute' },
  { key: 'soon', label: 'Scadono entro 30 giorni' },
  { key: 'later', label: 'Con scadenza oltre 30 giorni' },
  { key: 'plan', label: 'Confirmed da pianificare' },
  { key: 'none', label: 'Senza scadenza (non Confirmed)' },
] as const

export function cveUrgency(c: CveIssue): number {
  const tier = cveTier(c)
  if (!tier) return 4
  if (tier === 'plan') return 3
  const due = cveDueDate(c)
  // Confirmed con fascia ma senza data di conferma: tra le scadenze lontane,
  // la colonna Scadenza mostra "?".
  if (!due) return 2
  const days = Math.round((due.getTime() - today().getTime()) / 86400000)
  if (days < 0) return 0
  if (days <= 30) return 1
  return 2
}
