import { useIsFetching, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link } from 'react-router-dom'
import {
  CartesianGrid,
  Cell,
  Legend,
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
import type { CycleTimePoint, Project } from '../api/types'
import { dateStrToEpochDays, epochDaysToDate, formatEpochDaysAsDate, formatIsoDate, toEpochDays } from '../lib/dates'

const ROW_LABEL_WIDTH = 160
const BAR_HEIGHT = 30
// Increment non "in corso": tinta chiara dello stesso blu --primary, cosi'
// quelli "in corso" (blu pieno + bordo) risaltano per contrasto.
const COLOR_INACTIVE = '#c7d9fb'

// Palette categoriale fissa (Story/Bug/Activity, in quest'ordine) per il
// grafico a ciambella "Metriche": stessi colori gia' usati nell'app per
// altri scopi (--primary/--danger/--progetto), validata per distinguibilita'
// in daltonismo con scripts/validate_palette.js della skill dataviz.
const PBI_TYPE_COLORS: Record<string, string> = {
  Story: '#2f6fed',
  Bug: '#d3402f',
  Activity: '#5b3fb0',
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

// Grafico a ciambella: PBI (Story/Bug/Activity, tutti gli increment) messi a
// Done negli ultimi 12 mesi, con il totale al centro e il dettaglio per tipo
// sotto. Componente a se' (invece che inline in OverviewDashboardPage) cosi'
// da poter comparire sia nel ramo "nessuna data" sia in quello normale senza
// duplicare la query.
function MetricsCard() {
  const { data, refetch, isFetching } = useQuery({ queryKey: ['dashboard', 'overview'], queryFn: api.dashboard.overview })

  if (!data) {
    return (
      <div className="card">
        <h3 style={{ marginTop: 0 }}>Metriche</h3>
        <p className="muted">Caricamento...</p>
      </div>
    )
  }

  const total = data.done_last_12_months_total
  const chartData = data.done_last_12_months.map((d) => ({ ...d, color: PBI_TYPE_COLORS[d.issue_type] ?? COLOR_INACTIVE }))

  return (
    <div className="card">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <h3 style={{ marginTop: 0, marginBottom: 0 }}>Metriche</h3>
        <RefreshButton onClick={() => refetch()} isFetching={isFetching} />
      </div>
      <p className="muted" style={{ marginTop: 8, marginBottom: 12 }}>
        PBI (Story/Bug/Activity, intero progetto Jira) messi a Done negli ultimi 12 mesi.
      </p>

      {data.error ? (
        <p className="muted">{data.error}</p>
      ) : total === 0 ? (
        <p className="muted">Nessun PBI messo a Done negli ultimi 12 mesi.</p>
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
                  paddingAngle={chartData.filter((d) => d.count > 0).length > 1 ? 2 : 0}
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

          {/* Dettaglio con i singoli totali per tipo, sotto la torta. Sul Bug
              e' evidenziato quanti sono Complaint (Source Type = Complaint). */}
          <div style={{ display: 'flex', gap: 24, flexWrap: 'wrap', justifyContent: 'center' }}>
            {chartData.map((d) => (
              <span key={d.issue_type} style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13 }}>
                <span style={{ width: 10, height: 10, borderRadius: '50%', background: d.color, display: 'inline-block' }} />
                {d.issue_type}: <strong>{d.count}</strong>
                {d.issue_type === 'Bug' && (
                  <span className="muted" style={{ fontSize: 12 }}>
                    (di cui <strong>{data.bug_complaint_count}</strong> complaint)
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
        {p.key} ({p.issue_type})
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
  const { data, refetch, isFetching } = useQuery({ queryKey: ['dashboard', 'cycle-time'], queryFn: api.dashboard.cycleTime })

  if (!data) {
    return (
      <div className="card">
        <h3 style={{ marginTop: 0 }}>Cycle Time</h3>
        <p className="muted">Caricamento...</p>
      </div>
    )
  }

  const pointsByType: Record<string, ScatterPoint[]> = {}
  const xs: number[] = []
  for (const p of data.points) {
    const x = dateStrToEpochDays(p.finish_date)
    if (x === null) continue
    xs.push(x)
    ;(pointsByType[p.issue_type] ??= []).push({ ...p, x, y: p.cycle_time_days })
  }

  return (
    <div className="card">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <h3 style={{ marginTop: 0, marginBottom: 0 }}>Cycle Time</h3>
        <RefreshButton onClick={() => refetch()} isFetching={isFetching} />
      </div>
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
                {Object.entries(pointsByType).map(([type, points]) => (
                  <Scatter key={type} name={type} data={points} fill={PBI_TYPE_COLORS[type] ?? COLOR_INACTIVE} />
                ))}
              </ScatterChart>
            </ResponsiveContainer>
          </div>
        </>
      )}
    </div>
  )
}

// Riga con il pulsante "Aggiorna tutti i grafici": rifà entrambe le query
// dei grafici (Metriche e Cycle Time) in un colpo solo, senza toccare quella
// del Gantt increment (dati locali, non da Jira). Chiavi esplicite invece di
// un prefisso generico ['dashboard'] per non intercettare per sbaglio la
// query ['dashboard', projectId] della Dashboard di progetto.
function RefreshAllRow() {
  const queryClient = useQueryClient()
  const fetchingOverview = useIsFetching({ queryKey: ['dashboard', 'overview'] })
  const fetchingCycleTime = useIsFetching({ queryKey: ['dashboard', 'cycle-time'] })

  return (
    <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
      <RefreshButton
        onClick={() => {
          queryClient.refetchQueries({ queryKey: ['dashboard', 'overview'] })
          queryClient.refetchQueries({ queryKey: ['dashboard', 'cycle-time'] })
        }}
        isFetching={fetchingOverview + fetchingCycleTime > 0}
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
    </div>
  )
}
