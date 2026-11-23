import { createContext, useCallback, useContext, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { useIsFetching, useMutation, useQueries, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import { createPortal } from 'react-dom'
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  ComposedChart,
  LabelList,
  Legend,
  Line,
  LineChart,
  Pie,
  PieChart,
  ReferenceLine,
  Scatter,
  ScatterChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'
import { api, saveBlob } from '../api/client'
import { SyncProgressModal } from '../components/SyncProgressModal'
import { useCycleTimeData } from '../lib/useCycleTimeData'
import { RichText } from '../components/ScopeCard'
import type {
  BugsOpenedMonth,
  BugStatusCount,
  CycleTimePoint,
  DashboardSnapshotDetail,
  DashboardSnapshotTeamData,
  DoneByIncrement,
  OverviewMetrics,
  OverviewPeriod,
  Phase,
  Project,
  Team,
} from '../api/types'
import {
  dateStrToEpochDays,
  epochDaysToDate,
  formatEpochDaysAsDate,
  formatIsoDate,
  parseBackendDateTime,
  toEpochDays,
} from '../lib/dates'

const ROW_LABEL_WIDTH = 160
const BAR_HEIGHT = 30
// Increment non "in corso": tinta chiara dello stesso blu --primary, cosi'
// quelli "in corso" (blu pieno + bordo) risaltano per contrasto.
const COLOR_INACTIVE = '#c7d9fb'
// Marcatore della data di rilascio (increment "Rilasciato").
const COLOR_RELEASE = 'var(--success)'

// Palette categoriale fissa (Story/Bug/Activity/Task, in quest'ordine) per
// il grafico a ciambella "Metriche": stessi colori gia' usati nell'app per
// altri scopi (--primary/--danger/--progetto/--warning) piu' Task (solo per
// il Team Embedded), validata per distinguibilita' in daltonismo con
// scripts/validate_palette.js della skill dataviz.
const PBI_TYPE_COLORS: Record<string, string> = {
  Story: '#2f6fed',
  Bug: '#d3402f',
  Activity: '#5b3fb0',
  Task: '#c97a12',
}

// Serie per i grafici Cycle Time/Throughput: i Bug del bot di security scan
// (is_cve, vedi CycleTimePoint) sono evidenziati come serie a se' stante,
// stesso rosso del Bug ma con opacita' ridotta, invece di una nuova tinta -
// restano "Bug" concettualmente, solo chiusi in automatico e non da uno
// sviluppatore (vedi bug_cve_count in Metriche).
const SERIES: { key: string; color: string; opacity: number }[] = [
  { key: 'Story', color: PBI_TYPE_COLORS.Story, opacity: 1 },
  { key: 'Bug', color: PBI_TYPE_COLORS.Bug, opacity: 1 },
  { key: 'Bug (CVE)', color: PBI_TYPE_COLORS.Bug, opacity: 0.35 },
  { key: 'Activity', color: PBI_TYPE_COLORS.Activity, opacity: 1 },
  { key: 'Task', color: PBI_TYPE_COLORS.Task, opacity: 1 },
]

const TEAMS: { key: Team; label: string }[] = [
  { key: 'sw', label: 'SW' },
  { key: 'embedded', label: 'Embedded' },
]

function seriesKeyFor(p: { issue_type: string; is_cve: boolean }): string {
  return p.issue_type === 'Bug' && p.is_cve ? 'Bug (CVE)' : p.issue_type
}

// Calendario a risoluzione mensile (un tick per mese) sull'intero range di
// date coperto dagli increment - stessa logica di ProjectsDashboardPage, non
// condivisa perche' li' e' per-fase mentre qui e' una singola barra.
function buildMonthTicks(minEpoch: number, maxEpoch: number): { epoch: number; label: string }[] {
  const start = epochDaysToDate(minEpoch)
  const cursor = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), 1))
  const ticks: { epoch: number; label: string }[] = []
  for (let i = 0; i < 240; i++) {
    const epoch = toEpochDays(cursor)
    if (epoch > maxEpoch) break
    if (epoch >= minEpoch) {
      ticks.push({ epoch, label: cursor.toLocaleDateString('it-IT', { month: 'short', year: '2-digit', timeZone: 'UTC' }) })
    }
    cursor.setUTCMonth(cursor.getUTCMonth() + 1)
  }
  return ticks
}

// Fasi increment sotto la barra: due corsie, date pianificate e date
// effettive, con gli stessi colori del grafico della card Fasi increment
// (blu pianificata, arancio effettiva).
const COLOR_PHASE_PLANNED = '#2a78d6'
const COLOR_PHASE_ACTUAL = '#eb6834'
const PHASE_LANE_HEIGHT = 18
// Spazio tra la barra e le corsie: ci stanno le date di inizio/fine.
const PHASE_LANES_MARGIN_TOP = 24
// Larghezza media stimata di un carattere dell'etichetta (11px), per capire
// quali etichette si accavallerebbero.
const PHASE_LABEL_CHAR_WIDTH = 6.5
const PHASE_LABEL_OFFSET = 10
// Larghezza dell'area delle barre prima che sia stata misurata: quella
// minima del Gantt.
const FALLBACK_TRACK_WIDTH = 500

type PhaseMark = { id: number; name: string; epoch: number; date: string; title: string }
type PlacedPhaseMark = PhaseMark & { level: number; flipped: boolean }
type PhaseLaneLayout = { marks: PlacedPhaseMark[]; levels: number }

// Le fasi che hanno la data richiesta (pianificata o effettiva), nell'ordine
// delle fasi. Il tooltip riporta sempre entrambe le date, per confrontarle.
function phaseMarks(phases: Phase[], field: 'planned_date' | 'actual_date'): PhaseMark[] {
  return phases.flatMap((phase) => {
    const epoch = dateStrToEpochDays(phase[field])
    if (epoch === null) return []
    const title = `${phase.name}: pianificata ${formatIsoDate(phase.planned_date) ?? '—'}, effettiva ${formatIsoDate(phase.actual_date) ?? '—'}`
    return [{ id: phase.id, name: phase.name, epoch, date: formatEpochDaysAsDate(epoch), title }]
  })
}

// Dispone le etichette di una corsia su piu' righe quando fasi ravvicinate
// si accavallerebbero: ognuna va sulla prima riga in cui c'e' posto.
// L'etichetta sta a destra del segnalino, a sinistra se uscirebbe dal bordo.
function layoutPhaseMarks(marks: PhaseMark[], xOf: (epoch: number) => number, maxRight: number): PhaseLaneLayout {
  const taken: [number, number][][] = []
  const placed = [...marks]
    .sort((a, b) => a.epoch - b.epoch)
    .map((mark) => {
      const x = xOf(mark.epoch)
      const textWidth = `${mark.name} ${mark.date}`.length * PHASE_LABEL_CHAR_WIDTH
      const flipped = x + PHASE_LABEL_OFFSET + textWidth > maxRight && x - PHASE_LABEL_OFFSET - textWidth >= 0
      const left = flipped ? x - PHASE_LABEL_OFFSET - textWidth : x - 6
      const right = flipped ? x + 6 : x + PHASE_LABEL_OFFSET + textWidth
      let level = taken.findIndex((intervals) => intervals.every(([l, r]) => right + 8 <= l || left >= r + 8))
      if (level === -1) level = taken.push([]) - 1
      taken[level].push([left, right])
      return { ...mark, level, flipped }
    })
  return { marks: placed, levels: taken.length }
}

// Segnalino di una fase: rombo vuoto per la data pianificata, pieno per
// quella effettiva (distinguibili anche senza il colore).
function PhaseDiamond({ color, filled }: { color: string; filled: boolean }) {
  return (
    <span
      style={{
        display: 'inline-block',
        width: 8,
        height: 8,
        boxSizing: 'border-box',
        transform: 'rotate(45deg)',
        background: filled ? color : 'var(--surface)',
        border: `2px solid ${color}`,
      }}
    />
  )
}

function PhaseLane({
  layout,
  color,
  filled,
  pct,
}: {
  layout: PhaseLaneLayout
  color: string
  filled: boolean
  pct: (epoch: number) => number
}) {
  return (
    <div style={{ position: 'relative', height: layout.levels * PHASE_LANE_HEIGHT }}>
      {layout.marks.map((mark) => (
        <div
          key={mark.id}
          title={mark.title}
          style={{
            position: 'absolute',
            left: `${pct(mark.epoch)}%`,
            top: mark.level * PHASE_LANE_HEIGHT,
            height: PHASE_LANE_HEIGHT,
          }}
        >
          <span style={{ position: 'absolute', left: -4, top: (PHASE_LANE_HEIGHT - 8) / 2, lineHeight: 0 }}>
            <PhaseDiamond color={color} filled={filled} />
          </span>
          <span
            style={{
              position: 'absolute',
              ...(mark.flipped ? { right: PHASE_LABEL_OFFSET } : { left: PHASE_LABEL_OFFSET }),
              lineHeight: `${PHASE_LANE_HEIGHT}px`,
              fontSize: 11,
              whiteSpace: 'nowrap',
            }}
          >
            {mark.name} <span className="muted">{mark.date}</span>
          </span>
        </div>
      ))}
    </div>
  )
}

type Row = {
  project: Project
  startEpoch: number | null
  endEpoch: number | null
  releaseEpoch: number | null
  plannedPhases: PhaseMark[]
  actualPhases: PhaseMark[]
}

// Ordinamento delle righe del Gantt increment: un criterio (o l'ordine
// manuale, salvato nel database per tutti) piu' la direzione. La scelta del
// criterio invece e' una preferenza di chi guarda, tenuta in localStorage.
type GanttSortKey = 'manual' | 'start' | 'end' | 'code' | 'name'
type GanttSort = { key: GanttSortKey; dir: 'asc' | 'desc' }

const GANTT_SORT_OPTIONS: { key: GanttSortKey; label: string }[] = [
  { key: 'manual', label: 'Manuale' },
  { key: 'start', label: 'Data inizio' },
  { key: 'end', label: 'Planned finish' },
  { key: 'code', label: 'Codice' },
  { key: 'name', label: 'Nome' },
]
const GANTT_SORT_STORAGE_KEY = 'overviewDashboard.ganttSort'
const DEFAULT_GANTT_SORT: GanttSort = { key: 'start', dir: 'asc' }

function loadGanttSort(): GanttSort {
  try {
    const stored = JSON.parse(localStorage.getItem(GANTT_SORT_STORAGE_KEY) ?? 'null')
    if (GANTT_SORT_OPTIONS.some((o) => o.key === stored?.key) && (stored.dir === 'asc' || stored.dir === 'desc')) {
      return stored
    }
  } catch {
    // localStorage non disponibile o dato corrotto: usa il default
  }
  return DEFAULT_GANTT_SORT
}

// Righe senza il valore del criterio (data mancante, mai riordinate a mano)
// sempre in fondo, qualunque sia la direzione; a parita' decide la data di
// inizio, poi il codice, cosi' l'ordine e' stabile.
function sortGanttRows(rows: Row[], sort: GanttSort): Row[] {
  const valueOf = (r: Row): number | string | null => {
    switch (sort.key) {
      case 'manual':
        return r.project.gantt_order
      case 'start':
        return r.startEpoch
      case 'end':
        return r.endEpoch
      case 'code':
        return r.project.code.toLowerCase()
      case 'name':
        return r.project.name.toLowerCase()
    }
  }
  const sign = sort.key !== 'manual' && sort.dir === 'desc' ? -1 : 1
  return [...rows].sort((a, b) => {
    const va = valueOf(a)
    const vb = valueOf(b)
    if (va !== vb) {
      if (va === null) return 1
      if (vb === null) return -1
      return (va < vb ? -1 : 1) * sign
    }
    const byStart = (a.startEpoch ?? Infinity) - (b.startEpoch ?? Infinity)
    return byStart !== 0 ? byStart : a.project.code.localeCompare(b.project.code)
  })
}

// Snapshot della Dashboard generale attualmente visualizzato (null = dati
// live da Jira). Passato via context invece che come prop a ogni card: i
// grafici non cambiano, cambia solo da dove leggono i dati.
const SnapshotContext = createContext<DashboardSnapshotDetail | null>(null)

// Periodo (Dal/Al, date ISO) scelto una volta sola nel pannello "Periodo e
// dati" e usato da tutti i grafici dal Cycle Time in giu'.
type DashboardWindow = { from: string; to: string }
const DashboardWindowContext = createContext<DashboardWindow>({ from: '', to: '' })
const defaultWindowFrom = () => {
  const d = new Date()
  d.setFullYear(d.getFullYear() - 1)
  return isoDate(d)
}

// Dati di un grafico per il team scelto: dalla query live oppure, se si sta
// guardando uno snapshot, dalla fotografia salvata (la query live resta
// disabilitata, niente chiamate a Jira). isSnapshot serve alle card per
// nascondere il pulsante Aggiorna, che su dati congelati non ha senso.
function useChartData<T>(
  team: Team,
  queryKey: unknown[],
  queryFn: () => Promise<T>,
  fromSnapshot: (d: DashboardSnapshotTeamData) => T,
  enabled = true,
): { data: T | undefined; refetch: () => void; isFetching: boolean; isSnapshot: boolean } {
  const snapshot = useContext(SnapshotContext)
  const live = useQuery({ queryKey, queryFn, enabled: snapshot === null && enabled })
  if (snapshot) {
    const teamData = snapshot.teams[team]
    return { data: teamData ? fromSnapshot(teamData) : undefined, refetch: () => {}, isFetching: false, isSnapshot: true }
  }
  return { data: live.data, refetch: () => live.refetch(), isFetching: live.isFetching, isSnapshot: false }
}

// Pulsante di refresh usato sia nell'header di ogni singolo grafico sia,
// aggregato su piu' query, in quello "Aggiorna tutti i grafici".
function RefreshButton({ onClick, isFetching, label = 'Aggiorna' }: { onClick: () => void; isFetching: boolean; label?: string }) {
  return (
    <button className="btn" onClick={onClick} disabled={isFetching} style={{ fontSize: 12, padding: '4px 10px' }}>
      {isFetching ? 'Aggiornamento...' : `⟳ ${label}`}
    </button>
  )
}

// Storico Cycle Time di Cycle Time, Throughput e Flusso: come in Monte Carlo
// e Forecasting, l'ultima estrazione salvata, da Jira o da un file CSV
// pre-elaborato (stessi dati per team in tutte le pagine). Jira si rilegge
// solo con "Aggiorna da Jira" (lento: un changelog per PBI). In uno
// snapshot, i dati salvati li'.
function useDashboardCycleTime(team: Team, since?: string | null) {
  const snapshot = useContext(SnapshotContext)
  const source = useCycleTimeData(team, since)
  if (snapshot) return { ...source, data: snapshot.teams[team]?.cycle_time, isSnapshot: true }
  return { ...source, isSnapshot: false }
}
type DashboardCycleTime = ReturnType<typeof useDashboardCycleTime>

const formatFetchedAt = (value: string) =>
  parseBackendDateTime(value).toLocaleString('it-IT', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })

