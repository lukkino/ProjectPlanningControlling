import { useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import { Bar, BarChart, CartesianGrid, Legend, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { api } from '../api/client'
import type { Complaint } from '../api/types'
import { ARCHITECTURES, NO_ARCHITECTURE, architecturesOf } from '../lib/complaints'

// "Aperto" = creato su Jira (jira_created); "chiuso" = passato a uno stato
// Jira finale, Done o Rejected (jira_resolved). Lo stato Salesforce non entra
// nei KPI: e' gestito a mano e non ha una data.
const REJECTED_STATUS = 'Rejected'

// Finestre mobili all'indietro da oggi (come "Issue chiuse nell'ultima
// settimana" della Dashboard increment), non settimana/mese di calendario.
const PERIODS = [
  { label: 'Ultima settimana', days: 7 },
  { label: 'Ultimo mese', days: 30 },
  { label: 'Ultimo anno', days: 365 },
]

type Granularity = 'week' | 'month' | 'year'

const GRANULARITIES: { value: Granularity; label: string; description: string }[] = [
  { value: 'week', label: 'Settimana', description: 'ultime 12 settimane' },
  { value: 'month', label: 'Mese', description: 'ultimi 12 mesi' },
  { value: 'year', label: 'Anno', description: 'per anno' },
]
const BUCKET_COUNT = 12
// Per anno si parte dal primo complaint, ma senza andare troppo indietro.
const MAX_YEARS = 15

// Blu = aperti, verde = chiusi Done, grigio neutro = chiusi Rejected (scartati,
// quindi in secondo piano come i "Non Complaint" della Dashboard).
const COLORS = { opened: '#2f6fed', done: '#1a9c5c', rejected: '#6b7280', open: '#2f6fed' }

const pad = (n: number) => String(n).padStart(2, '0')
const toIso = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`

function parseIso(value: string): Date {
  const [y, m, d] = value.split('-').map(Number)
  return new Date(y, m - 1, d)
}

function mondayOf(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() - ((d.getDay() + 6) % 7))
}

// Chiave del periodo a cui appartiene una data ISO (yyyy-mm-dd).
function bucketKeyOf(granularity: Granularity, iso: string): string {
  if (granularity === 'year') return iso.slice(0, 4)
  if (granularity === 'month') return iso.slice(0, 7)
  return toIso(mondayOf(parseIso(iso)))
}

type Bucket = { key: string; label: string; title: string; end: string }

function buildBuckets(granularity: Granularity, today: Date, firstYear: number): Bucket[] {
  const buckets: Bucket[] = []
  if (granularity === 'year') {
    const currentYear = today.getFullYear()
    for (let y = Math.max(firstYear, currentYear - MAX_YEARS + 1); y <= currentYear; y++) {
      buckets.push({ key: String(y), label: String(y), title: `Anno ${y}`, end: `${y}-12-31` })
    }
  } else if (granularity === 'month') {
    for (let i = BUCKET_COUNT - 1; i >= 0; i--) {
      const start = new Date(today.getFullYear(), today.getMonth() - i, 1)
      const end = new Date(start.getFullYear(), start.getMonth() + 1, 0)
      buckets.push({
        key: toIso(start).slice(0, 7),
        label: start.toLocaleDateString('it-IT', { month: 'short', year: '2-digit' }),
        title: start.toLocaleDateString('it-IT', { month: 'long', year: 'numeric' }),
        end: toIso(end),
      })
    }
  } else {
    const monday = mondayOf(today)
    for (let i = BUCKET_COUNT - 1; i >= 0; i--) {
      const start = new Date(monday.getFullYear(), monday.getMonth(), monday.getDate() - 7 * i)
      const end = new Date(start.getFullYear(), start.getMonth(), start.getDate() + 6)
      const label = `${pad(start.getDate())}/${pad(start.getMonth() + 1)}`
      buckets.push({
        key: toIso(start),
        label,
        title: `Settimana ${label} - ${pad(end.getDate())}/${pad(end.getMonth() + 1)}`,
        end: toIso(end),
      })
    }
  }
  return buckets
}

const TOOLTIP_STYLE = {
  background: 'var(--surface)',
  border: '1px solid var(--border)',
  borderRadius: 6,
  fontSize: 12,
}
// Il nome nel tooltip resta nel colore del testo: l'identita' della serie la
// da' la legenda, non il colore della scritta.
const TOOLTIP_ITEM_STYLE = { color: 'var(--text)' }

function PeriodStats({ complaints, today }: { complaints: Complaint[]; today: Date }) {
  const stats = PERIODS.map((p) => {
    const cutoff = toIso(new Date(today.getFullYear(), today.getMonth(), today.getDate() - p.days))
    const closed = complaints.filter((c) => c.jira_resolved != null && c.jira_resolved >= cutoff)
    return {
      ...p,
      opened: complaints.filter((c) => c.jira_created != null && c.jira_created >= cutoff).length,
      closed: closed.length,
      rejected: closed.filter((c) => c.jira_status === REJECTED_STATUS).length,
    }
  })
  const stillOpen = complaints.filter((c) => c.jira_resolved == null).length

  return (
    <div className="grid-3" style={{ gridTemplateColumns: '2fr 2fr 1fr', marginBottom: 16 }}>
      <div className="card">
        <h3>Complaint aperti</h3>
        <div className="stat-chips" style={{ marginBottom: 0 }}>
          {stats.map((s) => (
            <div className="stat-chip blue" key={s.label} title={`Creati su Jira negli ultimi ${s.days} giorni`}>
              <span className="value">{s.opened}</span>
              <span className="label">{s.label}</span>
            </div>
          ))}
        </div>
      </div>
      <div className="card" style={{ marginTop: 0 }}>
        <h3>Complaint chiusi</h3>
        <div className="stat-chips" style={{ marginBottom: 0 }}>
          {stats.map((s) => (
            <div
              className="stat-chip green"
              key={s.label}
              title={`Passati a Done o Rejected negli ultimi ${s.days} giorni: ${s.closed - s.rejected} Done, ${s.rejected} Rejected`}
            >
              <span className="value">{s.closed}</span>
              <span className="label">{s.label}</span>
            </div>
          ))}
        </div>
      </div>
      <div className="card" style={{ marginTop: 0 }}>
        <h3>Ancora aperti</h3>
        <div className="stat-chips" style={{ marginBottom: 0 }}>
          <div className="stat-chip orange" title="Complaint non ancora in stato Done o Rejected su Jira">
            <span className="value">{stillOpen}</span>
            <span className="label">Su {complaints.length} complaint</span>
          </div>
        </div>
      </div>
    </div>
  )
}

function TrendCharts({ complaints, today }: { complaints: Complaint[]; today: Date }) {
  const [granularity, setGranularity] = useState<Granularity>('month')
  const current = GRANULARITIES.find((g) => g.value === granularity)!

  const firstCreated = complaints.reduce<string | null>(
    (min, c) => (c.jira_created && (!min || c.jira_created < min) ? c.jira_created : min),
    null,
  )
  const buckets = buildBuckets(granularity, today, firstCreated ? Number(firstCreated.slice(0, 4)) : today.getFullYear())
  const opened = new Map<string, number>()
  const done = new Map<string, number>()
  const rejected = new Map<string, number>()
  const increment = (counts: Map<string, number>, iso: string) => {
    const key = bucketKeyOf(granularity, iso)
    counts.set(key, (counts.get(key) ?? 0) + 1)
  }
  for (const c of complaints) {
    if (c.jira_created) increment(opened, c.jira_created)
    if (c.jira_resolved) increment(c.jira_status === REJECTED_STATUS ? rejected : done, c.jira_resolved)
  }
  const rows = buckets.map((b) => ({
    ...b,
    opened: opened.get(b.key) ?? 0,
    done: done.get(b.key) ?? 0,
    rejected: rejected.get(b.key) ?? 0,
    // Ancora aperti a fine periodo: creati entro quella data e non ancora chiusi.
    open: complaints.filter(
      (c) => c.jira_created != null && c.jira_created <= b.end && (c.jira_resolved == null || c.jira_resolved > b.end),
    ).length,
  }))

  const titleOf = (_: unknown, payload: readonly { payload?: Bucket }[]) => payload[0]?.payload?.title ?? ''
  const axisLabel = (value: string) => ({
    value,
    angle: -90,
    position: 'insideLeft' as const,
    style: { fontSize: 12, fill: 'var(--text-muted)' },
  })

  return (
    <>
      <div className="card">
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 8 }}>
          <h3 style={{ marginBottom: 0 }}>Aperti e chiusi nel tempo</h3>
          <div className="filter-group">
            <span className="filter-group-label">Raggruppa per</span>
            {GRANULARITIES.map((g) => (
              <button
                key={g.value}
                className={`btn filter-btn${granularity === g.value ? ' active' : ''}`}
                aria-pressed={granularity === g.value}
                onClick={() => setGranularity(g.value)}
              >
                {g.label}
              </button>
            ))}
          </div>
        </div>
        <p className="muted" style={{ marginTop: 8, marginBottom: 12 }}>
          Complaint creati su Jira e complaint chiusi (passati a Done o Rejected), {current.description}.
        </p>
        <div style={{ height: 300 }}>
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={rows} margin={{ top: 8, right: 16, left: 8, bottom: 8 }} barGap={2}>
              <CartesianGrid strokeDasharray="3 3" vertical={false} />
              <XAxis dataKey="label" tick={{ fontSize: 12 }} />
              <YAxis allowDecimals={false} tick={{ fontSize: 12 }} label={axisLabel('Complaint')} />
              <Tooltip
                contentStyle={TOOLTIP_STYLE}
                itemStyle={TOOLTIP_ITEM_STYLE}
                labelFormatter={titleOf}
                cursor={{ fill: 'var(--border)', fillOpacity: 0.4 }}
              />
              <Legend wrapperStyle={{ fontSize: 12 }} />
              {/* stackId anche qui: senza, recharts disegna la barra dopo quelle impilate. */}
              <Bar dataKey="opened" name="Aperti" stackId="opened" fill={COLORS.opened} />
              <Bar dataKey="done" name="Chiusi (Done)" stackId="closed" fill={COLORS.done} />
              <Bar dataKey="rejected" name="Chiusi (Rejected)" stackId="closed" fill={COLORS.rejected} />
            </BarChart>
          </ResponsiveContainer>
        </div>
      </div>

      <div className="card">
        <h3>Complaint ancora aperti</h3>
        <p className="muted" style={{ marginTop: 8, marginBottom: 12 }}>
          Quanti complaint risultavano non ancora chiusi alla fine di ogni periodo ({current.description}): sale quando
          se ne aprono più di quanti se ne chiudono.
        </p>
        <div style={{ height: 260 }}>
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={rows} margin={{ top: 8, right: 16, left: 8, bottom: 8 }}>
              <CartesianGrid strokeDasharray="3 3" vertical={false} />
              <XAxis dataKey="label" tick={{ fontSize: 12 }} />
              <YAxis allowDecimals={false} tick={{ fontSize: 12 }} label={axisLabel('Complaint aperti')} />
              <Tooltip contentStyle={TOOLTIP_STYLE} itemStyle={TOOLTIP_ITEM_STYLE} labelFormatter={titleOf} />
              <Line
                type="linear"
                dataKey="open"
                name="Ancora aperti"
                stroke={COLORS.open}
                strokeWidth={2}
                dot={{ r: 3, fill: COLORS.open }}
              />
            </LineChart>
          </ResponsiveContainer>
        </div>
      </div>
    </>
  )
}

// Complaint ancora aperti divisi per architettura: dove si concentra il
// lavoro residuo. Un complaint con due label di architettura conta in entrambe.
function OpenByArchitecture({ complaints, hidden }: { complaints: Complaint[]; hidden: Set<string> }) {
  const open = complaints.filter((c) => c.jira_resolved == null)
  const counts = new Map<string, number>()
  for (const c of open) for (const a of architecturesOf(c)) counts.set(a, (counts.get(a) ?? 0) + 1)
  // Le architetture escluse dal filtro non compaiono, nemmeno per i complaint
  // con due label rimasti visibili grazie all'altra.
  const rows = [...ARCHITECTURES, NO_ARCHITECTURE]
    .filter((a) => !hidden.has(a) && (a !== NO_ARCHITECTURE || counts.has(a)))
    .map((a) => ({ architecture: a, count: counts.get(a) ?? 0 }))

  return (
    <div className="card">
      <h3>Ancora aperti per architettura</h3>
      <p className="muted" style={{ marginTop: 8, marginBottom: 12 }}>
        I {open.length} complaint non ancora chiusi, per architettura ({NO_ARCHITECTURE} = nessuna label di architettura).
      </p>
      <div style={{ height: 44 * rows.length + 40 }}>
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={rows} layout="vertical" margin={{ top: 8, right: 32, left: 8, bottom: 8 }}>
            <CartesianGrid strokeDasharray="3 3" horizontal={false} />
            <XAxis type="number" allowDecimals={false} tick={{ fontSize: 12 }} />
            <YAxis type="category" dataKey="architecture" tick={{ fontSize: 12 }} width={60} />
            <Tooltip
              contentStyle={TOOLTIP_STYLE}
              itemStyle={TOOLTIP_ITEM_STYLE}
              cursor={{ fill: 'var(--border)', fillOpacity: 0.4 }}
            />
            <Bar
              dataKey="count"
              name="Ancora aperti"
              fill={COLORS.open}
              barSize={20}
              label={{ position: 'right', fontSize: 12, fill: 'var(--text)' }}
            />
          </BarChart>
        </ResponsiveContainer>
      </div>
    </div>
  )
}

export function ComplaintsKpiPage() {
  const { data: complaints, isLoading } = useQuery({ queryKey: ['complaints'], queryFn: api.complaints.list })
  const all = complaints ?? []
  const today = new Date()
  // Architetture escluse dai KPI: vuoto = si vede tutto. Al contrario dei
  // filtri dell'Elenco, qui i pulsanti partono tutti attivi e si spengono.
  const [hidden, setHidden] = useState<Set<string>>(new Set())

  if (isLoading) return <p className="muted">Caricamento...</p>
  if (all.length === 0) {
    return (
      <div className="card">
        <p className="muted" style={{ margin: 0 }}>
          Nessun complaint: premi "Sincronizza da Jira" per caricarli.
        </p>
      </div>
    )
  }

  // La data di chiusura arriva da Jira con la sync: finche' non se ne fa una
  // dopo l'aggiornamento, tutti i complaint risulterebbero ancora aperti.
  const missingClosingDates = all.every((c) => c.jira_resolved == null)

  const architectureCounts = new Map<string, number>()
  for (const c of all) for (const a of architecturesOf(c)) architectureCounts.set(a, (architectureCounts.get(a) ?? 0) + 1)
  const architectureOptions = architectureCounts.has(NO_ARCHITECTURE) ? [...ARCHITECTURES, NO_ARCHITECTURE] : ARCHITECTURES
  // Un complaint con due label di architettura resta finche' almeno una e' attiva.
  const visible = hidden.size === 0 ? all : all.filter((c) => architecturesOf(c).some((a) => !hidden.has(a)))
  const toggle = (architecture: string) =>
    setHidden((current) => {
      const next = new Set(current)
      if (!next.delete(architecture)) next.add(architecture)
      return next
    })

  return (
    <div>
      {missingClosingDates && (
        <div className="error-banner">
          Date di chiusura non ancora caricate: premi "Sincronizza da Jira" per avere i KPI sui complaint chiusi (per ora
          risultano tutti aperti).
        </div>
      )}
      <div className="filter-bar" style={{ alignItems: 'center', marginBottom: 16 }}>
        <div className="filter-group">
          <span className="filter-group-label">Architettura</span>
          {architectureOptions.map((a) => (
            <button
              key={a}
              className={`btn filter-btn${hidden.has(a) ? '' : ' active'}`}
              aria-pressed={!hidden.has(a)}
              title={hidden.has(a) ? `Includi ${a} nei KPI` : `Escludi ${a} dai KPI`}
              onClick={() => toggle(a)}
            >
              {a} <span className="muted">{architectureCounts.get(a) ?? 0}</span>
            </button>
          ))}
        </div>
        <span className="muted" style={{ fontSize: 13 }}>
          {visible.length} di {all.length} complaint
          {hidden.size > 0 && (
            <>
              {' · '}
              <button className="link-btn" onClick={() => setHidden(new Set())}>
                Mostra tutte
              </button>
            </>
          )}
        </span>
      </div>
      {visible.length === 0 ? (
        <div className="card">
          <p className="muted" style={{ margin: 0 }}>
            Nessuna architettura selezionata: attivane almeno una per vedere i KPI.
          </p>
        </div>
      ) : (
        <>
          <PeriodStats complaints={visible} today={today} />
          <TrendCharts complaints={visible} today={today} />
          <OpenByArchitecture complaints={visible} hidden={hidden} />
        </>
      )}
    </div>
  )
}
