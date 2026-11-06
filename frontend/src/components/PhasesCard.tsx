import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { CartesianGrid, Legend, ReferenceLine, ResponsiveContainer, Scatter, ScatterChart, Tooltip, XAxis, YAxis } from 'recharts'
import { api } from '../api/client'
import type { Phase } from '../api/types'
import { dateStrToEpochDays, formatEpochDaysAsDate, formatIsoDate, toEpochDays } from '../lib/dates'
import { DateInput } from './DateInput'

type Props = { projectId: number; currentStatus: string }

// Palette categorica validata del progetto (vedi skill data-viz), primi due
// slot fissi: blu, arancio; l'originale in grigio, come riferimento.
const COLOR_ORIGINAL = '#9a968c'
const COLOR_PLANNED = '#2a78d6'
const COLOR_ACTUAL = '#eb6834'
// Linea che unisce la data originale a quella che vale ora della stessa fase.
const COLOR_SLIP = '#d62728'
// Linea di oggi, rossa come nel Gantt del Backlog.
const COLOR_TODAY = '#d3402f'

// Fasi che portano le date dell'increment (la loro data aggiornata): il
// backend non le lascia rinominare ne' eliminare. Il Project start e' la
// prima fase, che si rinomina ma non si elimina.
const DATE_PHASES: Record<string, string> = {
  'code freeze': "Code freeze ufficiale dell'increment: vale per Backlog, Gantt, Monte Carlo e Forecasting",
  'release to market': "Planned finish dell'increment: vale per i Gantt delle dashboard e per Releases (Expected Release)",
}
const datePhaseRole = (p: Phase): string | undefined => DATE_PHASES[p.name.trim().toLowerCase().replace(/-/g, ' ')]

// Data che vale ora per una fase: l'effettiva se c'e', altrimenti la
// pianificata aggiornata.
const currentDate = (p: Phase) => p.actual_date ?? p.planned_date

// Scostamento in giorni di calendario della data che vale ora rispetto
// all'originale (positivo = in ritardo).
function slipDays(p: Phase): number | null {
  const original = dateStrToEpochDays(p.original_date)
  const current = dateStrToEpochDays(currentDate(p))
  return original === null || current === null ? null : current - original
}

// kind: la serie (Originale/Aggiornata/Effettiva), mostrata nel tooltip;
// i punti delle frecce di scostamento non ce l'hanno e non hanno tooltip.
type TimelinePoint = { x: number; y: string; kind: string }