// Da dove vengono i dati (Jira o file, e quando) con i pulsanti per
// rileggerli da Jira o caricare un CSV. Nascosta negli snapshot.
function CycleTimeSource({ team, source, label }: { team: Team; source: DashboardCycleTime; label?: string }) {
  // L'avanzamento dell'estrazione solo dove e' partita.
  const [started, setStarted] = useState(false)
  if (source.isSnapshot) return null
  const data = source.data
  return (
    <div className="ct-source">
      {label && <b className="ct-source-team">{label}</b>}
      <span className="muted">
        {data?.fetched_at ? (
          data.source ? (
            <>
              Dati dal file <b title={data.source}>{data.source}</b>, caricato il {formatFetchedAt(data.fetched_at)}
            </>
          ) : (
            <>Dati da Jira, estratti il {formatFetchedAt(data.fetched_at)}</>
          )
        ) : source.isLoadingCached ? (
          'Caricamento…'
        ) : (
          'Dati non ancora caricati: aggiorna da Jira o carica un file CSV.'
        )}
      </span>
      <button
        className="btn"
        style={{ fontSize: 12, padding: '3px 10px' }}
        disabled={source.isFetching}
        title="Rilegge lo storico da Jira (lento: un changelog per PBI); vale anche per Monte Carlo e Forecasting"
        onClick={() => {
          setStarted(true)
          source.refresh()
        }}
      >
        {source.isFetching ? 'Aggiornamento…' : '⟳ Aggiorna da Jira'}
      </button>
      <label
        className="btn"
        style={{ fontSize: 12, padding: '3px 10px', cursor: source.isImporting ? 'default' : 'pointer' }}
        title="Carica lo storico da un file CSV pre-elaborato (colonne ID, Developing, Done, Issue Type): più veloce di Jira; vale anche per Monte Carlo e Forecasting"
      >
        {source.isImporting ? 'Caricamento…' : '📄 Carica da file'}
        <input
          type="file"
          accept=".csv,text/csv"
          hidden
          disabled={source.isImporting}
          onChange={(e) => {
            const file = e.target.files?.[0]
            if (file) source.importFile(file)
            e.target.value = ''
          }}
        />
      </label>
      {source.error && <span style={{ color: 'var(--danger)' }}>{source.error}</span>}
      {source.importError && <span style={{ color: 'var(--danger)' }}>{source.importError}</span>}
      {started && source.isFetching && (
        <SyncProgressModal
          title="Estrazione dati da Jira"
          queryKey={['cycle-time-progress', team]}
          fetchProgress={() => api.dashboard.cycleTimeProgress(team)}
        />
      )}
    </div>
  )
}

// Periodo scelto nel pannello "Periodo e dati", accanto al titolo di ogni
// grafico che lo usa: scorrendo in basso il pannello non si vede piu'.
function WindowBadge() {
  const { from, to } = useContext(DashboardWindowContext)
  if (!from || !to) return null
  return (
    <span className="window-badge" title="Periodo scelto in Periodo e dati, in cima ai grafici">
      {formatIsoDate(from)} – {formatIsoDate(to)}
    </span>
  )
}

// Messaggio delle card del Cycle Time quando i dati del team non ci sono.
function NoCycleTimeData({ source }: { source: DashboardCycleTime }) {
  if (source.data) return null
  return (
    <p className="muted">
      {source.isLoadingCached
        ? 'Caricamento…'
        : 'Dati non ancora caricati: aggiornali da Jira o carica un file CSV nel pannello "Periodo e dati".'}
    </p>
  )
}

function TeamCycleTimeSource({ team, label, since }: { team: Team; label: string; since: string }) {
  const source = useDashboardCycleTime(team, since)
  return <CycleTimeSource team={team} source={source} label={label} />
}

// Pannello sopra i grafici dal Cycle Time in giu': il periodo Dal/Al e la
// fonte dello storico Cycle Time (Jira o file CSV) di ogni team, scelti una
// volta sola per tutti.
function DashboardControls({ window, onChange }: { window: DashboardWindow; onChange: (w: DashboardWindow) => void }) {
  const snapshot = useContext(SnapshotContext)
  const today = isoDate(new Date())
  const defaultFrom = defaultWindowFrom()
  return (
    <div className="card dash-controls">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 8 }}>
        <h3 style={{ margin: 0 }}>Periodo e dati</h3>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <label className="tp-date">
            Dal
            <input
              type="date"
              value={window.from}
              max={window.to}
              onChange={(e) => e.target.value && onChange({ ...window, from: e.target.value })}
            />
          </label>
          <label className="tp-date">
            Al
            <input
              type="date"
              value={window.to}
              min={window.from}
              onChange={(e) => e.target.value && onChange({ ...window, to: e.target.value })}
            />
          </label>
          {(window.from !== defaultFrom || window.to !== today) && (
            <button className="link-btn" style={{ fontSize: 12 }} onClick={() => onChange({ from: defaultFrom, to: today })}>
              Ultimi 12 mesi
            </button>
          )}
        </div>
      </div>
      <p className="muted" style={{ margin: '6px 0 0', fontSize: 13 }}>
        Il periodo vale per tutti i grafici qui sotto (per PBI chiusi per increment conta la data di rilascio). Cycle
        Time, Throughput e Flusso usano lo storico di ogni team, da Jira o da un file CSV: lo stesso di Monte Carlo e
        Forecasting.
      </p>
      {!snapshot &&
        TEAMS.map((t) => (
          <TeamCycleTimeSource key={t.key} team={t.key} label={`Team ${t.label}`} since={window.from} />
        ))}
    </div>
  )
}

// Selettore Team SW/Embedded presente in ogni grafico (Metriche, Cycle Time,
// Throughput): ognuno lo tiene come proprio stato locale, non condiviso -
// si puo' quindi confrontare per esempio il Cycle Time di un team con le
// Metriche dell'altro senza che si influenzino a vicenda.
function TeamSelector({ team, onChange }: { team: Team; onChange: (t: Team) => void }) {
  return (
    <div style={{ display: 'flex', gap: 2, border: '1px solid var(--border)', borderRadius: 'var(--radius)', padding: 2 }}>
      {TEAMS.map((t) => (
        <button
          key={t.key}
          onClick={() => onChange(t.key)}
          style={{
            border: 'none',
            borderRadius: 6,
            padding: '3px 10px',
            fontSize: 12,
            cursor: 'pointer',
            background: team === t.key ? 'var(--primary)' : 'transparent',
            color: team === t.key ? 'white' : 'var(--text)',
            fontWeight: team === t.key ? 600 : 400,
          }}
        >
          {t.label}
        </button>
      ))}
    </div>
  )
}

// Finestre temporali del grafico Metriche, relative a oggi (vedi
// OVERVIEW_PERIOD_JQL nel backend) o al giorno dello snapshot visualizzato:
// scorrono col passare del tempo.
function periodRangeLabel(period: OverviewPeriod, referenceDate: string | null): string {
  const DAY_MS = 24 * 60 * 60 * 1000
  const offsetDays = period === 'current' ? 0 : 365
  const reference = referenceDate ? new Date(`${referenceDate}T12:00:00`).getTime() : Date.now()
  const end = new Date(reference - offsetDays * DAY_MS)
  const start = new Date(end.getTime() - 365 * DAY_MS)
  const fmt = (d: Date) => d.toLocaleDateString('it-IT', { day: '2-digit', month: '2-digit', year: 'numeric' })
  return `${fmt(start)} – ${fmt(end)}`
}

// Periodi del grafico Metriche: ogni periodo e' confrontato con quello
// equivalente precedente. Date ISO [since, until] compresi; per gli ultimi
// 12 mesi restano le finestre relative del backend (anche negli snapshot).
type MetricsRange = '12m' | 'ytd' | '6m' | '1m'
const METRICS_RANGES: { key: MetricsRange; label: string; previousTitle: string }[] = [
  { key: '12m', label: 'Ultimi 12 mesi', previousTitle: '12 mesi precedenti' },
  { key: 'ytd', label: 'Anno in corso', previousTitle: 'Stesso periodo anno precedente' },
  { key: '6m', label: 'Ultimi 6 mesi', previousTitle: '6 mesi precedenti' },
  { key: '1m', label: 'Ultimo mese', previousTitle: 'Mese precedente' },
]

function shiftDate(d: Date, months: number, years = 0): Date {
  const r = new Date(d)
  r.setFullYear(r.getFullYear() + years, r.getMonth() + months)
  return r
}

function metricsRangeDates(range: MetricsRange, reference: Date): { current: [string, string]; previous: [string, string] } {
  const day = (d: Date, delta = 0) => {
    const r = new Date(d)
    r.setDate(r.getDate() + delta)
    return isoDate(r)
  }
  if (range === 'ytd') {
    const start = new Date(reference.getFullYear(), 0, 1)
    return {
      current: [isoDate(start), isoDate(reference)],
      previous: [isoDate(shiftDate(start, 0, -1)), isoDate(shiftDate(reference, 0, -1))],
    }
  }
  const months = range === '6m' ? 6 : range === '1m' ? 1 : 12
  const start = shiftDate(reference, -months)
  return {
    current: [day(start, 1), isoDate(reference)],
    previous: [day(shiftDate(start, -months), 1), isoDate(start)],
  }
}

// Grafico Metriche: PBI messi a Done sulla JQL base del team, due ciambelle
// affiancate - a sinistra gli ultimi 365 giorni, a destra i 365 precedenti.
// Componente a se' (invece che inline in OverviewDashboardPage) cosi' da
// poter comparire sia nel ramo "nessuna data" sia in quello normale senza
// duplicare le query. Il team e' condiviso tra le due ciambelle, altrimenti
// il confronto anno su anno non avrebbe senso.
function MetricsCard() {
  const [team, setTeam] = useState<Team>('sw')
  const [chosenRange, setRange] = useState<MetricsRange>('12m')
  const snapshot = useContext(SnapshotContext)
  // Negli snapshot sono salvati solo gli ultimi 12 mesi e l'anno prima.
  const range: MetricsRange = snapshot ? '12m' : chosenRange
  const referenceDate = snapshot?.snapshot_date ?? null
  const dates = metricsRangeDates(range, referenceDate ? new Date(`${referenceDate}T12:00:00`) : new Date())
  const explicit = range !== '12m'
  const current = useChartData(
    team,
    explicit ? ['dashboard', 'overview', team, 'current', ...dates.current] : ['dashboard', 'overview', team, 'current'],
    () => (explicit ? api.dashboard.overview(team, 'current', ...dates.current) : api.dashboard.overview(team, 'current')),
    (d) => d.overview_current,
  )
  const previous = useChartData(
    team,
    explicit ? ['dashboard', 'overview', team, 'previous', ...dates.previous] : ['dashboard', 'overview', team, 'previous'],
    () => (explicit ? api.dashboard.overview(team, 'previous', ...dates.previous) : api.dashboard.overview(team, 'previous')),
    (d) => d.overview_previous,
  )
  const rangeInfo = METRICS_RANGES.find((r) => r.key === range)!
  const label = ([from, to]: [string, string]) => `${formatIsoDate(from)} – ${formatIsoDate(to)}`

  return (
    <div className="card">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 8 }}>
        <h3 style={{ marginTop: 0, marginBottom: 0 }}>Metriche</h3>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <div className="filter-group">
            {METRICS_RANGES.map((r) => (
              <button
                key={r.key}
                className={`btn filter-btn${range === r.key ? ' active' : ''}`}
                aria-pressed={range === r.key}
                disabled={!!snapshot && r.key !== '12m'}
                title={snapshot && r.key !== '12m' ? 'Negli snapshot sono salvati solo gli ultimi 12 mesi' : undefined}
                onClick={() => setRange(r.key)}
              >
                {r.label}
              </button>
            ))}
          </div>
          <TeamSelector team={team} onChange={setTeam} />
          {!current.isSnapshot && (current.data || previous.data) && (
            <RefreshButton
              onClick={() => {
                current.refetch()
                previous.refetch()
              }}
              isFetching={current.isFetching || previous.isFetching}
            />
          )}
        </div>
      </div>
      <p className="muted" style={{ marginTop: 8, marginBottom: 12 }}>
        PBI messi a Done (JQL base del {team === 'sw' ? 'Team SW' : 'Team Embedded'}): {rangeInfo.label.toLowerCase()} a
        confronto con {rangeInfo.previousTitle.toLowerCase()}.
      </p>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))', gap: 24 }}>
        <DoneDonut
          data={current.data}
          title={rangeInfo.label}
          rangeLabel={explicit ? label(dates.current) : periodRangeLabel('current', referenceDate)}
        />
        <DoneDonut
          data={previous.data}
          title={rangeInfo.previousTitle}
          rangeLabel={explicit ? label(dates.previous) : periodRangeLabel('previous', referenceDate)}
        />
      </div>
    </div>
  )
}

// Singola ciambella del grafico Metriche: totale al centro e dettaglio per
// tipo sotto. MetricsCard ne affianca due con la stessa impaginazione, per
// confrontare i due anni a colpo d'occhio.
function DoneDonut({ data, title, rangeLabel }: { data: OverviewMetrics | undefined; title: string; rangeLabel: string }) {
  const heading = (
    <div style={{ textAlign: 'center', marginBottom: 12 }}>
      <div style={{ fontWeight: 600, fontSize: 14 }}>{title}</div>
      <div className="muted" style={{ fontSize: 12 }}>
        {rangeLabel}
      </div>
    </div>
  )

  if (!data) {
    return (
      <div>
        {heading}
        <p className="muted" style={{ textAlign: 'center' }}>
          Caricamento...
        </p>
      </div>
    )
  }

  const total = data.done_last_12_months_total
  const chartData = data.done_last_12_months
    .filter((d) => d.count > 0)
    .map((d) => ({ ...d, color: PBI_TYPE_COLORS[d.issue_type] ?? COLOR_INACTIVE }))

  return (
    <div>
      {heading}
      {data.error ? (
        <p className="muted" style={{ textAlign: 'center' }}>
          {data.error}
        </p>
      ) : total === 0 ? (
        <p className="muted" style={{ textAlign: 'center' }}>
          Nessun PBI messo a Done in questo periodo.
        </p>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 16 }}>
          <div style={{ position: 'relative', width: 220, height: 220 }}>
            <ResponsiveContainer width="100%" height="100%">
              <PieChart>
                <Pie
                  data={chartData}
                  dataKey="count"
                  nameKey="issue_type"
                  cx="50%"
                  cy="50%"
                  innerRadius={70}
                  outerRadius={100}
                  paddingAngle={chartData.length > 1 ? 2 : 0}
                  startAngle={90}
                  endAngle={-270}
                  stroke="var(--surface)"
                  strokeWidth={2}
                >
                  {chartData.map((d) => (
                    <Cell key={d.issue_type} fill={d.color} />
                  ))}
                </Pie>
                <Tooltip formatter={(value, name) => [value, name]} />
              </PieChart>
            </ResponsiveContainer>
            {/* Totale al centro della ciambella, sovrapposto al grafico. */}
            <div
              style={{
                position: 'absolute',
                inset: 0,
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                justifyContent: 'center',
                pointerEvents: 'none',
              }}
            >
              <span style={{ fontSize: 28, fontWeight: 700, color: 'var(--text)', lineHeight: 1 }}>{total}</span>
              <span className="muted" style={{ fontSize: 11 }}>
                Totale
              </span>
            </div>
          </div>

          {/* Dettaglio con i singoli totali per tipo, sotto la torta. Sulla
              Story e' evidenziato quante sono Enhancement (Enhancement =
              Yes); sul Bug quanti sono Complaint (Source Type = Complaint) e
              quanti CVE del bot di security scan (vedi bug_cve_count). */}
          <div style={{ display: 'flex', gap: 24, flexWrap: 'wrap', justifyContent: 'center' }}>
            {chartData.map((d) => (
              <span key={d.issue_type} style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13 }}>
                <span style={{ width: 10, height: 10, borderRadius: '50%', background: d.color, display: 'inline-block' }} />
                {d.issue_type}: <strong>{d.count}</strong>
                {d.issue_type === 'Story' && (
                  <span className="muted" style={{ fontSize: 12 }}>
                    (di cui <strong>{data.story_enhancement_count}</strong> enhancement)
                  </span>
                )}
                {d.issue_type === 'Bug' && (
                  <span className="muted" style={{ fontSize: 12 }}>
                    (di cui <strong>{data.bug_complaint_count}</strong> complaint, <strong>{data.bug_cve_count}</strong> CVE)
                  </span>
                )}
              </span>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

type ScatterPoint = CycleTimePoint & { x: number; y: number }

function CycleTimeTooltip({ active, payload }: { active?: boolean; payload?: { payload: ScatterPoint }[] }) {
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
      }}
    >
      <div style={{ fontWeight: 600 }}>
        {p.key} ({p.issue_type}
        {p.is_cve ? ' · CVE' : ''})
      </div>
      <div>Completato: {formatIsoDate(p.finish_date)}</div>
      <div>Cycle time: {p.cycle_time_days} giorni</div>
    </div>
  )
}

