import { Cell, Pie, PieChart, ResponsiveContainer, Tooltip } from 'recharts'
import type { CveIssue } from '../../api/types'

// Torta delle CVE per component Jira (Core, INTS, PAS...): conta le CVE
// mostrate dalla tabella, quindi segue i filtri (stato, severity, ricerca...).
// Il colore segue il component, non la sua posizione: e' assegnato
// sull'ordine dei component in tutte le CVE salvate, cosi' filtrando i
// colori non cambiano. Palette categoriale a 8 colori validata (skill
// dataviz); oltre l'ottavo component si raggruppa in "Altri".

const PALETTE = ['#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#e87ba4', '#008300', '#6250d6', '#e34948']
const NEUTRAL = '#9aa1ab'
const NO_COMPONENT = 'Senza component'
const OTHERS = 'Altri'

const componentOf = (c: CveIssue) => c.components[0] ?? NO_COMPONENT

type Slice = { name: string; value: number; color: string }

export function CveComponentPie({ all, visible }: { all: CveIssue[]; visible: CveIssue[] }) {
  // Ordine stabile: per numero di CVE su tutte quelle salvate.
  const totals = new Map<string, number>()
  for (const c of all) {
    const name = componentOf(c)
    if (name !== NO_COMPONENT) totals.set(name, (totals.get(name) ?? 0) + 1)
  }
  const ordered = [...totals.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([n]) => n)
  const colorOf = new Map(ordered.slice(0, PALETTE.length).map((name, i) => [name, PALETTE[i]]))

  const counts = new Map<string, number>()
  for (const c of visible) {
    const raw = componentOf(c)
    const name = raw === NO_COMPONENT || colorOf.has(raw) ? raw : OTHERS
    counts.set(name, (counts.get(name) ?? 0) + 1)
  }
  const slices: Slice[] = [...ordered.filter((n) => colorOf.has(n)), OTHERS, NO_COMPONENT]
    .filter((name) => counts.get(name))
    .map((name) => ({ name, value: counts.get(name) ?? 0, color: colorOf.get(name) ?? NEUTRAL }))
  const total = visible.length
  const percent = (value: number) =>
    total ? `${((value / total) * 100).toLocaleString('it-IT', { maximumFractionDigits: 1 })}%` : '0%'

  return (
    <div className="card cve-pie-card">
      <h3 style={{ margin: '0 0 4px' }}>CVE per component</h3>
      <p className="muted" style={{ margin: '0 0 8px', fontSize: 12 }}>
        Le {total} CVE mostrate in tabella: segue i filtri qui sotto (stato, severity, ricerca…).
      </p>
      {all.every((c) => c.components.length === 0) && (
        <div className="error-banner">
          Le CVE salvate non hanno ancora il component (lette prima che l'app lo salvasse): premi ⟳ Sincronizza da
          Jira per dividerle per component.
        </div>
      )}
      {total === 0 ? (
        <p className="muted">Nessuna CVE con i filtri attuali.</p>
      ) : (
        <div className="cve-pie">
          <div className="cve-pie-chart" role="img" aria-label="Grafico a torta delle CVE per component">
            <ResponsiveContainer width="100%" height="100%">
              <PieChart>
                <Pie
                  data={slices}
                  dataKey="value"
                  nameKey="name"
                  innerRadius="0%"
                  outerRadius="95%"
                  stroke="var(--surface)"
                  strokeWidth={2}
                  isAnimationActive={false}
                >
                  {slices.map((s) => (
                    <Cell key={s.name} fill={s.color} />
                  ))}
                </Pie>
                <Tooltip
                  content={({ active, payload }) => {
                    const slice = active && payload?.[0] ? (payload[0].payload as Slice) : null
                    if (!slice) return null
                    return (
                      <div className="cve-pie-tooltip">
                        <span className="cve-pie-swatch" style={{ background: slice.color }} />
                        <b>{slice.name}</b>
                        <div>
                          {slice.value} CVE · {percent(slice.value)}
                        </div>
                      </div>
                    )
                  }}
                />
              </PieChart>
            </ResponsiveContainer>
          </div>
          <table className="cve-pie-legend">
            <tbody>
              {slices.map((s) => (
                <tr key={s.name}>
                  <td>
                    <span className="cve-pie-swatch" style={{ background: s.color }} />
                    {s.name}
                  </td>
                  <td className="num">{s.value}</td>
                  <td className="num muted">{percent(s.value)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
