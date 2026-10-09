import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Legend,
  Line,
  LineChart,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'
import { api, saveBlob } from '../api/client'
import { PhasesCard } from '../components/PhasesCard'
import { ScopeCard } from '../components/ScopeCard'
import type { BacklogItem } from '../api/types'
import { dateStrToEpochDays, formatEpochDaysAsDate, formatIsoDate, workingDaysBetween } from '../lib/dates'
import { useProjectContext } from './useProjectContext'

// Palette categorica validata del progetto (skill data-viz): blu e arancio
// per le due serie di ore reali.
const COLOR_ACTUAL_HOURS = '#2a78d6'
const COLOR_ACTUAL_LOGGED = '#eb6834'
// Grafici previsione vs effettivo (Sizing/Durata, Ore stimate/loggate):
// previsione in grigio neutro, effettivo nel blu primario - il dato reale e'
// quello da guardare, la previsione fa da riferimento.
const COLOR_PLANNED = '#a3acb9'
const COLOR_ACTUAL = '#2f6fed'
// Data del code freeze nel grafico del completamento: rosso, la scadenza.
const COLOR_CODE_FREEZE = '#d3402f'

const pct = (v: number | null) => (v === null ? '—' : `${Math.round(v * 100)}%`)

function spiTone(spi: number | null) {
  if (spi === null) return ''
  if (spi > 1.05) return 'done'
  if (spi < 0.95) return 'progress'
  return ''
}

// Replica della formula Excel:
// =IF(H17>1,05;"Ahead of Schedule";IF(H17<0,95;"Behind Schedule";"On Schedule"))
function spiStatusLabel(spi: number | null) {
  if (spi === null) return null
  if (spi > 1.05) return 'Ahead of Schedule'
  if (spi < 0.95) return 'Behind Schedule'
  return 'On Schedule'
}

const BADGE_CLASS_BY_TONE: Record<string, string> = { done: 'done', progress: 'progress', '': 'todo' }

type PlanVsActualPoint = {
  key: string
  summary: string | null
  planned: number
  actual: number
  delta: number
}

// Scostamento effettivo - previsto: positivo = oltre la previsione (rosso),
// negativo = sotto (verde).
function deltaColor(delta: number): string {
  if (delta > 0) return 'var(--danger)'
  if (delta < 0) return 'var(--success)'
  return 'var(--text-muted)'
}

const fmtNumber = (v: number) => v.toLocaleString('it-IT', { maximumFractionDigits: 1 })

type PlanVsActualLabels = { planned: string; actual: string; unit: string }

function PlanVsActualTooltip({
  active,
  payload,
  labels,
}: {
  active?: boolean
  payload?: { payload: PlanVsActualPoint }[]
  labels: PlanVsActualLabels
}) {
  if (!active || !payload || !payload.length) return null
  const p = payload[0].payload
  return (
    <div
      style={{
        background: 'var(--surface)',
        border: '1px solid var(--border)',
        borderRadius: 6,
        padding: '6px 10px',
        fontSize: 12,
        boxShadow: '0 2px 8px rgba(0,0,0,0.12)',
        maxWidth: 320,
      }}
    >
      <div style={{ fontWeight: 600 }}>{p.key}</div>
      {p.summary && <div className="muted" style={{ marginBottom: 4, whiteSpace: 'normal' }}>{p.summary}</div>}
      <div>
        {labels.planned}: {fmtNumber(p.planned)} {labels.unit}
      </div>
      <div>
        {labels.actual}: {fmtNumber(p.actual)} {labels.unit}
      </div>
      <div style={{ fontWeight: 600, color: deltaColor(p.delta) }}>
        Scostamento: {p.delta > 0 ? '+' : ''}
        {fmtNumber(p.delta)} {labels.unit}
      </div>
    </div>
  )
}