// Scatterplot Cycle Time: un punto per PBI (JQL configurabile in
// Configurazione + ultimi 12 mesi), asse X la data di completamento, asse Y
// il cycle time in giorni, con le linee di percentile 50/85/95.
function CycleTimeCard() {
  const [team, setTeam] = useState<Team>('sw')
  const { from, to } = useContext(DashboardWindowContext)
  const source = useDashboardCycleTime(team)
  const { data } = source

  const header = (
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 8 }}>
      <h3 style={{ marginTop: 0, marginBottom: 0 }}>
        Cycle Time <WindowBadge />
      </h3>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        <TeamSelector team={team} onChange={setTeam} />
      </div>
    </div>
  )
  const sourceBar = <NoCycleTimeData source={source} />

  if (!data) {
    return (
      <div className="card">
        {header}
        {sourceBar}
      </div>
    )
  }

  const pointsBySeries: Record<string, ScatterPoint[]> = {}
  const xs: number[] = []
  const points = data.points.filter((p) => p.finish_date >= from && p.finish_date <= to)
  // Percentili del periodo scelto, senza i Bug CVE (come nel backend).
  const durations = points.filter((p) => !p.is_cve).map((p) => p.cycle_time_days)
  const p50 = durations.length ? percentile(durations, 50) : null
  const p85 = durations.length ? percentile(durations, 85) : null
  const p95 = durations.length ? percentile(durations, 95) : null
  for (const p of points) {
    const x = dateStrToEpochDays(p.finish_date)
    if (x === null) continue
    xs.push(x)
    ;(pointsBySeries[seriesKeyFor(p)] ??= []).push({ ...p, x, y: p.cycle_time_days })
  }

  return (
    <div className="card">
      {header}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 16, flexWrap: 'wrap', marginTop: 8, marginBottom: 12 }}>
        <p className="muted" style={{ margin: 0, flex: '1 1 320px' }}>
          Un punto per PBI: giorni trascorsi da inizio lavorazione a Done, per data di completamento, nel periodo scelto.
          Le linee tratteggiate sono il 50°, 85° e 95° percentile, calcolati senza i Bug CVE del bot di security scan.
        </p>
        {/* 85° percentile in evidenza: e' il valore da citare in
            presentazione ("l'85% dei PBI si chiude entro N giorni"), stesso
            colore della sua linea nel grafico. */}
        {!data.error && p85 != null && (
          <div style={{ textAlign: 'right', lineHeight: 1.1 }}>
            <div className="muted" style={{ fontSize: 12 }}>
              Cycle time 85° percentile
            </div>
            <div style={{ fontSize: 32, fontWeight: 700, color: 'var(--warning)' }}>
              {p85.toFixed(1)} <span style={{ fontSize: 16, fontWeight: 600 }}>giorni</span>
            </div>
            <div className="muted" style={{ fontSize: 11 }}>
              l'85% dei PBI (CVE esclusi) si chiude entro questo tempo
            </div>
          </div>
        )}
      </div>

      {data.error ? (
        <p className="muted">{data.error}</p>
      ) : points.length === 0 ? (
        <p className="muted">Nessun PBI completato nel periodo scelto con i dati necessari.</p>
      ) : (
        <>
          <div style={{ height: 340 }}>
            <ResponsiveContainer width="100%" height="100%">
              <ScatterChart margin={{ top: 8, right: 24, left: 8, bottom: 8 }}>
                <CartesianGrid strokeDasharray="3 3" />
                <XAxis
                  type="number"
                  dataKey="x"
                  domain={[Math.min(...xs), Math.max(...xs)]}
                  tickFormatter={formatEpochDaysAsDate}
                  tick={{ fontSize: 12 }}
                />
                <YAxis
                  type="number"
                  dataKey="y"
                  tick={{ fontSize: 12 }}
                  label={{ value: 'Giorni', angle: -90, position: 'insideLeft', style: { fontSize: 12, fill: 'var(--text-muted)' } }}
                />
                <Tooltip content={<CycleTimeTooltip />} />
                <Legend wrapperStyle={{ fontSize: 12 }} />
                {p50 != null && (
                  <ReferenceLine
                    y={p50}
                    stroke="var(--text-muted)"
                    strokeDasharray="4 4"
                    label={{ value: `P50: ${p50.toFixed(1)}g`, position: 'right', fontSize: 11, fill: 'var(--text-muted)' }}
                  />
                )}
                {p85 != null && (
                  <ReferenceLine
                    y={p85}
                    stroke="var(--warning)"
                    strokeDasharray="4 4"
                    label={{ value: `P85: ${p85.toFixed(1)}g`, position: 'right', fontSize: 11, fill: 'var(--warning)' }}
                  />
                )}
                {p95 != null && (
                  <ReferenceLine
                    y={p95}
                    stroke="var(--danger)"
                    strokeDasharray="4 4"
                    label={{ value: `P95: ${p95.toFixed(1)}g`, position: 'right', fontSize: 11, fill: 'var(--danger)' }}
                  />
                )}
                {SERIES.filter((s) => pointsBySeries[s.key]?.length).map((s) => (
                  <Scatter key={s.key} name={s.key} data={pointsBySeries[s.key]} fill={s.color} fillOpacity={s.opacity} />
                ))}
              </ScatterChart>
            </ResponsiveContainer>
          </div>
        </>
      )}
    </div>
  )
}

// Mesi (chiave YYYY-MM e data del primo del mese) da quello di `fromIso` a
// quello di `toIso`, estremi compresi: anche i mesi senza PBI completati.
function monthsBetween(fromIso: string, toIso: string): { key: string; date: string }[] {
  const [fy, fm] = fromIso.slice(0, 7).split('-').map(Number)
  const [ty, tm] = toIso.slice(0, 7).split('-').map(Number)
  const cursor = new Date(Date.UTC(fy, fm - 1, 1))
  const end = new Date(Date.UTC(ty, tm - 1, 1))
  const months: { key: string; date: string }[] = []
  while (cursor <= end && months.length < 600) {
    const key = `${cursor.getUTCFullYear()}-${String(cursor.getUTCMonth() + 1).padStart(2, '0')}`
    months.push({ key, date: `${key}-01` })
    cursor.setUTCMonth(cursor.getUTCMonth() + 1)
  }
  return months
}

