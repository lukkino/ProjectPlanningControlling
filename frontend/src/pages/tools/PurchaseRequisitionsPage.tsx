import { Fragment, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link } from 'react-router-dom'
import { api, saveBlob } from '../../api/client'
import type { Increment, PurchaseRequisition, RequisitionLinesPreview, RequisitionSettings } from '../../api/types'
import { SyncProgressModal } from '../../components/SyncProgressModal'
import { useAuth } from '../../components/authContext'
import { formatDateTime, formatIsoDate } from '../../lib/dates'

// Tool RDA: le richieste di acquisto preparate dall'utente in Dynamics 365,
// lette con il browser dell'app (vedi backend/app/services/tools/
// purchase_requisitions.py). Le RDA si creano in Dynamics; le righe di una
// RDA in bozza si possono caricare da un Excel (modello scaricabile qui).


// Stati Dynamics -> etichetta e colore del badge.
const STATUS: Record<string, { label: string; badge: string }> = {
  Draft: { label: 'Bozza', badge: 'todo' },
  InReview: { label: 'In revisione', badge: 'progress' },
  Approved: { label: 'Approvata', badge: 'done' },
  Rejected: { label: 'Rifiutata', badge: 'rda-rejected' },
  Cancelled: { label: 'Annullata', badge: 'todo' },
  Closed: { label: 'Chiusa', badge: 'done' },
}
const STATUS_ORDER = ['Draft', 'InReview', 'Approved', 'Rejected', 'Cancelled', 'Closed']
// RDA ancora "in corso": la selezione iniziale del filtro Stato.
const OPEN_STATUSES = new Set(['Draft', 'InReview', 'Approved'])

const statusLabel = (s: string | null) => (s ? (STATUS[s]?.label ?? s) : '-')
const StatusBadge = ({ status }: { status: string | null }) =>
  status ? <span className={`badge ${STATUS[status]?.badge ?? 'progress'}`}>{statusLabel(status)}</span> : null

const money = (value: number, currency = 'EUR') =>
  // useGrouping 'always': in italiano le cifre da 4 non avrebbero il punto (2472,00 €).
  value.toLocaleString('it-IT', { style: 'currency', currency, maximumFractionDigits: 2, useGrouping: 'always' } as Intl.NumberFormatOptions)

// Stati in cui la RDA e' ancora "di qualcuno" (in carico a un approvatore o
// rimandata al preparatore): per le chiuse/annullate il dato non serve.
const ACTIVE_STATUSES = new Set(['Draft', 'InReview', 'Approved', 'Rejected'])
// RDA che non impegnano budget del progetto.
const NOT_COMMITTED_STATUSES = new Set(['Rejected', 'Cancelled'])

// Data/ora dell'ultima azione: ora locale di Dynamics, senza fuso.
const formatLocalDateTime = (value: string) => {
  const [date, time = ''] = value.split('T')
  return `${formatIsoDate(date) ?? date} ${time.slice(0, 5)}`.trim()
}

const totalOf = (r: PurchaseRequisition) => r.lines.reduce((sum, l) => sum + (l.amount ?? 0), 0)
const currencyOf = (r: PurchaseRequisition) => r.lines.find((l) => l.currency)?.currency ?? 'EUR'
const vendorsOf = (r: PurchaseRequisition) => [
  ...new Set(r.lines.map((l) => l.vendor_name ?? l.vendor_account).filter((v): v is string => !!v)),
]