// Grafico previsione vs effettivo per PBI (nell'ordine del Backlog): in un
// solo grafico, per ogni PBI, la barra della previsione (grigia), quella del
// dato effettivo (blu) e lo scostamento effettivo - previsto (rosso sopra lo
// zero se oltre la previsione, verde sotto se entro). Usato per Sizing vs
// Durata e Ore stimate vs Ore loggate.
function PlanVsActualCard({
  title,
  description,
  emptyMessage,
  labels,
  points,
}: {
  title: string
  description: string
  emptyMessage: string
  labels: PlanVsActualLabels
  points: PlanVsActualPoint[]
}) {
  const over = points.filter((p) => p.delta > 0).length
  const totalPlanned = points.reduce((sum, p) => sum + p.planned, 0)
  const totalActual = points.reduce((sum, p) => sum + p.actual, 0)
  const totalDeltaPct = totalPlanned > 0 ? Math.round(((totalActual - totalPlanned) / totalPlanned) * 100) : null
  // Con molti PBI le etichette dei codici si inclinano per non sovrapporsi.
  const rotateLabels = points.length > 12

  return (
    <div className="card">
      <h3>{title}</h3>
      <p className="muted" style={{ marginTop: 0 }}>
        {description}
      </p>
      {points.length === 0 ? (
        <p className="muted">{emptyMessage}</p>
      ) : (
        <>
          <p style={{ fontSize: 13, marginTop: 0 }}>
            <strong>{points.length}</strong> PBI: <strong style={{ color: 'var(--danger)' }}>{over}</strong> oltre la
            previsione, <strong style={{ color: 'var(--success)' }}>{points.length - over}</strong> entro. Totale{' '}
            <strong>
              {fmtNumber(totalActual)} {labels.unit}
            </strong>{' '}
            effettivi su{' '}
            <strong>
              {fmtNumber(totalPlanned)} {labels.unit}
            </strong>{' '}
            previsti
            {totalDeltaPct !== null && (
              <>
                {' '}
                (<strong style={{ color: deltaColor(totalDeltaPct) }}>
                  {totalDeltaPct > 0 ? '+' : ''}
                  {totalDeltaPct}%
                </strong>
                )
              </>
            )}
            .
          </p>
          <div style={{ height: 320 }}>
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={points} margin={{ top: 8, right: 16, left: 8, bottom: 8 }} barGap={2}>
                <CartesianGrid strokeDasharray="3 3" vertical={false} />
                <XAxis
                  dataKey="key"
                  tick={{ fontSize: 11 }}
                  interval={0}
                  angle={rotateLabels ? -45 : 0}
                  textAnchor={rotateLabels ? 'end' : 'middle'}
                  height={rotateLabels ? 70 : 30}
                />
                <YAxis
                  tick={{ fontSize: 12 }}
                  label={{ value: labels.unit, angle: -90, position: 'insideLeft', style: { fontSize: 12, fill: 'var(--text-muted)' } }}
                />
                <Tooltip content={<PlanVsActualTooltip labels={labels} />} cursor={{ fill: 'var(--bg)' }} />
                <Legend
                  wrapperStyle={{ fontSize: 12 }}
                  // Voci scritte a mano (content): lo Scostamento ha due
                  // colori, uno per segno, che la legenda automatica - una
                  // voce per serie - non puo' mostrare. Recharts 3 non
                  // accetta piu' la prop "payload" per farlo.
                  content={() => (
                    <div style={{ display: 'flex', flexWrap: 'wrap', justifyContent: 'center', gap: '4px 14px' }}>
                      {[
                        { value: labels.planned, color: COLOR_PLANNED },
                        { value: labels.actual, color: COLOR_ACTUAL },
                        { value: 'Scostamento oltre la previsione', color: 'var(--danger)' },
                        { value: 'Scostamento entro la previsione', color: 'var(--success)' },
                      ].map((entry) => (
                        <span key={entry.value} style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
                          <span style={{ width: 10, height: 10, background: entry.color, flexShrink: 0 }} />
                          {entry.value}
                        </span>
                      ))}
                    </div>
                  )}
                />
                <ReferenceLine y={0} stroke="var(--text-muted)" />
                <Bar dataKey="planned" name={labels.planned} fill={COLOR_PLANNED} radius={[3, 3, 0, 0]} maxBarSize={22} />
                <Bar dataKey="actual" name={labels.actual} fill={COLOR_ACTUAL} radius={[3, 3, 0, 0]} maxBarSize={22} />
                <Bar dataKey="delta" name="Scostamento" radius={[3, 3, 3, 3]} maxBarSize={22}>
                  {points.map((p) => (
                    <Cell key={p.key} fill={deltaColor(p.delta)} />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>
        </>
      )}
    </div>
  )
}

// PBI in scope nell'ordine del Backlog, con i due valori (previsto,
// effettivo) estratti da getValues; esclusi quelli a cui ne manca uno.
function planVsActualPoints(
  items: BacklogItem[] | undefined,
  getValues: (i: BacklogItem) => [number | null | undefined, number | null | undefined],
): PlanVsActualPoint[] {
  return [...(items ?? [])]
    .filter((i) => i.in_scope)
    .sort((a, b) => a.priority_order - b.priority_order)
    .flatMap((i) => {
      const [planned, actual] = getValues(i)
      if (planned == null || actual == null) return []
      return [{ key: i.jira_key, summary: i.summary, planned, actual, delta: actual - planned }]
    })
}

// Periodi selezionabili nella card delle issue (sezione delle chiuse): finestre mobili
// all'indietro da oggi, non settimana/mese di calendario.
const RECENTLY_CLOSED_PERIODS = [
  { days: 7, label: 'Ultima settimana', title: "nell'ultima settimana" },
  { days: 14, label: 'Ultime 2 settimane', title: 'nelle ultime 2 settimane' },
  { days: 30, label: 'Ultimo mese', title: "nell'ultimo mese" },
]

// Issue in scope chiuse negli ultimi `days` giorni (oggi compreso), dalla
// piu' recente: Done con Actual finish (dal sync Jira) da `days` giorni fa in
// poi. Le date sono stringhe ISO yyyy-mm-dd, confrontabili direttamente.
function recentlyClosedItems(items: BacklogItem[] | undefined, days: number): BacklogItem[] {
  const cutoff = new Date()
  cutoff.setDate(cutoff.getDate() - days)
  const pad = (n: number) => String(n).padStart(2, '0')
  const cutoffStr = `${cutoff.getFullYear()}-${pad(cutoff.getMonth() + 1)}-${pad(cutoff.getDate())}`
  return (items ?? [])
    .filter((i) => i.in_scope && i.status === 'Done' && i.actual_finish != null && i.actual_finish >= cutoffStr)
    .sort((a, b) => (b.actual_finish ?? '').localeCompare(a.actual_finish ?? '') || a.priority_order - b.priority_order)
}

type RecentlyClosedPeriod = (typeof RECENTLY_CLOSED_PERIODS)[number]

function RecentlyClosedCard({
  items,
  period,
  setPeriod,
}: {
  items: BacklogItem[] | undefined
  period: RecentlyClosedPeriod
  setPeriod: (period: RecentlyClosedPeriod) => void
}) {
  const closed = recentlyClosedItems(items, period.days)
  // Sotto le chiuse, come nella presentazione: le issue in scope in
  // lavorazione ora e quelle ancora da iniziare che contano per il code
  // freeze (in scope e con impatto sul code freeze), nell'ordine del Backlog.
  const byBacklogOrder = (a: BacklogItem, b: BacklogItem) => a.priority_order - b.priority_order
  const inProgress = (items ?? []).filter((i) => i.in_scope && i.status === 'In Progress').sort(byBacklogOrder)
  const toDo = (items ?? [])
    .filter((i) => i.in_scope && i.included_in_codefreeze && i.status === 'To Do')
    .sort(byBacklogOrder)
  return (
    <div className="card">
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          flexWrap: 'wrap',
          gap: 8,
          marginBottom: 12,
        }}
      >
        <h3 style={{ marginBottom: 0 }}>
          Issue chiuse {period.title}
          {closed.length > 0 && ` (${closed.length})`}
        </h3>
        <div className="filter-group">
          {RECENTLY_CLOSED_PERIODS.map((p) => (
            <button
              key={p.days}
              className={`btn filter-btn${p.days === period.days ? ' active' : ''}`}
              aria-pressed={p.days === period.days}
              onClick={() => setPeriod(p)}
            >
              {p.label}
            </button>
          ))}
        </div>
      </div>
      <IssueTable
        items={closed}
        lastHeader="Chiusa il"
        lastValue={(item) => formatIsoDate(item.actual_finish)}
        emptyMessage={`Nessuna issue in scope chiusa negli ultimi ${period.days} giorni.`}
      />
      <h4 style={{ margin: '20px 0 12px' }}>In progress ({inProgress.length})</h4>
      <IssueTable
        items={inProgress}
        lastHeader="Iniziata il"
        lastValue={(item) => formatIsoDate(item.actual_start)}
        emptyMessage="Nessuna issue in scope in progress."
      />
      <h4 style={{ margin: '20px 0 12px' }}>Da fare ({toDo.length})</h4>
      <IssueTable
        items={toDo}
        lastHeader="Stato Jira"
        lastValue={(item) => item.jira_status ?? 'To Do'}
        emptyMessage="Nessuna issue in scope ancora da iniziare."
      />
    </div>
  )
}

// Tabella di issue della card qui sopra: le tre sezioni (chiuse, in progress,
// da fare) cambiano solo nell'ultima colonna. Larghezze fisse sulle colonne
// strette, cosi' le tre tabelle restano allineate tra loro.
function IssueTable({
  items,
  lastHeader,
  lastValue,
  emptyMessage,
}: {
  items: BacklogItem[]
  lastHeader: string
  lastValue: (item: BacklogItem) => string | null
  emptyMessage: string
}) {
  if (items.length === 0) {
    return (
      <p className="muted" style={{ margin: 0 }}>
        {emptyMessage}
      </p>
    )
  }
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            <th style={{ width: 120 }}>ID</th>
            <th style={{ width: 120 }}>Tipo</th>
            <th>Summary</th>
            <th style={{ width: 150 }}>{lastHeader}</th>
          </tr>
        </thead>
        <tbody>
          {items.map((item) => (
            <tr key={item.id}>
              <td>
                <a href={`https://inpeco.atlassian.net/browse/${item.jira_key}`} target="_blank" rel="noreferrer">
                  {item.jira_key}
                </a>
              </td>
              <td>{item.issue_type ?? <span className="muted">-</span>}</td>
              <td style={{ whiteSpace: 'normal' }}>{item.summary ?? <span className="muted">-</span>}</td>
              <td>{lastValue(item) ?? <span className="muted">-</span>}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

export function DashboardPage() {
  const { project } = useProjectContext()
  const queryClient = useQueryClient()

  const updateStatus = useMutation({
    mutationFn: (status: string) => api.projects.update(project.id, { status }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['project', project.id] }),
  })

  // Periodo della card delle issue chiuse: tenuto qui (non nella card)
  // perche' la presentazione generata usa lo stesso periodo.
  const [closedPeriod, setClosedPeriod] = useState(RECENTLY_CLOSED_PERIODS[0])

  const presentation = useMutation({
    mutationFn: () => api.dashboard.presentation(project.id, closedPeriod.days),
    onSuccess: ({ blob, filename }) => saveBlob(blob, filename),
  })

  // Stessa query cache di PhasesCard (query key condivisa): lo stato del
  // progetto e' scelto tra le fasi definite, non un elenco fisso - fasi
  // diverse per processi diversi danno stati diversi.
  const { data: phases } = useQuery({
    queryKey: ['phases', project.id],
    queryFn: () => api.phases.list(project.id),
  })
  const phaseNames = (phases ?? []).map((p) => p.name)
  const statusOptions = phaseNames

  const { data: metrics } = useQuery({
    queryKey: ['dashboard', project.id],
    queryFn: () => api.dashboard.get(project.id),
  })

  const { data: snapshots } = useQuery({
    queryKey: ['snapshots', project.id],
    queryFn: () => api.snapshots.list(project.id),
  })

  // Stessa query (e cache) della tab Backlog.
  const { data: backlogItems } = useQuery({
    queryKey: ['backlog', project.id],
    queryFn: () => api.backlog.list(project.id),
  })

  const startEpoch = dateStrToEpochDays(project.start_date)
  const freezeEpoch = dateStrToEpochDays(project.code_freeze_date)
  // Con inizio e code freeze noti si puo' tracciare l'obiettivo: la data del
  // code freeze e la linea ideale, dallo 0% all'inizio al 100% al code freeze.
  const hasPlan = startEpoch !== null && freezeEpoch !== null && freezeEpoch > startEpoch

  // % completamento dagli snapshot di Andamento, su un asse di date vere
  // (giorni) per poterla confrontare con la linea ideale: in ogni punto,
  // dove dovremmo essere per arrivare al 100% al code freeze.
  const completionByEpoch = new Map<number, number | null>()
  for (const s of snapshots ?? []) {
    const epoch = dateStrToEpochDays(s.snapshot_date)
    if (epoch === null) continue
    completionByEpoch.set(epoch, s.pbi_total ? Math.round(((s.pbi_done ?? 0) / s.pbi_total) * 100) : null)
  }
  const chartData = Array.from(new Set([...completionByEpoch.keys(), ...(hasPlan ? [startEpoch, freezeEpoch] : [])]))
    .sort((a, b) => a - b)
    .map((epoch) => ({
      x: epoch,
      completamento: completionByEpoch.get(epoch) ?? null,
      ideale: hasPlan
        ? Math.round(Math.min(Math.max((epoch - startEpoch) / (freezeEpoch - startEpoch), 0), 1) * 1000) / 10
        : null,
    }))

  // Ore effettive dagli snapshot di Andamento (actual_hours = "Actual
  // (PowerBI)", logged_hours = "Actual logged") nel tempo.

  let hoursChartData: { x: number; actualHours: number | null; actualLogged: number | null }[] = []
  if (startEpoch !== null && freezeEpoch !== null && freezeEpoch > startEpoch) {
    const snapshotByEpoch = new Map((snapshots ?? []).map((s) => [dateStrToEpochDays(s.snapshot_date), s]))
    const allEpochs = Array.from(new Set([startEpoch, freezeEpoch, ...snapshotByEpoch.keys()]))
      .filter((e): e is number => e !== null)
      .sort((a, b) => a - b)

    hoursChartData = allEpochs.map((epoch) => {
      const snap = snapshotByEpoch.get(epoch)
      return {
        x: epoch,
        actualHours: snap?.actual_hours ?? null,
        actualLogged: snap?.logged_hours ?? null,
      }
    })
  }

  return (
    <div>
      <div className="card">
        <div className="page-header" style={{ marginBottom: 0 }}>
          <h3 style={{ margin: 0 }}>Stato increment</h3>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <select
              value={project.status}
              onChange={(e) => updateStatus.mutate(e.target.value)}
              disabled={updateStatus.isPending}
            >
              {statusOptions.map((s) => (
                <option key={s}>{s}</option>
              ))}
            </select>
            <button
              className="btn btn-primary"
              title="Scarica una presentazione PowerPoint coi dati di questa dashboard"
              disabled={presentation.isPending}
              onClick={() => presentation.mutate()}
            >
              {presentation.isPending ? 'Generazione…' : '⬇ Genera presentazione (.pptx)'}
            </button>
          </div>
        </div>
        {presentation.isError && (
          <div className="error-banner" style={{ marginTop: 10, marginBottom: 0 }}>
            Generazione della presentazione non riuscita: {(presentation.error as Error).message}
          </div>
        )}
      </div>

      <ScopeCard projectId={project.id} scope={project.scope} />

      <div className="card">
        <div className="grid-4">
          <div className="stat">
            <span className="value">{metrics ? pct(metrics.percent_complete) : '—'}</span>
            <span className="label">
              Completamento backlog ({metrics?.backlog_done ?? 0}/{metrics?.backlog_in_scope ?? 0})
            </span>
            {metrics?.completion_source === 'snapshot' && (
              <span className="muted" style={{ fontSize: 11 }}>
                da snapshot del {formatIsoDate(metrics.last_snapshot_date)}
              </span>
            )}
          </div>
          <div className="stat">
            <span className="value">{metrics?.logged_hours_total ?? 0} h</span>
            <span className="label">Ore usate</span>
            {metrics?.percent_budget_used != null && (
              <span
                style={{ fontSize: 13 }}
                title={`Budget ore: somma dei budget dei progetti e sotto-progetti collegati (${[
                  ...project.progetti.map((p) => p.code),
                  ...project.sub_projects.map((s) => `${s.increment_code} › ${s.name}`),
                ].join(', ')})`}
              >
                <strong style={metrics.percent_budget_used > 1 ? { color: 'var(--danger)' } : undefined}>
                  {pct(metrics.percent_budget_used)}
                </strong>{' '}
                del budget di {metrics.budget_hours_total.toLocaleString('it-IT')} h
              </span>
            )}
            {metrics?.logged_hours_source === 'snapshot' && (
              <span className="muted" style={{ fontSize: 11 }}>
                da snapshot del {formatIsoDate(metrics.last_snapshot_date)}
              </span>
            )}
          </div>
          <div className="stat">
            <span className={`value ${metrics ? spiTone(metrics.spi) : ''}`}>
              {metrics?.spi != null ? metrics.spi.toFixed(2) : '—'}
            </span>
            <span className="label">SPI (avanzamento / tempo trascorso)</span>
          </div>
          <div className="stat">
            {metrics && spiStatusLabel(metrics.spi) ? (
              <span className={`badge ${BADGE_CLASS_BY_TONE[spiTone(metrics.spi)]}`} style={{ width: 'fit-content' }}>
                {spiStatusLabel(metrics.spi)}
              </span>
            ) : (
              <span className="value">—</span>
            )}
            <span className="label">Status</span>
          </div>
        </div>
      </div>

      <RecentlyClosedCard items={backlogItems} period={closedPeriod} setPeriod={setClosedPeriod} />

      <PhasesCard projectId={project.id} currentStatus={project.status} />

      <div className="card">
        <h3>Ore Usate nel Tempo</h3>
        {hoursChartData.length === 0 ? (
          <p className="muted">
            Servono la data di inizio increment e la data di code freeze (scheda increment) per tracciare le ore nel
            tempo.
          </p>
        ) : (
          <div style={{ height: 260 }}>
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={hoursChartData} margin={{ top: 8, right: 16, left: 8, bottom: 8 }}>
                <CartesianGrid strokeDasharray="3 3" />
                <XAxis
                  dataKey="x"
                  type="number"
                  domain={[startEpoch ?? 0, freezeEpoch ?? 1]}
                  tickFormatter={formatEpochDaysAsDate}
                  tick={{ fontSize: 12 }}
                />
                <YAxis tick={{ fontSize: 12 }} label={{ value: 'Ore', angle: -90, position: 'insideLeft', style: { fontSize: 12, fill: '#898781' } }} />
                <Tooltip labelFormatter={(v) => formatEpochDaysAsDate(Number(v))} />
                <Legend wrapperStyle={{ fontSize: 12 }} />
                <Line
                  type="monotone"
                  dataKey="actualHours"
                  name="Actual (PowerBI) (h)"
                  stroke={COLOR_ACTUAL_HOURS}
                  strokeWidth={2}
                  dot={{ r: 4 }}
                  connectNulls
                />
                <Line
                  type="monotone"
                  dataKey="actualLogged"
                  name="Actual logged (dev+test)"
                  stroke={COLOR_ACTUAL_LOGGED}
                  strokeWidth={2}
                  dot={{ r: 4 }}
                  connectNulls
                />
              </LineChart>
            </ResponsiveContainer>
          </div>
        )}
      </div>

      <div className="card">
        <h3>Andamento % completamento nel tempo</h3>
        {completionByEpoch.size === 0 ? (
          <p className="muted">
            Nessuno snapshot registrato. Aggiungine uno dalla tab "Andamento" per iniziare a tracciare lo storico.
          </p>
        ) : (
          <>
            {!hasPlan && (
              <p className="muted" style={{ marginTop: 0 }}>
                Imposta la data di inizio increment e la data di code freeze (scheda increment) per vedere il code
                freeze e la linea ideale.
              </p>
            )}
            <div style={{ height: 260 }}>
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={chartData} margin={{ top: 20, right: 24, left: 8, bottom: 8 }}>
                  <CartesianGrid strokeDasharray="3 3" />
                  <XAxis
                    dataKey="x"
                    type="number"
                    domain={['dataMin', 'dataMax']}
                    tickFormatter={formatEpochDaysAsDate}
                    tick={{ fontSize: 12 }}
                  />
                  <YAxis unit="%" domain={[0, 100]} tick={{ fontSize: 12 }} />
                  <Tooltip labelFormatter={(v) => formatEpochDaysAsDate(Number(v))} formatter={(v) => `${v}%`} />
                  <Legend wrapperStyle={{ fontSize: 12 }} />
                  {hasPlan && (
                    <ReferenceLine
                      x={freezeEpoch}
                      stroke={COLOR_CODE_FREEZE}
                      strokeDasharray="4 4"
                      label={{
                        value: `Code freeze ${formatEpochDaysAsDate(freezeEpoch)}`,
                        position: 'insideBottomRight',
                        fill: COLOR_CODE_FREEZE,
                        fontSize: 12,
                      }}
                    />
                  )}
                  {hasPlan && (
                    <Line
                      type="linear"
                      dataKey="ideale"
                      name="Ideale"
                      stroke={COLOR_PLANNED}
                      strokeWidth={2}
                      strokeDasharray="6 4"
                      dot={false}
                    />
                  )}
                  <Line
                    type="linear"
                    dataKey="completamento"
                    name="Completamento"
                    stroke={COLOR_ACTUAL}
                    strokeWidth={2}
                    dot={{ r: 4 }}
                    connectNulls
                  />
                </LineChart>
              </ResponsiveContainer>
            </div>
          </>
        )}
      </div>

      <PlanVsActualCard
        title="Sizing vs Durata"
        description="Per ogni PBI in scope: Sizing (previsione) e Durata effettiva in giorni lavorativi, da Actual start ad Actual finish come nella colonna Durata (gg) del Backlog, con lo scostamento Durata - Sizing."
        emptyMessage="Nessun PBI con sia il Sizing (gg) sia la Durata (gg): servono il Sizing compilato nel Backlog e le date effettive di inizio/fine dal sync Jira."
        labels={{ planned: 'Sizing', actual: 'Durata', unit: 'gg' }}
        points={planVsActualPoints(backlogItems, (i) => [i.planned_duration_days, workingDaysBetween(i.actual_start, i.actual_finish)])}
      />
      <PlanVsActualCard
        title="Ore stimate vs Ore loggate"
        description="Per ogni PBI in scope: Ore stimate (Developer Effort da Jira, solo Story) e Ore loggate, con lo scostamento Ore loggate - Ore stimate."
        emptyMessage="Nessun PBI con sia le Ore stimate sia le Ore loggate."
        labels={{ planned: 'Ore stimate', actual: 'Ore loggate', unit: 'h' }}
        points={planVsActualPoints(backlogItems, (i) => [i.dev_effort_hours, i.logged_hours])}
      />
    </div>
  )
}