// Primo del mese spostato di `delta` mesi (negativo = indietro).
function shiftMonths(firstOfMonth: string, delta: number): string {
  const [y, m] = firstOfMonth.split('-').map(Number)
  const d = new Date(Date.UTC(y, m - 1 + delta, 1))
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-01`
}

function isoDate(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

function median(values: number[]): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
}

function monthLabel(date: string, long = false): string {
  return new Date(`${date}T12:00:00Z`).toLocaleDateString('it-IT', {
    month: long ? 'long' : 'short',
    year: long ? 'numeric' : '2-digit',
    timeZone: 'UTC',
  })
}

// Media mobile sugli ultimi 3 mesi (il mese stesso e i due precedenti).
const MOVING_AVERAGE_MONTHS = 3
const THROUGHPUT_LINE = 'Throughput mensile'
const THROUGHPUT_AVERAGE = `Media mobile (${MOVING_AVERAGE_MONTHS} mesi)`

type ThroughputMonth = { date: string; count: number; average: number | null }

function ThroughputTooltip({ active, payload }: { active?: boolean; payload?: { payload: ThroughputMonth }[] }) {
  if (!active || !payload || !payload.length) return null
  const m = payload[0].payload
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
      <div style={{ fontWeight: 600, textTransform: 'capitalize' }}>{monthLabel(m.date, true)}</div>
      <div>
        Completati: <b>{m.count}</b>
      </div>
      {m.average != null && <div>Media mobile: {m.average.toFixed(1)}</div>}
    </div>
  )
}

// Riga di riepilogo della card Throughput: etichetta a sinistra, valori e
// spiegazione (icona ⓘ) a destra.
function ThroughputStatRow({ label, info, children }: { label: string; info: string; children: ReactNode }) {
  return (
    <div className="tp-row">
      <div className="tp-row-label">{label}</div>
      <div className="tp-row-body">{children}</div>
      <span className="tp-info" title={info}>
        ⓘ
      </span>
    </div>
  )
}

function ThroughputStat({ icon, value, label }: { icon: string; value: string; label: string }) {
  return (
    <div className="tp-stat">
      <div>
        <span className="tp-stat-icon">{icon}</span> <b>{value}</b>
      </div>
      <div className="muted">{label}</div>
    </div>
  )
}

// Throughput: PBI completati per mese, sugli stessi PBI del Cycle Time -
// stessa query ['dashboard','cycle-time'] (React Query la condivide tra i
// due componenti, un'unica chiamata a Jira per entrambi i grafici), solo
// aggregata qui per mese. Periodo scelto con Dal/Al (default ultimi 12
// mesi), dentro i dati disponibili.
function ThroughputCard() {
  const [team, setTeam] = useState<Team>('sw')
  const { from, to } = useContext(DashboardWindowContext)
  const [hidden, setHidden] = useState<Set<string>>(() => new Set())
  const source = useDashboardCycleTime(team)
  const { data } = source

  const header = (
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 8 }}>
      <h3 style={{ marginTop: 0, marginBottom: 0 }}>
        Throughput <WindowBadge />
      </h3>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <TeamSelector team={team} onChange={setTeam} />
      </div>
    </div>
  )
  const sourceBar = <NoCycleTimeData source={source} />

  if (!data) {
    return (
      <div className="card">
        {header}
        {sourceBar}
      </div>
    )
  }

  const points = data.points.filter((p) => p.finish_date >= from && p.finish_date <= to)
  const firstAvailable = data.points.reduce<string | null>(
    (min, p) => (min === null || p.finish_date < min ? p.finish_date : min),
    null,
  )
  const months = monthsBetween(from, to)
  const counts: Record<string, number> = Object.fromEntries(months.map((m) => [m.key, 0]))
  for (const p of points) counts[p.finish_date.slice(0, 7)] = (counts[p.finish_date.slice(0, 7)] ?? 0) + 1
  // La media mobile dei primi mesi usa anche i mesi prima di "Dal", se ci
  // sono dati: cosi' la linea parte dall'inizio del periodo scelto.
  const firstMonth = firstAvailable?.slice(0, 7) ?? months[0]?.key ?? ''
  const allCounts: Record<string, number> = {}
  for (const p of data.points) allCounts[p.finish_date.slice(0, 7)] = (allCounts[p.finish_date.slice(0, 7)] ?? 0) + 1
  const extended = months.length ? monthsBetween(shiftMonths(months[0].date, 1 - MOVING_AVERAGE_MONTHS), to) : []
  const monthly: ThroughputMonth[] = months.map((m, i) => {
    const window = extended.slice(i, i + MOVING_AVERAGE_MONTHS)
    return {
      date: m.date,
      count: counts[m.key],
      average:
        window[0].key < firstMonth
          ? null
          : window.reduce((sum, w) => sum + (counts[w.key] ?? allCounts[w.key] ?? 0), 0) / window.length,
    }
  })
  const values = monthly.map((m) => m.count)
  const total = points.length
  const average = values.length ? total / values.length : 0
  const med = median(values)
  const atOrAboveMedian = values.filter((v) => v >= med).length
  let longestGap = 0
  let run = 0
  for (const v of values) {
    run = v === 0 ? run + 1 : 0
    longestGap = Math.max(longestGap, run)
  }
  const mix = SERIES.map((s) => ({ ...s, count: points.filter((p) => seriesKeyFor(p) === s.key).length })).filter(
    (s) => s.count > 0,
  )
  const months_ = (n: number) => `${n} ${n === 1 ? 'mese' : 'mesi'}`
  const fmt = (n: number) => n.toLocaleString('it-IT', { maximumFractionDigits: 1, minimumFractionDigits: 1 })

  return (
    <div className="card">
      {header}
      <p className="muted" style={{ marginTop: 8, marginBottom: 12 }}>
        Quanti PBI si chiudono ogni mese (stessi PBI del grafico Cycle Time): un throughput costante rende le
        previsioni più affidabili.
        {firstAvailable && from.slice(0, 7) < firstAvailable.slice(0, 7) && (
          <> Dati disponibili dal {formatIsoDate(firstAvailable)}: i mesi precedenti risultano a zero.</>
        )}
      </p>

      {data.error ? (
        <p className="muted">{data.error}</p>
      ) : total === 0 ? (
        <p className="muted">Nessun PBI completato nel periodo scelto.</p>
      ) : (
        <>
          <ThroughputStatRow
            label="Volume"
            info={
              'PBI completati nel periodo scelto e, mese per mese, media, mediana e minimo-massimo. ' +
              'Il primo e l’ultimo mese possono essere parziali se Dal/Al non cadono a inizio/fine mese.'
            }
          >
            <ThroughputStat icon="✓" value={`${total} PBI`} label={`Completati nel periodo (${months_(values.length)})`} />
            <ThroughputStat icon="#" value={`${fmt(average)} PBI`} label="Media mensile" />
            <ThroughputStat icon="#" value={`${fmt(med)} PBI`} label="Mediana mensile" />
            <ThroughputStat icon="↕" value={`${Math.min(...values)}–${Math.max(...values)} PBI`} label="Minimo–massimo mensile" />
          </ThroughputStatRow>
          <ThroughputStatRow
            label="Regolarità"
            info={
              'Mesi con throughput pari o sopra la mediana (più sono, più la consegna è regolare) e ' +
              'la serie più lunga di mesi consecutivi senza nessun PBI completato.'
            }
          >
            <ThroughputStat
              icon="↥"
              value={`${months_(atOrAboveMedian)} (${Math.round((100 * atOrAboveMedian) / values.length)}%)`}
              label="Pari o sopra la mediana"
            />
            <ThroughputStat icon="◷" value={months_(longestGap)} label="Pausa più lunga senza consegne" />
          </ThroughputStatRow>
          <ThroughputStatRow
            label="Mix"
            info="PBI completati nel periodo per tipo. I Bug CVE sono quelli chiusi in automatico dal bot di security scan."
          >
            <div className="tp-mix">
              {mix.map((s) => {
                const pct = Math.round((100 * s.count) / total)
                return (
                  <div
                    key={s.key}
                    className="tp-mix-seg"
                    style={{
                      flexGrow: s.count,
                      background: s.color,
                      opacity: s.opacity < 1 ? 0.55 : 1,
                    }}
                    title={`${s.key}: ${s.count} (${pct}%)`}
                  >
                    {pct >= 6 ? `${s.key}: ${s.count} (${pct}%)` : pct >= 3 ? s.count : ''}
                  </div>
                )
              })}
            </div>
          </ThroughputStatRow>

          <div style={{ height: 320, marginTop: 12 }}>
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={monthly} margin={{ top: 8, right: 24, left: 8, bottom: 8 }}>
                <CartesianGrid strokeDasharray="3 3" vertical={false} />
                <XAxis dataKey="date" tickFormatter={(d: string) => monthLabel(d)} tick={{ fontSize: 12 }} />
                <YAxis
                  allowDecimals={false}
                  tick={{ fontSize: 12 }}
                  label={{
                    value: 'PBI al mese',
                    angle: -90,
                    position: 'insideLeft',
                    style: { fontSize: 12, fill: 'var(--text-muted)' },
                  }}
                />
                <Tooltip content={<ThroughputTooltip />} />
                <Legend
                  wrapperStyle={{ fontSize: 12, cursor: 'pointer' }}
                  itemSorter={(item) => (item.value === THROUGHPUT_LINE ? 0 : 1)}
                  onClick={(entry) => {
                    const key = String(entry.value)
                    setHidden((prev) => {
                      const next = new Set(prev)
                      if (next.has(key)) next.delete(key)
                      else next.add(key)
                      return next
                    })
                  }}
                  formatter={(value: string) => (
                    <span style={{ textDecoration: hidden.has(value) ? 'line-through' : undefined, opacity: hidden.has(value) ? 0.5 : 1 }}>
                      {value}
                    </span>
                  )}
                />
                <ReferenceLine y={med} stroke="var(--text-muted)" strokeDasharray="2 4" ifOverflow="extendDomain" />
                <Line
                  type="linear"
                  dataKey="count"
                  name={THROUGHPUT_LINE}
                  stroke="var(--primary)"
                  strokeWidth={2}
                  dot={{ r: 4, fill: 'var(--primary)' }}
                  activeDot={{ r: 6 }}
                  hide={hidden.has(THROUGHPUT_LINE)}
                  isAnimationActive={false}
                />
                <Line
                  type="linear"
                  dataKey="average"
                  name={THROUGHPUT_AVERAGE}
                  stroke="var(--text-muted)"
                  strokeWidth={2}
                  strokeDasharray="6 4"
                  dot={false}
                  connectNulls={false}
                  hide={hidden.has(THROUGHPUT_AVERAGE)}
                  isAnimationActive={false}
                />
              </LineChart>
            </ResponsiveContainer>
          </div>
          <p className="muted" style={{ fontSize: 12, margin: '4px 0 0' }}>
            Linea grigia puntinata: mediana mensile. Clic su una voce della legenda per nasconderla o mostrarla.
          </p>
        </>
      )}
    </div>
  )
}

// Serie del grafico Bug aperti: Complaint col rosso pieno del Bug (peso
// maggiore, segnalati da cliente), non Complaint in grigio neutro, CVE come
// nel Cycle Time (rosso a opacita' ridotta, tratteggiato) e nascosti di
// default perche' aperti in blocco a centinaia dal bot di security scan.
const BUGS_OPENED_SERIES = [
  { key: 'complaint', name: 'Complaint', color: PBI_TYPE_COLORS.Bug, opacity: 1, dash: undefined },
  { key: 'non_complaint', name: 'Non Complaint', color: '#6b7280', opacity: 1, dash: undefined },
  { key: 'cve', name: 'CVE (bot)', color: PBI_TYPE_COLORS.Bug, opacity: 0.45, dash: '5 4' },
] as const

type BugsOpenedPoint = BugsOpenedMonth & { label: string; total: number }

// Tooltip del grafico Bug aperti: valori per serie piu' i totali del mese,
// cosi' non serve sommarli a mente. Il totale con i CVE compare solo quando
// sono visibili.
function BugsOpenedTooltip({ active, payload, showCve }: { active?: boolean; payload?: { payload: BugsOpenedPoint }[]; showCve: boolean }) {
  if (!active || !payload || !payload.length) return null
  const p = payload[0].payload
  const row = (label: string, value: number, color: string, bold = false) => (
    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 16, fontWeight: bold ? 600 : 400 }}>
      <span style={{ color }}>{label}</span>
      <span>{value}</span>
    </div>
  )
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
      <div style={{ fontWeight: 600, marginBottom: 4 }}>{p.label}</div>
      {row('Complaint', p.complaint, PBI_TYPE_COLORS.Bug)}
      {row('Non Complaint', p.non_complaint, '#6b7280')}
      {row('Totale (esclusi CVE)', p.total, 'var(--text)', true)}
      {showCve && (
        <>
          {row('CVE (bot)', p.cve, PBI_TYPE_COLORS.Bug)}
          {row('Totale (con CVE)', p.total + p.cve, 'var(--text)', true)}
        </>
      )}
    </div>
  )
}

// Andamento mese per mese dei Bug aperti negli ultimi 12 mesi, Complaint e
// non Complaint piu' la loro somma (CVE opzionali, mai inclusi nel totale).
function BugsOpenedCard() {
  const { from, to } = useContext(DashboardWindowContext)
  const [team, setTeam] = useState<Team>('sw')
  const [showCve, setShowCve] = useState(false)
  const { data, refetch, isFetching, isSnapshot } = useChartData(
    team,
    ['dashboard', 'bugs-opened', team, from, to],
    () => api.dashboard.bugsOpened(team, from, to),
    (d) => d.bugs_opened,
  )

  const header = (
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 8 }}>
      <h3 style={{ marginTop: 0, marginBottom: 0 }}>
        Bug aperti <WindowBadge />
      </h3>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        <label style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 12, cursor: 'pointer' }}>
          <input type="checkbox" checked={showCve} onChange={(e) => setShowCve(e.target.checked)} />
          Mostra CVE
        </label>
        <TeamSelector team={team} onChange={setTeam} />
        {data && !isSnapshot && <RefreshButton onClick={() => refetch()} isFetching={isFetching} />}
      </div>
    </div>
  )

  if (!data) {
    return (
      <div className="card">
        {header}
        <p className="muted">Caricamento...</p>
      </div>
    )
  }

  const months = data.months.filter((m) => m.month >= from.slice(0, 7) && m.month <= to.slice(0, 7))
  const chartData = months.map((m) => {
    const [year, month] = m.month.split('-').map(Number)
    const label = new Date(Date.UTC(year, month - 1, 1)).toLocaleDateString('it-IT', {
      month: 'short',
      year: '2-digit',
      timeZone: 'UTC',
    })
    return { ...m, label, total: m.complaint + m.non_complaint }
  })
  const totals = Object.fromEntries(
    BUGS_OPENED_SERIES.map((s) => [s.key, months.reduce((sum, m) => sum + m[s.key], 0)]),
  ) as Record<(typeof BUGS_OPENED_SERIES)[number]['key'], number>
  const visibleSeries = BUGS_OPENED_SERIES.filter((s) => s.key !== 'cve' || showCve)

  return (
    <div className="card">
      {header}
      <p className="muted" style={{ marginTop: 8, marginBottom: 12 }}>
        Bug creati per mese nel periodo scelto (JQL base del {team === 'sw' ? 'Team SW' : 'Team Embedded'}): totale{' '}
        <strong>{totals.complaint + totals.non_complaint}</strong> (<strong>{totals.complaint}</strong> complaint,{' '}
        <strong>{totals.non_complaint}</strong> non complaint)
        {totals.cve > 0 && (
          <>
            , più <strong>{totals.cve}</strong> CVE del bot di security scan{showCve ? '' : ' (nascosti)'}
          </>
        )}
        .
      </p>

      {data.error ? (
        <p className="muted">{data.error}</p>
      ) : (
        <div style={{ display: 'flex', gap: 24, flexWrap: 'wrap', alignItems: 'flex-start' }}>
          <div style={{ flex: '1 1 480px', minWidth: 0, height: 280 }}>
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={chartData} margin={{ top: 8, right: 16, left: 8, bottom: 8 }}>
                <CartesianGrid strokeDasharray="3 3" />
                <XAxis dataKey="label" tick={{ fontSize: 12 }} />
                <YAxis
                  allowDecimals={false}
                  tick={{ fontSize: 12 }}
                  label={{ value: 'Bug', angle: -90, position: 'insideLeft', style: { fontSize: 12, fill: 'var(--text-muted)' } }}
                />
                <Tooltip content={<BugsOpenedTooltip showCve={showCve} />} />
                <Legend wrapperStyle={{ fontSize: 12 }} />
                <Line
                  type="linear"
                  dataKey="total"
                  name="Totale (esclusi CVE)"
                  stroke="var(--text)"
                  strokeWidth={3}
                  dot={{ r: 3, fill: 'var(--text)' }}
                />
                {visibleSeries.map((s) => (
                  <Line
                    key={s.key}
                    type="linear"
                    dataKey={s.key}
                    name={s.name}
                    stroke={s.color}
                    strokeOpacity={s.opacity}
                    strokeDasharray={s.dash}
                    strokeWidth={2}
                    dot={{ r: 3, fill: s.color, fillOpacity: s.opacity }}
                  />
                ))}
              </LineChart>
            </ResponsiveContainer>
          </div>
          <BugStatusTable byStatus={data.by_status} />
        </div>
      )}
    </div>
  )
}

// ---------- Flusso: WIP, Throughput e Cycle Time ----------

// Colori del grafico Flusso: tre misure diverse, prese dalla palette gia'
// usata (viola Activity, blu Story, arancio Task) per restare distinguibili.
const FLOW_WIP_COLOR = PBI_TYPE_COLORS.Activity
const FLOW_THROUGHPUT_COLOR = PBI_TYPE_COLORS.Story
const FLOW_CYCLE_TIME_COLOR = PBI_TYPE_COLORS.Task

type FlowGranularity = 'month' | 'week'
type FlowPeriod = {
  label: string
  // Periodo ancora in corso: fuori dalle correlazioni (throughput parziale).
  partial: boolean
  wip: number
  throughput: number
  cycleTime: number | null
}

// Lunedi' della settimana di un giorno (epoch day 0 = giovedi' 1/1/1970).
const mondayOf = (day: number) => day - ((day + 3) % 7)

// Periodi del grafico Flusso (mesi o settimane del periodo scelto), come
// intervalli [from, to) in epoch days.
function flowPeriods(granularity: FlowGranularity, startDay: number, endDay: number): { from: number; to: number; label: string }[] {
  if (granularity === 'week') {
    const periods: { from: number; to: number; label: string }[] = []
    for (let from = mondayOf(startDay); from <= endDay && periods.length < 600; from += 7) {
      const d = epochDaysToDate(from)
      periods.push({
        from,
        to: from + 7,
        label: d.toLocaleDateString('it-IT', { day: '2-digit', month: '2-digit', year: '2-digit', timeZone: 'UTC' }),
      })
    }
    return periods
  }
  const iso = (day: number) => epochDaysToDate(day).toISOString().slice(0, 10)
  return monthsBetween(iso(startDay), iso(endDay)).map((m) => ({
    from: dateStrToEpochDays(m.date) as number,
    to: dateStrToEpochDays(shiftMonths(m.date, 1)) as number,
    label: monthLabel(m.date),
  }))
}

// Percentile con interpolazione lineare (come _percentile nel backend e
// numpy): per il cycle time all'85° percentile del grafico Flusso.
function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const k = (sorted.length - 1) * (p / 100)
  const f = Math.floor(k)
  const c = Math.ceil(k)
  return f === c ? sorted[f] : sorted[f] * (c - k) + sorted[c] * (k - f)
}

// Correlazione di Pearson (null con meno di 3 coppie o senza variazione).
function pearson(pairs: [number, number][]): number | null {
  if (pairs.length < 3) return null
  const n = pairs.length
  const mx = pairs.reduce((s, [x]) => s + x, 0) / n
  const my = pairs.reduce((s, [, y]) => s + y, 0) / n
  let sxy = 0
  let sxx = 0
  let syy = 0
  for (const [x, y] of pairs) {
    sxy += (x - mx) * (y - my)
    sxx += (x - mx) ** 2
    syy += (y - my) ** 2
  }
  return sxx && syy ? sxy / Math.sqrt(sxx * syy) : null
}

function strength(r: number): string {
  const a = Math.abs(r)
  return a >= 0.6 ? 'forte' : a >= 0.3 ? 'moderata' : 'debole'
}

// Lettura in parole delle due correlazioni: il WIP allunga il cycle time?
// e il throughput intanto cala o tiene?
function flowVerdict(rCt: number | null, rTp: number | null): string {
  if (rCt === null || rTp === null) return 'Dati insufficienti per una lettura.'
  const ct =
    rCt >= 0.3
      ? 'Quando ci sono più PBI in parallelo il cycle time tende ad allungarsi'
      : rCt <= -0.3
        ? 'Quando ci sono più PBI in parallelo il cycle time tende ad accorciarsi'
        : 'Il cycle time non segue in modo chiaro il WIP'
  const tp =
    rTp >= 0.3
      ? 'il throughput sale insieme al WIP: si chiude comunque di più.'
      : rTp <= -0.3
        ? 'il throughput cala quando il WIP sale: il parallelismo sta frenando il flusso.'
        : 'il throughput non cambia molto col WIP: più parallelismo non porta più PBI chiusi.'
  return `${ct}; ${tp}`
}

function FlowTooltip({
  active,
  payload,
}: {
  active?: boolean
  payload?: { payload: FlowPeriod }[]
}) {
  if (!active || !payload || !payload.length) return null
  const p = payload[0].payload
  const row = (label: string, value: string, color: string) => (
    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 16 }}>
      <span style={{ color }}>{label}</span>
      <span>{value}</span>
    </div>
  )
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
      <div style={{ fontWeight: 600, marginBottom: 4 }}>
        {p.label}
        {p.partial ? ' (in corso)' : ''}
      </div>
      {row('WIP medio', p.wip.toLocaleString('it-IT', { maximumFractionDigits: 1 }), FLOW_WIP_COLOR)}
      {row('PBI chiusi', String(p.throughput), FLOW_THROUGHPUT_COLOR)}
      {row(
        'Cycle time 85° percentile',
        p.cycleTime === null ? '—' : `${p.cycleTime.toLocaleString('it-IT', { maximumFractionDigits: 1 })} gg`,
        FLOW_CYCLE_TIME_COLOR,
      )}
    </div>
  )
}

// Piccolo grafico a dispersione: un punto per periodo, WIP medio in X.
function FlowScatter({
  title,
  points,
  yName,
  xName = 'WIP medio',
  color,
  r,
}: {
  title: string
  points: { x: number; y: number; label: string }[]
  yName: string
  xName?: string
  color: string
  r: number | null
}) {
  return (
    <div style={{ flex: '1 1 260px', minWidth: 0 }}>
      <div style={{ fontSize: 13, fontWeight: 600 }}>{title}</div>
      <div className="muted" style={{ fontSize: 12, marginBottom: 4 }}>
        {r === null ? 'correlazione non calcolabile' : `correlazione ${strength(r)} (r = ${r.toFixed(2).replace('.', ',')})`}
      </div>
      <div style={{ height: 200 }}>
        <ResponsiveContainer width="100%" height="100%">
          <ScatterChart margin={{ top: 8, right: 12, left: 0, bottom: 16 }}>
            <CartesianGrid strokeDasharray="3 3" />
            <XAxis
              type="number"
              dataKey="x"
              name={xName}
              tick={{ fontSize: 11 }}
              domain={['auto', 'auto']}
              label={{ value: xName, position: 'insideBottom', offset: -8, style: { fontSize: 11, fill: 'var(--text-muted)' } }}
            />
            <YAxis type="number" dataKey="y" name={yName} tick={{ fontSize: 11 }} domain={['auto', 'auto']} width={36} />
            <Tooltip
              cursor={{ strokeDasharray: '3 3' }}
              content={({ active, payload }) =>
                active && payload?.length ? (
                  <div
                    style={{
                      background: 'var(--surface)',
                      border: '1px solid var(--border)',
                      borderRadius: 6,
                      padding: '4px 8px',
                      fontSize: 12,
                    }}
                  >
                    <b>{(payload[0].payload as { label: string }).label}</b>
                    <div>
                      {xName} {Number(payload[0].payload.x).toLocaleString('it-IT', { maximumFractionDigits: 1 })}
                    </div>
                    <div>
                      {yName} {Number(payload[0].payload.y).toLocaleString('it-IT', { maximumFractionDigits: 1 })}
                    </div>
                  </div>
                ) : null
              }
            />
            <Scatter data={points} fill={color} fillOpacity={points.length > 40 ? 0.55 : 1} shape={points.length > 40 ? 'circle' : undefined} />
          </ScatterChart>
        </ResponsiveContainer>
      </div>
    </div>
  )
}

// WIP, Throughput e Cycle Time nello stesso grafico, per periodo: il WIP e'
// la media giornaliera dei PBI in lavorazione (da inizio In Progress a
// Done), il throughput i PBI chiusi, il cycle time l'85° percentile di quelli
// chiusi nel periodo. Sotto, WIP contro cycle time e contro throughput,
// con la correlazione: per capire se il parallelismo allunga i tempi e se
// intanto si chiude di piu' o di meno. Bug CVE del bot esclusi.
function FlowCard() {
  const [team, setTeam] = useState<Team>('sw')
  const [granularity, setGranularity] = useState<FlowGranularity>('month')
  const [includeStale, setIncludeStale] = useState(false)
  const window = useContext(DashboardWindowContext)
  const cycle = useDashboardCycleTime(team)
  // Dati da file: i PBI in corso sono nel file stesso; da Jira si leggono a
  // parte (solo quelli iniziati davvero).
  const fromFile = !cycle.isSnapshot && !!cycle.data?.source
  const wip = useChartData(
    team,
    ['dashboard', 'wip', team],
    () => api.dashboard.wip(team),
    (d) => d.wip ?? { in_progress: [], error: 'Grafico non presente in questo snapshot (creato prima).' },
    !fromFile,
  )

  const header = (
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 8 }}>
      <h3 style={{ marginTop: 0, marginBottom: 0 }}>
        Flusso: WIP, Throughput e Cycle Time <WindowBadge />
      </h3>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <div style={{ display: 'flex', gap: 2, border: '1px solid var(--border)', borderRadius: 'var(--radius)', padding: 2 }}>
          {(
            [
              ['month', 'Mesi'],
              ['week', 'Settimane'],
            ] as const
          ).map(([key, label]) => (
            <button
              key={key}
              onClick={() => setGranularity(key)}
              style={{
                border: 'none',
                borderRadius: 6,
                padding: '3px 10px',
                fontSize: 12,
                cursor: 'pointer',
                background: granularity === key ? 'var(--primary)' : 'transparent',
                color: granularity === key ? 'white' : 'var(--text)',
                fontWeight: granularity === key ? 600 : 400,
              }}
            >
              {label}
            </button>
          ))}
        </div>
        <TeamSelector team={team} onChange={setTeam} />
        {!cycle.isSnapshot && !fromFile && wip.data && (
          <RefreshButton
            onClick={() => wip.refetch()}
            isFetching={wip.isFetching}
            label="Aggiorna PBI in corso"
          />
        )}
      </div>
    </div>
  )
  const sourceBar = <NoCycleTimeData source={cycle} />

  if (!cycle.data || (!fromFile && !wip.data)) {
    return (
      <div className="card">
        {header}
        {sourceBar}
        {cycle.data && <p className="muted">Lettura da Jira dei PBI in corso (qualche secondo)…</p>}
      </div>
    )
  }
  const error = cycle.data.error ?? (fromFile ? null : (wip.data?.error ?? null))
  if (error) {
    return (
      <div className="card">
        {header}
        {sourceBar}
        <p className="muted">{error}</p>
      </div>
    )
  }
  const inProgress = fromFile ? (cycle.data.in_progress ?? []) : (wip.data?.in_progress ?? [])

  // Ultimo giorno considerato: la fine del periodo scelto, al massimo oggi.
  const today = Math.min(
    dateStrToEpochDays(isoDate(new Date())) as number,
    dateStrToEpochDays(window.to) as number,
  )
  const periods = flowPeriods(granularity, dateStrToEpochDays(window.from) as number, today)
  const rangeStart = periods[0].from
  // PBI chiusi: inizio = fine - cycle time. PBI aperti: fine ancora da venire.
  const closed = cycle.data.points
    .filter((p) => !p.is_cve)
    .map((p) => {
      const finish = dateStrToEpochDays(p.finish_date) as number
      return { key: p.key, start: finish - p.cycle_time_days, finish, cycleTime: p.cycle_time_days }
    })
  const openAll = inProgress.filter((i) => !i.is_cve)
  const stale = openAll.filter((i) => (dateStrToEpochDays(i.start_date) as number) < rangeStart)
  const open = openAll
    .filter((i) => includeStale || (dateStrToEpochDays(i.start_date) as number) >= rangeStart)
    .map((i) => ({ start: dateStrToEpochDays(i.start_date) as number }))

  // PBI chiusi nel periodo scelto: per ognuno il WIP vissuto durante la sua
  // lavorazione (grafico per PBI), quindi il WIP serve anche da prima del
  // periodo, dall'inizio del PBI chiuso nel periodo iniziato prima.
  const windowStartDay = dateStrToEpochDays(window.from) as number
  const closedInWindow = closed.filter((c) => c.finish >= windowStartDay && c.finish <= today)
  const wipStart = Math.min(rangeStart, ...closedInWindow.map((c) => c.start))

  // WIP di ogni giorno da wipStart a oggi: +1 dal giorno di inizio, -1 dal
  // giorno di chiusura (somme prefisse).
  const days = today - wipStart + 1
  const delta = new Array<number>(days + 1).fill(0)
  const addSpan = (start: number, end: number) => {
    const s = Math.max(start, wipStart)
    const e = Math.min(end, today + 1)
    if (e <= s) return
    delta[s - wipStart] += 1
    delta[e - wipStart] -= 1
  }
  for (const c of closed) addSpan(c.start, c.finish)
  for (const o of open) addSpan(o.start, today + 1)
  const wipByDay: number[] = []
  let running = 0
  for (let i = 0; i < days; i++) {
    running += delta[i]
    wipByDay.push(running)
  }

  const data: FlowPeriod[] = periods.map((p) => {
    const lastDay = Math.min(p.to, today + 1)
    const span = wipByDay.slice(p.from - wipStart, lastDay - wipStart)
    const finished = closed.filter((c) => c.finish >= p.from && c.finish < p.to)
    return {
      label: p.label,
      partial: p.to > today + 1,
      wip: span.length ? span.reduce((s, v) => s + v, 0) / span.length : 0,
      throughput: finished.length,
      cycleTime: finished.length ? percentile(finished.map((c) => c.cycleTime), 85) : null,
    }
  })
  const complete = data.filter((d) => !d.partial)
  // WIP -> cycle time per PBI: per ogni PBI chiuso nel periodo, quanti altri
  // PBI erano in lavorazione in media mentre lo era lui (lui escluso), contro
  // il suo cycle time. Cosi' le due misure riguardano gli stessi PBI e gli
  // stessi giorni (confrontare il WIP di un mese col cycle time dei PBI
  // chiusi in quel mese mescola PBI diversi: il WIP alto di un mese pesa sui
  // PBI che si chiudono nei mesi dopo).
  const pbiPoints = closedInWindow.map((c) => {
    const end = Math.max(c.finish, c.start + 1)
    const span = wipByDay.slice(c.start - wipStart, end - wipStart)
    const own = c.finish > c.start ? 1 : 0
    const avg = span.length ? span.reduce((sum, v) => sum + v, 0) / span.length - own : 0
    return { x: Math.max(0, avg), y: c.cycleTime, label: c.key }
  })
  // Tre fasce di PBI per parallelismo (terzili), con l'85° percentile del
  // cycle time di ciascuna: piu' leggibile della sola correlazione.
  const sortedPbi = [...pbiPoints].sort((a, b) => a.x - b.x)
  const bands =
    sortedPbi.length >= 9
      ? ['Meno parallelismo', 'Parallelismo medio', 'Più parallelismo'].map((name, i) => {
          const part = sortedPbi.slice(Math.floor((i * sortedPbi.length) / 3), Math.floor(((i + 1) * sortedPbi.length) / 3))
          return {
            name,
            count: part.length,
            from: part[0].x,
            to: part[part.length - 1].x,
            p85: percentile(part.map((p) => p.y), 85),
            median: median(part.map((p) => p.y)),
          }
        })
      : []
  const tpPoints = complete.map((d) => ({ x: d.wip, y: d.throughput, label: d.label }))
  const rCt = pearson(pbiPoints.map((p) => [p.x, p.y]))
  const rTp = pearson(tpPoints.map((p) => [p.x, p.y]))
  const fmt1 = (n: number) => n.toLocaleString('it-IT', { maximumFractionDigits: 1 })
  const w =
    granularity === 'month'
      ? { per: 'mese', the: 'il mese', inThe: 'nel mese', a: 'un mese' }
      : { per: 'settimana', the: 'la settimana', inThe: 'nella settimana', a: 'una settimana' }

  return (
    <div className="card">
      {header}
      <p className="muted" style={{ marginTop: 8, marginBottom: 8 }}>
        Per {w.per}: <b style={{ color: FLOW_WIP_COLOR }}>WIP medio</b> (PBI contemporaneamente in lavorazione, da
        In Progress a Done, media dei giorni), <b style={{ color: FLOW_THROUGHPUT_COLOR }}>PBI chiusi</b> e{' '}
        <b style={{ color: FLOW_CYCLE_TIME_COLOR }}>cycle time all'85° percentile</b> dei PBI chiusi {w.inThe} (l'85% si
        è chiuso entro quel numero di giorni). Bug CVE del bot
        esclusi; {w.the} in corso è nel grafico (più chiara) ma non nelle correlazioni.
      </p>
      {stale.length > 0 && (
        <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, marginBottom: 8 }}>
          <input type="checkbox" checked={includeStale} onChange={(e) => setIncludeStale(e.target.checked)} />
          Includi {stale.length} PBI ancora aperti ma iniziati prima del periodo (fermi da tempo: alzano il WIP di{' '}
          {stale.length} per tutto il periodo)
        </label>
      )}
      <div style={{ height: 320 }}>
        <ResponsiveContainer width="100%" height="100%">
          <ComposedChart data={data} margin={{ top: 8, right: 8, left: 0, bottom: 8 }}>
            <CartesianGrid strokeDasharray="3 3" vertical={false} />
            <XAxis dataKey="label" tick={{ fontSize: 12 }} interval={granularity === 'week' ? 3 : 0} />
            <YAxis
              yAxisId="pbi"
              allowDecimals={false}
              tick={{ fontSize: 12 }}
              label={{ value: 'PBI', angle: -90, position: 'insideLeft', style: { fontSize: 12, fill: 'var(--text-muted)' } }}
            />
            <YAxis
              yAxisId="days"
              orientation="right"
              tick={{ fontSize: 12 }}
              label={{ value: 'giorni', angle: 90, position: 'insideRight', style: { fontSize: 12, fill: 'var(--text-muted)' } }}
            />
            <Tooltip content={<FlowTooltip />} cursor={{ fill: 'var(--bg)' }} />
            <Legend wrapperStyle={{ fontSize: 12 }} />
            <Bar yAxisId="pbi" dataKey="throughput" name="PBI chiusi" fill={FLOW_THROUGHPUT_COLOR} fillOpacity={0.55} maxBarSize={40}>
              {data.map((d) => (
                <Cell key={d.label} fillOpacity={d.partial ? 0.25 : 0.55} />
              ))}
            </Bar>
            <Line
              yAxisId="pbi"
              type="linear"
              dataKey="wip"
              name="WIP medio"
              stroke={FLOW_WIP_COLOR}
              strokeWidth={2.5}
              dot={{ r: 3, fill: FLOW_WIP_COLOR }}
            />
            <Line
              yAxisId="days"
              type="linear"
              dataKey="cycleTime"
              name="Cycle time 85° percentile (giorni)"
              stroke={FLOW_CYCLE_TIME_COLOR}
              strokeWidth={2}
              strokeDasharray="5 3"
              dot={{ r: 3, fill: FLOW_CYCLE_TIME_COLOR }}
              connectNulls
            />
          </ComposedChart>
        </ResponsiveContainer>
      </div>
      <div className="flow-verdict">{flowVerdict(rCt, rTp)}</div>
      <div style={{ display: 'flex', gap: 24, flexWrap: 'wrap', marginTop: 8 }}>
        <div style={{ flex: '1 1 260px', minWidth: 0 }}>
          <FlowScatter
            title={`Parallelismo → Cycle time (un punto per PBI, ${pbiPoints.length})`}
            points={pbiPoints}
            xName="PBI in parallelo"
            yName="Cycle time (gg)"
            color={FLOW_CYCLE_TIME_COLOR}
            r={rCt}
          />
          {bands.length > 0 && (
            <table className="flow-bands">
              <thead>
                <tr>
                  <th />
                  <th>PBI in parallelo</th>
                  <th>PBI</th>
                  <th>Cycle time mediano</th>
                  <th>85° percentile</th>
                </tr>
              </thead>
              <tbody>
                {bands.map((b) => (
                  <tr key={b.name}>
                    <td>{b.name}</td>
                    <td>
                      {fmt1(b.from)}–{fmt1(b.to)}
                    </td>
                    <td>{b.count}</td>
                    <td>{fmt1(b.median)} gg</td>
                    <td>{fmt1(b.p85)} gg</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
        <FlowScatter
          title={`WIP → PBI chiusi (un punto per ${w.per})`}
          points={tpPoints}
          yName="PBI chiusi"
          color={FLOW_THROUGHPUT_COLOR}
          r={rTp}
        />
      </div>
      <details className="flow-help">
        <summary>Come leggere questi grafici</summary>
        <p>
          <b>WIP</b>: quanti PBI sono in lavorazione nello stesso giorno, da quando passano a In Progress (On-Going per
          le Activity) a quando vanno in Done. Nel grafico in alto è la media dei giorni di ogni {w.per}.
        </p>
        <p>
          <b>Parallelismo → Cycle time</b> è calcolato <b>per PBI</b>: per ogni PBI chiuso nel periodo si guarda quanti
          altri PBI erano in lavorazione, in media, nei giorni in cui era in lavorazione lui (lui escluso), e lo si
          confronta con il suo cycle time. Così le due misure riguardano gli stessi PBI e gli stessi giorni.
        </p>
        <p>
          Non si usa il confronto {w.per} per {w.per} perché mescola PBI diversi: il WIP di {w.a} conta tutti i PBI in
          lavorazione, mentre il cycle time di quel {w.per} riguarda solo quelli chiusi in quel {w.per}. Quando il WIP
          è alto, la maggior parte di quei PBI si chiude nei {granularity === 'month' ? 'mesi' : 'periodi'} successivi,
          quindi un eventuale allungamento dei tempi si vedrebbe più avanti e non nello stesso {w.per}.
        </p>
        <p>
          La tabella divide i PBI in tre fasce uguali per parallelismo: se il cycle time cresce passando da "meno" a
          "più parallelismo", lavorare su più PBI insieme allunga i tempi.
        </p>
        <p>
          <b>WIP → PBI chiusi</b> resta per {w.per}: misura se nei {granularity === 'month' ? 'mesi' : 'periodi'} con più
          lavoro aperto si chiude di più o di meno. Se il cycle time cresce col parallelismo ma i PBI chiusi crescono
          anche loro, il flusso tiene; se calano, il parallelismo lo sta frenando.
        </p>
        <p>
          <b>Correlazione</b>: vicino a +1 le due misure crescono insieme, vicino a −1 una cresce mentre l'altra cala,
          vicino a 0 non c'è legame. È un indizio, non una prova di causa. Bug CVE del bot esclusi. Il WIP dei giorni
          prima dei dati disponibili (inizio dello storico) può essere sottostimato.
        </p>
      </details>
    </div>
  )
}

// Serie del grafico PBI chiusi per increment, impilate dal basso: Story e
// Bug con i colori di sempre, Bug Complaint con l'arancio della palette
// (validata per il daltonismo), CVE come negli altri grafici (rosso a
// opacita' ridotta) e nascosti di default: chiusi in blocco dal bot.
// Activity col viola di sempre, nascoste di default (non sono sviluppo).
const DONE_BY_INCREMENT_SERIES = [
  { key: 'story', name: 'Story', color: PBI_TYPE_COLORS.Story, opacity: 1 },
  { key: 'bug', name: 'Bug', color: PBI_TYPE_COLORS.Bug, opacity: 1 },
  { key: 'bug_complaint', name: 'Bug Complaint', color: PBI_TYPE_COLORS.Task, opacity: 1 },
  { key: 'activity', name: 'Activity', color: PBI_TYPE_COLORS.Activity, opacity: 1 },
  { key: 'bug_cve', name: 'Bug CVE (bot)', color: PBI_TYPE_COLORS.Bug, opacity: 0.35 },
] as const
type DoneByIncrementSeries = (typeof DONE_BY_INCREMENT_SERIES)[number]

// topKey: serie del segmento piu' alto non vuoto, su cui va il totale.
type DoneByIncrementPoint = DoneByIncrement & { label: string; total: number; topKey?: string }

// "PTBSYS-03-004 - December 26" -> "03-004": la chiave del progetto e' la
// stessa per tutti.
function shortVersion(version: string): string {
  const match = version.match(/^[A-Z][A-Z0-9]*-(\d+-\d+)/)
  return match ? match[1] : version
}

function DoneByIncrementTooltip({
  active,
  payload,
  series,
}: {
  active?: boolean
  payload?: { payload: DoneByIncrementPoint }[]
  series: DoneByIncrementSeries[]
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
      }}
    >
      <div style={{ fontWeight: 600 }}>{p.version}</div>
      <div className="muted" style={{ marginBottom: 4 }}>
        {p.project_name ? `${p.project_name} · ` : ''}
        {p.released ? 'rilasciato' : 'non rilasciato'}
        {p.release_date ? ` · ${formatIsoDate(p.release_date)}` : ''}
      </div>
      {[...series].reverse().map((s) => (
        <div key={s.key} style={{ display: 'flex', justifyContent: 'space-between', gap: 16 }}>
          <span style={{ color: s.color }}>{s.name}</span>
          <span>{p[s.key]}</span>
        </div>
      ))}
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 16, fontWeight: 600 }}>
        <span>Totale</span>
        <span>{p.total}</span>
      </div>
      {p.project_id !== null && <div className="muted" style={{ marginTop: 4 }}>Clic per aprire l'increment</div>}
    </div>
  )
}

// PBI chiusi (Done) per increment, cioe' per fix version Jira, sulla JQL
// base del team: barre impilate per tipo, dagli increment piu' vecchi ai
// piu' recenti (ultimi 12).
function DoneByIncrementCard() {
  const [team, setTeam] = useState<Team>('sw')
  const [showCve, setShowCve] = useState(false)
  const [showActivity, setShowActivity] = useState(false)
  const { from, to } = useContext(DashboardWindowContext)
  const navigate = useNavigate()
  const { data, refetch, isFetching, isSnapshot } = useChartData(
    team,
    ['dashboard', 'done-by-increment', team],
    () => api.dashboard.doneByIncrement(team),
    (d) => d.done_by_increment ?? { increments: [], error: 'Grafico non presente in questo snapshot (creato prima).' },
  )

  const header = (
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 8 }}>
      <h3 style={{ marginTop: 0, marginBottom: 0 }}>
        PBI chiusi per increment <WindowBadge />
      </h3>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        <label style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 12, cursor: 'pointer' }}>
          <input type="checkbox" checked={showActivity} onChange={(e) => setShowActivity(e.target.checked)} />
          Mostra Activity
        </label>
        <label style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 12, cursor: 'pointer' }}>
          <input type="checkbox" checked={showCve} onChange={(e) => setShowCve(e.target.checked)} />
          Mostra CVE
        </label>
        <TeamSelector team={team} onChange={setTeam} />
        {data && !isSnapshot && <RefreshButton onClick={() => refetch()} isFetching={isFetching} />}
      </div>
    </div>
  )

  if (!data) {
    return (
      <div className="card">
        {header}
        <p className="muted">Caricamento...</p>
      </div>
    )
  }

  const series: DoneByIncrementSeries[] = DONE_BY_INCREMENT_SERIES.filter(
    (s) => (s.key !== 'bug_cve' || showCve) && (s.key !== 'activity' || showActivity),
  )
  // Gli increment senza nessun PBI dei tipi mostrati (es. solo Activity,
  // con le Activity nascoste) restano fuori.
  // Increment rilasciati (data di rilascio) nel periodo scelto; quelli
  // senza data di rilascio restano.
  const inWindow = data.increments.filter((i) => !i.release_date || (i.release_date >= from && i.release_date <= to))
  const chartData: DoneByIncrementPoint[] = inWindow
    .map((i) => ({
      ...i,
      // Snapshot creati prima delle Activity: 0.
      activity: i.activity ?? 0,
      label: shortVersion(i.version),
      total: series.reduce((sum, s) => sum + (i[s.key] ?? 0), 0),
      topKey: [...series].reverse().find((s) => (i[s.key] ?? 0) > 0)?.key,
    }))
    .filter((p) => p.total > 0)
  const cveTotal = inWindow.reduce((sum, i) => sum + i.bug_cve, 0)

  return (
    <div className="card">
      {header}
      <p className="muted" style={{ marginTop: 8, marginBottom: 12 }}>
        PBI in Done per fix version (JQL base del {team === 'sw' ? 'Team SW' : 'Team Embedded'}): {chartData.length} increment con data di
        rilascio nel periodo scelto (tra gli ultimi 12 con PBI chiusi), più quelli senza data. I Bug Complaint sono quelli con Source Type = Complaint
        {cveTotal > 0 && !showCve && (
          <>
            ; nascosti <strong>{cveTotal}</strong> Bug CVE del bot di security scan
          </>
        )}
        .{showActivity ? ' I Task non sono contati.' : ' Activity (nascoste) e Task non sono contati.'}
      </p>
      {data.error ? (
        <p className="muted">{data.error}</p>
      ) : chartData.length === 0 ? (
        <p className="muted">Nessun PBI chiuso con una fix version di increment.</p>
      ) : (
        <div style={{ height: 300 }}>
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={chartData} margin={{ top: 20, right: 16, left: 8, bottom: 8 }}>
              <CartesianGrid strokeDasharray="3 3" vertical={false} />
              <XAxis dataKey="label" tick={{ fontSize: 12 }} interval={0} />
              <YAxis
                allowDecimals={false}
                tick={{ fontSize: 12 }}
                label={{ value: 'PBI', angle: -90, position: 'insideLeft', style: { fontSize: 12, fill: 'var(--text-muted)' } }}
              />
              <Tooltip content={<DoneByIncrementTooltip series={series} />} cursor={{ fill: 'var(--bg)' }} />
              <Legend
                wrapperStyle={{ fontSize: 12 }}
                itemSorter={(item) => DONE_BY_INCREMENT_SERIES.findIndex((s) => s.name === item.value)}
              />
              {series.map((s) => (
                <Bar
                  key={s.key}
                  dataKey={s.key}
                  name={s.name}
                  stackId="done"
                  fill={s.color}
                  fillOpacity={s.opacity}
                  maxBarSize={56}
                  style={{ cursor: 'pointer' }}
                  onClick={(entry: { payload?: DoneByIncrementPoint }) => {
                    const id = entry.payload?.project_id
                    if (id != null) navigate(`/projects/${id}`)
                  }}
                >
                  {/* Totale sopra la barra: sul segmento piu' alto non vuoto. */}
                  <LabelList
                    position="top"
                    style={{ fontSize: 12, fill: 'var(--text)' }}
                    valueAccessor={(entry: { payload: DoneByIncrementPoint }) =>
                      entry.payload.topKey === s.key ? entry.payload.total : null
                    }
                  />
                </Bar>
              ))}
            </BarChart>
          </ResponsiveContainer>
        </div>
      )}
    </div>
  )
}

// Tabellina a fianco del grafico Bug aperti: gli stessi Bug (ultimi 12 mesi,
// CVE esclusi) per stato Jira attuale - "aperti" nel grafico vuol dire
// segnalati nel mese, qui si vede quanti sono poi stati chiusi o scartati.
function BugStatusTable({ byStatus }: { byStatus: BugStatusCount[] }) {
  const total = byStatus.reduce((sum, s) => sum + s.count, 0)
  const cell = { padding: '4px 8px', borderBottom: '1px solid var(--border)' }
  return (
    <div style={{ flex: '0 0 auto' }}>
      <div style={{ fontWeight: 600, fontSize: 13, marginBottom: 2 }}>Stato attuale</div>
      <div className="muted" style={{ fontSize: 12, marginBottom: 8 }}>
        Bug del periodo scelto, CVE esclusi
      </div>
      <table style={{ borderCollapse: 'collapse', fontSize: 13 }}>
        <thead>
          <tr>
            <th style={{ ...cell, textAlign: 'left' }}>Stato</th>
            <th style={{ ...cell, textAlign: 'right' }}>Bug</th>
          </tr>
        </thead>
        <tbody>
          {byStatus.map((s) => (
            <tr key={s.status}>
              <td style={cell}>{s.status}</td>
              <td style={{ ...cell, textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{s.count}</td>
            </tr>
          ))}
          <tr>
            <td style={{ ...cell, fontWeight: 600, borderBottom: 'none' }}>Totale</td>
            <td style={{ ...cell, fontWeight: 600, borderBottom: 'none', textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>
              {total}
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  )
}

// Pannello snapshot in cima alla Dashboard generale: crea una fotografia dei
// grafici Jira (entrambi i team) e ne elenca lo storico; lo snapshot scelto
// finisce nell'URL (?snapshot=ID), cosi' un link o un refresh della pagina
// riaprono gli stessi dati - comodo per la presentazione mensile.
function SnapshotPanel({ selectedId, onSelect }: { selectedId: number | null; onSelect: (id: number | null) => void }) {
  const queryClient = useQueryClient()
  const [note, setNote] = useState('')
  const { data: snapshots } = useQuery({ queryKey: ['dashboard-snapshots'], queryFn: api.dashboardSnapshots.list })

  const create = useMutation({
    mutationFn: () => api.dashboardSnapshots.create(note.trim() || null),
    onSuccess: (created) => {
      setNote('')
      queryClient.invalidateQueries({ queryKey: ['dashboard-snapshots'] })
      onSelect(created.id)
    },
  })
  const update = useMutation({
    mutationFn: ({ id, note }: { id: number; note: string | null }) => api.dashboardSnapshots.update(id, note),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['dashboard-snapshots'] })
      queryClient.invalidateQueries({ queryKey: ['dashboard-snapshot'] })
    },
  })
  const remove = useMutation({
    mutationFn: (id: number) => api.dashboardSnapshots.remove(id),
    onSuccess: (_, id) => {
      if (id === selectedId) onSelect(null)
      queryClient.invalidateQueries({ queryKey: ['dashboard-snapshots'] })
    },
  })

  const selected = snapshots?.find((s) => s.id === selectedId)

  return (
    <div className="card">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 8 }}>
        <h3 style={{ marginTop: 0, marginBottom: 0 }}>Snapshot</h3>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <input
            placeholder="Nota (es. Presentazione settembre)"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            disabled={create.isPending}
            style={{ width: 260 }}
          />
          <button className="btn btn-primary" onClick={() => create.mutate()} disabled={create.isPending}>
            {create.isPending ? 'Creazione in corso...' : '📷 Crea snapshot'}
          </button>
        </div>
      </div>
      <p className="muted" style={{ marginTop: 8, marginBottom: 12 }}>
        Uno snapshot congela i dati Jira di tutti i grafici qui sotto (Metriche, Cycle Time, Throughput, Bug aperti) per
        entrambi i team, cosi' si possono rivedere in futuro esattamente come erano oggi.
        {create.isPending && ' La raccolta da Jira puo\' richiedere circa un minuto.'}
      </p>
      {create.isError && <p style={{ color: 'var(--danger)' }}>Errore nella creazione: {(create.error as Error).message}</p>}

      {selected && (
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            flexWrap: 'wrap',
            gap: 8,
            padding: '8px 12px',
            marginBottom: 12,
            borderRadius: 'var(--radius)',
            border: '1px solid var(--warning)',
            background: 'var(--bg)',
          }}
        >
          <span>
            Stai visualizzando lo snapshot del <strong>{formatIsoDate(selected.snapshot_date)}</strong>
            {selected.note ? ` (${selected.note})` : ''}: i grafici non si aggiornano.
          </span>
          <button className="btn" onClick={() => onSelect(null)}>
            Torna ai dati live
          </button>
        </div>
      )}

      {snapshots && snapshots.length > 0 ? (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Data</th>
                <th>Nota</th>
                <th>Creato alle</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {snapshots.map((s) => (
                <tr key={s.id} style={s.id === selectedId ? { background: 'var(--bg)' } : undefined}>
                  <td>
                    <strong>{formatIsoDate(s.snapshot_date)}</strong>
                    {s.has_errors && (
                      <span style={{ color: 'var(--warning)', marginLeft: 6 }} title="Alcuni grafici hanno restituito un errore al momento dello snapshot">
                        ⚠
                      </span>
                    )}
                  </td>
                  <td className="editable-cell" style={{ width: '100%' }}>
                    <input
                      key={`${s.id}-${s.note ?? ''}`}
                      defaultValue={s.note ?? ''}
                      placeholder="Aggiungi una nota"
                      onBlur={(e) => {
                        if ((e.target.value.trim() || null) !== s.note) update.mutate({ id: s.id, note: e.target.value })
                      }}
                    />
                  </td>
                  <td className="muted">
                    {parseBackendDateTime(s.created_at).toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' })}
                  </td>
                  <td>
                    <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end' }}>
                      {s.id === selectedId ? (
                        <button className="btn active" onClick={() => onSelect(null)}>
                          In visualizzazione
                        </button>
                      ) : (
                        <button className="btn" onClick={() => onSelect(s.id)}>
                          Visualizza
                        </button>
                      )}
                      <button
                        className="btn btn-danger"
                        onClick={() => {
                          if (confirm(`Eliminare lo snapshot del ${formatIsoDate(s.snapshot_date)}? L'operazione non è reversibile.`))
                            remove.mutate(s.id)
                        }}
                      >
                        ✕
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        snapshots && <p className="muted">Nessuno snapshot ancora: i grafici mostrano i dati live.</p>
      )}
    </div>
  )
}

