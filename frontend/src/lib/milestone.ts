import type { BacklogItem } from '../api/types'

// Milestone: item Jira (di solito un'Activity) con la label "Milestone".
// Nel Gantt e' un rombo su un giorno solo, fuori dal code freeze; si puo'
// collegare a una fase dell'increment (milestone_phase_id) e ne prende la
// data. Stessa regola di models.is_milestone nel backend.
export const isMilestone = (item: Pick<BacklogItem, 'labels'>): boolean =>
  (item.labels ?? '').split(';').some((label) => label.trim().toLowerCase() === 'milestone')
