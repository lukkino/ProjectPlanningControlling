import { useQuery } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import { api } from '../api/client'
import type { CoReviewRow, CoTargetRow } from '../api/types'

// Riepilogo del Change Order in cima a Documents: Status e, dalle griglie
// del pannello del CO lette insieme allo Status (GET .../change-order/details),
// chi ha gia' valutato e chi manca. In Execution conta la valutazione dei
// reparti (Departments Targets), in Review i revisori (Row Review).

// Numero della fase in testa allo stato del portale ("06-Review" -> 6).
const phaseNumber = (value: string | null | undefined) => {
  const n = parseInt(value ?? '', 10)
  return Number.isNaN(n) ? null : n
}
const stripPhase = (value: string | null | undefined) => (value ?? '').replace(/^\d+\s*-\s*/, '') || '—'

// Righe dei reparti: prima di "03-..." (Not Involved, Involved...) il
// reparto non ha ancora valutato l'impatto.
const targetEvaluated = (row: CoTargetRow) => (phaseNumber(row.row_status) ?? 0) >= 3
const targetTone = (row: CoTargetRow) => {
  const n = phaseNumber(row.row_status) ?? 0
  if (n < 3) return 'todo'
  if (n === 3) return 'ready'
  if (n === 5) return 'progress'
  return 'done'
}
// Revisori: 01-Not Start, 02-Pending (tocca a lui), 04-Completed.
const reviewTone = (row: CoReviewRow) => {
  const s = (row.status ?? '').toLowerCase()
  if (/complet|approv|done/.test(s)) return 'done'
  if (/reject/.test(s)) return 'rda-rejected'
  if (/pending|progress/.test(s)) return 'progress'
  return 'todo'
}

function NameList({ label, names, tone }: { label: string; names: ReactNode[]; tone: string }) {
  if (names.length === 0) return null
  return (
    <div className="co-overview-line">
      <span className={`badge ${tone}`}>
        {label} ({names.length})
      </span>
      <span>
        {names.map((n, i) => (
          <span key={i}>
            {i > 0 && ', '}
            {n}
          </span>
        ))}
      </span>
    </div>
  )
}

function ReviewSummary({ reviews }: { reviews: CoReviewRow[] }) {
  const sorted = [...reviews].sort((a, b) => (Number(a.order) || 99) - (Number(b.order) || 99))
  const who = (r: CoReviewRow) => (
    <>
      <b>{r.assigned_to ?? '—'}</b> <span className="muted">({r.department ?? '—'})</span>
    </>
  )
  const done = sorted.filter((r) => reviewTone(r) === 'done')
  const pending = sorted.filter((r) => reviewTone(r) === 'progress')
  const rejected = sorted.filter((r) => reviewTone(r) === 'rda-rejected')
  const todo = sorted.filter((r) => reviewTone(r) === 'todo')
  return (
    <div className="co-overview-section">
      <div className="co-overview-title">
        Review: {done.length}/{sorted.length} completate
      </div>
      <NameList label="Completata" tone="done" names={done.map(who)} />
      <NameList label="In corso" tone="progress" names={pending.map(who)} />
      <NameList label="Respinta" tone="rda-rejected" names={rejected.map(who)} />
      <NameList label="Da fare" tone="todo" names={todo.map(who)} />
    </div>
  )
}

function TargetsTable({ targets }: { targets: CoTargetRow[] }) {
  return (
    <table className="co-overview-table">
      <thead>
        <tr>
          <th>Reparto</th>
          <th>PN / motivo</th>
          <th>Stato</th>
          <th>Owner</th>
          <th>Review</th>
          <th>Approvazione</th>
        </tr>
      </thead>
      <tbody>
        {targets.map((t, i) => (
          <tr key={t.row_number ?? i}>
            <td>{t.department ?? '—'}</td>
            <td className="muted">{t.change_reason ?? ''}</td>
            <td>
              <span className={`badge ${targetTone(t)}`}>{stripPhase(t.row_status)}</span>
            </td>
            <td title={t.assigned_to.length ? `Assegnato a: ${t.assigned_to.join(', ')}` : undefined}>{t.owner ?? '—'}</td>
            <td>{t.reviewer ?? '—'}</td>
            <td>{t.approver ?? '—'}</td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}

function TargetsSummary({ targets }: { targets: CoTargetRow[] }) {
  // Un reparto puo' avere piu' righe (es. Software, una per PN): si conta
  // il reparto come valutato quando lo sono tutte le sue righe.
  const departments = new Map<string, CoTargetRow[]>()
  for (const t of targets) {
    const key = t.department ?? '—'
    departments.set(key, [...(departments.get(key) ?? []), t])
  }
  const evaluated: ReactNode[] = []
  const missing: ReactNode[] = []
  for (const [department, rows] of departments) {
    if (rows.every(targetEvaluated)) {
      const statuses = [...new Set(rows.map((r) => stripPhase(r.row_status)))].join(' / ')
      evaluated.push(
        <>
          <b>{department}</b> <span className="muted">({statuses})</span>
        </>,
      )
    } else {
      const owners = [...new Set(rows.filter((r) => !targetEvaluated(r)).map((r) => r.owner).filter(Boolean))]
      missing.push(
        <>
          <b>{department}</b> {owners.length > 0 && <span className="muted">({owners.join(', ')})</span>}
        </>,
      )
    }
  }
  return (
    <div className="co-overview-section">
      <div className="co-overview-title">
        Valutazione dei reparti: {evaluated.length}/{departments.size} valutati
      </div>
      <NameList label="Manca" tone="todo" names={missing} />
      <NameList label="Valutato" tone="done" names={evaluated} />
    </div>
  )
}

export function ChangeOrderOverview({ projectId, status }: { projectId: number; status: ReactNode }) {
  const { data } = useQuery({
    queryKey: ['co-details', projectId],
    queryFn: () => api.projects.changeOrderDetails(projectId),
  })
  const phase = phaseNumber(data?.co_status)
  const inReview = phase != null && phase >= 6 && (data?.reviews.length ?? 0) > 0
  const targets = data?.targets ?? []
  const reviews = data?.reviews ?? []

  return (
    <div className="card">
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
        <h3 style={{ margin: 0 }}>Stato del Change Order</h3>
        {status}
      </div>
      {targets.length === 0 && reviews.length === 0 ? (
        <p className="muted" style={{ marginBottom: 0 }}>
          Valutazioni dei reparti e review non ancora lette: premi ⟳ Aggiorna.
        </p>
      ) : (
        <>
          {inReview && <ReviewSummary reviews={reviews} />}
          {targets.length > 0 && <TargetsSummary targets={targets} />}
          {!inReview && reviews.length > 0 && <ReviewSummary reviews={reviews} />}
          {targets.length > 0 && (
            <details style={{ marginTop: 8 }}>
              <summary className="muted" style={{ cursor: 'pointer' }}>
                Dettaglio dei Departments Targets ({targets.length} righe)
              </summary>
              <TargetsTable targets={targets} />
            </details>
          )}
        </>
      )}
    </div>
  )
}