// Riga con il pulsante "Aggiorna tutti i grafici": rifà tutte le query dei
// grafici (Metriche, Cycle Time/Throughput, che condividono la stessa
// query, e Bug aperti), per QUALUNQUE team selezionato nelle singole card - la chiave
// parziale ['dashboard','overview']/['dashboard','cycle-time'] matcha sia
// [...,'sw'] sia [...,'embedded'] - senza toccare quella del Gantt increment
// (dati locali, non da Jira). Chiavi esplicite invece di un prefisso
// generico ['dashboard'] per non intercettare per sbaglio la query
// ['dashboard', projectId] della Dashboard di progetto.
function RefreshAllRow() {
  const queryClient = useQueryClient()
  const fetchingOverview = useIsFetching({ queryKey: ['dashboard', 'overview'] })
  const fetchingBugsOpened = useIsFetching({ queryKey: ['dashboard', 'bugs-opened'] })
  const fetchingDoneByIncrement = useIsFetching({ queryKey: ['dashboard', 'done-by-increment'] })
  const fetchingWip = useIsFetching({ queryKey: ['dashboard', 'wip'] })

  return (
    <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
      <RefreshButton
        onClick={() => {
          queryClient.refetchQueries({ queryKey: ['dashboard', 'overview'] })
          queryClient.refetchQueries({ queryKey: ['dashboard', 'bugs-opened'] })
          queryClient.refetchQueries({ queryKey: ['dashboard', 'done-by-increment'] })
          queryClient.refetchQueries({ queryKey: ['dashboard', 'wip'] })
        }}
        isFetching={fetchingOverview + fetchingBugsOpened + fetchingDoneByIncrement + fetchingWip > 0}
        label="Aggiorna tutti i grafici"
      />
    </div>
  )
}

