import { Fragment, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link } from 'react-router-dom'
import { api } from '../../api/client'
import type { CveIssue } from '../../api/types'
import { SyncProgressModal } from '../../components/SyncProgressModal'
import { useAuth } from '../../components/authContext'
import { formatDateTime, formatIsoDate } from '../../lib/dates'
import { CveComponentPie } from './CveComponentPie'
import { CveDeadlineChart } from './CveDeadlineChart'
import { CVE_URGENCY, cveDueDate, cveScore, cveTier, cveUrgency, formatDay, today } from '../../lib/cveDeadlines'

// Tool CVE: i bug Jira di sicurezza della JQL del tool (di default quelli
// aperti dalla pipeline delle vulnerabilita'), salvati dal backend
// (routers/tools_cve.py). Solo lettura: niente viene modificato in Jira.

const JIRA_BROWSE = 'https://inpeco.atlassian.net/browse/'
const NVD_DETAIL = 'https://nvd.nist.gov/vuln/detail/'
// Righe mostrate prima di "Mostra altre": con oltre mille bug la tabella
// intera rallenterebbe la pagina a ogni filtro.
const PAGE_SIZE = 200
// Ordinamento per urgenza acceso/spento: ricordato per browser.
const URGENCY_STORAGE_KEY = 'cve-sort-urgency-v1'

// Per urgenza: fascia, poi scadenza piu' vicina, poi CVSS piu' alto.
function compareUrgency(a: CveIssue, b: CveIssue): number {
  const ua = cveUrgency(a)
  const ub = cveUrgency(b)
  if (ua !== ub) return ua - ub
  const da = cveDueDate(a)?.getTime() ?? Infinity
  const db = cveDueDate(b)?.getTime() ?? Infinity
  if (da !== db) return da < db ? -1 : 1
  return (cveScore(b) ?? -1) - (cveScore(a) ?? -1) || keyNumber(b.jira_key) - keyNumber(a.jira_key)
}

const SEVERITY_RANK: Record<string, number> = { Critical: 4, High: 3, Medium: 2, Low: 1 }

function statusClass(c: CveIssue): string {
  if ((c.status ?? '').toLowerCase() === 'rejected') return 'cve-rejected'
  if (c.status_category === 'done') return 'done'
  if (c.status_category === 'indeterminate') return 'progress'
  return 'todo'
}

// Colore del punteggio CVSS secondo le fasce standard (v3).
function cvssClass(score: number | null): string {
  if (score == null) return ''
  if (score >= 9) return 'cve-critical'
  if (score >= 7) return 'cve-high'
  if (score >= 4) return 'cve-medium'
  return 'cve-low'
}

const searchable = (c: CveIssue) =>
  [c.jira_key, c.summary, c.package, c.assignee, c.discovered_in, ...c.cve_ids, ...c.fix_versions, ...c.components]
    .filter(Boolean)
    .join(' ')
    .toLowerCase()

type SortKey = 'key' | 'created' | 'cvss_base' | 'cvss_inpeco' | 'severity' | 'status' | 'package' | 'component' | 'due'
type Sort = { key: SortKey; desc: boolean }

const keyNumber = (key: string) => Number(key.split('-').pop()) || 0

function compare(a: CveIssue, b: CveIssue, key: SortKey): number {
  switch (key) {
    case 'key':
      return keyNumber(a.jira_key) - keyNumber(b.jira_key)
    case 'created':
      return (a.created ?? '').localeCompare(b.created ?? '') || keyNumber(a.jira_key) - keyNumber(b.jira_key)
    case 'cvss_base':
      return (a.cvss_base ?? -1) - (b.cvss_base ?? -1)
    case 'cvss_inpeco':
      return (a.cvss_inpeco ?? -1) - (b.cvss_inpeco ?? -1)
    case 'severity':
      return (SEVERITY_RANK[a.severity ?? ''] ?? 0) - (SEVERITY_RANK[b.severity ?? ''] ?? 0)
    case 'status':
      return (a.status ?? '').localeCompare(b.status ?? '')
    case 'package':
      return (a.package ?? '').localeCompare(b.package ?? '')
    case 'component':
      return (a.components[0] ?? '').localeCompare(b.components[0] ?? '')
    case 'due': {
      // Senza scadenza in fondo (anche ordinando al contrario resta l'ultima
      // cosa a cui guardare): Infinity sopra a ogni data.
      const da = cveDueDate(a)?.getTime() ?? Infinity
      const db = cveDueDate(b)?.getTime() ?? Infinity
      return da === db ? 0 : da < db ? -1 : 1
    }
  }
}

