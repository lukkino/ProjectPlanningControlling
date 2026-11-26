import type { CSSProperties } from 'react'
import type { BacklogItem } from '../api/types'
import { countBacklogStats, trimmedMeanDuration } from '../lib/backlogStats'

// Box riassuntivi del backlog (PBI in Scope, Code Freeze, Done, Sviluppati,
// Rimanenti, Durata media): stessi conteggi nel Backlog e nella Dashboard.
export function BacklogStatChips({ items, style }: { items: BacklogItem[] | undefined; style?: CSSProperties }) {
  const { totalInScopeCount, codefreezeCount, doneCount, developedCount, remainingCount } = countBacklogStats(items ?? [])
  const avgDuration = trimmedMeanDuration(items ?? [])
  return (
    <div className="stat-chips" style={style}>
      <div className="stat-chip blue">
        <span className="value">{totalInScopeCount}</span>
        <span className="label">PBI in Scope</span>
      </div>
      <div className="stat-chip violet">
        <span className="value">{codefreezeCount}</span>
        <span className="label">PBI in Code Freeze</span>
      </div>
      <div className="stat-chip green">
        <span className="value">{doneCount}</span>
        <span className="label">Done</span>
      </div>
      {developedCount > 0 && (
        <div
          className="stat-chip green"
          title="Sviluppati entro il code freeze, chiusi dopo (colonna Sviluppato, chiusura in): contano come completati per il code freeze"
        >
          <span className="value">{developedCount}</span>
          <span className="label">Sviluppati, chiusura posticipata</span>
        </div>
      )}
      <div className="stat-chip orange">
        <span className="value">{remainingCount}</span>
        <span className="label">Rimanenti (In Progress + To Do)</span>
      </div>
      <div
        className="stat-chip teal"
        title={`Media della Durata effettiva (gg) dei PBI in scope chiusi, escludendo il valore più grande e quello più piccolo (${avgDuration.count} PBI con durata)`}
      >
        <span className="value">
          {avgDuration.mean != null ? avgDuration.mean.toLocaleString('it-IT', { maximumFractionDigits: 1 }) : '—'}
        </span>
        <span className="label">Durata media (gg, senza min/max)</span>
      </div>
    </div>
  )
}