// Grafici Jira della Dashboard generale, live o letti dallo snapshot scelto.
// Con uno snapshot selezionato si aspetta di averlo caricato prima di
// mostrarli, altrimenti partirebbero per un attimo le query live verso Jira.
function JiraCharts({ snapshotId }: { snapshotId: number | null }) {
  const [window, setWindow] = useState<DashboardWindow>(() => ({ from: defaultWindowFrom(), to: isoDate(new Date()) }))
  const { data: snapshot, isError } = useQuery({
    queryKey: ['dashboard-snapshot', snapshotId],
    queryFn: () => api.dashboardSnapshots.get(snapshotId as number),
    enabled: snapshotId !== null,
  })

  if (snapshotId !== null && !snapshot) {
    return (
      <div className="card">
        <p className="muted">{isError ? 'Snapshot non trovato.' : 'Caricamento snapshot...'}</p>
      </div>
    )
  }

  return (
    <SnapshotContext.Provider value={snapshotId !== null ? (snapshot ?? null) : null}>
      {snapshotId === null && <RefreshAllRow />}
      <MetricsCard />
      <DashboardControls window={window} onChange={setWindow} />
      <DashboardWindowContext.Provider value={window}>
        <CycleTimeCard />
        <ThroughputCard />
        <FlowCard />
        <DoneByIncrementCard />
        <BugsOpenedCard />
      </DashboardWindowContext.Provider>
    </SnapshotContext.Provider>
  )
}

