import { Fragment, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link } from 'react-router-dom'
import { api } from '../../api/client'
import type { Enhancement, EnhancementsSettings, Project } from '../../api/types'
import { SyncProgressModal } from '../../components/SyncProgressModal'
import { useAuth } from '../../components/authContext'
import { formatDateTime, formatIsoDate, parseBackendDateTime } from '../../lib/dates'

// Tool Enhancements: gli Enhancement (Opportunity) di una list view
// Salesforce (di default "Enhancement ProTube"; il link e' un'impostazione
// personale), letti col browser dell'app (vedi
// backend/app/services/tools/enhancements.py), con il loro corrispettivo su
// Jira: l'ID Jira arriva da un campo Salesforce che verra' aggiunto e si
// cerca nel backlog degli increment.

const JIRA_BROWSE = 'https://inpeco.atlassian.net/browse/'

// Colore dello stage: chiusi in verde, pianificati/in sviluppo in arancione.
function stageClass(e: Enhancement): string {
  if (e.is_closed) return 'done'
  const s = (e.stage ?? '').toLowerCase()
  if (/planned|develop|progress|release|test/.test(s)) return 'progress'
  return 'todo'
}

type JiraFilter = 'all' | 'missing' | 'linked' | 'outside'

const JIRA_FILTERS: { value: JiraFilter; label: string; title: string }[] = [
  { value: 'all', label: 'Tutti', title: 'Tutti gli enhancement' },
  { value: 'missing', label: 'Senza Jira', title: 'Enhancement senza ID Jira in Salesforce' },
  { value: 'outside', label: 'Jira fuori backlog', title: "Con ID Jira, ma la issue non è nel backlog di nessun tuo increment" },
  { value: 'linked', label: 'In un increment', title: 'Con ID Jira nel backlog di un tuo increment' },
]

function jiraState(e: Enhancement): Exclude<JiraFilter, 'all'> {
  if (e.jira.length === 0) return 'missing'
  return e.jira.some((j) => j.increment_id != null) ? 'linked' : 'outside'
}

