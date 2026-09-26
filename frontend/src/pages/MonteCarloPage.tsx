import { useQuery } from '@tanstack/react-query'
import { useMemo, useState } from 'react'
import { Bar, BarChart, CartesianGrid, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { api } from '../api/client'
import type { Team } from '../api/types'
import { countBacklogStats } from '../lib/backlogStats'
import { dateStrToEpochDays, formatEpochDaysAsDate, formatIsoDate, toEpochDays } from '../lib/dates'
import {
  dailyThroughputSamples,
  interpolatedPercentile,
  nearestRank,
  simulateHowMany,
  simulateWhen,
} from '../lib/monteCarlo'
import { useProjectContext } from './useProjectContext'

type Mode = 'when' | 'howMany'

const ISSUE_TYPES = ['Story', 'Bug', 'Activity', 'Task']
const HISTORY_WINDOWS = [
  { days: 90, label: 'Ultimi 3 mesi' },
  { days: 180, label: 'Ultimi 6 mesi' },
  { days: 365, label: 'Ultimo anno' },
]
const CONFIDENCE_LEVELS = [50, 70, 85, 95]
// Numero massimo di barre dell'istogramma: oltre, i valori si raggruppano
// in intervalli piu' larghi (settimane per le date, range per i conteggi).
const MAX_BUCKETS = 45

function todayIso(): string {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

type SimulationResult = {
  mode: Mode
  // Ordinati crescenti: epoch days per "When", conteggi item per "How Many".
  values: number[]
  itemCount: number
  startDay: number
  endDay: number
  sampleDays: number
}

type Bucket = { from: number; to: number; label: string; pct: number; cumulativePct: number }

function buildBuckets(result: SimulationResult): Bucket[] {
  const { values, mode } = result
  const min = values[0]
  const max = values[values.length - 1]
  const width = Math.max(1, Math.ceil((max - min + 1) / MAX_BUCKETS))
  const format = (v: number) => (mode === 'when' ? formatEpochDaysAsDate(v) : String(v))
  const buckets: Bucket[] = []
  let i = 0
  for (let from = min; from <= max; from += width) {
    const to = from + width - 1
    let count = 0
    while (i < values.length && values[i] <= to) {
      count++
      i++
    }
    buckets.push({
      from,
      to,
      label: width === 1 ? format(from) : `${format(from)} – ${format(to)}`,
      pct: (count / values.length) * 100,
      cumulativePct: (i / values.length) * 100,
    })
  }
  return buckets
}

function bucketLabelFor(buckets: Bucket[], value: number): string | undefined {
  return buckets.find((b) => value >= b.from && value <= b.to)?.label
}

function HistogramTooltip({
  active,
  payload,
  mode,
}: {
  active?: boolean
  payload?: { payload: Bucket }[]
  mode: Mode
}) {
  if (!active || !payload || !payload.length) return null
  const b = payload[0].payload
  return (
    <div
      style={{
        background: 'var(--surface)',
        border: '1px solid var(--border)',
        borderRadius: 6,
        padding: '6px 10px',
        fontSize: 12,
        boxShadow: '0 2px 8px rgba(0,0,0,0.12)',
      }}
    >
      <div style={{ fontWeight: 600 }}>{mode === 'when' ? `Completamento: ${b.label}` : `${b.label} item`}</div>
      <div>{b.pct.toFixed(1)}% delle simulazioni</div>
      <div className="muted">
        {mode === 'when'
          ? `${b.cumulativePct.toFixed(1)}% completate entro questa data`
          : `${(100 - b.cumulativePct + b.pct).toFixed(1)}% chiudono almeno ${b.from} item`}
      </div>
    </div>
  )
}

// Sezione Monte Carlo dell'increment: previsione "When" (entro quando
// chiudiamo N item partendo da una data) o "How Many" (quanti item chiudiamo
// tra due date), campionando il throughput giornaliero storico del team.
// Sorgente dati: gli stessi PBI Done degli ultimi 12 mesi del grafico Cycle
// Time della Dashboard generale (stessa query React Query, un'unica
// estrazione Jira condivisa), filtrati per tipo di item.
export function MonteCarloPage() {
  const { project } = useProjectContext()

  const [mode, setMode] = useState<Mode>('when')
  const [team, setTeam] = useState<Team>('sw')
  const [issueTypes, setIssueTypes] = useState<string[]>(['Story', 'Bug'])
  const [excludeCve, setExcludeCve] = useState(true)
  const [historyDays, setHistoryDays] = useState(365)
  const [workingDaysOnly, setWorkingDaysOnly] = useState(true)
  const [startDate, setStartDate] = useState(todayIso())
  const [itemCountInput, setItemCountInput] = useState<string | null>(null)
  const [endDateInput, setEndDateInput] = useState<string | null>(null)
  const [iterations, setIterations] = useState(10000)
  // Incrementato da "Ripeti simulazione": forza una nuova estrazione
  // casuale anche a parametri invariati.
  const [runId, setRunId] = useState(0)

  // L'estrazione Jira e' lenta (un changelog per issue): la si tiene in
  // cache finche' non la si aggiorna a mano, invece dei 10s di default.
  const cycleTime = useQuery({
    queryKey: ['dashboard', 'cycle-time', team],
    queryFn: () => api.dashboard.cycleTime(team),
    staleTime: Infinity,
  })
  const { data: backlogItems } = useQuery({
    queryKey: ['backlog', project.id],
    queryFn: () => api.backlog.list(project.id),
  })
  const { remainingCount } = countBacklogStats(backlogItems ?? [])

  // Default finche' l'utente non li modifica: item rimanenti del backlog
  // dell'increment (gia' limitati a quelli inclusi nel code freeze, vedi
  // countBacklogStats) e sua data di code freeze: e' quella la scadenza a
  // cui si riferisce la previsione, non la planned finish.
  const itemCount = itemCountInput ?? String(remainingCount)
  const endDate = endDateInput ?? project.code_freeze_date ?? ''

  const today = toEpochDays(new Date(`${todayIso()}T00:00:00Z`))

  const history = useMemo(() => {
    const points = (cycleTime.data?.points ?? []).filter(
      (p) => issueTypes.includes(p.issue_type) && !(excludeCve && p.is_cve),
    )
    const fromDay = today - historyDays
    const toDay = today - 1
    const inWindow = points.filter((p) => {
      const d = dateStrToEpochDays(p.finish_date)
      return d !== null && d >= fromDay && d <= toDay
    })
    const finishDays = inWindow.map((p) => dateStrToEpochDays(p.finish_date) as number)
    const samples = dailyThroughputSamples(finishDays, fromDay, toDay, workingDaysOnly)
    const cycleTimes = inWindow.map((p) => p.cycle_time_days).sort((a, b) => a - b)
    return {
      itemCount: inWindow.length,
      samples,
      perWeek: (inWindow.length / historyDays) * 7,
      p50: interpolatedPercentile(cycleTimes, 50),
      p85: interpolatedPercentile(cycleTimes, 85),
      p95: interpolatedPercentile(cycleTimes, 95),
    }
  }, [cycleTime.data, issueTypes, excludeCve, historyDays, workingDaysOnly, today])

  const toggleIssueType = (t: string) =>
    setIssueTypes((prev) => (prev.includes(t) ? prev.filter((x) => x !== t) : [...prev, t]))

  // Rieseguita in automatico a ogni cambio di parametro (anche dello
  // storico): con 10.000 prove costa pochi millisecondi, niente pulsante.
  const { result, error: runError } = useMemo((): { result: SimulationResult | null; error: string | null } => {
    if (!cycleTime.data || cycleTime.data.error) return { result: null, error: null }
    const startDay = dateStrToEpochDays(startDate)
    if (startDay === null) return { result: null, error: 'Data di inizio non valida.' }
    if (history.itemCount === 0) {
      return { result: null, error: 'Nessun item completato nello storico selezionato: impossibile simulare.' }
    }
    const n = Number(itemCount)
    const endDay = dateStrToEpochDays(endDate)
    if (mode === 'when' && !(Number.isInteger(n) && n > 0)) {
      return { result: null, error: 'Inserisci un numero di item intero maggiore di zero.' }
    }
    if (mode === 'howMany' && (endDay === null || endDay < startDay)) {
      return { result: null, error: 'Inserisci una data di fine successiva alla data di inizio.' }
    }
    const iter = Math.min(100000, Math.max(100, Math.round(iterations) || 0))
    const values =
      mode === 'when'
        ? simulateWhen(history.samples, n, startDay, iter, workingDaysOnly)
        : simulateHowMany(history.samples, startDay, endDay as number, iter, workingDaysOnly)
    return {
      result: { mode, values, itemCount: n, startDay, endDay: endDay ?? startDay, sampleDays: history.samples.length },
      error: null,
    }
    // runId non e' letto: serve solo a ricalcolare su richiesta.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cycleTime.data, history, startDate, itemCount, endDate, mode, iterations, workingDaysOnly, runId])

  const buckets = result ? buildBuckets(result) : []
  const percentileValue = (level: number) =>
    result
      ? // How Many: "all'85% chiudiamo ALMENO N item" e' il 15° percentile
        // della distribuzione, non l'85°.
        nearestRank(result.values, result.mode === 'when' ? level : 100 - level)
      : 0
  const formatValue = (v: number) => (result?.mode === 'when' ? formatEpochDaysAsDate(v) : `${v} item`)

  const codeFreezeDay = dateStrToEpochDays(project.code_freeze_date)
  let highlight: string | null = null
  if (result?.mode === 'when' && codeFreezeDay !== null) {
    const p = (result.values.filter((v) => v <= codeFreezeDay).length / result.values.length) * 100
    highlight = `Probabilità di chiudere ${result.itemCount} item entro il code freeze (${formatIsoDate(project.code_freeze_date)}): ${p.toFixed(0)}%`
  } else if (result?.mode === 'howMany' && remainingCount > 0) {
    const p = (result.values.filter((v) => v >= remainingCount).length / result.values.length) * 100
    highlight = `Probabilità di chiudere tutti i ${remainingCount} item rimanenti del backlog (perimetro code freeze) entro il ${formatEpochDaysAsDate(result.endDay)}: ${p.toFixed(0)}%`
  }

  return (
    <div>
      <div className="card">
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 8 }}>
          <h3 style={{ margin: 0 }}>Simulazione Monte Carlo</h3>
          <div style={{ display: 'flex', gap: 2, border: '1px solid var(--border)', borderRadius: 'var(--radius)', padding: 2 }}>
            {(
              [
                { key: 'when', label: 'When · entro quando?' },
                { key: 'howMany', label: 'How Many · quanti item?' },
              ] as { key: Mode; label: string }[]
            ).map((m) => (
              <button
                key={m.key}
                onClick={() => setMode(m.key)}
                style={{
                  border: 'none',
                  borderRadius: 6,
                  padding: '4px 12px',
                  fontSize: 13,
                  cursor: 'pointer',
                  background: mode === m.key ? 'var(--primary)' : 'transparent',
                  color: mode === m.key ? 'white' : 'var(--text)',
                  fontWeight: mode === m.key ? 600 : 400,
                }}
              >
                {m.label}
              </button>
            ))}
          </div>
        </div>
        <p className="muted" style={{ marginTop: 8 }}>
          {mode === 'when'
            ? 'Entro quale data, con i vari livelli di confidenza, riusciamo a chiudere un certo numero di item a partire da una data.'
            : 'Quanti item riusciamo a chiudere, con i vari livelli di confidenza, tra la data di inizio e la data di fine.'}{' '}
          Ogni simulazione ripete giorno per giorno un throughput giornaliero estratto a caso dallo storico selezionato.
        </p>

        <div className="grid-2" style={{ marginTop: 12 }}>
          <div>
            <h4 style={{ marginTop: 0 }}>Storico (dati Jira)</h4>
            <div className="form-row">
              <label>Team</label>
              <select value={team} onChange={(e) => setTeam(e.target.value as Team)}>
                <option value="sw">Team SW</option>
                <option value="embedded">Team Embedded</option>
              </select>
            </div>
            <div className="form-row">
              <label>Tipi di item</label>
              <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', fontSize: 13 }}>
                {ISSUE_TYPES.map((t) => (
                  <label key={t} style={{ display: 'flex', gap: 4, alignItems: 'center', color: 'var(--text)', fontSize: 13 }}>
                    <input type="checkbox" checked={issueTypes.includes(t)} onChange={() => toggleIssueType(t)} />
                    {t}
                  </label>
                ))}
                <label style={{ display: 'flex', gap: 4, alignItems: 'center', color: 'var(--text)', fontSize: 13 }}>
                  <input type="checkbox" checked={excludeCve} onChange={(e) => setExcludeCve(e.target.checked)} />
                  Escludi Bug CVE
                </label>
              </div>
            </div>
            <div className="form-row">
              <label>Finestra storica</label>
              <select value={historyDays} onChange={(e) => setHistoryDays(Number(e.target.value))}>
                {HISTORY_WINDOWS.map((w) => (
                  <option key={w.days} value={w.days}>
                    {w.label}
                  </option>
                ))}
              </select>
            </div>
            <label style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 13 }}>
              <input type="checkbox" checked={workingDaysOnly} onChange={(e) => setWorkingDaysOnly(e.target.checked)} />
              Solo giorni lavorativi (i weekend non contano né nello storico né nella simulazione)
            </label>

            <div style={{ marginTop: 12, fontSize: 13 }}>
              {cycleTime.isLoading ? (
                <span className="muted">Estrazione dati da Jira in corso (può richiedere qualche minuto)...</span>
              ) : cycleTime.data?.error ? (
                <span style={{ color: 'var(--danger)' }}>{cycleTime.data.error}</span>
              ) : cycleTime.isError ? (
                <span style={{ color: 'var(--danger)' }}>{(cycleTime.error as Error).message}</span>
              ) : (
                <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
                  <span>
                    <strong>{history.itemCount}</strong> item completati · <strong>{history.perWeek.toFixed(1)}</strong>/settimana
                  </span>
                  {history.p85 != null && (
                    <span className="muted">
                      Cycle time P50 {history.p50?.toFixed(1)}g · P85 {history.p85.toFixed(1)}g · P95{' '}
                      {history.p95?.toFixed(1)}g
                    </span>
                  )}
                  <button
                    className="btn"
                    onClick={() => cycleTime.refetch()}
                    disabled={cycleTime.isFetching}
                    style={{ fontSize: 12, padding: '4px 10px' }}
                  >
                    {cycleTime.isFetching ? 'Aggiornamento...' : '⟳ Aggiorna da Jira'}
                  </button>
                </div>
              )}
            </div>
          </div>

          <div>
            <h4 style={{ marginTop: 0 }}>Parametri</h4>
            <div className="form-row">
              <label>Data di inizio</label>
              <input type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} />
            </div>
            {mode === 'when' ? (
              <div className="form-row">
                <label>Numero di item da chiudere (default: item rimanenti del backlog inclusi nel code freeze)</label>
                <input type="number" min={1} value={itemCount} onChange={(e) => setItemCountInput(e.target.value)} />
              </div>
            ) : (
              <div className="form-row">
                <label>Data di fine (default: code freeze dell'increment)</label>
                <input type="date" value={endDate} onChange={(e) => setEndDateInput(e.target.value)} />
              </div>
            )}
            <div className="form-row">
              <label>Numero di simulazioni</label>
              <input
                type="number"
                min={100}
                max={100000}
                step={1000}
                value={iterations}
                onChange={(e) => setIterations(Number(e.target.value))}
              />
            </div>
            <button className="btn" onClick={() => setRunId((r) => r + 1)} disabled={!result}>
              ⟳ Ripeti simulazione
            </button>
            <span className="muted" style={{ fontSize: 12, marginLeft: 8 }}>
              I risultati si aggiornano da soli a ogni modifica dei parametri.
            </span>
            {runError && <p style={{ color: 'var(--danger)', fontSize: 13 }}>{runError}</p>}
          </div>
        </div>
      </div>

      {result && (
        <div className="card">
          <h3>
            {result.mode === 'when'
              ? `Quando chiudiamo ${result.itemCount} item partendo dal ${formatEpochDaysAsDate(result.startDay)}?`
              : `Quanti item chiudiamo dal ${formatEpochDaysAsDate(result.startDay)} al ${formatEpochDaysAsDate(result.endDay)}?`}
          </h3>
          <p className="muted" style={{ marginTop: -8 }}>
            {result.values.length.toLocaleString('it-IT')} simulazioni su {result.sampleDays} giorni di storico.
          </p>

          <div className="stat-chips">
            {CONFIDENCE_LEVELS.map((level) => (
              <div key={level} className={`stat-chip ${level === 85 ? 'orange' : 'blue'}`}>
                <span className="label">{level}% di confidenza</span>
                <span className="value">
                  {result.mode === 'howMany' && 'almeno '}
                  {formatValue(percentileValue(level))}
                </span>
              </div>
            ))}
          </div>
          {highlight && <p style={{ fontSize: 13, fontWeight: 600 }}>{highlight}</p>}

          <div style={{ height: 320 }}>
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={buckets} margin={{ top: 20, right: 24, left: 8, bottom: 8 }} barCategoryGap={2}>
                <CartesianGrid strokeDasharray="3 3" vertical={false} />
                <XAxis dataKey="label" tick={{ fontSize: 11 }} minTickGap={16} />
                <YAxis
                  tick={{ fontSize: 12 }}
                  tickFormatter={(v: number) => `${v}%`}
                  label={{
                    value: '% simulazioni',
                    angle: -90,
                    position: 'insideLeft',
                    style: { fontSize: 12, fill: 'var(--text-muted)' },
                  }}
                />
                <Tooltip content={<HistogramTooltip mode={result.mode} />} cursor={{ fill: 'rgba(0,0,0,0.04)' }} />
                {[
                  { level: 50, color: 'var(--text-muted)' },
                  { level: 85, color: 'var(--warning)' },
                  { level: 95, color: 'var(--danger)' },
                ].map(({ level, color }) => {
                  const label = bucketLabelFor(buckets, percentileValue(level))
                  return label ? (
                    <ReferenceLine
                      key={level}
                      x={label}
                      stroke={color}
                      strokeDasharray="4 4"
                      label={{ value: `${level}%`, position: 'top', fontSize: 11, fill: color }}
                    />
                  ) : null
                })}
                <Bar dataKey="pct" fill="var(--primary)" radius={[4, 4, 0, 0]} isAnimationActive={false} />
              </BarChart>
            </ResponsiveContainer>
          </div>
          <p className="muted" style={{ fontSize: 12, marginBottom: 0 }}>
            {result.mode === 'when'
              ? 'Distribuzione delle date di completamento: più la linea di confidenza è a destra, più la data è prudente.'
              : 'Distribuzione degli item chiusi: il valore a N% di confidenza è quello raggiunto o superato nell’N% delle simulazioni.'}
          </p>
        </div>
      )}
    </div>
  )
}