// Popup del Gantt: passando sopra la barra di un increment, codice e nome,
// date (inizio, code freeze, fine), PBI del backlog e Scope schematico.
// Posizione fissa vicino al puntatore, dentro la finestra.
type GanttHover = { project: Project; x: number; y: number }
const GANTT_POPUP_WIDTH = 420

function GanttBarPopup({ hover }: { hover: GanttHover }) {
  const { project, x, y } = hover
  const counts = project.backlog_counts
  const left = Math.max(8, Math.min(x + 16, window.innerWidth - GANTT_POPUP_WIDTH - 8))
  // Sotto il puntatore se c'e' spazio, se no sopra.
  const below = y < window.innerHeight * 0.55
  const date = (d: string | null) => formatIsoDate(d) ?? '—'
  return (
    <div
      className="gantt-popup"
      style={{
        left,
        width: GANTT_POPUP_WIDTH,
        ...(below ? { top: y + 16 } : { bottom: window.innerHeight - y + 16 }),
      }}
    >
      <div className="gantt-popup-title">
        {project.code} <span className="muted">· {project.name}</span>
      </div>
      <div className="gantt-popup-dates">
        <span>
          Inizio <b>{date(project.start_date)}</b>
        </span>
        <span>
          Code freeze <b>{date(project.code_freeze_date)}</b>
        </span>
        <span>
          Fine <b>{date(project.planned_finish_date)}</b>
        </span>
      </div>
      {counts && (
        <div className="gantt-popup-counts">
          <b>{counts.total}</b> PBI in scope nel backlog: {counts.done} Done, {counts.in_progress} in corso,{' '}
          {counts.to_do} da fare
        </div>
      )}
      <div className="gantt-popup-scope">
        {project.scope ? <RichText text={project.scope} /> : <span className="muted">Nessuno scope definito.</span>}
      </div>
    </div>
  )
}

// Presentazione mensile "Project Review TTP": aggiorna la presentazione
// scelta (date delle milestone, ore e materiali, % completamento backlog) e
// la salva accanto con data e ora; quella salvata diventa la prossima da
// aggiornare. Aggiunge le slide dei progetti attivi nuovi.
const fileName = (path: string) => path.split(/[\\/]/).pop() ?? path

function TtpReviewButton() {
  const { data: settings, refetch } = useQuery({ queryKey: ['ttp-review-settings'], queryFn: api.ttpReview.settings })
  const [message, setMessage] = useState<string | null>(null)
  // Finestra "Apri file" di Windows: path null = annullata.
  const browse = useMutation({ mutationFn: api.ttpReview.browse, onSuccess: () => refetch() })
  const exportDeck = useMutation({
    mutationFn: api.ttpReview.export,
    onSuccess: (result) => {
      refetch()
      saveBlob(result.blob, result.filename)
      const parts = [
        result.updated.length ? `aggiornate ${result.updated.join(', ')}` : null,
        result.added.length ? `aggiunte ${result.added.join(', ')}` : null,
        result.skipped.length ? `non attivi, lasciati com'erano: ${result.skipped.join(', ')}` : null,
      ].filter(Boolean)
      setMessage(
        `Partito da "${result.source}": ${parts.join('; ') || 'nessuna slide di progetto'}. ` +
          (result.saved ? `Salvata in ${result.saved}` : 'Non salvata nella cartella (solo scaricata).'),
      )
    },
    onError: () => setMessage(null),
  })
  const run = async () => {
    setMessage(null)
    if (!settings?.path) {
      const chosen = await browse.mutateAsync().catch(() => null)
      if (!chosen?.path) return
    }
    exportDeck.mutate()
  }
  const error = (browse.error ?? exportDeck.error) as Error | null
  return (
    <div className="ttp-review">
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', justifyContent: 'flex-end' }}>
        <button
          className="link-btn"
          disabled={browse.isPending}
          title="Scegli dal disco la presentazione da aggiornare (si apre la finestra di Windows, a volte dietro il browser)"
          onClick={() => {
            setMessage(null)
            browse.mutate()
          }}
        >
          {browse.isPending ? 'Scelta del file…' : settings?.path ? 'Cambia presentazione' : 'Scegli presentazione'}
        </button>
        <button className="btn btn-primary" disabled={exportDeck.isPending || browse.isPending} onClick={run}>
          {exportDeck.isPending ? 'Esportazione…' : '📊 Esporta PowerPoint'}
        </button>
      </div>
      {settings?.path && (
        <span className="muted" style={{ fontSize: 12, marginTop: 4 }} title={settings.path}>
          Da aggiornare: {fileName(settings.path)}
        </span>
      )}
      {error && <div className="error-banner">Esportazione non riuscita: {error.message}</div>}
      {message && (
        <p className="muted" style={{ margin: '6px 0 0', fontSize: 12 }}>
          {message}
        </p>
      )}
    </div>
  )
}