const countBy = (items: CveIssue[], value: (c: CveIssue) => string) => {
  const counts = new Map<string, number>()
  for (const c of items) counts.set(value(c), (counts.get(value(c)) ?? 0) + 1)
  return [...counts.entries()].sort((a, b) => b[1] - a[1])
}

function toggled(set: Set<string>, value: string): Set<string> {
  const next = new Set(set)
  if (!next.delete(value)) next.add(value)
  return next
}

export function CvePage() {
  const { can } = useAuth()
  const queryClient = useQueryClient()
  const { data: cves, isLoading, error } = useQuery({ queryKey: ['cve-issues'], queryFn: api.tools.cve.list })
  const sync = useMutation({
    mutationFn: api.tools.cve.sync,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['cve-issues'] }),
  })
  const [jqlOpen, setJqlOpen] = useState(false)
  const [search, setSearch] = useState('')
  // Stati e severity nascosti (pulsante spento): vuoto = si vedono tutti.
  const [hiddenStatuses, setHiddenStatuses] = useState<Set<string>>(new Set())
  const [hiddenSeverities, setHiddenSeverities] = useState<Set<string>>(new Set())
  const [minCvss, setMinCvss] = useState(0)
  const [discoveredIn, setDiscoveredIn] = useState('')
  const [fixVersion, setFixVersion] = useState<'' | 'with' | 'without'>('')
  const [sort, setSort] = useState<Sort>({ key: 'created', desc: true })
  const [byUrgency, setByUrgency] = useState<boolean>(() => {
    try {
      return localStorage.getItem(URGENCY_STORAGE_KEY) === '1'
    } catch {
      return false
    }
  })
  const toggleUrgency = (on: boolean) => {
    setByUrgency(on)
    try {
      localStorage.setItem(URGENCY_STORAGE_KEY, on ? '1' : '0')
    } catch {
      // ignora: e' solo una comodita' per-browser
    }
  }
  const [shown, setShown] = useState(PAGE_SIZE)

  const all = cves ?? []
  const words = search.trim().toLowerCase().split(/[\s,]+/).filter(Boolean)
  const visible = all
    .filter(
      (c) =>
        !hiddenStatuses.has(c.status ?? '-') &&
        !hiddenSeverities.has(c.severity ?? '-') &&
        (minCvss === 0 || (c.cvss_inpeco ?? c.cvss_base ?? 0) >= minCvss) &&
        (!discoveredIn || c.discovered_in === discoveredIn) &&
        (fixVersion === '' || (fixVersion === 'with') === c.fix_versions.length > 0) &&
        words.every((w) => searchable(c).includes(w)),
    )
    .sort((a, b) => (byUrgency ? compareUrgency(a, b) : (sort.desc ? -1 : 1) * compare(a, b, sort.key)))
  const lastSync = all.reduce<string | null>(
    (latest, c) => (c.synced_at && (!latest || c.synced_at > latest) ? c.synced_at : latest),
    null,
  )
  const statusCounts = countBy(all, (c) => c.status ?? '-')
  const severityCounts = countBy(all, (c) => c.severity ?? '-').sort(
    (a, b) => (SEVERITY_RANK[b[0]] ?? 0) - (SEVERITY_RANK[a[0]] ?? 0),
  )
  const discoveredOptions = countBy(all, (c) => c.discovered_in ?? '')
    .filter(([v]) => v)
    .sort((a, b) => a[0].localeCompare(b[0]))
  const open = visible.filter((c) => c.status_category !== 'done')
  const criticalOpen = open.filter((c) => (c.cvss_inpeco ?? c.cvss_base ?? 0) >= 9).length
  const highOpen = open.filter((c) => {
    const score = c.cvss_inpeco ?? c.cvss_base ?? 0
    return score >= 7 && score < 9
  }).length
  const filtered =
    hiddenStatuses.size > 0 || hiddenSeverities.size > 0 || minCvss > 0 || !!discoveredIn || !!fixVersion || words.length > 0

  // Clic su un'intestazione: ordina su quella colonna e spegne l'ordinamento
  // per urgenza (al primo clic non inverte, riparte dal verso di default).
  const sortBy = (key: SortKey) => {
    if (byUrgency) {
      toggleUrgency(false)
      setSort({ key, desc: true })
      return
    }
    setSort((s) => (s.key === key ? { key, desc: !s.desc } : { key, desc: true }))
  }
  const header = (key: SortKey, label: string, title?: string) => (
    <th
      className="sortable"
      onClick={() => sortBy(key)}
      title={title}
      aria-sort={!byUrgency && sort.key === key ? (sort.desc ? 'descending' : 'ascending') : undefined}
    >
      {label}
      {!byUrgency && sort.key === key && (sort.desc ? ' ▾' : ' ▴')}
    </th>
  )
  const urgencyCounts = byUrgency ? visible.reduce<number[]>((acc, c) => {
    acc[cveUrgency(c)] += 1
    return acc
  }, CVE_URGENCY.map(() => 0)) : []
  const COLUMN_COUNT = 14
  const resetFilters = () => {
    setSearch('')
    setHiddenStatuses(new Set())
    setHiddenSeverities(new Set())
    setMinCvss(0)
    setDiscoveredIn('')
    setFixVersion('')
  }

  return (
    <div>
      <div className="page-header">
        <div>
          <div className="sub">
            <Link to="/tools">Tools</Link> ›
          </div>
          <h1>🛡️ CVE</h1>
          <div className="sub">
            Bug di sicurezza da Jira · Ultima sync: {lastSync ? formatDateTime(lastSync) : 'mai'} ·{' '}
            <button className="link-btn" aria-expanded={jqlOpen} onClick={() => setJqlOpen((o) => !o)}>
              JQL {jqlOpen ? '▴' : '▾'}
            </button>
          </div>
        </div>
        {can('editor') && (
          <button className="btn btn-primary" onClick={() => sync.mutate()} disabled={sync.isPending}>
            {sync.isPending ? 'Sincronizzazione...' : '⟳ Sincronizza da Jira'}
          </button>
        )}
      </div>

      {jqlOpen && <JqlSettings />}

      {sync.isPending && (
        <SyncProgressModal title="CVE da Jira" queryKey={['cve-sync-progress']} fetchProgress={api.tools.cve.syncProgress} />
      )}
      {sync.isError && <div className="error-banner">{(sync.error as Error).message}</div>}
      {sync.isSuccess && (
        <p className="muted" style={{ marginTop: 0 }}>
          Lette {sync.data.total} issue: {sync.data.created} nuove, {sync.data.updated} aggiornate
          {sync.data.removed > 0 && `, ${sync.data.removed} rimosse (non più nella JQL)`}.
        </p>
      )}
      {error && <div className="error-banner">{(error as Error).message}</div>}

      {all.length > 0 && (
        <div className="cve-stats">
          <div className="cve-stat">
            <span className="cve-stat-value">{visible.length}</span>
            <span className="muted">{filtered ? `di ${all.length} bug` : 'bug'}</span>
          </div>
          <div className="cve-stat">
            <span className="cve-stat-value">{open.length}</span>
            <span className="muted">non chiusi</span>
          </div>
          <div className="cve-stat" title="Non chiusi con CVSS ≥ 9 (punteggio Inpeco, o base se manca)">
            <span className="cve-stat-value cve-critical">{criticalOpen}</span>
            <span className="muted">critici aperti</span>
          </div>
          <div className="cve-stat" title="Non chiusi con CVSS tra 7 e 8,9 (punteggio Inpeco, o base se manca)">
            <span className="cve-stat-value cve-high">{highOpen}</span>
            <span className="muted">alti aperti</span>
          </div>
        </div>
      )}

      {all.length > 0 && (
        <div className="cve-charts">
          <CveComponentPie all={all} visible={visible} />
          <CveDeadlineChart visible={visible} />
        </div>
      )}

      <div className="card">
        <div className="cert-toolbar">
          <input
            type="search"
            placeholder="Cerca CVE, chiave Jira, pacchetto, testo…"
            value={search}
            onChange={(e) => {
              setSearch(e.target.value)
              setShown(PAGE_SIZE)
            }}
            aria-label="Cerca nelle CVE"
          />
          <div className="filter-group">
            <span className="filter-group-label">Stato</span>
            {statusCounts.map(([status, count]) => (
              <button
                key={status}
                type="button"
                className={`btn filter-btn${hiddenStatuses.has(status) ? '' : ' active'}`}
                aria-pressed={!hiddenStatuses.has(status)}
                onClick={() => setHiddenStatuses((s) => toggled(s, status))}
              >
                {status} <span className="muted">{count}</span>
              </button>
            ))}
          </div>
          <div className="filter-group">
            <span className="filter-group-label">Severity</span>
            {severityCounts.map(([severity, count]) => (
              <button
                key={severity}
                type="button"
                className={`btn filter-btn${hiddenSeverities.has(severity) ? '' : ' active'}`}
                aria-pressed={!hiddenSeverities.has(severity)}
                onClick={() => setHiddenSeverities((s) => toggled(s, severity))}
              >
                {severity} <span className="muted">{count}</span>
              </button>
            ))}
          </div>
          <label className="cve-select" title="Punteggio CVSS Inpeco (o base se manca)">
            CVSS
            <select value={minCvss} onChange={(e) => setMinCvss(Number(e.target.value))}>
              <option value={0}>tutti</option>
              <option value={4}>≥ 4 (medio)</option>
              <option value={7}>≥ 7 (alto)</option>
              <option value={9}>≥ 9 (critico)</option>
            </select>
          </label>
          <label className="cve-select">
            Discovered in
            <select value={discoveredIn} onChange={(e) => setDiscoveredIn(e.target.value)}>
              <option value="">tutte</option>
              {discoveredOptions.map(([v, n]) => (
                <option key={v} value={v}>
                  {v} ({n})
                </option>
              ))}
            </select>
          </label>
          <label className="cve-select">
            Fix version
            <select value={fixVersion} onChange={(e) => setFixVersion(e.target.value as '' | 'with' | 'without')}>
              <option value="">tutte</option>
              <option value="with">con fix version</option>
              <option value="without">senza fix version</option>
            </select>
          </label>
          <label
            className="cve-select cve-urgency-toggle"
            title="Raggruppa le righe per urgenza di risoluzione (scadute, entro 30 giorni, oltre, da pianificare, senza scadenza), ognuna col suo colore; dentro ogni gruppo prima la scadenza più vicina"
          >
            <input type="checkbox" checked={byUrgency} onChange={(e) => toggleUrgency(e.target.checked)} />
            ⚡ Ordina per urgenza
          </label>
          {filtered && (
            <button className="link-btn" onClick={resetFilters}>
              Azzera filtri
            </button>
          )}
        </div>

        {isLoading ? (
          <p className="muted">Caricamento…</p>
        ) : all.length === 0 ? (
          <p className="muted">
            Nessuna CVE salvata: premi <b>⟳ Sincronizza da Jira</b> per leggerle con la JQL del tool (la vedi e la
            modifichi da <b>JQL ▾</b> qui sopra).
          </p>
        ) : (
          <>
            <div className="table-wrap">
              <table className="cert-table cve-table">
                <thead>
                  <tr>
                    {header('key', 'Jira')}
                    <th>CVE</th>
                    <th>Summary</th>
                    {header('package', 'Pacchetto')}
                    {header('component', 'Component')}
                    {header('status', 'Stato')}
                    {header('severity', 'Severity')}
                    {header('cvss_base', 'CVSS base', 'CVSS v.3 Score - base')}
                    {header('cvss_inpeco', 'CVSS Inpeco', 'CVSS v.3 Score – Inpeco use')}
                    <th>Discovered in</th>
                    <th>Fix version</th>
                    {header('created', 'Creato')}
                    {header(
                      'due',
                      'Scadenza',
                      'Confirmed: dalla data di conferma, CVSS Inpeco ≥ 9 entro 4 settimane, > 7 e < 9 entro 24 settimane, le altre da pianificare',
                    )}
                    <th>Chiuso</th>
                  </tr>
                </thead>
                <tbody>
                  {visible.slice(0, shown).map((c, index, page) => {
                    const urgency = cveUrgency(c)
                    const group = CVE_URGENCY[urgency]
                    const newGroup = byUrgency && (index === 0 || cveUrgency(page[index - 1]) !== urgency)
                    return (
                    <Fragment key={c.id}>
                    {newGroup && (
                      <tr className={`cve-group-row cve-row-${group.key}`}>
                        <td colSpan={COLUMN_COUNT}>
                          {urgency === 0 && '⚠ '}
                          {group.label} <span className="muted">· {urgencyCounts[urgency]}</span>
                        </td>
                      </tr>
                    )}
                    <tr className={byUrgency ? `cve-row-${group.key}` : undefined}>
                      <td className="nowrap">
                        <a href={`${JIRA_BROWSE}${c.jira_key}`} target="_blank" rel="noreferrer">
                          {c.jira_key}
                        </a>
                      </td>
                      <td className="nowrap">
                        {c.cve_ids.length === 0 ? (
                          <span className="muted">-</span>
                        ) : (
                          c.cve_ids.map((id) => (
                            <div key={id}>
                              <a href={`${NVD_DETAIL}${id}`} target="_blank" rel="noreferrer" title={`${id} su NVD`}>
                                {id}
                              </a>
                            </div>
                          ))
                        )}
                      </td>
                      <td>
                        <span className="cert-clamp cve-summary" title={c.summary ?? ''}>
                          {(c.summary ?? '').replace(/^\s*(\[[^\]]*CVE[^\]]*\]\s*)+/i, '') || '-'}
                        </span>
                      </td>
                      <td>{c.package ?? <span className="muted">-</span>}</td>
                      <td>
                        {c.components.length ? (
                          c.components.map((name) => <div key={name}>{name}</div>)
                        ) : (
                          <span className="muted">-</span>
                        )}
                      </td>
                      <td className="nowrap">
                        {c.status && (
                          <span
                            className={`badge ${statusClass(c)}`}
                            title={c.rejection_reason ? `Motivo: ${c.rejection_reason}` : undefined}
                          >
                            {c.status}
                          </span>
                        )}
                      </td>
                      <td>{c.severity ?? <span className="muted">-</span>}</td>
                      <td className={`num ${cvssClass(c.cvss_base)}`}>{c.cvss_base?.toLocaleString('it-IT') ?? '-'}</td>
                      <td className={`num ${cvssClass(c.cvss_inpeco)}`}>{c.cvss_inpeco?.toLocaleString('it-IT') ?? '-'}</td>
                      <td className="nowrap">{c.discovered_in ?? <span className="muted">-</span>}</td>
                      <td>
                        {c.fix_versions.length ? (
                          c.fix_versions.map((v) => <div key={v}>{v}</div>)
                        ) : (
                          <span className="muted">-</span>
                        )}
                      </td>
                      <td className="nowrap">{formatIsoDate(c.created) ?? '-'}</td>
                      <td className="nowrap">
                        <DueCell cve={c} />
                      </td>
                      <td className="nowrap">{formatIsoDate(c.resolved) ?? <span className="muted">-</span>}</td>
                    </tr>
                    </Fragment>
                    )
                  })}
                </tbody>
              </table>
            </div>
            {visible.length > shown && (
              <p style={{ textAlign: 'center' }}>
                <span className="muted">
                  Mostrate {shown} di {visible.length}.{' '}
                </span>
                <button className="btn" onClick={() => setShown((n) => n + PAGE_SIZE)}>
                  Mostra altre {Math.min(PAGE_SIZE, visible.length - shown)}
                </button>{' '}
                <button className="link-btn" onClick={() => setShown(visible.length)}>
                  mostra tutte
                </button>
              </p>
            )}
          </>
        )}
      </div>
    </div>
  )
}