const searchable = (e: Enhancement) =>
  [
    e.request_id,
    e.name,
    e.stage,
    e.priority,
    e.enhancement_type,
    e.source,
    e.target_release,
    e.short_description,
    e.accounts,
    e.cases,
    e.sf_owner,
    e.created_by,
    e.jira_key,
    e.increment_code,
    ...e.jira.map((j) => j.increment_code),
    ...e.jira.map((j) => j.jira_status),
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase()

export function EnhancementsPage() {
  const { can } = useAuth()
  const queryClient = useQueryClient()
  const { data: enhancements, isLoading, error } = useQuery({
    queryKey: ['enhancements'],
    queryFn: api.tools.enhancements.list,
  })
  const { data: settings } = useQuery({
    queryKey: ['enhancements-settings'],
    queryFn: api.tools.enhancements.getSettings,
  })
  const [settingsOpen, setSettingsOpen] = useState(false)
  const sync = useMutation({
    mutationFn: api.tools.enhancements.sync,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['enhancements'] })
      queryClient.invalidateQueries({ queryKey: ['enhancements-settings'] })
    },
  })
  const { data: increments } = useQuery({ queryKey: ['projects'], queryFn: api.projects.list })
  const setIncrement = useMutation({
    mutationFn: ({ id, incrementId }: { id: number; incrementId: number | null }) =>
      api.tools.enhancements.setIncrement(id, incrementId),
    onSuccess: (saved) =>
      queryClient.setQueryData<Enhancement[]>(['enhancements'], (old) => old?.map((e) => (e.id === saved.id ? saved : e))),
  })
  const [hiddenStages, setHiddenStages] = useState<Set<string>>(new Set())
  const [jiraFilter, setJiraFilter] = useState<JiraFilter>('all')
  // Filtro per increment associato: tutti, nessuno o uno in particolare.
  const [incrementFilter, setIncrementFilter] = useState<'all' | 'none' | number>('all')
  const [search, setSearch] = useState('')
  const [open, setOpen] = useState<Set<number>>(new Set())

  const all = enhancements ?? []
  const stageCounts = new Map<string, number>()
  for (const e of all) stageCounts.set(e.stage ?? '-', (stageCounts.get(e.stage ?? '-') ?? 0) + 1)
  const stages = [...stageCounts.entries()].sort(([a], [b]) => a.localeCompare(b))
  const jiraCounts = { all: all.length, missing: 0, outside: 0, linked: 0 }
  for (const e of all) jiraCounts[jiraState(e)] += 1
  // Increment con almeno un enhancement associato (piu' quello scelto nel
  // filtro, anche se nel frattempo e' rimasto vuoto), in ordine di codice.
  const incrementCounts = new Map<number, { code: string; count: number }>()
  for (const e of all) {
    if (e.increment_id == null) continue
    const entry = incrementCounts.get(e.increment_id) ?? { code: e.increment_code ?? String(e.increment_id), count: 0 }
    entry.count += 1
    incrementCounts.set(e.increment_id, entry)
  }
  if (typeof incrementFilter === 'number' && !incrementCounts.has(incrementFilter)) {
    const code = increments?.find((p) => p.id === incrementFilter)?.code ?? String(incrementFilter)
    incrementCounts.set(incrementFilter, { code, count: 0 })
  }
  const incrementOptions = [...incrementCounts.entries()].sort(([, a], [, b]) => a.code.localeCompare(b.code))
  const withoutIncrement = all.filter((e) => e.increment_id == null).length
  const words = search.trim().toLowerCase().split(/\s+/).filter(Boolean)
  const visible = all.filter(
    (e) =>
      !hiddenStages.has(e.stage ?? '-') &&
      (jiraFilter === 'all' || jiraState(e) === jiraFilter) &&
      (incrementFilter === 'all' ||
        (incrementFilter === 'none' ? e.increment_id == null : e.increment_id === incrementFilter)) &&
      words.every((w) => searchable(e).includes(w)),
  )
  const lastSync = all.reduce<string | null>(
    (latest, e) => (e.synced_at && (!latest || e.synced_at > latest) ? e.synced_at : latest),
    null,
  )
  const toggle = <T,>(set: Set<T>, value: T, apply: (s: Set<T>) => void) => {
    const next = new Set(set)
    if (next.has(value)) next.delete(value)
    else next.add(value)
    apply(next)
  }
  const dash = <span className="muted">-</span>

  return (
    <div>
      <div className="page-header">
        <div>
          <div className="sub">
            <Link to="/tools">Tools</Link> ›
          </div>
          <h1>💡 Enhancements</h1>
          <div className="sub">
            Enhancement della{' '}
            {settings ? (
              <a href={settings.list_url} target="_blank" rel="noreferrer">
                list view Salesforce
              </a>
            ) : (
              'list view Salesforce'
            )}{' '}
            · Ultimo aggiornamento: {lastSync ? formatDateTime(lastSync) : 'mai'}
          </div>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button
            className="btn"
            aria-expanded={settingsOpen}
            title="Link alla list view Salesforce degli enhancement"
            onClick={() => setSettingsOpen((v) => !v)}
          >
            ⚙ Link Salesforce
          </button>
          {can('editor') && (
            <button className="btn btn-primary" onClick={() => sync.mutate()} disabled={sync.isPending}>
              {sync.isPending ? 'Lettura...' : '⟳ Aggiorna da Salesforce'}
            </button>
          )}
        </div>
      </div>

      {settingsOpen && settings && <LinkSettings settings={settings} onClose={() => setSettingsOpen(false)} />}

      {sync.isPending && (
        <SyncProgressModal
          title="Enhancement Salesforce"
          queryKey={['enhancements-progress']}
          fetchProgress={api.tools.enhancements.syncProgress}
        />
      )}
      {sync.isError && <div className="error-banner">{(sync.error as Error).message}</div>}
      {setIncrement.isError && (
        <div className="error-banner">Associazione non salvata: {(setIncrement.error as Error).message}</div>
      )}
      {sync.isSuccess && (
        <p className="muted" style={{ marginTop: 0 }}>
          Letti {sync.data.total} enhancement{sync.data.view && ` dalla vista "${sync.data.view}"`}: {sync.data.created}{' '}
          nuovi, {sync.data.updated} aggiornati
          {sync.data.removed > 0 && `, ${sync.data.removed} rimossi (non più nella vista)`}.
        </p>
      )}
      {error && <div className="error-banner">{(error as Error).message}</div>}
      {settings && !settings.jira_field && all.length > 0 && (
        <div className="card" style={{ background: '#fffaf0', borderColor: '#f3dcae', fontSize: 13 }}>
          In Salesforce le Opportunity non hanno ancora un campo con l'ID Jira: per ora tutti gli enhancement risultano{' '}
          <b>Senza Jira</b>. Appena il campo verrà creato (con "Jira" nel nome o nell'etichetta), alla prossima lettura
          gli ID verranno letti e confrontati con il backlog dei tuoi increment, senza altre modifiche.
        </div>
      )}

      <div className="card">
        <div className="cert-toolbar">
          <input
            type="search"
            placeholder="Cerca request id, nome, cliente, owner, Jira…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            aria-label="Cerca negli enhancement"
          />
          <div className="filter-group">
            <span className="filter-group-label">Jira</span>
            {JIRA_FILTERS.map((f) => (
              <button
                key={f.value}
                type="button"
                title={f.title}
                className={`btn filter-btn${jiraFilter === f.value ? ' active' : ''}`}
                aria-pressed={jiraFilter === f.value}
                onClick={() => setJiraFilter(f.value)}
              >
                {f.label} <span className="muted">{jiraCounts[f.value]}</span>
              </button>
            ))}
          </div>
          <span className="muted cert-count">
            {visible.length} di {all.length} enhancement
          </span>
        </div>
        <div className="filter-group" style={{ marginBottom: 12, flexWrap: 'wrap' }}>
          <span className="filter-group-label">Stage</span>
          {stages.map(([stage, count]) => (
            <button
              key={stage}
              type="button"
              className={`btn filter-btn${hiddenStages.has(stage) ? '' : ' active'}`}
              aria-pressed={!hiddenStages.has(stage)}
              onClick={() => toggle(hiddenStages, stage, setHiddenStages)}
            >
              {stage} <span className="muted">{count}</span>
            </button>
          ))}
        </div>
        <div className="filter-group" style={{ marginBottom: 12, flexWrap: 'wrap' }}>
          <span className="filter-group-label">Increment</span>
          {[
            { value: 'all' as const, label: 'Tutti', count: all.length, title: 'Tutti gli enhancement' },
            { value: 'none' as const, label: 'Nessuno', count: withoutIncrement, title: 'Enhancement senza increment associato' },
            ...incrementOptions.map(([id, { code, count }]) => ({
              value: id,
              label: code,
              count,
              title: `Enhancement associati a ${code}`,
            })),
          ].map((f) => (
            <button
              key={f.value}
              type="button"
              title={f.title}
              className={`btn filter-btn${incrementFilter === f.value ? ' active' : ''}`}
              aria-pressed={incrementFilter === f.value}
              onClick={() => setIncrementFilter(f.value)}
            >
              {f.label} <span className="muted">{f.count}</span>
            </button>
          ))}
        </div>

        {isLoading ? (
          <p className="muted">Caricamento…</p>
        ) : all.length === 0 ? (
          <p className="muted">
            Nessun enhancement salvato: premi <b>⟳ Aggiorna da Salesforce</b> per leggerli. Si legge con l'accesso
            Salesforce del browser dell'app (lo stesso dei Complaints).
          </p>
        ) : (
          <div className="table-wrap">
            <table className="cert-table">
              <thead>
                <tr>
                  <th>Request Id</th>
                  <th style={{ width: 320 }}>Nome</th>
                  <th>Stage</th>
                  <th>Priorità</th>
                  <th style={{ width: 200 }}>Clienti</th>
                  <th>Owner</th>
                  <th>Due date</th>
                  <th>Release</th>
                  <th style={{ width: 220 }}>Jira</th>
                  <th>Stato Jira</th>
                  <th title="Increment a cui appartiene l'enhancement, scelto a mano">Increment</th>
                  <th>Modificato</th>
                </tr>
              </thead>
              <tbody>
                {visible.map((e) => {
                  const isOpen = open.has(e.id)
                  return (
                    <Fragment key={e.id}>
                      <tr className="cert-row" onClick={() => toggle(open, e.id, setOpen)}>
                        <td className="nowrap">
                          <span className="wl-caret">{isOpen ? '▾' : '▸'}</span>
                          <a href={e.url} target="_blank" rel="noreferrer" onClick={(ev) => ev.stopPropagation()}>
                            {e.request_id ?? e.sf_id}
                          </a>
                        </td>
                        <td>{e.name ?? dash}</td>
                        <td>{e.stage && <span className={`badge ${stageClass(e)}`}>{e.stage}</span>}</td>
                        <td>{e.priority ?? dash}</td>
                        <td>{e.accounts ?? dash}</td>
                        <td>{e.sf_owner ?? dash}</td>
                        <td className="nowrap">{formatIsoDate(e.expected_due_date) ?? '-'}</td>
                        <td className="nowrap">{formatIsoDate(e.release_date) ?? '-'}</td>
                        <td onClick={(ev) => ev.stopPropagation()}>
                          <JiraCell enhancement={e} />
                        </td>
                        <td className="nowrap">
                          {e.jira.some((j) => j.jira_status)
                            ? e.jira.map((j) => j.jira_status ?? '-').join(', ')
                            : dash}
                        </td>
                        <td onClick={(ev) => ev.stopPropagation()}>
                          <IncrementSelect
                            enhancement={e}
                            increments={increments ?? []}
                            disabled={!can('editor') || setIncrement.isPending}
                            onChange={(incrementId) => setIncrement.mutate({ id: e.id, incrementId })}
                          />
                        </td>
                        <td className="nowrap">
                          {e.modified_at ? parseBackendDateTime(e.modified_at).toLocaleDateString('it-IT') : '-'}
                        </td>
                      </tr>
                      {isOpen && (
                        <tr className="cert-detail">
                          <td colSpan={12}>
                            <EnhancementDetail enhancement={e} />
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  )
}

// Issue Jira dell'enhancement: link a Jira e, se e' nel backlog di un tuo
// increment, link alla sua Dashboard con lo stato Jira.
function JiraCell({ enhancement: e }: { enhancement: Enhancement }) {
  if (e.jira.length === 0) {
    return <span className="badge todo" title="Nessun ID Jira in Salesforce">Senza Jira</span>
  }
  return (
    <div style={{ display: 'grid', gap: 2 }}>
      {e.jira.map((j) => (
        <div key={j.key} className="nowrap">
          <a href={`${JIRA_BROWSE}${j.key}`} target="_blank" rel="noreferrer">
            {j.key}
          </a>
          {j.increment_id != null ? (
            <span className="muted">
              {' '}
              · <Link to={`/projects/${j.increment_id}`}>{j.increment_code}</Link>
              {j.jira_status && ` · ${j.jira_status}`}
            </span>
          ) : (
            <span className="muted" title="La issue non è nel backlog di nessuno dei tuoi increment">
              {' '}
              · fuori backlog
            </span>
          )}
        </div>
      ))}
    </div>
  )
}

// Increment associato a mano. Se l'ID Jira dell'enhancement e' nel backlog
// di un altro increment, un avviso lo segnala.
function IncrementSelect({
  enhancement: e,
  increments,
  disabled,
  onChange,
}: {
  enhancement: Enhancement
  increments: Project[]
  disabled: boolean
  onChange: (incrementId: number | null) => void
}) {
  const fromJira = e.jira.filter((j) => j.increment_id != null)
  const mismatch = e.increment_id != null && fromJira.length > 0 && !fromJira.some((j) => j.increment_id === e.increment_id)
  const sorted = [...increments].sort((a, b) => a.code.localeCompare(b.code))
  return (
    <span className="nowrap" style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
      <select
        aria-label={`Increment dell'enhancement ${e.request_id ?? e.sf_id}`}
        value={e.increment_id ?? ''}
        disabled={disabled}
        onChange={(ev) => onChange(ev.target.value ? Number(ev.target.value) : null)}
      >
        <option value="">—</option>
        {sorted.map((p) => (
          <option key={p.id} value={p.id}>
            {p.code} · {p.name}
          </option>
        ))}
      </select>
      {mismatch && (
        <span
          style={{ color: 'var(--warning)' }}
          title={`L'issue Jira è nel backlog di ${fromJira.map((j) => j.increment_code).join(', ')}, non dell'increment scelto`}
        >
          ⚠
        </span>
      )}
    </span>
  )
}

// Link alla list view Salesforce: impostazione personale (un altro PJM puo'
// usare un'altra vista). Vuoto = quella predefinita.
function LinkSettings({ settings, onClose }: { settings: EnhancementsSettings; onClose: () => void }) {
  const queryClient = useQueryClient()
  const { can } = useAuth()
  const [draft, setDraft] = useState(settings.list_url)
  const save = useMutation({
    mutationFn: (listUrl: string) => api.tools.enhancements.updateSettings({ list_url: listUrl }),
    onSuccess: (saved) => {
      queryClient.setQueryData(['enhancements-settings'], saved)
      setDraft(saved.list_url)
    },
  })
  const dirty = draft.trim() !== settings.list_url
  return (
    <div className="card rda-settings">
      <div className="form-row" style={{ marginBottom: 0 }}>
        <label htmlFor="enh-list-url">Link alla list view Salesforce degli enhancement</label>
        <div style={{ display: 'flex', gap: 8 }}>
          <input
            id="enh-list-url"
            type="url"
            style={{ flex: 1 }}
            value={draft}
            disabled={!can('editor')}
            onChange={(e) => setDraft(e.target.value)}
            placeholder={settings.default_url}
          />
          {can('editor') && (
            <button className="btn" disabled={!dirty || save.isPending} onClick={() => save.mutate(draft.trim())}>
              {save.isPending ? 'Salvataggio...' : 'Salva'}
            </button>
          )}
          {settings.default_url && draft.trim() !== settings.default_url && can('editor') && (
            <button className="link-btn" onClick={() => setDraft(settings.default_url ?? '')}>
              Predefinito
            </button>
          )}
          <button className="link-btn" onClick={onClose}>
            Chiudi
          </button>
        </div>
        <span className="muted" style={{ fontSize: 12 }}>
          Apri la list view delle Opportunity in Salesforce e copia qui l'indirizzo dalla barra del browser (es.{' '}
          <code>…lightning.force.com/lightning/o/Opportunity/list?filterName=Enhancement_ProTube</code>): si leggono
          gli enhancement con i filtri della vista, alla prossima lettura.
        </span>
        {save.isError && <div className="error-banner">{(save.error as Error).message}</div>}
      </div>
    </div>
  )
}

function EnhancementDetail({ enhancement: e }: { enhancement: Enhancement }) {
  const fields: [string, string | null][] = [
    ['Short description', e.short_description],
    ['Tipo', e.enhancement_type],
    ['Fonte', e.source],
    ['Product line', e.product_line],
    ['Target release', e.target_release],
    ['Case collegati', e.cases],
    ['ID Jira (Salesforce)', e.jira_key],
    ['Creato da', e.created_by],
    ['Creato il', e.created_at ? parseBackendDateTime(e.created_at).toLocaleDateString('it-IT') : null],
  ]
  return (
    <div className="cert-detail-body">
      <div>
        <h4>Dettagli</h4>
        <dl className="cert-fields">
          {fields.map(([label, value]) => (
            <Fragment key={label}>
              <dt>{label}</dt>
              <dd>{value || <span className="muted">-</span>}</dd>
            </Fragment>
          ))}
        </dl>
        {e.jira
          .filter((j) => j.summary)
          .map((j) => (
            <p key={j.key} className="muted" style={{ margin: '6px 0 0', fontSize: 13 }}>
              {j.key}: {j.summary}
            </p>
          ))}
      </div>
      <p className="muted cert-detail-note">
        Letto il {e.synced_at ? parseBackendDateTime(e.synced_at).toLocaleString('it-IT') : '-'} ·{' '}
        <a href={e.url} target="_blank" rel="noreferrer">
          apri in Salesforce
        </a>
      </p>
    </div>
  )
}
