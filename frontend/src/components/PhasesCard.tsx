import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { createPortal } from 'react-dom'
import { CartesianGrid, Legend, ReferenceLine, ResponsiveContainer, Scatter, ScatterChart, Tooltip, XAxis, YAxis } from 'recharts'
import { api } from '../api/client'
import { isMilestone } from '../lib/milestone'
import type { BacklogItem, Phase } from '../api/types'
import { dateStrToEpochDays, epochDaysToDate, formatEpochDaysAsDate, formatIsoDate, toEpochDays } from '../lib/dates'
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

// Date dell'increment: ognuna e' la data aggiornata della fase scelta qui
// (le fasi hanno nomi liberi e si eliminano senza vincoli; fase non scelta =
// data vuota).
type DateLink = 'start_phase_id' | 'code_freeze_phase_id' | 'finish_phase_id'
const DATE_LINKS: { field: DateLink; label: string; tag: string; usage: string }[] = [
  { field: 'start_phase_id', label: 'Project start', tag: 'Start', usage: 'inizio dell\'increment (Gantt, Releases)' },
  {
    field: 'code_freeze_phase_id',
    label: 'Code freeze',
    tag: 'Code freeze',
    usage: 'code freeze ufficiale (Backlog, Gantt, Monte Carlo, Forecasting)',
  },
  {
    field: 'finish_phase_id',
    label: 'Planned finish',
    tag: 'Fine',
    usage: 'fine pianificata (Gantt delle dashboard, Releases: Expected Release)',
  },
]

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

// Stato Jira della milestone e data effettiva della fase non d'accordo: il
// colore del rombo segue Jira, la data definitiva si mette qui.
function MilestoneMismatch({
  phase,
  milestone,
  onUseDate,
}: {
  phase: Phase
  milestone: BacklogItem | undefined
  onUseDate: (date: string) => void
}) {
  if (!milestone) return null
  const done = milestone.status === 'Done'
  if (done && !phase.actual_date) {
    return (
      <div className="milestone-mismatch">
        ⚠ Chiusa su Jira{milestone.actual_finish ? ` il ${formatIsoDate(milestone.actual_finish)}` : ''}: imposta la data
        effettiva.
        {milestone.actual_finish && (
          <button type="button" className="link-btn" onClick={() => onUseDate(milestone.actual_finish!)}>
            Usa {formatIsoDate(milestone.actual_finish)}
          </button>
        )}
      </div>
    )
  }
  if (!done && phase.actual_date) {
    return (
      <div className="milestone-mismatch">
        ⚠ Data effettiva impostata ma {milestone.jira_key} è ancora aperta su Jira.
      </div>
    )
  }
  return null
}

const isoOfEpoch = (day: number) => epochDaysToDate(day).toISOString().slice(0, 10)

// Spostamento della data aggiornata di una fase con "Mantieni l'ordine delle
// fasi": le successive che finirebbero prima si spostano degli stessi giorni
// (le durate tra le fasi restano uguali), almeno fino alla fase precedente.
type PhaseShift = { phase: Phase; from: string; to: string }
type OrderPlan =
  // fix: dal pulsante "Sistema" (fasi gia' fuori ordine), non da uno spostamento.
  | { kind: 'after'; phase: Phase; newDate: string; shifts: PhaseShift[]; fix?: boolean }
  | { kind: 'before'; phase: Phase; newDate: string; previous: Phase }

function planPhaseMove(phases: Phase[], phase: Phase, newDate: string): OrderPlan | null {
  const index = phases.findIndex((p) => p.id === phase.id)
  const previous = phases
    .slice(0, index)
    .reverse()
    .find((p) => p.planned_date)
  if (previous?.planned_date && newDate < previous.planned_date) return { kind: 'before', phase, newDate, previous }
  const oldDay = dateStrToEpochDays(phase.planned_date)
  const newDay = dateStrToEpochDays(newDate) as number
  const delta = oldDay === null ? 0 : newDay - oldDay
  const shifts: PhaseShift[] = []
  let last = newDay
  for (const next of phases.slice(index + 1)) {
    const day = dateStrToEpochDays(next.planned_date)
    if (day === null) continue
    if (day < last) {
      const to = Math.max(day + Math.max(delta, 0), last)
      shifts.push({ phase: next, from: next.planned_date as string, to: isoOfEpoch(to) })
      last = to
    } else {
      last = day
    }
  }
  return shifts.length > 0 ? { kind: 'after', phase, newDate, shifts } : null
}

// Prima fase gia' fuori ordine (data aggiornata prima di una fase che la
// precede): la fase "colpevole" e quella che la supera.
function firstOutOfOrder(phases: Phase[]): { ahead: Phase; behind: Phase } | null {
  let ahead: Phase | null = null
  for (const p of phases) {
    if (!p.planned_date) continue
    if (ahead?.planned_date && p.planned_date < ahead.planned_date) return { ahead, behind: p }
    if (!ahead?.planned_date || p.planned_date >= ahead.planned_date) ahead = p
  }
  return null
}