const searchable = (r: PurchaseRequisition) =>
  [
    r.number,
    r.name,
    statusLabel(r.status),
    r.project_id,
    r.justification_code,
    r.justification,
    ...r.in_charge,
    r.last_action_by,
    ...r.lines.flatMap((l) => [l.product, l.description, l.item_number, l.category, l.vendor_name, l.vendor_account]),
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase()

// Progetto dell'app (codice PTIH-...) a cui appartiene l'ID progetto Dynamics
// (es. "PTIH-PT13-004" -> progetto "PTIH-PT13"): il codice piu' lungo che ne
// e' il prefisso.
function incrementOf(projectId: string | null, increments: Increment[]): Increment | undefined {
  if (!projectId) return undefined
  const id = projectId.toUpperCase()
  return increments
    .filter((i) => id === i.code.toUpperCase() || id.startsWith(`${i.code.toUpperCase()}-`))
    .sort((a, b) => b.code.length - a.code.length)[0]
}

export function PurchaseRequisitionsPage() {
  const { can } = useAuth()
  const queryClient = useQueryClient()
  const { data, isLoading, error } = useQuery({
    queryKey: ['purchase-requisitions'],
    queryFn: api.tools.requisitions.list,
  })
  const { data: increments } = useQuery({ queryKey: ['increments'], queryFn: api.increments.list })
  const { data: settings } = useQuery({
    queryKey: ['purchase-requisitions-settings'],
    queryFn: api.tools.requisitions.getSettings,
  })
  const [settingsOpen, setSettingsOpen] = useState(false)
  const template = useMutation({
    mutationFn: api.tools.requisitions.linesTemplate,
    onSuccess: ({ blob, filename }) => saveBlob(blob, filename),
  })
  const sync = useMutation({
    mutationFn: api.tools.requisitions.sync,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['purchase-requisitions'] }),
  })
  // Stati mostrati: all'inizio solo le RDA in corso (se ce ne sono).
  const [shownStatuses, setShownStatuses] = useState<Set<string> | null>(null)
  const [search, setSearch] = useState('')
  // Progetto: il progetto dell'app (PTIH-PT13) se l'ID progetto Dynamics ne
  // fa parte, se no le prime due parti dell'ID (PTIH-PTB6-002 -> PTIH-PTB6);
  // '' = tutti.
  const [projectFilter, setProjectFilter] = useState('')
  const [open, setOpen] = useState<Set<number>>(new Set())

  const all = data ?? []
  const statusCounts = new Map<string, number>()
  for (const r of all) statusCounts.set(r.status ?? '-', (statusCounts.get(r.status ?? '-') ?? 0) + 1)
  const statuses = [...statusCounts.keys()].sort(
    (a, b) => (STATUS_ORDER.indexOf(a) + 1 || 99) - (STATUS_ORDER.indexOf(b) + 1 || 99),
  )
  const defaultShown = all.some((r) => OPEN_STATUSES.has(r.status ?? ''))
    ? new Set(statuses.filter((s) => OPEN_STATUSES.has(s)))
    : new Set(statuses)
  const shown = shownStatuses ?? defaultShown
  const projectOf = (r: PurchaseRequisition) =>
    incrementOf(r.project_id, increments ?? [])?.code ?? (r.project_id ?? '').toUpperCase().split('-').slice(0, 2).join('-')
  const projectCounts = new Map<string, number>()
  for (const r of all) projectCounts.set(projectOf(r), (projectCounts.get(projectOf(r)) ?? 0) + 1)
  const projects = [...projectCounts.keys()].filter(Boolean).sort()
  const words = search.trim().toLowerCase().split(/\s+/).filter(Boolean)
  const visible = all.filter(
    (r) =>
      shown.has(r.status ?? '-') &&
      (!projectFilter || projectOf(r) === projectFilter) &&
      words.every((w) => searchable(r).includes(w)),
  )
  const visibleTotal = visible.reduce((sum, r) => sum + totalOf(r), 0)
  // Filtro diverso da quello iniziale (solo le RDA in corso): i totali in
  // alto seguono le RDA filtrate.
  const statusesChanged = shown.size !== defaultShown.size || [...shown].some((s) => !defaultShown.has(s))
  const filtered = statusesChanged || !!projectFilter || words.length > 0
  const filterDescription = [
    projectFilter && `progetto ${projectFilter}`,
    statusesChanged &&
      (shown.size === statuses.length ? 'tutti gli stati' : `stati: ${[...shown].map(statusLabel).join(', ') || 'nessuno'}`),
    words.length > 0 && `ricerca «${search.trim()}»`,
  ]
    .filter(Boolean)
    .join(' · ')
  const openRequisitions = all.filter((r) => OPEN_STATUSES.has(r.status ?? ''))
  const lastSync = all.reduce<string | null>(
    (latest, r) => (r.synced_at && (!latest || r.synced_at > latest) ? r.synced_at : latest),
    null,
  )
  // Budget del progetto filtrato (se e' un progetto dell'app): budget
  // materiali come nella pagina del progetto, contro le RDA del progetto
  // che impegnano budget (tutte tranne rifiutate e annullate), qualunque
  // sia il filtro Stato.
  const selectedIncrement = projectFilter ? (increments ?? []).find((i) => i.code === projectFilter) : undefined
  const { data: incrementDetail } = useQuery({
    queryKey: ['increment', selectedIncrement?.id],
    queryFn: () => api.increments.get(selectedIncrement!.id),
    enabled: !!selectedIncrement,
  })
  const projectRequisitions = all.filter(
    (r) => projectFilter && projectOf(r) === projectFilter && !NOT_COMMITTED_STATUSES.has(r.status ?? ''),
  )
  const projectRequisitionsTotal = projectRequisitions.reduce((sum, r) => sum + totalOf(r), 0)
  const projectInProgressTotal = projectRequisitions
    .filter((r) => r.status === 'Draft' || r.status === 'InReview')
    .reduce((sum, r) => sum + totalOf(r), 0)
  const toggleStatus = (status: string) => {
    const next = new Set(shown)
    if (next.has(status)) next.delete(status)
    else next.add(status)
    setShownStatuses(next)
  }
  const toggleOpen = (id: number) => {
    const next = new Set(open)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    setOpen(next)
  }

  return (
    <div>
      <div className="page-header">
        <div>
          <div className="sub">
            <Link to="/tools">Tools</Link> ›
          </div>
          <h1>🛒 RDA</h1>
          <div className="sub">
            Richieste di acquisto preparate da te in{' '}
            {settings ? (
              <a href={settings.list_url} target="_blank" rel="noreferrer">
                Dynamics 365
              </a>
            ) : (
              'Dynamics 365'
            )}{' '}
            · Ultimo aggiornamento: {lastSync ? formatDateTime(lastSync) : 'mai'}
          </div>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button
            className="btn"
            aria-expanded={settingsOpen}
            title="Link all'elenco delle tue RDA in Dynamics 365 (ambiente e società)"
            onClick={() => setSettingsOpen((v) => !v)}
          >
            ⚙ Link Dynamics
          </button>
          <button
            className="btn"
            title="Modello Excel per le righe di una RDA: compilalo e caricalo su una RDA in bozza (Carica righe da Excel)"
            onClick={() => template.mutate()}
            disabled={template.isPending}
          >
            📄 Modello Excel righe
          </button>
          {can('editor') && (
            <button className="btn btn-primary" onClick={() => sync.mutate()} disabled={sync.isPending}>
              {sync.isPending ? 'Lettura...' : '⟳ Aggiorna da Dynamics'}
            </button>
          )}
        </div>
      </div>

      {settingsOpen && settings && <LinkSettings settings={settings} onClose={() => setSettingsOpen(false)} />}

      {sync.isPending && (
        <SyncProgressModal
          title="RDA"
          queryKey={['purchase-requisitions-progress']}
          fetchProgress={api.tools.requisitions.syncProgress}
        />
      )}
      {sync.isError && <div className="error-banner">{(sync.error as Error).message}</div>}
      {template.isError && <div className="error-banner">{(template.error as Error).message}</div>}
      {sync.isSuccess && (
        <p className="muted" style={{ marginTop: 0 }}>
          Lette {sync.data.total} RDA: {sync.data.created} nuove, {sync.data.updated} aggiornate
          {sync.data.removed > 0 && `, ${sync.data.removed} rimosse (non più in Dynamics)`}
          {sync.data.account && ` · lette con l'account ${sync.data.account}`}.
        </p>
      )}
      {error && <div className="error-banner">{(error as Error).message}</div>}

      {all.length > 0 && (
        <div className="rda-kpis">
          <div className={`card rda-kpi${filtered ? ' rda-kpi--filtered' : ''}`}>
            <div className="rda-kpi-value">{filtered ? visible.length : openRequisitions.length}</div>
            <div className="muted">{filtered ? 'RDA filtrate' : 'RDA in corso (bozza, in revisione, approvate)'}</div>
          </div>
          <div className={`card rda-kpi${filtered ? ' rda-kpi--filtered' : ''}`}>
            <div className="rda-kpi-value">
              {money(filtered ? visibleTotal : openRequisitions.reduce((s, r) => s + totalOf(r), 0))}
            </div>
            <div className="muted">{filtered ? 'Importo delle RDA filtrate' : 'Importo delle RDA in corso'}</div>
          </div>
          <div className="card rda-kpi">
            <div className="rda-kpi-value">{all.length}</div>
            <div className="muted">RDA totali</div>
          </div>
        </div>
      )}
      {selectedIncrement && (
        <div className="card rda-budget">
          <div className="rda-budget-title">
            Budget materiali di{' '}
            <Link to={`/increments/${selectedIncrement.id}`}>
{selectedIncrement.code}</Link>
          </div>
          {!incrementDetail ? (
            <p className="muted">Caricamento…</p>
          ) : (
            <div className="rda-kpis">
              <div>
                <div className="rda-kpi-value">{money(incrementDetail.budget_material_total)}</div>
                <div className="muted">Budget progetto</div>
              </div>
              <div>
                <div className="rda-kpi-value">{money(projectRequisitionsTotal)}</div>
                <div className="muted">
                  RDA sul progetto ({projectRequisitions.length}, escluse rifiutate e annullate)
                  {projectInProgressTotal > 0 && <>, di cui {money(projectInProgressTotal)} in bozza o in revisione</>}
                </div>
              </div>
              <div>
                <div
                  className="rda-kpi-value"
                  style={{
                    color:
                      incrementDetail.budget_material_total - projectRequisitionsTotal < 0 ? 'var(--danger)' : undefined,
                  }}
                >
                  {money(incrementDetail.budget_material_total - projectRequisitionsTotal)}
                </div>
                <div className="muted">
                  Rimanenza
                  {incrementDetail.budget_material_total > 0 &&
                    ` (${Math.round((projectRequisitionsTotal / incrementDetail.budget_material_total) * 100)}% del budget impegnato)`}
                </div>
              </div>
            </div>
          )}
        </div>
      )}
      {all.length > 0 && filtered && (
        <p className="muted rda-filter-note">
          Totali secondo il filtro: {filterDescription}.{' '}
          <button
            type="button"
            className="link-btn"
            onClick={() => {
              setSearch('')
              setProjectFilter('')
              setShownStatuses(null)
            }}
          >
            Togli i filtri
          </button>
        </p>
      )}

      <div className="card">
        <div className="cert-toolbar">
          <input
            type="search"
            placeholder="Cerca numero, nome, progetto, prodotto, fornitore…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            aria-label="Cerca nelle RDA"
          />
          <label className="filter-group">
            <span className="filter-group-label">Progetto</span>
            <select value={projectFilter} onChange={(e) => setProjectFilter(e.target.value)} aria-label="Filtra per progetto">
              <option value="">Tutti</option>
              {projects.map((p) => (
                <option key={p} value={p}>
                  {p} ({projectCounts.get(p)})
                </option>
              ))}
            </select>
          </label>
          <div className="filter-group">
            <span className="filter-group-label">Stato</span>
            {statuses.map((status) => (
              <button
                key={status}
                type="button"
                className={`btn filter-btn${shown.has(status) ? ' active' : ''}`}
                aria-pressed={shown.has(status)}
                onClick={() => toggleStatus(status)}
              >
                {statusLabel(status)} <span className="muted">{statusCounts.get(status)}</span>
              </button>
            ))}
            {shown.size < statuses.length && (
              <button className="link-btn" onClick={() => setShownStatuses(new Set(statuses))}>
                Tutti
              </button>
            )}
          </div>
          <span className="muted cert-count">
            {visible.length} di {all.length} RDA · {money(visibleTotal)}
          </span>
        </div>

        {isLoading ? (
          <p className="muted">Caricamento…</p>
        ) : all.length === 0 ? (
          <p className="muted">
            Nessuna RDA salvata: premi <b>⟳ Aggiorna da Dynamics</b> per leggerle. Il login a Dynamics avviene da solo
            con l'accesso Microsoft del browser dell'app (lo stesso dei Change Order).
          </p>
        ) : (
          <div className="table-wrap">
            <table className="cert-table">
              <thead>
                <tr>
                  <th>RDA</th>
                  <th>Nome</th>
                  <th>Stato</th>
                  <th title="Approvatori a cui la RDA è in attesa (flusso di lavoro di Dynamics)">In carico a</th>
                  <th title="Ultima azione del flusso di lavoro: quando e chi">Ultima azione</th>
                  <th>Data</th>
                  <th>Progetto</th>
                  <th>Fornitore</th>
                  <th className="num">Righe</th>
                  <th className="num">Importo</th>
                </tr>
              </thead>
              <tbody>
                {visible.map((r) => {
                  const isOpen = open.has(r.id)
                  const increment = incrementOf(r.project_id, increments ?? [])
                  return (
                    <Fragment key={r.id}>
                      <tr className="cert-row" onClick={() => toggleOpen(r.id)}>
                        <td className="nowrap">
                          <span className="wl-caret">{isOpen ? '▾' : '▸'}</span>
                          <b>{r.number}</b> <CopyNumber value={r.number} /> <DynamicsLink requisition={r} />
                        </td>
                        <td>{r.name ?? <span className="muted">-</span>}</td>
                        <td className="nowrap">
                          <StatusBadge status={r.status} />
                          {r.on_hold && (
                            <span className="badge progress" title={r.on_hold_explanation ?? undefined}>
                              In attesa
                            </span>
                          )}
                        </td>
                        <td>
                          {ACTIVE_STATUSES.has(r.status ?? '') && r.in_charge.length > 0 ? (
                            <span className="rda-in-charge">{r.in_charge.join(', ')}</span>
                          ) : (
                            <span className="muted">-</span>
                          )}
                        </td>
                        <td className="nowrap">
                          {r.last_action_at ? (
                            <>
                              {formatLocalDateTime(r.last_action_at)}
                              <div className="muted rda-last-by">{r.last_action_by}</div>
                            </>
                          ) : (
                            <span className="muted">-</span>
                          )}
                        </td>
                        <td className="nowrap">{formatIsoDate(r.date) ?? '-'}</td>
                        <td className="nowrap">
                          {r.project_id ?? <span className="muted">-</span>}
                          {increment && (
                            <>
                              {' '}
                              <Link
                                to={`/increments/${increment.id}`}
                                onClick={(e) => e.stopPropagation()}
                                title={`Progetto ${increment.code} nell'app`}
                              >
                                ↗
                              </Link>
                            </>
                          )}
                        </td>
                        <td>{vendorsOf(r).join(', ') || <span className="muted">-</span>}</td>
                        <td className="num">{r.lines.length}</td>
                        <td className="num nowrap">{money(totalOf(r), currencyOf(r))}</td>
                      </tr>
                      {isOpen && (
                        <tr className="cert-detail">
                          <td colSpan={10}>
                            <RequisitionDetail requisition={r} />
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  )
                })}
                {visible.length === 0 && (
                  <tr>
                    <td colSpan={10} className="muted">
                      Nessuna RDA con i filtri selezionati.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  )
}

// Link all'elenco "Richieste di acquisto preparate dall'utente" di
// Dynamics 365: impostazione personale (ambiente e societa' possono
// cambiare da utente a utente). Vuoto = quello predefinito.
function LinkSettings({ settings, onClose }: { settings: RequisitionSettings; onClose: () => void }) {
  const queryClient = useQueryClient()
  const { can } = useAuth()
  const [draft, setDraft] = useState(settings.list_url)
  const save = useMutation({
    mutationFn: (listUrl: string) => api.tools.requisitions.updateSettings({ list_url: listUrl }),
    onSuccess: (saved) => {
      queryClient.setQueryData(['purchase-requisitions-settings'], saved)
      setDraft(saved.list_url)
    },
  })
  const dirty = draft.trim() !== settings.list_url
  return (
    <div className="card rda-settings">
      <div className="form-row" style={{ marginBottom: 0 }}>
        <label>Link all'elenco delle tue RDA in Dynamics 365</label>
        <div style={{ display: 'flex', gap: 8 }}>
          <input
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
          In Dynamics apri la pagina <b>Richieste di acquisto preparate dall'utente</b> nella tua società e copia qui
          l'indirizzo dalla barra del browser (es. <code>…dynamics.com/?cmp=ISP&amp;mi=PurchReqPreparedByMe</code>).
          Le RDA si leggono con l'account Microsoft collegato al browser dell'app.
        </span>
        {save.isError && <div className="error-banner">{(save.error as Error).message}</div>}
      </div>
    </div>
  )
}

function RequisitionDetail({ requisition: r }: { requisition: PurchaseRequisition }) {
  const { can } = useAuth()
  const number = (value: number | null) => (value == null ? '-' : value.toLocaleString('it-IT'))
  return (
    <div className="rda-detail">
      {r.status === 'Draft' && can('editor') && <ExcelLinesImport requisition={r} />}
      <dl className="cert-fields">
        <dt>Giustificazione</dt>
        <dd>
          {[r.justification_code, r.justification].filter(Boolean).join(' – ') || <span className="muted">-</span>}
        </dd>
        <dt>Data richiesta</dt>
        <dd>{formatIsoDate(r.requested_date) ?? '-'}</dd>
        <dt>Scopo · società</dt>
        <dd>
          {r.purpose === 'Consumption' ? 'Consumo' : (r.purpose ?? '-')} · {(r.legal_entity ?? '-').toUpperCase()}
        </dd>
        {r.on_hold && (
          <>
            <dt>In attesa</dt>
            <dd>{r.on_hold_explanation ?? '-'}</dd>
          </>
        )}
        <dt>Approvazioni</dt>
        <dd>
          {r.approvers.length === 0 ? (
            <span className="muted">nessun flusso di approvazione</span>
          ) : (
            <span className="rda-approvers">
              {r.approvers.map((a, i) => (
                <span
                  key={`${a.name}-${a.status}-${i}`}
                  className={`rda-approver rda-approver--${a.status === 'Pending' ? 'pending' : 'done'}`}
                  title={a.status === 'Pending' ? 'In attesa della sua approvazione' : 'Ha approvato'}
                >
                  {a.status === 'Pending' ? '⏳' : '✓'} {a.name}
                </span>
              ))}
            </span>
          )}
        </dd>
        {r.last_action_at && (
          <>
            <dt>Ultima azione</dt>
            <dd>
              {formatLocalDateTime(r.last_action_at)} · {r.last_action_by}
            </dd>
          </>
        )}
      </dl>
      <table className="rda-lines">
        <thead>
          <tr>
            <th>#</th>
            <th>Prodotto</th>
            <th>Categoria</th>
            <th>Fornitore</th>
            <th>Progetto</th>
            <th className="num">Quantità</th>
            <th className="num">Prezzo</th>
            <th className="num">Importo</th>
            <th>Stato</th>
          </tr>
        </thead>
        <tbody>
          {r.lines.map((l) => (
            <tr key={l.line ?? l.product}>
              <td>{l.line ?? '-'}</td>
              <td>
                {l.product ?? '-'}
                {l.description && l.description !== l.product && <div className="muted">{l.description}</div>}
              </td>
              <td>{l.category ?? '-'}</td>
              <td>
                {l.vendor_name ?? l.vendor_account ?? <span className="muted">-</span>}
                {l.vendor_name && l.vendor_account && <span className="muted"> ({l.vendor_account})</span>}
              </td>
              <td className="nowrap">{l.project_id ?? '-'}</td>
              <td className="num nowrap">
                {number(l.quantity)} {l.unit ?? ''}
              </td>
              <td className="num nowrap">{l.price == null ? '-' : money(l.price, l.currency ?? 'EUR')}</td>
              <td className="num nowrap">{l.amount == null ? '-' : money(l.amount, l.currency ?? 'EUR')}</td>
              <td>
                <StatusBadge status={l.status} />
              </td>
            </tr>
          ))}
          {r.lines.length === 0 && (
            <tr>
              <td colSpan={9} className="muted">
                Nessuna riga.
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  )
}


// Link alla RDA in Dynamics. Il link e' cifrato da Dynamics e non si
// costruisce dal numero: la prima volta l'app lo chiede a Dynamics (~30 s,
// col browser dell'app) e lo salva; dopo si apre subito.
// Copia il numero della RDA (es. per incollarlo in una chat) senza aprirla
// in Dynamics. Se l'app e' aperta via http da un altro PC, il browser non
// offre navigator.clipboard: si ripiega su una textarea temporanea.
function CopyNumber({ value }: { value: string }) {
  const [copied, setCopied] = useState(false)
  const copy = async (e: React.MouseEvent) => {
    e.stopPropagation()
    try {
      if (navigator.clipboard) {
        await navigator.clipboard.writeText(value)
      } else {
        const area = document.createElement('textarea')
        area.value = value
        area.style.position = 'fixed'
        area.style.opacity = '0'
        document.body.appendChild(area)
        area.select()
        const ok = document.execCommand('copy')
        area.remove()
        if (!ok) throw new Error('copy failed')
      }
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1500)
    } catch {
      window.prompt('Copia il numero della RDA (Ctrl+C):', value)
    }
  }
  return (
    <button
      type="button"
      className="rda-dyn-link"
      onClick={(e) => void copy(e)}
      title={copied ? 'Copiato' : `Copia ${value}`}
      aria-label={`Copia ${value}`}
    >
      {copied ? '✓' : '⧉'}
    </button>
  )
}

function DynamicsLink({ requisition: r }: { requisition: PurchaseRequisition }) {
  const queryClient = useQueryClient()
  const { can } = useAuth()
  const link = useMutation({
    mutationFn: () => api.tools.requisitions.link(r.id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['purchase-requisitions'] }),
  })
  if (r.dynamics_url) {
    return (
      <a
        className="rda-dyn-link"
        href={r.dynamics_url}
        target="_blank"
        rel="noreferrer"
        title={`Apri ${r.number} in Dynamics 365`}
        onClick={(e) => e.stopPropagation()}
      >
        ↗
      </a>
    )
  }
  if (!can('editor')) return null
  const open = (e: React.MouseEvent) => {
    e.stopPropagation()
    // La scheda si apre subito (dopo l'attesa il browser bloccherebbe il
    // popup) e va alla RDA quando arriva il link.
    const tab = window.open('', '_blank')
    tab?.document.write(
      `<p style="font-family:sans-serif">Apertura di ${r.number} in Dynamics 365: l'app chiede il link a Dynamics (circa 30 secondi)…</p>`,
    )
    link.mutate(undefined, {
      onSuccess: ({ url }) => {
        if (tab) tab.location.href = url
        else window.open(url, '_blank')
      },
      onError: (error) => {
        tab?.close()
        window.alert(`Link alla RDA non ottenuto: ${(error as Error).message}`)
      },
    })
  }
  return (
    <button
      type="button"
      className="rda-dyn-link"
      onClick={open}
      disabled={link.isPending}
      title={`Apri ${r.number} in Dynamics 365 (la prima volta l'app chiede il link a Dynamics: circa 30 secondi)`}
    >
      {link.isPending ? '…' : '↗'}
    </button>
  )
}

// Righe da Excel su una RDA in bozza: si carica il modello compilato,
// l'app mostra l'anteprima con gli errori e, solo dopo la conferma, scrive
// in Dynamics le righe senza errori.
function ExcelLinesImport({ requisition: r }: { requisition: PurchaseRequisition }) {
  const queryClient = useQueryClient()
  const [preview, setPreview] = useState<RequisitionLinesPreview | null>(null)
  const [fileName, setFileName] = useState('')
  const load = useMutation({
    mutationFn: (file: File) => api.tools.requisitions.previewLines(r.id, file),
    onSuccess: (data) => {
      setPreview(data)
      write.reset()
    },
  })
  const write = useMutation({
    mutationFn: () => api.tools.requisitions.writeLines(r.id, preview?.lines ?? []),
    onSuccess: () => {
      setPreview(null)
      queryClient.invalidateQueries({ queryKey: ['purchase-requisitions'] })
    },
  })
  const confirmWrite = () => {
    if (!preview) return
    const skipped = preview.lines.length - preview.valid
    const ok = window.confirm(
      `Aggiungere ${preview.valid} righe (${money(preview.total)}) alla RDA ${r.number} in Dynamics?` +
        (skipped > 0 ? `\n\n${skipped} righe con errori non verranno scritte.` : '') +
        (r.lines.length > 0 ? `\n\nLa RDA ha già ${r.lines.length} righe: le nuove si aggiungono dopo.` : ''),
    )
    if (ok) write.mutate()
  }
  const vendorLabel = (code: string | null) =>
    code ? `${code}${preview?.vendor_names[code] ? ` · ${preview.vendor_names[code]}` : ''}` : '-'

  return (
    <div className="rda-excel">
      <div className="rda-excel-head">
        <b>📥 Righe da Excel</b>
        <label className="btn" style={{ cursor: 'pointer' }}>
          {load.isPending ? 'Lettura…' : 'Carica righe da Excel'}
          <input
            type="file"
            accept=".xlsx"
            hidden
            onChange={(e) => {
              const file = e.target.files?.[0]
              e.target.value = ''
              if (!file) return
              setFileName(file.name)
              load.mutate(file)
            }}
          />
        </label>
        <span className="muted" style={{ fontSize: 12 }}>
          Compila il <b>📄 Modello Excel righe</b> (in alto) e caricalo: vedi l'anteprima prima di scrivere in Dynamics.
        </span>
      </div>
      {load.isError && <div className="error-banner">{(load.error as Error).message}</div>}
      {write.isError && <div className="error-banner">{(write.error as Error).message}</div>}
      {write.isPending && (
        <SyncProgressModal
          title={`Righe della ${r.number}`}
          queryKey={['purchase-requisitions-progress', 'lines']}
          fetchProgress={api.tools.requisitions.syncProgress}
        />
      )}
      {write.isSuccess && (
        <div style={{ marginTop: 8 }}>
          <b className="rda-excel-ok">
            Scritte {write.data.results.filter((x) => x.ok).length} righe in Dynamics
          </b>
          {write.data.results.some((x) => !x.ok) && (
            <ul className="rda-excel-error" style={{ margin: '4px 0 0' }}>
              {write.data.results
                .filter((x) => !x.ok)
                .map((x) => (
                  <li key={x.row}>
                    Riga Excel {x.row}: {x.error}
                  </li>
                ))}
            </ul>
          )}
        </div>
      )}
      {preview && (
        <>
          <div className="table-wrap">
            <table className="rda-lines">
              <thead>
                <tr>
                  <th title="Riga del foglio Excel">Riga</th>
                  <th>Categoria</th>
                  <th>Prodotto</th>
                  <th className="num">Quantità</th>
                  <th className="num">Prezzo</th>
                  <th className="num">Importo</th>
                  <th>Fornitore</th>
                  <th>Data</th>
                  <th>Controllo</th>
                </tr>
              </thead>
              <tbody>
                {preview.lines.map((l) => (
                  <tr key={l.row} className={l.errors.length > 0 ? 'rda-excel-bad' : undefined}>
                    <td>{l.row}</td>
                    <td>{l.category ?? '-'}</td>
                    <td>{l.product ?? '-'}</td>
                    <td className="num nowrap">
                      {l.quantity == null ? '-' : l.quantity.toLocaleString('it-IT')} {l.unit ?? ''}
                    </td>
                    <td className="num nowrap">{l.price == null ? '-' : money(l.price, l.currency)}</td>
                    <td className="num nowrap">
                      {l.price == null || l.quantity == null ? '-' : money(l.price * l.quantity, l.currency)}
                    </td>
                    <td>{vendorLabel(l.vendor)}</td>
                    <td className="nowrap">
                      {l.requested_date ? (
                        formatIsoDate(l.requested_date)
                      ) : (
                        <span className="muted">{formatIsoDate(r.requested_date) ?? '-'}</span>
                      )}
                    </td>
                    <td>
                      {l.errors.length === 0 ? (
                        <span className="rda-excel-ok">✓</span>
                      ) : (
                        <span className="rda-excel-error">{l.errors.join('; ')}</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="rda-excel-head" style={{ marginTop: 10 }}>
            <span>
              <b>{fileName}</b>: {preview.valid} righe da scrivere su {preview.lines.length} · {money(preview.total)}
              {preview.valid < preview.lines.length && (
                <span className="rda-excel-error"> · {preview.lines.length - preview.valid} con errori (saltate)</span>
              )}
            </span>
            <button className="btn btn-primary" disabled={preview.valid === 0 || write.isPending} onClick={confirmWrite}>
              Scrivi {preview.valid} righe in Dynamics
            </button>
            <button className="link-btn" onClick={() => setPreview(null)}>
              Annulla
            </button>
          </div>
          <p className="muted" style={{ fontSize: 12, margin: '6px 0 0' }}>
            Tutte le righe prendono dall'intestazione della RDA il progetto <b>{r.project_id ?? '-'}</b> e il motivo{' '}
            <b>{[r.justification_code, r.justification].filter(Boolean).join(' – ') || '-'}</b>
            {!r.justification_code && (
              <span className="rda-excel-error">
                {' '}
                (vuoto: compilalo nell'intestazione in Dynamics e premi ⟳ Aggiorna da Dynamics prima di scrivere)
              </span>
            )}
            ; in grigio la data dell'intestazione. Le righe si aggiungono in bozza: l'invio all'approvazione resta
            da fare in Dynamics.
          </p>
        </>
      )}
    </div>
  )
}
