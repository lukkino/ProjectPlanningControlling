import { Bar, BarChart, CartesianGrid, LabelList, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import type { CveIssue } from '../../api/types'
import { CONFIRMED_STATUS, CVE_TIERS, cveDueDate, cveTier, today } from '../../lib/cveDeadlines'

// Scadenze delle CVE Confirmed (regole in lib/cveDeadlines.ts): quante ne
// vanno risolte in ogni mese, piu' una barra per quelle gia' scadute. Segue
// i filtri della tabella come la torta dei component.
// Colori: rampa ordinale di un solo tono (piu' scuro = piu' urgente),
// validata con lo script della skill dataviz.

const COLORS = { critical: '#9f2a1e', high: '#e8826a' }
const OVERDUE = 'Scadute'

type Bucket = { label: string; title: string; critical: number; high: number; total: number }

const monthKey = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
const monthLabel = (d: Date) =>
  d.toLocaleDateString('it-IT', { month: 'short', year: '2-digit' }).replace('.', '')

export function CveDeadlineChart({ visible }: { visible: CveIssue[] }) {
  const now = today()
  const in30 = new Date(now)
  in30.setDate(in30.getDate() + 30)

  const confirmed = visible.filter((c) => c.status === CONFIRMED_STATUS)
  const toPlan = confirmed.filter((c) => cveTier(c) === 'plan').length
  const withDue = confirmed
    .map((c) => ({ tier: cveTier(c) as 'critical' | 'high', due: cveDueDate(c) }))
    .filter((x): x is { tier: 'critical' | 'high'; due: Date } => x.due != null)
  const missingDate = confirmed.filter((c) => cveTier(c) !== 'plan' && !c.confirmed_at).length
  const overdue = withDue.filter((x) => x.due < now)
  const next30 = withDue.filter((x) => x.due >= now && x.due <= in30).length

  // Un mese per barra, dal mese corrente all'ultima scadenza (anche i mesi
  // vuoti, cosi' l'asse e' un calendario), con le scadute davanti.
  const buckets: Bucket[] = []
  if (overdue.length) {
    buckets.push({
      label: OVERDUE,
      title: `Scadute (prima del ${now.toLocaleDateString('it-IT')})`,
      critical: overdue.filter((x) => x.tier === 'critical').length,
      high: overdue.filter((x) => x.tier === 'high').length,
      total: overdue.length,
    })
  }
  const future = withDue.filter((x) => x.due >= now)
  if (future.length) {
    const last = future.reduce((max, x) => (x.due > max ? x.due : max), future[0].due)
    const byMonth = new Map<string, { critical: number; high: number }>()
    for (const x of future) {
      const key = monthKey(x.due)
      const entry = byMonth.get(key) ?? { critical: 0, high: 0 }
      entry[x.tier] += 1
      byMonth.set(key, entry)
    }
    for (let d = new Date(now.getFullYear(), now.getMonth(), 1); d <= last; d.setMonth(d.getMonth() + 1)) {
      const entry = byMonth.get(monthKey(d)) ?? { critical: 0, high: 0 }
      buckets.push({
        label: monthLabel(d),
        title: d.toLocaleDateString('it-IT', { month: 'long', year: 'numeric' }),
        ...entry,
        total: entry.critical + entry.high,
      })
    }
  }

  return (
    <div className="card cve-chart-card">
      <h3 style={{ margin: '0 0 4px' }}>Scadenze di risoluzione</h3>
      <p className="muted" style={{ margin: '0 0 8px', fontSize: 12 }}>
        CVE Confirmed mostrate in tabella, per mese di scadenza dalla data di conferma: CVSS Inpeco ≥ 9 entro 4
        settimane, &gt; 7 e &lt; 9 entro 24 settimane, le altre da pianificare.
      </p>
      <div className="cve-deadline-kpis">
        <span className={overdue.length ? 'cve-kpi-alert' : undefined}>
          {overdue.length ? '⚠ ' : ''}
          <b>{overdue.length}</b> scadute
        </span>
        <span>
          <b>{next30}</b> entro 30 giorni
        </span>
        <span>
          <b>{withDue.length - overdue.length}</b> da risolvere con scadenza
        </span>
        <span>
          <b>{toPlan}</b> da pianificare
        </span>
      </div>
      {missingDate > 0 && (
        <div className="error-banner">
          {missingDate} CVE Confirmed senza data di conferma (lette prima che l'app la salvasse): premi ⟳ Sincronizza da
          Jira per calcolarne la scadenza.
        </div>
      )}
      {buckets.length === 0 ? (
        <p className="muted">Nessuna CVE Confirmed con scadenza con i filtri attuali.</p>
      ) : (
        <>
          <div className="cve-deadline-chart" role="img" aria-label="CVE da risolvere per mese di scadenza">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={buckets} margin={{ top: 20, right: 8, bottom: 0, left: 0 }} barCategoryGap="20%">
                <CartesianGrid vertical={false} stroke="var(--border)" />
                <XAxis
                  dataKey="label"
                  tickLine={false}
                  axisLine={{ stroke: 'var(--border)' }}
                  tick={{ fontSize: 12, fill: 'var(--text-muted)' }}
                  interval={0}
                />
                <YAxis
                  allowDecimals={false}
                  tickLine={false}
                  axisLine={false}
                  width={36}
                  tick={{ fontSize: 12, fill: 'var(--text-muted)' }}
                />
                <Tooltip
                  cursor={{ fill: 'var(--bg)' }}
                  content={({ active, payload }) => {
                    const b = active && payload?.[0] ? (payload[0].payload as Bucket) : null
                    if (!b) return null
                    return (
                      <div className="cve-pie-tooltip">
                        <b>{b.title}</b>
                        <div>{b.total} CVE da risolvere</div>
                        {(['critical', 'high'] as const).map((tier) =>
                          b[tier] ? (
                            <div key={tier}>
                              <span className="cve-pie-swatch" style={{ background: COLORS[tier] }} />
                              {CVE_TIERS[tier].label}: {b[tier]}
                            </div>
                          ) : null,
                        )}
                      </div>
                    )
                  }}
                />
                <Bar
                  dataKey="critical"
                  stackId="due"
                  fill={COLORS.critical}
                  stroke="var(--surface)"
                  strokeWidth={1}
                  isAnimationActive={false}
                />
                <Bar
                  dataKey="high"
                  stackId="due"
                  fill={COLORS.high}
                  stroke="var(--surface)"
                  strokeWidth={1}
                  radius={[4, 4, 0, 0]}
                  isAnimationActive={false}
                >
                  <LabelList
                    dataKey="total"
                    position="top"
                    style={{ fontSize: 12, fill: 'var(--text)' }}
                    formatter={(value) => (Number(value) > 0 ? String(value) : '')}
                  />
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>
          <div className="cve-deadline-legend">
            {(['critical', 'high'] as const).map((tier) => (
              <span key={tier}>
                <span className="cve-pie-swatch" style={{ background: COLORS[tier] }} />
                {CVE_TIERS[tier].label}
              </span>
            ))}
          </div>
        </>
      )}
    </div>
  )
}