function JqlSettings() {
  const { can } = useAuth()
  const queryClient = useQueryClient()
  const { data: settings } = useQuery({ queryKey: ['cve-settings'], queryFn: api.tools.cve.getSettings })
  const [draft, setDraft] = useState<string | null>(null)
  const save = useMutation({
    mutationFn: (jql: string) => api.tools.cve.updateSettings({ jql }),
    onSuccess: (saved) => {
      queryClient.setQueryData(['cve-settings'], saved)
      setDraft(null)
    },
  })
  if (!settings) return null
  const value = draft ?? settings.jql
  const dirty = draft !== null && draft.trim() !== settings.jql

  return (
    <div className="card form-row" style={{ marginBottom: 12 }}>
      <label>JQL delle CVE (le issue Jira da leggere)</label>
      <div style={{ display: 'flex', gap: 8, alignItems: 'flex-start' }}>
        <textarea
          rows={2}
          style={{ flex: 1 }}
          value={value}
          readOnly={!can('editor')}
          onChange={(e) => setDraft(e.target.value)}
        />
        {can('editor') && (
          <button className="btn" disabled={!dirty || save.isPending} onClick={() => save.mutate(value)}>
            {save.isPending ? 'Salvataggio...' : 'Salva JQL'}
          </button>
        )}
      </div>
      <span className="muted" style={{ fontSize: 12 }}>
        {dirty
          ? 'JQL modificata e non ancora salvata: la sincronizzazione usa quella salvata.'
          : settings.is_default
            ? 'JQL predefinita. Svuotala e salva per tornare a questa dopo una modifica.'
            : 'JQL personalizzata: svuotala e salva per tornare a quella predefinita.'}{' '}
        Dopo il salvataggio premi ⟳ Sincronizza da Jira: le issue non più nella JQL vengono tolte dall'elenco.
      </span>
      {save.isError && <div className="error-banner">{(save.error as Error).message}</div>}
    </div>
  )
}

function DueCell({ cve: c }: { cve: CveIssue }) {
  const tier = cveTier(c)
  if (!tier) return <span className="muted">-</span>
  if (tier === 'plan') return <span className="muted">da pianificare</span>
  const due = cveDueDate(c)
  if (!due) return <span className="muted" title="Data di conferma mancante: risincronizza">?</span>
  const days = Math.round((due.getTime() - today().getTime()) / 86400000)
  const title = `Confermata il ${c.confirmed_at ? formatDateTime(c.confirmed_at) : '-'}; ${
    days < 0 ? `scaduta da ${-days} giorni` : days === 0 ? 'scade oggi' : `mancano ${days} giorni`
  }`
  return (
    <span className={days < 0 ? 'cve-overdue' : days <= 30 ? 'cve-due-soon' : undefined} title={title}>
      {days < 0 && '⚠ '}
      {formatDay(due)}
    </span>
  )
}
