import { useQueries, useQuery } from '@tanstack/react-query'
import { Link } from 'react-router-dom'
import { api } from '../api/client'
import type { Phase, Project } from '../api/types'
import { dateStrToEpochDays, epochDaysToDate, formatEpochDaysAsDate, toEpochDays } from '../lib/dates'

// Palette categorica validata del progetto (vedi skill data-viz). Ogni
// progetto ha sempre almeno queste 5 fasi standard (create automaticamente
// alla creazione, vedi backend STANDARD_PHASE_NAMES): il colore segue quindi
// il NOME della fase, uguale in tutti i progetti - non solo la posizione,
// visto che ora la sequenza e' garantita coerente. Eventuali fasi extra
// aggiunte a mano ricadono sui colori restanti della palette.
const PHASE_COLORS = ['#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#e87ba4', '#008300', '#4a3aa7', '#e34948']
const STANDARD_PHASES = ['Kick-off', 'Planning', 'Execution', 'Deployment', 'Release to Market']
const PHASE_COLOR_BY_NAME: Record<string, string> = Object.fromEntries(
  STANDARD_PHASES.map((name, i) => [name, PHASE_COLORS[i]]),
)

function colorForPhase(name: string, fallbackIndex: number): string {
  return PHASE_COLOR_BY_NAME[name] ?? PHASE_COLORS[(STANDARD_PHASES.length + fallbackIndex) % PHASE_COLORS.length]
}

const ROW_LABEL_WIDTH = 220
const MIN_LABEL_GAP_PCT = 6 // sotto questa distanza in %, un'etichetta data viene saltata per evitare sovrapposizioni
const MIN_PHASE_NAME_WIDTH_PCT = 7 // sotto questa larghezza il nome fase non ci sta leggibile dentro il segmento

type Milestone = { label: string; epoch: number }

function buildMilestones(project: Project, phases: Phase[]): Milestone[] {
  const milestones: Milestone[] = []
  const startEpoch = dateStrToEpochDays(project.start_date)
  if (startEpoch !== null) milestones.push({ label: 'Inizio increment', epoch: startEpoch })

  for (const phase of [...phases].sort((a, b) => a.order - b.order)) {
    let epoch = dateStrToEpochDays(phase.planned_date) ?? dateStrToEpochDays(phase.actual_date)
    // "Release to Market" senza data propria: ricade sulla data di fine
    // pianificata del progetto, se impostata (stesso concetto, spesso non
    // ancora tracciato come fase a se' stante).
    if (epoch === null && phase.name === 'Release to Market') {
      epoch = dateStrToEpochDays(project.planned_finish_date)
    }
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
        <h3 style={{ marginTop: 0 }}>Dashboard increment</h3>
        <p className="muted">
          Nessuna data disponibile (data inizio increment o date fasi) su nessun increment: non c'e' ancora niente da
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

  // Legenda: i nomi di fase effettivamente presenti in almeno un progetto,
  // fasi standard per prime (nell'ordine canonico) seguite da eventuali fasi
  // extra aggiunte a mano, ciascuna col colore che verra' usato nelle barre.
  const usedNames = new Set(rows.flatMap((r) => r.milestones.slice(1).map((m) => m.label)))
  const legendNames = [
    ...STANDARD_PHASES.filter((n) => usedNames.has(n)),
    ...[...usedNames].filter((n) => !STANDARD_PHASES.includes(n)).sort(),
  ]

  return (
    <div>
      <div className="card">
        <h3 style={{ marginTop: 0 }}>Dashboard increment</h3>
        <p className="muted" style={{ marginTop: 0, marginBottom: 12 }}>
          Panoramica di tutti gli increment: ogni barra va dalla data di inizio increment alla fase di deployment/rilascio,
          passando per le fasi intermedie (sempre almeno Kick-off, Planning, Execution, Deployment, Release to
          Market), per individuare sovrapposizioni e date di rilascio vicine. Passa il mouse su un segmento per
          vedere la fase e le date esatte. La linea rossa tratteggiata indica la data odierna.
        </p>
        {legendNames.length > 0 && (
          <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', alignItems: 'center' }}>
            {legendNames.map((name, i) => (
              <div key={name} style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12 }}>
                <span
                  style={{
                    width: 12,
                    height: 12,
                    borderRadius: 3,
                    background: colorForPhase(name, i),
                    display: 'inline-block',
                  }}
                />
                <span className="muted">{name}</span>
              </div>
            ))}
          </div>
        )}
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
                          background: colorForPhase(milestones[0].label, 0),
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
                            background: colorForPhase(next.label, i),
                            borderRadius: 4,
                            overflow: 'hidden',
                            display: 'flex',
                            alignItems: 'center',
                          }}
                        >
                          {width >= MIN_PHASE_NAME_WIDTH_PCT && (
                            <span
                              style={{
                                fontSize: 10,
                                color: 'white',
                                padding: '0 5px',
                                whiteSpace: 'nowrap',
                                overflow: 'hidden',
                                textOverflow: 'ellipsis',
                              }}
                            >
                              {next.label}
                            </span>
                          )}
                        </div>
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