export function PhasesCard({ projectId, currentStatus }: Props) {
  const queryClient = useQueryClient()
  const { data: phases } = useQuery({ queryKey: ['phases', projectId], queryFn: () => api.phases.list(projectId) })
  const { data: project } = useQuery({ queryKey: ['project', projectId], queryFn: () => api.projects.get(projectId) })
  const linksOf = (phase: Phase) => DATE_LINKS.filter((l) => project?.[l.field] === phase.id)

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
    onSuccess: () => {
      invalidate()
      // Le milestone collegate seguono la data della fase.
      queryClient.invalidateQueries({ queryKey: ['backlog', projectId] })
    },
  })
  // Milestone del backlog (label Milestone su Jira), collegabili a una fase:
  // nel Gantt prendono la sua data.
  const { data: backlog } = useQuery({ queryKey: ['backlog', projectId], queryFn: () => api.backlog.list(projectId) })
  const milestones = (backlog ?? []).filter(isMilestone)
  const linkMilestone = useMutation({
    mutationFn: async ({ phaseId, itemId }: { phaseId: number; itemId: number | null }) => {
      const current = milestones.find((m) => m.milestone_phase_id === phaseId)
      if (itemId !== null) await api.backlog.update(itemId, { milestone_phase_id: phaseId })
      else if (current) await api.backlog.update(current.id, { milestone_phase_id: null })
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['backlog', projectId] }),
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
  const setLink = useMutation({
    mutationFn: ({ field, phaseId }: { field: DateLink; phaseId: number | null }) =>
      api.projects.update(projectId, { [field]: phaseId }),
    onSuccess: () => {
      invalidate()
      queryClient.invalidateQueries({ queryKey: ['backlog', projectId] })
    },
  })

  // Mantieni l'ordine delle fasi (opzione dell'increment, attiva di default).
  const keepOrder = project?.keep_phase_order ?? true
  const setKeepOrder = useMutation({
    mutationFn: (value: boolean) => api.projects.update(projectId, { keep_phase_order: value }),
    onSuccess: invalidate,
  })
  const [orderPlan, setOrderPlan] = useState<OrderPlan | null>(null)
  // Rimonta i campi data dopo un "Annulla", per rimostrare la data salvata.
  const [dateResets, setDateResets] = useState(0)
  const applyMoves = useMutation({
    mutationFn: async (moves: { id: number; date: string }[]) => {
      for (const m of moves) await api.phases.update(m.id, { planned_date: m.date })
    },
    onSuccess: () => {
      invalidate()
      queryClient.invalidateQueries({ queryKey: ['backlog', projectId] })
    },
  })
  const changePlannedDate = (phase: Phase, value: string | null) => {
    const plan = keepOrder && value && phases ? planPhaseMove(phases, phase, value) : null
    if (plan) setOrderPlan(plan)
    else update.mutate({ id: phase.id, data: { planned_date: value } })
  }
  // Fasi gia' fuori ordine (es. spostate prima che ci fosse l'opzione):
  // "Sistema" propone di portare le successive almeno alla data della fase
  // che le supera, con lo stesso riquadro di conferma.
  const outOfOrder = keepOrder && phases ? firstOutOfOrder(phases) : null
  const fixOrder = () => {
    if (!outOfOrder || !phases) return
    const plan = planPhaseMove(phases, outOfOrder.ahead, outOfOrder.ahead.planned_date as string)
    if (plan?.kind === 'after') setOrderPlan({ ...plan, fix: true })
  }
  const closePlan = (moves: { id: number; date: string }[] | null) => {
    if (moves) applyMoves.mutate(moves)
    else setDateResets((n) => n + 1)
    setOrderPlan(null)
  }

  const error =
    update.error ?? addPhase.error ?? removePhase.error ?? linkMilestone.error ?? setLink.error ?? applyMoves.error ?? setKeepOrder.error

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
  // Oggi entra nel range (con la sua linea) solo da Project start in poi: per
  // un increment che parte nel futuro allargherebbe il grafico fino a oggi,
  // schiacciando le fasi. Senza Project start vale la prima data delle fasi.
  const todayEpoch = toEpochDays(new Date())
  const startEpoch = dateStrToEpochDays(project?.start_date ?? null) ?? (allEpochs.length > 0 ? Math.min(...allEpochs) : null)
  const showToday = startEpoch !== null && todayEpoch >= startEpoch
  const domainEpochs = showToday ? [...allEpochs, todayEpoch] : allEpochs
  const dateDomain: [number, number] =
    allEpochs.length > 0 ? [Math.min(...domainEpochs) - 3, Math.max(...domainEpochs) + 3] : [0, 1]
  // Etichetta "Today" dal lato con piu' spazio: a destra della linea nella
  // prima meta' del grafico (a inizio progetto la linea e' vicina all'asse
  // delle fasi e il testo a sinistra ci finirebbe sopra), a sinistra nella
  // seconda (a destra uscirebbe dal grafico).
  const todayLabelPosition =
    todayEpoch - dateDomain[0] < (dateDomain[1] - dateDomain[0]) / 2 ? 'insideTopLeft' : 'insideTopRight'

  return (
    <div className="card">
      <div className="phases-head">
        <h3>Fasi increment</h3>
        {project && (
          <label
            className="phases-keep-order"
            title="Spostando la data aggiornata di una fase, propone di spostare anche le successive che finirebbero prima, e avvisa se la fase andrebbe prima della precedente"
          >
            <input
              type="checkbox"
              checked={keepOrder}
              disabled={setKeepOrder.isPending}
              onChange={(e) => setKeepOrder.mutate(e.target.checked)}
            />{' '}
            Mantieni l'ordine delle fasi
          </label>
        )}
      </div>
      {orderPlan && <PhaseOrderModal plan={orderPlan} onClose={closePlan} />}
      {outOfOrder && (
        <div className="phase-link-missing phase-out-of-order">
          ⚠ <b>{outOfOrder.behind.name}</b> ({formatIsoDate(outOfOrder.behind.planned_date)}) è prima di{' '}
          <b>{outOfOrder.ahead.name}</b> ({formatIsoDate(outOfOrder.ahead.planned_date)}).{' '}
          <button type="button" className="link-btn" onClick={fixOrder} disabled={applyMoves.isPending}>
            Sistema
          </button>
        </div>
      )}
      {error && <div className="error-banner">Salvataggio non riuscito: {(error as Error).message}</div>}
      {project && (
        <div className="phase-links">
          <span className="muted">Date dell'increment dalla fase:</span>
          {DATE_LINKS.map((l) => (
            <label key={l.field} title={`Data aggiornata della fase scelta = ${l.usage}`}>
              {l.label}{' '}
              <select
                value={project[l.field] ?? ''}
                disabled={setLink.isPending}
                onChange={(e) => setLink.mutate({ field: l.field, phaseId: e.target.value ? Number(e.target.value) : null })}
              >
                <option value="">— nessuna —</option>
                {(phases ?? []).map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
            </label>
          ))}
        </div>
      )}
      {project &&
        DATE_LINKS.filter((l) => !project[l.field]).map((l) => (
          <div key={l.field} className="phase-link-missing">
            ⚠ {l.label} non impostato: nessuna fase scelta, quindi l'increment non ha la data di {l.usage}.
          </div>
        ))}
      {/* Tabella piu' larga del grafico: date, scostamento e note devono stare tutte. */}
      <div className="grid-3-2" style={{ gridTemplateColumns: '2fr 1fr' }}>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th style={{ minWidth: 170 }}>Fase</th>
                <th title="Data della prima pianificazione (baseline)">Originale</th>
                <th title="Data pianificata che vale ora: Backlog, Gantt e presentazioni usano questa. Ogni cambio resta nello storico.">
                  Aggiornata
                </th>
                <th>Effettiva</th>
                <th title="Giorni di calendario tra l'originale e la data che vale ora (effettiva, se no aggiornata)">Scost.</th>
                {milestones.length > 0 && (
                  <th title="Activity Jira con la label Milestone: collegata alla fase, nel Gantt del Backlog sta sulla sua data">
                    Milestone
                  </th>
                )}
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
                        onBlur={(e) => {
                          const value = e.target.value.trim()
                          if (value && value !== phase.name) update.mutate({ id: phase.id, data: { name: value } })
                          else e.target.value = phase.name
                        }}
                      />
                      {index === currentPhaseIndex && (
                        <span className="badge current" title="Fase in cui ci troviamo ora">
                          Ora
                        </span>
                      )}
                    </div>
                    {linksOf(phase).length > 0 && (
                      <div className="phase-link-tags">
                        {linksOf(phase).map((l) => (
                          <span key={l.field} className="badge phase-link-tag" title={`La data aggiornata è il ${l.usage}`}>
                            {l.tag}
                          </span>
                        ))}
                      </div>
                    )}
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
                      key={`${phase.id}|${phase.planned_date}|${dateResets}`}
                      onChange={(value) => changePlannedDate(phase, value)}
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
                  {milestones.length > 0 && (
                    <td className="editable-cell" style={{ minWidth: 160 }}>
                      <select
                        value={milestones.find((m) => m.milestone_phase_id === phase.id)?.id ?? ''}
                        disabled={linkMilestone.isPending}
                        title={milestones.find((m) => m.milestone_phase_id === phase.id)?.summary ?? undefined}
                        onChange={(e) =>
                          linkMilestone.mutate({ phaseId: phase.id, itemId: e.target.value ? Number(e.target.value) : null })
                        }
                      >
                        <option value="">—</option>
                        {milestones.map((m) => (
                          <option key={m.id} value={m.id}>
                            ◆ {m.jira_key}
                            {m.summary ? ` – ${m.summary}` : ''}
                          </option>
                        ))}
                      </select>
                      <MilestoneMismatch
                        phase={phase}
                        milestone={milestones.find((m) => m.milestone_phase_id === phase.id)}
                        onUseDate={(date) => update.mutate({ id: phase.id, data: { actual_date: date } })}
                      />
                    </td>
                  )}
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
                      title="Elimina la fase"
                      onClick={() => {
                        const links = linksOf(phase)
                        if (
                          links.length === 0 ||
                          confirm(
                            `La fase ${phase.name} dà all'increment: ${links.map((l) => l.label).join(', ')}. ` +
                              'Eliminandola quella data resterà vuota finché non scegli un\'altra fase. Eliminare?',
                          )
                        )
                          removePhase.mutate(phase.id)
                      }}
                    >
                      ✕
                    </button>
                  </td>
                </tr>
              ))}
              {phases?.length === 0 && (
                <tr>
                  <td colSpan={milestones.length > 0 ? 8 : 7} className="muted">
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
                {showToday && (
                  <ReferenceLine
                    x={todayEpoch}
                    stroke={COLOR_TODAY}
                    strokeWidth={2}
                    label={{ value: 'Today', position: todayLabelPosition, fill: COLOR_TODAY, fontSize: 11, fontWeight: 700 }}
                  />
                )}
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

// Avviso di "Mantieni l'ordine delle fasi": cosa succede spostando la fase.
function PhaseOrderModal({
  plan,
  onClose,
}: {
  plan: OrderPlan
  onClose: (moves: { id: number; date: string }[] | null) => void
}) {
  const fmt = (iso: string) => formatIsoDate(iso) ?? iso
  const only = [{ id: plan.phase.id, date: plan.newDate }]
  return createPortal(
    <div className="modal-overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose(null)}>
      <div className="modal phase-order-modal" role="dialog" aria-label="Ordine delle fasi">
        {plan.kind === 'after' ? (
          <>
            <h3>{plan.fix ? 'Rimettere in ordine le fasi?' : 'Spostare anche le fasi successive?'}</h3>
            {plan.fix ? (
              <p>
                Queste fasi sono prima di <b>{plan.phase.name}</b> ({fmt(plan.newDate)}): si portano almeno alla sua data.
              </p>
            ) : (
              <p>
                Con <b>{plan.phase.name}</b> al <b>{fmt(plan.newDate)}</b> queste fasi finirebbero prima. Spostandole degli
                stessi giorni restano in ordine:
              </p>
            )}
            <ul>
              {plan.shifts.map((s) => (
                <li key={s.phase.id}>
                  <b>{s.phase.name}</b>: {fmt(s.from)} → {fmt(s.to)}
                </li>
              ))}
            </ul>
            <div className="phase-order-actions">
              <button className="btn" onClick={() => onClose(null)}>
                Annulla
              </button>
              {!plan.fix && (
                <button className="btn" onClick={() => onClose(only)}>
                  Sposta solo {plan.phase.name}
                </button>
              )}
              <button
                className="btn btn-primary"
                onClick={() =>
                  onClose([...(plan.fix ? [] : only), ...plan.shifts.map((s) => ({ id: s.phase.id, date: s.to }))])
                }
              >
                {plan.fix ? 'Sistema le date' : 'Sposta anche le successive'}
              </button>
            </div>
          </>
        ) : (
          <>
            <h3>Fase prima della precedente</h3>
            <p>
              <b>{plan.phase.name}</b> al <b>{fmt(plan.newDate)}</b> sarebbe prima di <b>{plan.previous.name}</b> (
              {fmt(plan.previous.planned_date as string)}).
            </p>
            <div className="phase-order-actions">
              <button className="btn" onClick={() => onClose(null)}>
                Annulla
              </button>
              <button className="btn" onClick={() => onClose(only)}>
                Usa comunque {fmt(plan.newDate)}
              </button>
              <button
                className="btn btn-primary"
                onClick={() => onClose([{ id: plan.phase.id, date: plan.previous.planned_date as string }])}
              >
                Usa {fmt(plan.previous.planned_date as string)}
              </button>
            </div>
          </>
        )}
      </div>
    </div>,
    document.body,
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
