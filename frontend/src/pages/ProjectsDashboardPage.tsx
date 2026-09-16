import { useQueries, useQuery } from '@tanstack/react-query'
import { Link } from 'react-router-dom'
import { api } from '../api/client'
import type { Phase, Project } from '../api/types'
import { dateStrToEpochDays, epochDaysToDate, formatEpochDaysAsDate, toEpochDays } from '../lib/dates'

// Palette categorica validata del progetto (vedi skill data-viz): il colore
// segue la POSIZIONE della fase nella sequenza di un progetto (1a, 2a, 3a...),
// non un nome di fase fisso - progetti diversi possono chiamare le fasi in
// modo diverso, ma la sequenza (Kick-off -> ... -> Deployment) e' comparabile
// in ordine.
const PHASE_COLORS = ['#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#e87ba4', '#008300', '#4a3aa7', '#e34948']

const ROW_LABEL_WIDTH = 220
const MIN_LABEL_GAP_PCT = 6 // sotto questa distanza in %, un'etichetta data viene saltata per evitare sovrapposizioni

type Milestone = { label: string; epoch: number }

function buildMilestones(project: Project, phases: Phase[]): Milestone[] {
  const milestones: Milestone[] = []
  const startEpoch = dateStrToEpochDays(project.start_date)
  if (startEpoch !== null) milestones.push({ label: 'Inizio progetto', epoch: startEpoch })

  for (const phase of [...phases].sort((a, b) => a.order - b.order)) {
    const epoch = dateStrToEpochDays(phase.planned_date) ?? dateStrToEpochDays(phase.actual_date)
    if (epoch !== null) milestones.push({ label: phase.name, epoch })
  }

  // Ordinate per data (non per campo "order"): un segmento non puo' avere
  // larghezza negativa, quindi il disegno segue sempre la cronologia reale.
  milestones.sort((a, b) => a.epoch - b.epoch)
  return milestones
}

function buildMonthTicks(minEpoch: number, maxEpoch: number): { epoch: number; label: string }[] {
  const start = epochDaysToDate(minEpoch)
  const cursor = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), 1))
  const ticks: { epoch: number; label: string }[] = []
  // Limite di sicurezza per non generare un numero assurdo di tick se le
  // date in database fossero incoerenti.
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

// Sceglie quali etichette data mostrare sotto la barra: sempre la prima e
// l'ultima, le altre solo se abbastanza distanziate dall'ultima mostrata
// (altrimenti si accavallerebbero su fasi molto ravvicinate).
function pickLabels(milestones: Milestone[], pct: (epoch: number) => number): Milestone[] {
  if (milestones.length === 0) return []
  const picked: Milestone[] = [milestones[0]]
  let lastPct = pct(milestones[0].epoch)
  for (let i = 1; i < milestones.length - 1; i++) {
    const p = pct(milestones[i].epoch)
    if (p - lastPct >= MIN_LABEL_GAP_PCT) {
      picked.push(milestones[i])
      lastPct = p
    }
  }
  if (milestones.length > 1) {
    const last = milestones[milestones.length - 1]
    // Stessa soglia usata per le etichette intermedie: se la data di fine e'
    // troppo vicina all'ultima gia' mostrata si accavallerebbero (es. due
    // fasi a poche settimane di distanza su un asse di piu' anni). Se pero'
    // e' l'unica candidata oltre alla prima, va mostrata comunque - meglio
    // due etichette vicine che nascondere del tutto la data di fine.
    if (pct(last.epoch) - lastPct >= MIN_LABEL_GAP_PCT || picked.length === 1) {
      picked.push(last)
    }
  }
  return picked
}

