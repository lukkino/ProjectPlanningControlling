import { useQuery } from '@tanstack/react-query'
import { CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { api } from '../api/client'
import { BudgetLinesCard } from '../components/BudgetLinesCard'
import { PhasesCard } from '../components/PhasesCard'
import { useProjectContext } from './useProjectContext'

const pct = (v: number | null) => (v === null ? '—' : `${Math.round(v * 100)}%`)

function spiTone(spi: number | null) {
  if (spi === null) return ''
  if (spi > 1.05) return 'done'
  if (spi < 0.95) return 'progress'
  return ''
}

export function DashboardPage() {
  const { project } = useProjectContext()

  const { data: metrics } = useQuery({
    queryKey: ['dashboard', project.id],
    queryFn: () => api.dashboard.get(project.id),
  })

  const { data: snapshots } = useQuery({
    queryKey: ['snapshots', project.id],
    queryFn: () => api.snapshots.list(project.id),
  })

  const chartData = (snapshots ?? []).map((s) => ({
    date: s.snapshot_date,
    completamento: s.pbi_total ? Math.round(((s.pbi_done ?? 0) / s.pbi_total) * 100) : null,
  }))

  return (
    <div>
      {project.scope && (
        <div className="card">
          <h3>Scope</h3>
          <p style={{ whiteSpace: 'pre-wrap', margin: 0 }}>{project.scope}</p>
        </div>
      )}

      <div className="card">
        <div className="grid-3">
          <div className="stat">
            <span className="value">{metrics ? pct(metrics.percent_complete) : '—'}</span>
            <span className="label">
              Completamento backlog ({metrics?.backlog_done ?? 0}/{metrics?.backlog_in_scope ?? 0})
            </span>
          </div>
          <div className="stat">
            <span className="value">{metrics ? pct(metrics.percent_budget_used) : '—'}</span>
            <span className="label">
              Ore usate ({metrics?.logged_hours_total ?? 0} / {metrics?.budget_hours_total ?? 0} h)
            </span>
          </div>
          <div className="stat">
            <span className={`value ${metrics ? spiTone(metrics.spi) : ''}`}>
              {metrics?.spi != null ? metrics.spi.toFixed(2) : '—'}
            </span>
            <span className="label">SPI (avanzamento / tempo trascorso)</span>
          </div>
        </div>
      </div>

      <PhasesCard projectId={project.id} />
      <BudgetLinesCard projectId={project.id} />

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
