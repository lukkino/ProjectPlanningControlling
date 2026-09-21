import { useQuery } from '@tanstack/react-query'
import { Link } from 'react-router-dom'
import { api } from '../api/client'
import type { Project } from '../api/types'
import { dateStrToEpochDays, epochDaysToDate, formatEpochDaysAsDate, toEpochDays } from '../lib/dates'

const ROW_LABEL_WIDTH = 160
const BAR_HEIGHT = 30
// Increment non "in corso": tinta chiara dello stesso blu --primary, cosi'
// quelli "in corso" (blu pieno + bordo) risaltano per contrasto.
const COLOR_INACTIVE = '#c7d9fb'

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
      <div className="card">
        <h3 style={{ marginTop: 0 }}>Dashboard generale</h3>
        <p className="muted">
          Nessuna data di inizio/fine impostata su nessun increment: non c'e' ancora niente da mostrare nel Gantt.
        </p>
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
    </div>
  )
}
