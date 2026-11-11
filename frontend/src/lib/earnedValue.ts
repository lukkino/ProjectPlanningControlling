import type { BacklogItem } from '../api/types'

// Stesse regole di backend/app/services/earned_value.py: budget = stima dev +
// test, altrimenti Sizing (gg) x 8 h; % completamento = Done 100%, altrimenti
// ore loggate / budget, al massimo 95% finche' non e' Done.
export const HOURS_PER_DAY = 8
export const MAX_OPEN_COMPLETION = 0.95

export function itemBudget(item: BacklogItem): number | null {
  const estimate = (item.dev_estimate_hours ?? 0) + (item.test_estimate_hours ?? 0)
  if (estimate > 0) return estimate
  if (item.planned_duration_days && item.planned_duration_days > 0) return item.planned_duration_days * HOURS_PER_DAY
  return null
}

export function itemCompletion(item: BacklogItem): number | null {
  if (item.status === 'Done') return 1
  const budget = itemBudget(item)
  if (!budget) return null
  return Math.min((item.logged_hours ?? 0) / budget, MAX_OPEN_COMPLETION)
}

// Semaforo di SPI/CPI: verde da 0,95, giallo da 0,85, rosso sotto.
export type EvTone = 'good' | 'warn' | 'bad' | ''
export function evTone(index: number | null): EvTone {
  if (index === null) return ''
  if (index >= 0.95) return 'good'
  if (index >= 0.85) return 'warn'
  return 'bad'
}

export const formatIndex = (v: number | null) => (v === null ? '—' : v.toFixed(2).replace('.', ','))
export const formatHours = (v: number | null) =>
  v === null ? '—' : `${Math.round(v).toLocaleString('it-IT')} h`
export const formatSignedHours = (v: number) =>
  `${v > 0 ? '+' : v < 0 ? '−' : ''}${Math.abs(Math.round(v)).toLocaleString('it-IT')} h`
export const formatPct = (v: number | null) => (v === null ? '—' : `${Math.round(v * 100)}%`)
