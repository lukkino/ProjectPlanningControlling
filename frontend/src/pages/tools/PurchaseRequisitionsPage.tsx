import { Fragment, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link } from 'react-router-dom'
import { api } from '../../api/client'
import type { Increment, PurchaseRequisition, RequisitionSettings } from '../../api/types'
import { SyncProgressModal } from '../../components/SyncProgressModal'
import { useAuth } from '../../components/authContext'
import { formatDateTime, formatIsoDate } from '../../lib/dates'

// Tool RDA: le richieste di acquisto preparate dall'utente in Dynamics 365,
// lette con il browser dell'app (vedi backend/app/services/tools/
// purchase_requisitions.py). Solo consultazione: le RDA si creano e si
// modificano in Dynamics.


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
  const sync = useMutation({
    mutationFn: api.tools.requisitions.sync,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['purchase-requisitions'] }),
  })
  // Stati mostrati: all'inizio solo le RDA in corso (se ce ne sono).
  const [shownStatuses, setShownStatuses] = useState<Set<string> | null>(null)
  const [search, setSearch] = useState('')
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
  const words = search.trim().toLowerCase().split(/\s+/).filter(Boolean)
  const visible = all.filter((r) => shown.has(r.status ?? '-') && words.every((w) => searchable(r).includes(w)))
  const visibleTotal = visible.reduce((sum, r) => sum + totalOf(r), 0)
  const openRequisitions = all.filter((r) => OPEN_STATUSES.has(r.status ?? ''))
  const lastSync = all.reduce<string | null>(
    (latest, r) => (r.synced_at && (!latest || r.synced_at > latest) ? r.synced_at : latest),
    null,
  )
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
          <div className="card rda-kpi">
            <div className="rda-kpi-value">{openRequisitions.length}</div>
            <div className="muted">RDA in corso (bozza, in revisione, approvate)</div>
          </div>
          <div className="card rda-kpi">
            <div className="rda-kpi-value">{money(openRequisitions.reduce((s, r) => s + totalOf(r), 0))}</div>
            <div className="muted">Importo delle RDA in corso</div>
          </div>
          <div className="card rda-kpi">
            <div className="rda-kpi-value">{all.length}</div>
            <div className="muted">RDA totali</div>
          </div>
        </div>
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
                  <th>Data</th>
                  <th>Progetto</th>
                  <th>Fornitore</th>
                  <th className="num">Righe</th>
                  <th className="num">Importo</th>
                  <th>Giustificazione</th>
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
                          <b>{r.number}</b>
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
                        <td>{r.justification_code ?? <span className="muted">-</span>}</td>
                      </tr>
                      {isOpen && (
                        <tr className="cert-detail">
                          <td colSpan={9}>
                            <RequisitionDetail requisition={r} />
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  )
                })}
                {visible.length === 0 && (
                  <tr>
                    <td colSpan={9} className="muted">
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
  const number = (value: number | null) => (value == null ? '-' : value.toLocaleString('it-IT'))
  return (
    <div className="rda-detail">
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
