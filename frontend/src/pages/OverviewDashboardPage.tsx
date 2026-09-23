import { useState } from 'react'
import { useIsFetching, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link } from 'react-router-dom'
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
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
import { api } from '../api/client'
import type { BugsOpenedMonth, BugStatusCount, CycleTimePoint, OverviewMetrics, OverviewPeriod, Project, Team } from '../api/types'
import { dateStrToEpochDays, epochDaysToDate, formatEpochDaysAsDate, formatIsoDate, toEpochDays } from '../lib/dates'

const ROW_LABEL_WIDTH = 160
const BAR_HEIGHT = 30
// Increment non "in corso": tinta chiara dello stesso blu --primary, cosi'
// quelli "in corso" (blu pieno + bordo) risaltano per contrasto.
const COLOR_INACTIVE = '#c7d9fb'

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

type Row = { project: Project; startEpoch: number | null; endEpoch: number | null }

// Pulsante di refresh usato sia nell'header di ogni singolo grafico sia,
// aggregato su piu' query, in quello "Aggiorna tutti i grafici".
function RefreshButton({ onClick, isFetching, label = 'Aggiorna' }: { onClick: () => void; isFetching: boolean; label?: string }) {
  return (
    <button className="btn" onClick={onClick} disabled={isFetching} style={{ fontSize: 12, padding: '4px 10px' }}>
      {isFetching ? 'Aggiornamento...' : `⟳ ${label}`}
    </button>
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
// OVERVIEW_PERIOD_JQL nel backend): scorrono col passare del tempo.
function periodRangeLabel(period: OverviewPeriod): string {
  const DAY_MS = 24 * 60 * 60 * 1000
  const offsetDays = period === 'current' ? 0 : 365
  const end = new Date(Date.now() - offsetDays * DAY_MS)
  const start = new Date(end.getTime() - 365 * DAY_MS)
  const fmt = (d: Date) => d.toLocaleDateString('it-IT', { day: '2-digit', month: '2-digit', year: 'numeric' })
  return `${fmt(start)} – ${fmt(end)}`
}

// Grafico Metriche: PBI messi a Done sulla JQL base del team, due ciambelle
// affiancate - a sinistra gli ultimi 365 giorni, a destra i 365 precedenti.
// Componente a se' (invece che inline in OverviewDashboardPage) cosi' da
// poter comparire sia nel ramo "nessuna data" sia in quello normale senza
// duplicare le query. Il team e' condiviso tra le due ciambelle, altrimenti
// il confronto anno su anno non avrebbe senso.
function MetricsCard() {
  const [team, setTeam] = useState<Team>('sw')
  const current = useQuery({
    queryKey: ['dashboard', 'overview', team, 'current'],
    queryFn: () => api.dashboard.overview(team, 'current'),
  })
  const previous = useQuery({
    queryKey: ['dashboard', 'overview', team, 'previous'],
    queryFn: () => api.dashboard.overview(team, 'previous'),
  })

  return (
    <div className="card">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 8 }}>
        <h3 style={{ marginTop: 0, marginBottom: 0 }}>Metriche</h3>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <TeamSelector team={team} onChange={setTeam} />
          {(current.data || previous.data) && (
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
        PBI messi a Done (JQL base del {team === 'sw' ? 'Team SW' : 'Team Embedded'}): ultimo anno a confronto con
        l'anno precedente.
      </p>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))', gap: 24 }}>
        <DoneDonut data={current.data} title="Ultimi 12 mesi" rangeLabel={periodRangeLabel('current')} />
        <DoneDonut data={previous.data} title="12 mesi precedenti" rangeLabel={periodRangeLabel('previous')} />
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
                <Tooltip formatter={(value: number, name: string) => [value, name]} />
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
  const { data, refetch, isFetching } = useQuery({
    queryKey: ['dashboard', 'cycle-time', team],
    queryFn: () => api.dashboard.cycleTime(team),
  })

  const header = (
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 8 }}>
      <h3 style={{ marginTop: 0, marginBottom: 0 }}>Cycle Time</h3>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        <TeamSelector team={team} onChange={setTeam} />
        {data && <RefreshButton onClick={() => refetch()} isFetching={isFetching} />}
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

  const pointsBySeries: Record<string, ScatterPoint[]> = {}
  const xs: number[] = []
  for (const p of data.points) {
    const x = dateStrToEpochDays(p.finish_date)
    if (x === null) continue
    xs.push(x)
    ;(pointsBySeries[seriesKeyFor(p)] ??= []).push({ ...p, x, y: p.cycle_time_days })
  }

  return (
    <div className="card">
      {header}
      <p className="muted" style={{ marginTop: 8, marginBottom: 12 }}>
        Un punto per PBI: giorni trascorsi da inizio lavorazione a Done, per data di completamento (ultimi 12 mesi).
        Le linee tratteggiate sono il 50°, 85° e 95° percentile.
      </p>

      {data.error ? (
        <p className="muted">{data.error}</p>
      ) : data.points.length === 0 ? (
        <p className="muted">Nessun PBI completato negli ultimi 12 mesi con i dati necessari.</p>
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
                {data.p50 != null && (
                  <ReferenceLine
                    y={data.p50}
                    stroke="var(--text-muted)"
                    strokeDasharray="4 4"
                    label={{ value: `P50: ${data.p50.toFixed(1)}g`, position: 'right', fontSize: 11, fill: 'var(--text-muted)' }}
                  />
                )}
                {data.p85 != null && (
                  <ReferenceLine
                    y={data.p85}
                    stroke="var(--warning)"
                    strokeDasharray="4 4"
                    label={{ value: `P85: ${data.p85.toFixed(1)}g`, position: 'right', fontSize: 11, fill: 'var(--warning)' }}
                  />
                )}
                {data.p95 != null && (
                  <ReferenceLine
                    y={data.p95}
                    stroke="var(--danger)"
                    strokeDasharray="4 4"
                    label={{ value: `P95: ${data.p95.toFixed(1)}g`, position: 'right', fontSize: 11, fill: 'var(--danger)' }}
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

// Bucket mensili per il grafico Throughput, dal mese del primo al mese
// dell'ultimo PBI completato presente nei punti del Cycle Time - cosi' il
// totale delle barre torna sempre uguale al numero di punti dello scatter
// (invece di un fisso "ultimi 12 mesi solari" che potrebbe tagliare fuori il
// mese piu' vecchio, dato che la finestra Jira e' "AFTER -365d" a giorni,
// non a mesi solari).
function buildMonthBuckets(points: { finish_date: string }[]): { key: string; label: string }[] {
  if (points.length === 0) return []
  const monthKeys = points.map((p) => p.finish_date.slice(0, 7)).sort()
  const [minYear, minMonth] = monthKeys[0].split('-').map(Number)
  const [maxYear, maxMonth] = monthKeys[monthKeys.length - 1].split('-').map(Number)
  const cursor = new Date(Date.UTC(minYear, minMonth - 1, 1))
  const end = new Date(Date.UTC(maxYear, maxMonth - 1, 1))
  const buckets: { key: string; label: string }[] = []
  while (cursor <= end) {
    const key = `${cursor.getUTCFullYear()}-${String(cursor.getUTCMonth() + 1).padStart(2, '0')}`
    const label = cursor.toLocaleDateString('it-IT', { month: 'short', year: '2-digit', timeZone: 'UTC' })
    buckets.push({ key, label })
    cursor.setUTCMonth(cursor.getUTCMonth() + 1)
  }
  return buckets
}

// Throughput: PBI completati per mese, sugli stessi PBI del Cycle Time -
// stessa query ['dashboard','cycle-time'] (React Query la condivide tra i
// due componenti, un'unica chiamata a Jira per entrambi i grafici), solo
// aggregata qui per mese invece che mostrata punto per punto.
function ThroughputCard() {
  const [team, setTeam] = useState<Team>('sw')
  const { data, refetch, isFetching } = useQuery({
    queryKey: ['dashboard', 'cycle-time', team],
    queryFn: () => api.dashboard.cycleTime(team),
  })

  const header = (
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 8 }}>
      <h3 style={{ marginTop: 0, marginBottom: 0 }}>Throughput</h3>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        <TeamSelector team={team} onChange={setTeam} />
        {data && <RefreshButton onClick={() => refetch()} isFetching={isFetching} />}
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

  const buckets = buildMonthBuckets(data.points)
  const countsByMonth: Record<string, Record<string, number>> = {}
  for (const b of buckets) countsByMonth[b.key] = Object.fromEntries(SERIES.map((s) => [s.key, 0]))
  for (const p of data.points) {
    const key = p.finish_date.slice(0, 7)
    const seriesKey = seriesKeyFor(p)
    countsByMonth[key][seriesKey] = (countsByMonth[key][seriesKey] ?? 0) + 1
  }
  const chartData = buckets.map((b) => ({ label: b.label, ...countsByMonth[b.key] }))

  return (
    <div className="card">
      {header}
      <p className="muted" style={{ marginTop: 8, marginBottom: 12 }}>
        PBI completati per mese (stessi PBI del grafico Cycle Time), ultimi 12 mesi.
      </p>

      {data.error ? (
        <p className="muted">{data.error}</p>
      ) : data.points.length === 0 ? (
        <p className="muted">Nessun PBI completato negli ultimi 12 mesi.</p>
      ) : (
        <div style={{ height: 280 }}>
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={chartData} margin={{ top: 8, right: 16, left: 8, bottom: 8 }}>
              <CartesianGrid strokeDasharray="3 3" />
              <XAxis dataKey="label" tick={{ fontSize: 12 }} />
              <YAxis
                allowDecimals={false}
                tick={{ fontSize: 12 }}
                label={{ value: 'PBI', angle: -90, position: 'insideLeft', style: { fontSize: 12, fill: 'var(--text-muted)' } }}
              />
              <Tooltip />
              <Legend wrapperStyle={{ fontSize: 12 }} />
              {SERIES.map((s) => (
                <Bar key={s.key} dataKey={s.key} name={s.key} stackId="throughput" fill={s.color} fillOpacity={s.opacity} />
              ))}
            </BarChart>
          </ResponsiveContainer>
        </div>
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
  const [team, setTeam] = useState<Team>('sw')
  const [showCve, setShowCve] = useState(false)
  const { data, refetch, isFetching } = useQuery({
    queryKey: ['dashboard', 'bugs-opened', team],
    queryFn: () => api.dashboard.bugsOpened(team),
  })

  const header = (
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 8 }}>
      <h3 style={{ marginTop: 0, marginBottom: 0 }}>Bug aperti</h3>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        <label style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 12, cursor: 'pointer' }}>
          <input type="checkbox" checked={showCve} onChange={(e) => setShowCve(e.target.checked)} />
          Mostra CVE
        </label>
        <TeamSelector team={team} onChange={setTeam} />
        {data && <RefreshButton onClick={() => refetch()} isFetching={isFetching} />}
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

  const chartData = data.months.map((m) => {
    const [year, month] = m.month.split('-').map(Number)
    const label = new Date(Date.UTC(year, month - 1, 1)).toLocaleDateString('it-IT', {
      month: 'short',
      year: '2-digit',
      timeZone: 'UTC',
    })
    return { ...m, label, total: m.complaint + m.non_complaint }
  })
  const totals = Object.fromEntries(
    BUGS_OPENED_SERIES.map((s) => [s.key, data.months.reduce((sum, m) => sum + m[s.key], 0)]),
  ) as Record<(typeof BUGS_OPENED_SERIES)[number]['key'], number>
  const visibleSeries = BUGS_OPENED_SERIES.filter((s) => s.key !== 'cve' || showCve)

  return (
    <div className="card">
      {header}
      <p className="muted" style={{ marginTop: 8, marginBottom: 12 }}>
        Bug creati per mese negli ultimi 12 mesi (JQL base del {team === 'sw' ? 'Team SW' : 'Team Embedded'}): totale{' '}
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
        Bug degli ultimi 12 mesi, CVE esclusi
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
  const fetchingCycleTime = useIsFetching({ queryKey: ['dashboard', 'cycle-time'] })
  const fetchingBugsOpened = useIsFetching({ queryKey: ['dashboard', 'bugs-opened'] })

  return (
    <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
      <RefreshButton
        onClick={() => {
          queryClient.refetchQueries({ queryKey: ['dashboard', 'overview'] })
          queryClient.refetchQueries({ queryKey: ['dashboard', 'cycle-time'] })
          queryClient.refetchQueries({ queryKey: ['dashboard', 'bugs-opened'] })
        }}
        isFetching={fetchingOverview + fetchingCycleTime + fetchingBugsOpened > 0}
        label="Aggiorna tutti i grafici"
      />
    </div>
  )
}

export function OverviewDashboardPage() {
  const { data: projects } = useQuery({ queryKey: ['projects'], queryFn: api.projects.list })

  if (!projects) return <p className="muted">Caricamento...</p>

  const rows: Row[] = projects.map((project) => ({
    project,
    startEpoch: dateStrToEpochDays(project.start_date),
    endEpoch: dateStrToEpochDays(project.planned_finish_date),
  }))

  const allEpochs = rows.flatMap((r) => [r.startEpoch, r.endEpoch]).filter((e): e is number => e !== null)

  if (allEpochs.length === 0) {
    return (
      <div>
        <div className="card">
          <h3 style={{ marginTop: 0 }}>Dashboard generale</h3>
          <p className="muted">
            Nessuna data di inizio/fine impostata su nessun increment: non c'e' ancora niente da mostrare nel Gantt.
          </p>
        </div>

        <RefreshAllRow />
        <MetricsCard />
        <CycleTimeCard />
        <ThroughputCard />
        <BugsOpenedCard />
      </div>
    )
  }

  const domainMin = Math.min(...allEpochs) - 4
  const domainMax = Math.max(...allEpochs) + 4
  const span = Math.max(1, domainMax - domainMin)
  const pct = (epoch: number) => ((epoch - domainMin) / span) * 100

  const monthTicks = buildMonthTicks(domainMin, domainMax)
  const todayEpoch = toEpochDays(new Date())

  const sortedRows = [...rows].sort((a, b) => (a.startEpoch ?? Infinity) - (b.startEpoch ?? Infinity))

  return (
    <div>
      <div className="card">
        <h3 style={{ marginTop: 0 }}>Dashboard generale</h3>
        <p className="muted" style={{ marginTop: 0, marginBottom: 12 }}>
          Panoramica di tutti gli increment: una barra per increment, da Inizio a Planned finish. Quelli "in corso"
          sono evidenziati. La linea rossa tratteggiata indica la data odierna.
        </p>
        <div style={{ display: 'flex', gap: 16, alignItems: 'center', fontSize: 12 }}>
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
        </div>
      </div>

      <div className="card">
        <div style={{ overflowX: 'auto' }}>
          <div style={{ minWidth: 720, paddingRight: 48 }}>
            {/* Header: tick dei mesi, allineato con le barre sotto */}
            <div style={{ display: 'grid', gridTemplateColumns: `${ROW_LABEL_WIDTH}px 1fr`, gap: 12 }}>
              <div />
              <div style={{ position: 'relative', height: 22 }}>
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

            {sortedRows.map(({ project, startEpoch, endEpoch }) => (
              <div
                key={project.id}
                style={{
                  display: 'grid',
                  gridTemplateColumns: `${ROW_LABEL_WIDTH}px 1fr`,
                  gap: 12,
                  alignItems: 'center',
                  padding: '20px 0 24px',
                  borderTop: '1px solid var(--border)',
                }}
              >
                <Link to={`/projects/${project.id}`} style={{ textDecoration: 'none', color: 'inherit' }}>
                  <div style={{ fontWeight: 600, fontSize: 13, display: 'flex', alignItems: 'center', gap: 6 }}>
                    {project.code}
                    {project.is_current && (
                      <span title="In corso" style={{ color: 'var(--warning)' }}>
                        ●
                      </span>
                    )}
                  </div>
                </Link>

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
                      title={`${project.name}: dal ${formatEpochDaysAsDate(startEpoch)} al ${formatEpochDaysAsDate(endEpoch)}`}
                      style={{
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

                  {/* Date di inizio/fine ben visibili sotto la barra. */}
                  {startEpoch !== null && (
                    <span className="muted" style={{ position: 'absolute', left: `${pct(startEpoch)}%`, bottom: -18, fontSize: 11, fontWeight: 600, whiteSpace: 'nowrap' }}>
                      {formatEpochDaysAsDate(startEpoch)}
                    </span>
                  )}
                  {endEpoch !== null && (
                    <span
                      className="muted"
                      style={{
                        position: 'absolute',
                        left: `${pct(endEpoch)}%`,
                        bottom: -18,
                        fontSize: 11,
                        fontWeight: 600,
                        whiteSpace: 'nowrap',
                        transform: 'translateX(-100%)',
                      }}
                    >
                      {formatEpochDaysAsDate(endEpoch)}
                    </span>
                  )}
                </div>
              </div>
            ))}

            {sortedRows.length === 0 && <p className="muted">Nessun increment creato ancora.</p>}
          </div>
        </div>
      </div>

      <RefreshAllRow />
      <MetricsCard />
      <CycleTimeCard />
      <ThroughputCard />
      <BugsOpenedCard />
    </div>
  )
}
