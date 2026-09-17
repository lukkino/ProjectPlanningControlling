import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { CartesianGrid, Legend, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { api } from '../api/client'
import { PhasesCard } from '../components/PhasesCard'
import { dateStrToEpochDays, formatEpochDaysAsDate, formatIsoDate } from '../lib/dates'
import { useProjectContext } from './useProjectContext'

// Palette categorica validata del progetto (skill data-viz): blu e arancio
// per le due serie di ore reali.
const COLOR_ACTUAL_HOURS = '#2a78d6'
const COLOR_ACTUAL_LOGGED = '#eb6834'

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

export function DashboardPage() {
  const { project } = useProjectContext()
  const queryClient = useQueryClient()

  const updateStatus = useMutation({
    mutationFn: (status: string) => api.projects.update(project.id, { status }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['project', project.id] }),
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

  const chartData = (snapshots ?? []).map((s) => ({
    date: formatIsoDate(s.snapshot_date) ?? s.snapshot_date,
    completamento: s.pbi_total ? Math.round(((s.pbi_done ?? 0) / s.pbi_total) * 100) : null,
  }))

  // Ore effettive dagli snapshot di Andamento (actual_hours = "Actual
  // (PowerBI)", logged_hours = "Actual logged") nel tempo.
  const startEpoch = dateStrToEpochDays(project.start_date)
  const freezeEpoch = dateStrToEpochDays(project.code_freeze_date)

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
          <select
            value={project.status}
            onChange={(e) => updateStatus.mutate(e.target.value)}
            disabled={updateStatus.isPending}
          >
            {statusOptions.map((s) => (
              <option key={s}>{s}</option>
            ))}
          </select>
        </div>
      </div>

      {project.scope && (
        <div className="card">
          <h3>Scope</h3>
          <p style={{ whiteSpace: 'pre-wrap', margin: 0 }}>{project.scope}</p>
        </div>
      )}

      <PhasesCard projectId={project.id} currentStatus={project.status} />

      <div className="card">
        <div className="grid-5">
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
            {metrics?.logged_hours_source === 'snapshot' && (
              <span className="muted" style={{ fontSize: 11 }}>
                da snapshot del {formatIsoDate(metrics.last_snapshot_date)}
              </span>
            )}
          </div>
          <div className="stat">
            <span className="value">{metrics?.dev_logged_hours_total ?? 0} h</span>
            <span className="label">Ore loggate</span>
            <span className="muted" style={{ fontSize: 11 }}>
              solo Development (Time Tracking Jira)
            </span>
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
        {chartData.length === 0 ? (
          <p className="muted">
            Nessuno snapshot registrato. Aggiungine uno dalla tab "Andamento" per iniziare a tracciare lo storico.
          </p>
        ) : (
          <div style={{ height: 220 }}>
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={chartData}>
                <CartesianGrid strokeDasharray="3 3" />
                <XAxis dataKey="date" tick={{ fontSize: 12 }} />
                <YAxis unit="%" tick={{ fontSize: 12 }} />
                <Tooltip />
                <Line type="monotone" dataKey="completamento" stroke="#2f6fed" strokeWidth={2} dot />
              </LineChart>
            </ResponsiveContainer>
          </div>
        )}
      </div>
    </div>
  )
}
