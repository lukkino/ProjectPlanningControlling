import type { ActivityPhase, BacklogItem, PhaseTemplate } from '../api/types'

// Attivita' di servizio (dopo il code freeze, finalizzate al rilascio), per
// fase dell'increment a cui servono ed entro cui vanno fatte. Nel Gantt sono
// tutte a strisce, ognuna col suo colore (stessi colori nella presentazione,
// services/presentation.py::ACTIVITY_PHASES).
export const ACTIVITY_PHASES: { value: ActivityPhase; label: string; phaseName: string; color: string }[] = [
  { value: 'execution', label: 'Execution', phaseName: 'execution', color: '#2f6fed' },
  { value: 'deployment', label: 'Deployment', phaseName: 'deployment', color: '#7c4dbd' },
  { value: 'release', label: 'Release to Market', phaseName: 'release to market', color: '#0f9d8a' },
  { value: 'medium_change', label: 'Medium Change', phaseName: 'medium change', color: '#0f9d8a' },
]

// Fasi disponibili per tipo di increment (stesse di models.REVIEW_TYPE_PHASES):
// Full Review = Execution, Deployment, Release to Market; Medium Change = la
// sola review di Medium Change. L'ultima prende anche gli altri PBI non del
// code freeze.
export const activityPhasesFor = (reviewType: PhaseTemplate | null | undefined) =>
  ACTIVITY_PHASES.filter((p) => (reviewType === 'medium_change' ? p.value === 'medium_change' : p.value !== 'medium_change'))

export const activityPhaseInfo = (item: Pick<BacklogItem, 'activity_phase' | 'is_activity'>) =>
  item.is_activity ? (ACTIVITY_PHASES.find((p) => p.value === item.activity_phase) ?? ACTIVITY_PHASES[0]) : null

// Nome di una fase dell'increment confrontabile con phaseName qui sopra
// ("Release-to-Market" -> "release to market").
export const normalizePhaseName = (name: string) => name.trim().toLowerCase().replace(/-/g, ' ')