export function PhasesCard({ projectId, currentStatus }: Props) {
  const queryClient = useQueryClient()
  const { data: phases } = useQuery({ queryKey: ['phases', projectId], queryFn: () => api.phases.list(projectId) })

  // Kick-off, Code freeze e Release to Market danno le date dell'increment
  // (il backend le tiene allineate): si rinfresca anche l'increment.
  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ['phases', projectId] })
    queryClient.invalidateQueries({ queryKey: ['project', projectId] })
    queryClient.invalidateQueries({ queryKey: ['projects'] })
  }
  const [openHistory, setOpenHistory] = useState<Set<number>>(new Set())
  const toggleHistory = (id: number) =>
    setOpenHistory((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })

  const update = useMutation({
    mutationFn: ({ id, data }: { id: number; data: Partial<Phase> }) => api.phases.update(id, data),
    onSuccess: invalidate,
  })
  const addPhase = useMutation({
    mutationFn: () =>
      api.phases.create(projectId, { name: 'Nuova fase', order: (phases?.length ?? 0) + 1 }),
    onSuccess: invalidate,
  })
  const removePhase = useMutation({
    mutationFn: (id: number) => api.phases.remove(id),
    onSuccess: invalidate,
  })

  const error = update.error ?? addPhase.error ?? removePhase.error

  // Fase corrente: quella il cui nome corrisponde allo Stato increment scelto
  // in Dashboard (il menu li' e' popolato proprio dai nomi di queste fasi).
  const currentPhaseIndex = (phases ?? []).findIndex((p) => p.name === currentStatus)

  const phaseNames = (phases ?? []).map((p) => p.name)
  const isPoint = (p: { x: number | null; y: string; kind: string }): p is TimelinePoint => p.x !== null
  const originalPoints = (phases ?? []).map((p) => ({ x: dateStrToEpochDays(p.original_date), y: p.name, kind: 'Originale' })).filter(isPoint)
  const plannedPoints = (phases ?? []).map((p) => ({ x: dateStrToEpochDays(p.planned_date), y: p.name, kind: 'Aggiornata' })).filter(isPoint)
  const actualPoints = (phases ?? []).map((p) => ({ x: dateStrToEpochDays(p.actual_date), y: p.name, kind: 'Effettiva' })).filter(isPoint)
  // Segmento originale -> data che vale ora (effettiva, se no aggiornata),
  // per le fasi che si sono spostate.
  const slipSegments = (phases ?? [])
    .map((p) => ({ id: p.id, from: dateStrToEpochDays(p.original_date), to: dateStrToEpochDays(currentDate(p)), y: p.name }))
    .filter((s) => s.from !== null && s.to !== null && s.from !== s.to)
    .map((s) => ({ id: s.id, points: [{ x: s.from as number, y: s.y }, { x: s.to as number, y: s.y }] }))
  const arrowId = `phase-slip-arrow-${projectId}`
  const allEpochs = [...originalPoints, ...plannedPoints, ...actualPoints].map((p) => p.x)
  // Oggi entra sempre nel range, cosi' la sua linea resta visibile.
  const todayEpoch = toEpochDays(new Date())
  const dateDomain: [number, number] =
    allEpochs.length > 0 ? [Math.min(...allEpochs, todayEpoch) - 3, Math.max(...allEpochs, todayEpoch) + 3] : [0, 1]
  // Etichetta "Today" dal lato con piu' spazio: a destra della linea nella
  // prima meta' del grafico (a inizio progetto la linea e' vicina all'asse
  // delle fasi e il testo a sinistra ci finirebbe sopra), a sinistra nella
  // seconda (a destra uscirebbe dal grafico).
  const todayLabelPosition =
    todayEpoch - dateDomain[0] < (dateDomain[1] - dateDomain[0]) / 2 ? 'insideTopLeft' : 'insideTopRight'

  return (
    <div className="card">
      <h3>Fasi increment</h3>
      {error && <div className="error-banner">Salvataggio non riuscito: {(error as Error).message}</div>}
      {/* Tabella piu' larga del grafico: date, scostamento e note devono stare tutte. */}
      <div className="grid-3-2" style={{ gridTemplateColumns: '2fr 1fr' }}>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th style={{ minWidth: 140 }}>Fase</th>
                <th title="Data della prima pianificazione (baseline)">Originale</th>
                <th title="Data pianificata che vale ora: Backlog, Gantt e presentazioni usano questa. Ogni cambio resta nello storico.">
                  Aggiornata
                </th>
                <th>Effettiva</th>
                <th title="Giorni di calendario tra l'originale e la data che vale ora (effettiva, se no aggiornata)">Scost.</th>
                <th>Note</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {phases?.map((phase, index) => (
                <tr key={phase.id} className={index === currentPhaseIndex ? 'phase-current' : undefined}>
                  <td className="editable-cell">
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                      <input
                        defaultValue={phase.name}
                        disabled={!!datePhaseRole(phase)}
                        title={datePhaseRole(phase) && `La data aggiornata è il ${datePhaseRole(phase)}`}
                        onBlur={(e) => e.target.value !== phase.name && update.mutate({ id: phase.id, data: { name: e.target.value } })}
                      />
                      {index === currentPhaseIndex && (
                        <span className="badge current" title="Fase in cui ci troviamo ora">
                          Ora
                        </span>
                      )}
                    </div>
                  </td>
                  <td className="editable-cell">
                    <DateInput
                      value={phase.original_date}
                      onChange={(value) => update.mutate({ id: phase.id, data: { original_date: value } })}
                    />
                  </td>
                  <td className="editable-cell">
                    <DateInput
                      value={phase.planned_date}
                      onChange={(value) => update.mutate({ id: phase.id, data: { planned_date: value } })}
                    />
                    {phase.changes.length > 0 && (
                      <div className="phase-history">
                        <button className="link-btn" onClick={() => toggleHistory(phase.id)}>
                          {openHistory.has(phase.id) ? '▾' : '▸'} {phase.changes.length}{' '}
                          {phase.changes.length === 1 ? 'modifica' : 'modifiche'}
                        </button>
                        {openHistory.has(phase.id) && (
                          <ul>
                            {phase.changes.map((change) => (
                              <li key={change.id}>
                                {formatIsoDate(change.old_date) ?? '—'} → {formatIsoDate(change.new_date) ?? '—'}
                                <span className="muted"> il {formatIsoDate(change.changed_at.slice(0, 10))}</span>
                              </li>
                            ))}
                          </ul>
                        )}
                      </div>
                    )}
                  </td>
                  <td className="editable-cell">
                    <DateInput
                      value={phase.actual_date}
                      onChange={(value) => update.mutate({ id: phase.id, data: { actual_date: value } })}
                    />
                  </td>
                  <td className="text-right" style={{ whiteSpace: 'nowrap' }}>
                    <SlipCell phase={phase} />
                  </td>
                  <td className="editable-cell" style={{ minWidth: 240 }}>
                    <input
                      defaultValue={phase.notes ?? ''}
                      onBlur={(e) => {
                        const value = e.target.value || null
                        if (value !== phase.notes) update.mutate({ id: phase.id, data: { notes: value } })
                      }}
                    />
                  </td>
                  <td>
                    <button
                      className="btn btn-danger"
                      disabled={!!datePhaseRole(phase) || index === 0}
                      title={
                        index === 0
                          ? "La prima fase porta il Project start dell'increment: non si può eliminare"
                          : datePhaseRole(phase) && "Porta una data dell'increment: non si può eliminare"
                      }
                      onClick={() => removePhase.mutate(phase.id)}
                    >
                      ✕
                    </button>
                  </td>
                </tr>
              ))}
              {phases?.length === 0 && (
                <tr>
                  <td colSpan={7} className="muted">
                    Nessuna fase definita.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>

        {allEpochs.length > 0 ? (
          <div style={{ height: Math.max(160, phaseNames.length * 40) }}>
            <ResponsiveContainer width="100%" height="100%">
              <ScatterChart margin={{ top: 8, right: 16, left: 8, bottom: 8 }}>
                <CartesianGrid stroke="#e1e0d9" horizontal={false} />
                <XAxis
                  type="number"
                  dataKey="x"
                  domain={dateDomain}
                  tickFormatter={formatEpochDaysAsDate}
                  tick={{ fontSize: 11 }}
                />
                <YAxis
                  type="category"
                  dataKey="y"
                  domain={phaseNames}
                  width={90}
                  tick={{ fontSize: 12 }}
                  allowDuplicatedCategory={false}
                />
                {/* Tooltip su misura: quello standard formatta come data anche
                    la fase (asse Y), che diventava "NaN". */}
                <Tooltip
                  cursor={{ strokeDasharray: '3 3' }}
                  content={({ active, payload }) => {
                    const point = active ? (payload?.[0]?.payload as TimelinePoint | undefined) : undefined
                    if (!point?.kind) return null
                    return (
                      <div className="chart-tooltip">
                        <strong>{point.y}</strong>
                        <div>
                          {point.kind}: {formatEpochDaysAsDate(point.x)}
                        </div>
                      </div>
                    )
                  }}
                />
                <Legend wrapperStyle={{ fontSize: 12 }} />
                <ReferenceLine
                  x={todayEpoch}
                  stroke={COLOR_TODAY}
                  strokeWidth={2}
                  label={{ value: 'Today', position: todayLabelPosition, fill: COLOR_TODAY, fontSize: 11, fontWeight: 700 }}
                />
                {/* Punta della freccia verso la data effettiva, arretrata di
                    qualche pixel per non finire sotto il pallino. */}
                <defs>
                  <marker
                    id={arrowId}
                    viewBox="0 0 10 10"
                    refX={17.5}
                    refY={5}
                    markerWidth={8}
                    markerHeight={8}
                    markerUnits="userSpaceOnUse"
                    orient="auto"
                  >
                    <path d="M0,0 L10,5 L0,10 z" fill={COLOR_SLIP} />
                  </marker>
                </defs>
                {/* Prima le linee, cosi' i pallini restano sopra. */}
                {slipSegments.map((s) => (
                  <Scatter
                    key={s.id}
                    data={s.points}
                    line={{ stroke: COLOR_SLIP, strokeWidth: 2, markerEnd: `url(#${arrowId})` }}
                    shape={() => <g />}
                    legendType="none"
                    tooltipType="none"
                    isAnimationActive={false}
                  />
                ))}
                <Scatter name="Originale" data={originalPoints} fill="none" stroke={COLOR_ORIGINAL} strokeWidth={2} />
                <Scatter name="Aggiornata" data={plannedPoints} fill={COLOR_PLANNED} />
                <Scatter name="Effettiva" data={actualPoints} fill={COLOR_ACTUAL} />
              </ScatterChart>
            </ResponsiveContainer>
          </div>
        ) : (
          <p className="muted">Imposta almeno una data per vedere il grafico.</p>
        )}
      </div>
      <div style={{ marginTop: 10 }}>
        <button className="btn" onClick={() => addPhase.mutate()}>
          + Aggiungi fase
        </button>
      </div>
    </div>
  )
}

function SlipCell({ phase }: { phase: Phase }) {
  const slip = slipDays(phase)
  if (slip === null) return <span className="muted">—</span>
  if (slip === 0) return <span className="muted">0</span>
  return (
    <span style={{ color: slip > 0 ? 'var(--danger)' : 'var(--success)', fontWeight: 600 }}>
      {slip > 0 ? `+${slip}` : slip} gg
    </span>
  )
}