export function OverviewDashboardPage() {
  const { data: projects } = useQuery({ queryKey: ['projects'], queryFn: api.projects.list })
  const [searchParams, setSearchParams] = useSearchParams()
  const snapshotParam = Number(searchParams.get('snapshot'))
  const snapshotId = Number.isInteger(snapshotParam) && snapshotParam > 0 ? snapshotParam : null
  const selectSnapshot = (id: number | null) => setSearchParams(id === null ? {} : { snapshot: String(id) })

  const queryClient = useQueryClient()
  const [ganttSort, setGanttSortState] = useState<GanttSort>(loadGanttSort)
  const setGanttSort = (sort: GanttSort) => {
    setGanttSortState(sort)
    try {
      localStorage.setItem(GANTT_SORT_STORAGE_KEY, JSON.stringify(sort))
    } catch {
      // preferenza non salvata: resta valida solo per questa sessione
    }
  }
  // Aggiornamento ottimistico: la riga si sposta subito, senza aspettare il
  // backend; in caso di errore si ricarica la lista vera.
  const saveGanttOrder = useMutation({
    mutationFn: api.projects.setGanttOrder,
    onMutate: (ids: number[]) => {
      queryClient.setQueryData<Project[]>(['projects'], (old) =>
        old?.map((p) => ({ ...p, gantt_order: ids.includes(p.id) ? ids.indexOf(p.id) : p.gantt_order })),
      )
    },
    onError: () => queryClient.invalidateQueries({ queryKey: ['projects'] }),
  })

  // Fasi di ogni increment: stessa query (e cache) della card Fasi increment.
  const phaseQueries = useQueries({
    queries: (projects ?? []).map((p) => ({
      queryKey: ['phases', p.id],
      queryFn: () => api.phases.list(p.id),
    })),
  })

  // Larghezza in pixel dell'area delle barre, misurata sull'header dei mesi:
  // serve a disporre le etichette delle fasi senza accavallarle.
  const [trackWidth, setTrackWidth] = useState(0)
  const [ganttHover, setGanttHover] = useState<GanttHover | null>(null)
  const trackObserver = useRef<ResizeObserver | null>(null)
  const trackRef = useCallback((el: HTMLDivElement | null) => {
    trackObserver.current?.disconnect()
    trackObserver.current = null
    if (el) {
      trackObserver.current = new ResizeObserver(([entry]) => setTrackWidth(entry.contentRect.width))
      trackObserver.current.observe(el)
    }
  }, [])

  const jiraSection = (
    <>
      <SnapshotPanel selectedId={snapshotId} onSelect={selectSnapshot} />
      <JiraCharts snapshotId={snapshotId} />
    </>
  )

  if (!projects) return <p className="muted">Caricamento...</p>

  const rows: Row[] = projects.map((project, index) => {
    const phases = phaseQueries[index]?.data ?? []
    return {
      project,
      startEpoch: dateStrToEpochDays(project.start_date),
      endEpoch: dateStrToEpochDays(project.planned_finish_date),
      releaseEpoch: dateStrToEpochDays(project.release_date),
      plannedPhases: phaseMarks(phases, 'planned_date'),
      actualPhases: phaseMarks(phases, 'actual_date'),
    }
  })

  // Anche le date delle fasi e del rilascio allargano l'asse: possono cadere
  // prima dell'inizio o dopo il Planned finish dell'increment.
  const allEpochs = rows
    .flatMap((r) => [r.startEpoch, r.endEpoch, r.releaseEpoch, ...[...r.plannedPhases, ...r.actualPhases].map((m) => m.epoch)])
    .filter((e): e is number => e !== null)

  if (allEpochs.length === 0) {
    return (
      <div>
        <div className="card">
          <h3 style={{ marginTop: 0 }}>Dashboard generale</h3>
          <p className="muted">
            Nessuna data di inizio/fine o di fase impostata su nessun increment: non c'e' ancora niente da mostrare
            nel Gantt.
          </p>
        </div>

        {jiraSection}
      </div>
    )
  }

  const domainMin = Math.min(...allEpochs) - 4
  const domainMax = Math.max(...allEpochs) + 4
  const span = Math.max(1, domainMax - domainMin)
  const pct = (epoch: number) => ((epoch - domainMin) / span) * 100
  // Posizione in pixel nell'area delle barre; le etichette delle fasi possono
  // sporgere a destra nel margine lasciato dopo l'ultima data.
  const layoutWidth = trackWidth || FALLBACK_TRACK_WIDTH
  const xOf = (epoch: number) => (pct(epoch) / 100) * layoutWidth
  const maxLabelRight = layoutWidth + 40

  const monthTicks = buildMonthTicks(domainMin, domainMax)
  const todayEpoch = toEpochDays(new Date())

  const sortedRows = sortGanttRows(rows, ganttSort)
  const isManual = ganttSort.key === 'manual'
  // Sposta una riga di una posizione e salva l'ordine completo: la prima
  // volta fissa anche la posizione di tutte le altre righe, cosi' da li' in
  // poi l'ordine manuale non dipende piu' dalle date.
  const moveRow = (index: number, delta: -1 | 1) => {
    const ids = sortedRows.map((r) => r.project.id)
    const target = index + delta
    if (target < 0 || target >= ids.length) return
    ;[ids[index], ids[target]] = [ids[target], ids[index]]
    saveGanttOrder.mutate(ids)
  }

  return (
    <div>
      {ganttHover && createPortal(<GanttBarPopup hover={ganttHover} />, document.body)}
      <div className="card">
        <div className="page-header" style={{ marginBottom: 4, alignItems: 'flex-start' }}>
          <h3 style={{ margin: 0 }}>Dashboard generale</h3>
          <TtpReviewButton />
        </div>
        <p className="muted" style={{ marginTop: 0, marginBottom: 12 }}>
          Panoramica di tutti gli increment: una barra per increment, da Inizio a Planned finish. Quelli "in corso"
          sono evidenziati. Sotto ogni barra le fasi dell'increment, col nome: su una corsia le date pianificate,
          sull'altra quelle effettive. La linea verde indica la data di rilascio degli increment rilasciati, quella
          rossa tratteggiata la data odierna.
        </p>
        <div style={{ display: 'flex', gap: 16, alignItems: 'center', flexWrap: 'wrap', fontSize: 12 }}>
          <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <span style={{ width: 14, height: 14, borderRadius: 3, background: COLOR_INACTIVE, display: 'inline-block' }} />
            Increment
          </span>
          <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <span
              style={{
                width: 14,
                height: 14,
                borderRadius: 3,
                background: 'var(--primary)',
                border: '2px solid var(--warning)',
                display: 'inline-block',
              }}
            />
            In corso
          </span>
          <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <PhaseDiamond color={COLOR_PHASE_PLANNED} filled={false} />
            Fase: data pianificata
          </span>
          <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <PhaseDiamond color={COLOR_PHASE_ACTUAL} filled />
            Fase: data effettiva
          </span>
          <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <span style={{ width: 3, height: 14, background: COLOR_RELEASE, display: 'inline-block' }} />
            Rilascio
          </span>
        </div>
      </div>

      <div className="card">
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: 12, fontSize: 13 }}>
          <label htmlFor="gantt-sort" className="muted">
            Ordina per
          </label>
          <select
            id="gantt-sort"
            value={ganttSort.key}
            onChange={(e) => setGanttSort({ ...ganttSort, key: e.target.value as GanttSortKey })}
            style={{ width: 'auto' }}
          >
            {GANTT_SORT_OPTIONS.map((o) => (
              <option key={o.key} value={o.key}>
                {o.label}
              </option>
            ))}
          </select>
          {isManual ? (
            <span className="muted" style={{ fontSize: 12 }}>
              Sposta le righe con le frecce ▲▼ accanto al codice: l'ordine viene salvato.
            </span>
          ) : (
            <button
              className="btn"
              onClick={() => setGanttSort({ ...ganttSort, dir: ganttSort.dir === 'asc' ? 'desc' : 'asc' })}
              title="Inverti l'ordine"
              style={{ fontSize: 12, padding: '4px 10px' }}
            >
              {ganttSort.dir === 'asc' ? '↑ Crescente' : '↓ Decrescente'}
            </button>
          )}
        </div>
        <div style={{ overflowX: 'auto' }}>
          <div style={{ minWidth: 720, paddingRight: 48 }}>
            {/* Header: tick dei mesi, allineato con le barre sotto */}
            <div style={{ display: 'grid', gridTemplateColumns: `${ROW_LABEL_WIDTH}px 1fr`, gap: 12 }}>
              <div />
              <div ref={trackRef} style={{ position: 'relative', height: 22 }}>
                {monthTicks.map((t) => (
                  <span
                    key={t.epoch}
                    className="muted"
                    style={{
                      position: 'absolute',
                      left: `${pct(t.epoch)}%`,
                      fontSize: 11,
                      whiteSpace: 'nowrap',
                      transform: 'translateX(-2px)',
                      borderLeft: '1px solid var(--border)',
                      paddingLeft: 4,
                    }}
                  >
                    {t.label}
                  </span>
                ))}
              </div>
            </div>

            {sortedRows.map(({ project, startEpoch, endEpoch, releaseEpoch, plannedPhases, actualPhases }, index) => {
              // Corsie delle fasi sotto la barra: prima le pianificate, poi
              // le effettive; a sinistra l'intestazione di ciascuna.
              const phaseLanes = [
                { caption: 'Fasi pianificate', color: COLOR_PHASE_PLANNED, filled: false, marks: plannedPhases },
                { caption: 'Fasi effettive', color: COLOR_PHASE_ACTUAL, filled: true, marks: actualPhases },
              ]
                .filter((lane) => lane.marks.length > 0)
                .map((lane) => ({ ...lane, layout: layoutPhaseMarks(lane.marks, xOf, maxLabelRight) }))
              return (
              <div
                key={project.id}
                style={{
                  display: 'grid',
                  gridTemplateColumns: `${ROW_LABEL_WIDTH}px 1fr`,
                  gap: 12,
                  alignItems: 'start',
                  padding: phaseLanes.length > 0 ? '20px 0 12px' : '20px 0 24px',
                  borderTop: '1px solid var(--border)',
                }}
              >
                <div style={{ minWidth: 0 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0, minHeight: BAR_HEIGHT }}>
                  {isManual && (
                    <div style={{ display: 'flex', flexDirection: 'column' }}>
                      <button
                        className="gantt-move"
                        onClick={() => moveRow(index, -1)}
                        disabled={index === 0}
                        title="Sposta su"
                        aria-label={`Sposta ${project.code} su`}
                      >
                        ▲
                      </button>
                      <button
                        className="gantt-move"
                        onClick={() => moveRow(index, 1)}
                        disabled={index === sortedRows.length - 1}
                        title="Sposta giù"
                        aria-label={`Sposta ${project.code} giù`}
                      >
                        ▼
                      </button>
                    </div>
                  )}
                  <Link to={`/projects/${project.id}`} style={{ textDecoration: 'none', color: 'inherit', minWidth: 0 }}>
                    <div style={{ fontWeight: 600, fontSize: 13, display: 'flex', alignItems: 'center', gap: 6 }}>
                      {project.code}
                      {project.is_current && (
                        <span title="In corso" style={{ color: 'var(--warning)' }}>
                          ●
                        </span>
                      )}
                      {project.release_date && (
                        <span title={`Rilasciato il ${formatIsoDate(project.release_date)}`} style={{ color: COLOR_RELEASE }}>
                          ✓
                        </span>
                      )}
                    </div>
                  </Link>
                </div>
                {phaseLanes.length > 0 && (
                  <div style={{ marginTop: PHASE_LANES_MARGIN_TOP }}>
                    {phaseLanes.map((lane) => (
                      <div
                        key={lane.caption}
                        className="muted"
                        style={{
                          height: lane.layout.levels * PHASE_LANE_HEIGHT,
                          lineHeight: `${PHASE_LANE_HEIGHT}px`,
                          fontSize: 11,
                          textAlign: 'right',
                          whiteSpace: 'nowrap',
                        }}
                      >
                        {lane.caption}
                      </div>
                    ))}
                  </div>
                )}
                </div>

                <div style={{ minWidth: 0 }}>
                <div style={{ position: 'relative', height: BAR_HEIGHT }}>
                  {/* Griglia mensile di sfondo, per confrontare le righe */}
                  {monthTicks.map((t) => (
                    <div
                      key={t.epoch}
                      style={{ position: 'absolute', left: `${pct(t.epoch)}%`, top: 0, bottom: 0, width: 1, background: 'var(--border)' }}
                    />
                  ))}

                  {/* Marcatore data odierna */}
                  {todayEpoch >= domainMin && todayEpoch <= domainMax && (
                    <div
                      title={`Oggi: ${formatEpochDaysAsDate(todayEpoch)}`}
                      style={{
                        position: 'absolute',
                        left: `${pct(todayEpoch)}%`,
                        top: -4,
                        bottom: -4,
                        width: 0,
                        borderLeft: '2px dashed var(--danger)',
                      }}
                    />
                  )}

                  {startEpoch === null && endEpoch === null && (
                    <span className="muted" style={{ fontSize: 12 }}>
                      Nessuna data disponibile
                    </span>
                  )}

                  {/* Solo una delle due date impostata: nessuna barra da
                      disegnare, ma un pallino indica dove si trova. */}
                  {(startEpoch === null) !== (endEpoch === null) && (
                    <div
                      title={`${startEpoch !== null ? 'Inizio' : 'Planned finish'}: ${formatEpochDaysAsDate((startEpoch ?? endEpoch)!)}`}
                      style={{
                        position: 'absolute',
                        left: `${pct((startEpoch ?? endEpoch)!)}%`,
                        top: '50%',
                        width: 10,
                        height: 10,
                        borderRadius: '50%',
                        background: project.is_current ? 'var(--primary)' : COLOR_INACTIVE,
                        transform: 'translate(-50%, -50%)',
                      }}
                    />
                  )}

                  {startEpoch !== null && endEpoch !== null && (
                    <div
                      onMouseEnter={(e) => setGanttHover({ project, x: e.clientX, y: e.clientY })}
                      onMouseMove={(e) => setGanttHover({ project, x: e.clientX, y: e.clientY })}
                      onMouseLeave={() => setGanttHover(null)}
                      style={{
                        cursor: 'default',
                        position: 'absolute',
                        left: `${pct(startEpoch)}%`,
                        width: `${Math.max(pct(endEpoch) - pct(startEpoch), 1.2)}%`,
                        top: 3,
                        bottom: 3,
                        background: project.is_current ? 'var(--primary)' : COLOR_INACTIVE,
                        border: project.is_current ? '2px solid var(--warning)' : 'none',
                        boxShadow: project.is_current ? '0 1px 4px rgba(0,0,0,0.25)' : 'none',
                        borderRadius: 6,
                        display: 'flex',
                        alignItems: 'center',
                        overflow: 'hidden',
                        padding: '0 8px',
                      }}
                    >
                      <span
                        style={{
                          color: project.is_current ? 'white' : 'var(--primary-dark)',
                          fontSize: 11,
                          fontWeight: 600,
                          whiteSpace: 'nowrap',
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                        }}
                      >
                        {project.name}
                      </span>
                    </div>
                  )}

                  {/* Data di rilascio: linea verde sopra la barra, con la
                      data sopra (sotto ci sono inizio e fine). */}
                  {releaseEpoch !== null && (
                    <>
                      <div
                        title={`Rilasciato il ${formatEpochDaysAsDate(releaseEpoch)}`}
                        style={{
                          position: 'absolute',
                          left: `${pct(releaseEpoch)}%`,
                          top: -6,
                          bottom: -6,
                          width: 3,
                          borderRadius: 2,
                          background: COLOR_RELEASE,
                          transform: 'translateX(-50%)',
                          zIndex: 1,
                        }}
                      />
                      <span
                        style={{
                          position: 'absolute',
                          left: `${pct(releaseEpoch)}%`,
                          top: -20,
                          fontSize: 11,
                          fontWeight: 600,
                          whiteSpace: 'nowrap',
                          color: COLOR_RELEASE,
                          transform: 'translateX(-50%)',
                        }}
                      >
                        ✓ Rilascio {formatEpochDaysAsDate(releaseEpoch)}
                      </span>
                    </>
                  )}

                  {/* Date di inizio/fine ben visibili sotto la barra: dentro
                      gli estremi; con una barra troppo corta per entrambe,
                      l'inizio va a sinistra e la fine a destra degli
                      estremi, cosi' non si sovrappongono. */}
                  {(() => {
                    const dateLabelWidth = 10 * PHASE_LABEL_CHAR_WIDTH
                    const px = (epoch: number) => (pct(epoch) / 100) * layoutWidth
                    const tight =
                      startEpoch !== null && endEpoch !== null && px(endEpoch) - px(startEpoch) < 2 * dateLabelWidth + 8
                    // Spazio per spostare l'inizio a sinistra (al bordo sinistro no).
                    const startOutside = tight && px(startEpoch!) >= dateLabelWidth + 4
                    const endOutside = tight && px(endEpoch!) + dateLabelWidth + 4 <= layoutWidth
                    const base = { position: 'absolute', bottom: -18, fontSize: 11, fontWeight: 600, whiteSpace: 'nowrap' } as const
                    return (
                      <>
                        {startEpoch !== null && (
                          <span
                            className="muted"
                            style={{
                              ...base,
                              left: `${pct(startEpoch)}%`,
                              transform: startOutside ? 'translateX(calc(-100% - 4px))' : undefined,
                            }}
                          >
                            {formatEpochDaysAsDate(startEpoch)}
                          </span>
                        )}
                        {endEpoch !== null && (
                          <span
                            className="muted"
                            style={{
                              ...base,
                              left: `${pct(endEpoch)}%`,
                              transform: endOutside || (tight && !startOutside) ? 'translateX(4px)' : 'translateX(-100%)',
                            }}
                          >
                            {formatEpochDaysAsDate(endEpoch)}
                          </span>
                        )}
                      </>
                    )
                  })()}
                </div>
                {phaseLanes.length > 0 && (
                  <div style={{ marginTop: PHASE_LANES_MARGIN_TOP }}>
                    {phaseLanes.map((lane) => (
                      <PhaseLane key={lane.caption} layout={lane.layout} color={lane.color} filled={lane.filled} pct={pct} />
                    ))}
                  </div>
                )}
                </div>
              </div>
              )
            })}

            {sortedRows.length === 0 && <p className="muted">Nessun increment creato ancora.</p>}
          </div>
        </div>
      </div>

      {jiraSection}
    </div>
  )
}