export function ProjectsDashboardPage() {
  const { data: projects } = useQuery({ queryKey: ['projects'], queryFn: api.projects.list })

  const phaseQueries = useQueries({
    queries: (projects ?? []).map((p) => ({
      queryKey: ['phases', p.id],
      queryFn: () => api.phases.list(p.id),
    })),
  })

  if (!projects) return <p className="muted">Caricamento...</p>

  const rows = projects.map((project, idx) => ({
    project,
    milestones: buildMilestones(project, phaseQueries[idx]?.data ?? []),
  }))

  const allEpochs = rows.flatMap((r) => r.milestones.map((m) => m.epoch))

  if (allEpochs.length === 0) {
    return (
      <div className="card">
        <h3 style={{ marginTop: 0 }}>Dashboard progetti</h3>
        <p className="muted">
          Nessuna data disponibile (data inizio progetto o date fasi) su nessun progetto: non c'e' ancora niente da
          mostrare nel Gantt.
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

  const sortedRows = [...rows].sort((a, b) => {
    const aStart = a.milestones[0]?.epoch ?? Infinity
    const bStart = b.milestones[0]?.epoch ?? Infinity
    return aStart - bStart
  })

  return (
    <div>
      <div className="card">
        <h3 style={{ marginTop: 0 }}>Dashboard progetti</h3>
        <p className="muted" style={{ marginTop: 0, marginBottom: 0 }}>
          Panoramica di tutti i progetti: ogni barra va dalla data di inizio progetto alla fase di deployment/rilascio,
          passando per le fasi intermedie, per individuare sovrapposizioni e date di rilascio vicine. Il colore segue
          la posizione della fase nella sequenza del progetto (1ª, 2ª, 3ª...), non un nome fisso: passa il mouse su un
          segmento per vedere la fase e le date esatte. La linea rossa tratteggiata indica la data odierna.
        </p>
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

            {sortedRows.map(({ project, milestones }) => {
              const labels = pickLabels(milestones, pct)
              return (
                <div
                  key={project.id}
                  style={{
                    display: 'grid',
                    gridTemplateColumns: `${ROW_LABEL_WIDTH}px 1fr`,
                    gap: 12,
                    alignItems: 'center',
                    padding: '20px 0 10px',
                    borderTop: '1px solid var(--border)',
                  }}
                >
                  <Link to={`/projects/${project.id}`} style={{ textDecoration: 'none', color: 'inherit' }}>
                    <div style={{ fontWeight: 600, fontSize: 13 }}>{project.code}</div>
                    <div className="muted" style={{ fontSize: 12, lineHeight: 1.3 }}>
                      {project.name}
                    </div>
                  </Link>

                  <div style={{ position: 'relative', height: 34 }}>
                    {/* Griglia mensile di sfondo, per confrontare le righe */}
                    {monthTicks.map((t) => (
                      <div
                        key={t.epoch}
                        style={{
                          position: 'absolute',
                          left: `${pct(t.epoch)}%`,
                          top: 0,
                          bottom: 0,
                          width: 1,
                          background: 'var(--border)',
                        }}
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
                          bottom: 8,
                          width: 0,
                          borderLeft: '2px dashed #e34948',
                        }}
                      />
                    )}

                    {milestones.length === 0 && (
                      <span className="muted" style={{ fontSize: 12 }}>
                        Nessuna data disponibile
                      </span>
                    )}

                    {/* Un solo milestone (es. solo data inizio, nessuna fase datata
                        ancora): nessun segmento da disegnare, ma un pallino indica
                        comunque dove si trova quella data. */}
                    {milestones.length === 1 && (
                      <div
                        title={`${milestones[0].label}: ${formatEpochDaysAsDate(milestones[0].epoch)}`}
                        style={{
                          position: 'absolute',
                          left: `${pct(milestones[0].epoch)}%`,
                          top: '50%',
                          width: 10,
                          height: 10,
                          borderRadius: '50%',
                          background: PHASE_COLORS[0],
                          transform: 'translate(-50%, -50%)',
                        }}
                      />
                    )}

                    {milestones.slice(0, -1).map((m, i) => {
                      const next = milestones[i + 1]
                      const left = pct(m.epoch)
                      const width = Math.max(pct(next.epoch) - left, 0.6)
                      return (
                        <div
                          key={i}
                          title={`${next.label}: dal ${formatEpochDaysAsDate(m.epoch)} al ${formatEpochDaysAsDate(next.epoch)}`}
                          style={{
                            position: 'absolute',
                            left: `${left}%`,
                            width: `${width}%`,
                            top: 8,
                            bottom: 8,
                            background: PHASE_COLORS[i % PHASE_COLORS.length],
                            borderRadius: 4,
                          }}
                        />
                      )
                    })}

                    {labels.map((m, i) => {
                      // Prima etichetta allineata a sinistra del punto, ultima a
                      // destra (altrimenti sborda dal bordo del contenitore),
                      // le intermedie centrate.
                      const align = i === 0 ? '0%' : i === labels.length - 1 ? '-100%' : '-50%'
                      return (
                        <span
                          key={m.label + m.epoch}
                          className="muted"
                          style={{
                            position: 'absolute',
                            left: `${pct(m.epoch)}%`,
                            bottom: -14,
                            fontSize: 10,
                            whiteSpace: 'nowrap',
                            transform: `translateX(${align})`,
                          }}
                        >
                          {formatEpochDaysAsDate(m.epoch)}
                        </span>
                      )
                    })}
                  </div>
                </div>
              )
            })}
          </div>
        </div>
      </div>
    </div>
  )
}
