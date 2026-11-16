import { Fragment, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link } from 'react-router-dom'
import { api } from '../../api/client'
import type { CommercialCodingSettings, CommercialCodingTicket } from '../../api/types'
import { SyncProgressModal } from '../../components/SyncProgressModal'
import { useAuth } from '../../components/authContext'
import { formatDateTime, parseBackendDateTime } from '../../lib/dates'

// Tool Commercial Coding: i ticket di una lista SharePoint (di default
// "Tickets" del sito Development; il link e' un'impostazione personale)
// creati dall'utente, letti col browser dell'app (vedi
// backend/app/services/tools/commercial_coding.py).

// Colore dello stato: Closed in verde, In progress/Waiting in arancione.
function statusClass(status: string | null): string {
  const s = (status ?? '').toLowerCase()
  if (s === 'closed') return 'done'
  if (s === 'in progress' || s === 'waiting') return 'progress'
  return 'todo'
}

const searchable = (t: CommercialCodingTicket) =>
  [
    String(t.item_id),
    t.description,
    t.vendor,
    t.vendor_code,
    t.family,
    t.status,
    t.final_coding,
    t.change_reason,
    t.certification_ticket,
    t.department,
    t.agent,
    ...Object.values(t.details),
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase()

// Date SharePoint salvate in UTC: mostrate nell'ora locale.
const formatDate = (value: string | null) =>
  value ? parseBackendDateTime(value).toLocaleDateString('it-IT') : '-'

// Codifica finale: un codice Inpeco (es. PFD1352) o una nota ("DESCRIPTION NOT CHANGED").
const isCode = (value: string | null) => !!value && /^[A-Z]{2,4}\d{3,}/.test(value)

export function CommercialCodingPage() {
  const { can } = useAuth()
  const queryClient = useQueryClient()
  const { data: tickets, isLoading, error } = useQuery({
    queryKey: ['commercial-coding'],
    queryFn: api.tools.commercialCoding.list,
  })
  const { data: settings } = useQuery({
    queryKey: ['commercial-coding-settings'],
    queryFn: api.tools.commercialCoding.getSettings,
  })
  const [settingsOpen, setSettingsOpen] = useState(false)
  const sync = useMutation({
    mutationFn: api.tools.commercialCoding.sync,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['commercial-coding'] }),
  })
  const [hiddenStatuses, setHiddenStatuses] = useState<Set<string>>(new Set())
  const [search, setSearch] = useState('')
  const [open, setOpen] = useState<Set<number>>(new Set())

  const all = tickets ?? []
  const statusCounts = new Map<string, number>()
  for (const t of all) statusCounts.set(t.status ?? '-', (statusCounts.get(t.status ?? '-') ?? 0) + 1)
  const words = search.trim().toLowerCase().split(/\s+/).filter(Boolean)
  const visible = all.filter(
    (t) => !hiddenStatuses.has(t.status ?? '-') && words.every((w) => searchable(t).includes(w)),
  )
  const lastSync = all.reduce<string | null>(
    (latest, t) => (t.synced_at && (!latest || t.synced_at > latest) ? t.synced_at : latest),
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
          <h1>🔖 Commercial Coding</h1>
          <div className="sub">
            I tuoi ticket nella{' '}
            {settings ? (
              <a href={settings.list_url} target="_blank" rel="noreferrer">
                lista SharePoint
              </a>
            ) : (
              'lista SharePoint'
            )}{' '}
            · Ultimo aggiornamento: {lastSync ? formatDateTime(lastSync) : 'mai'}
          </div>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button
            className="btn"
            aria-expanded={settingsOpen}
            title="Link alla lista SharePoint dei ticket di Commercial Coding"
            onClick={() => setSettingsOpen((v) => !v)}
          >
            ⚙ Link SharePoint
          </button>
          {can('editor') && (
            <button className="btn btn-primary" onClick={() => sync.mutate()} disabled={sync.isPending}>
              {sync.isPending ? 'Lettura...' : '⟳ Aggiorna da SharePoint'}
            </button>
          )}
        </div>
      </div>

      {settingsOpen && settings && <LinkSettings settings={settings} onClose={() => setSettingsOpen(false)} />}

      {sync.isPending && (
        <SyncProgressModal
          title="Ticket Commercial Coding"
          queryKey={['commercial-coding-progress']}
          fetchProgress={api.tools.commercialCoding.syncProgress}
        />
      )}
      {sync.isError && <div className="error-banner">{(sync.error as Error).message}</div>}
      {sync.isSuccess && (
        <p className="muted" style={{ marginTop: 0 }}>
          Letti {sync.data.total} ticket{sync.data.account && ` di ${sync.data.account}`}: {sync.data.created} nuovi,{' '}
          {sync.data.updated} aggiornati
          {sync.data.removed > 0 && `, ${sync.data.removed} rimossi (non più nella lista)`}.
        </p>
      )}
      {error && <div className="error-banner">{(error as Error).message}</div>}

      <div className="card">
        <div className="cert-toolbar">
          <input
            type="search"
            placeholder="Cerca articolo, vendor, codice, famiglia…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            aria-label="Cerca nei ticket"
          />
          <div className="filter-group">
            <span className="filter-group-label">Stato</span>
            {[...statusCounts.entries()].map(([status, count]) => (
              <button
                key={status}
                type="button"
                className={`btn filter-btn${hiddenStatuses.has(status) ? '' : ' active'}`}
                aria-pressed={!hiddenStatuses.has(status)}
                onClick={() => toggle(hiddenStatuses, status, setHiddenStatuses)}
              >
                {status} <span className="muted">{count}</span>
              </button>
            ))}
          </div>
          <span className="muted cert-count">
            {visible.length} di {all.length} ticket
          </span>
        </div>

        {isLoading ? (
          <p className="muted">Caricamento…</p>
        ) : all.length === 0 ? (
          <p className="muted">
            Nessun ticket salvato: premi <b>⟳ Aggiorna da SharePoint</b> per leggerli. Si leggono i ticket creati
            dall'account Microsoft del browser dell'app (lo stesso dei Change Order).
          </p>
        ) : (
          <div className="table-wrap">
            <table className="cert-table">
              <thead>
                <tr>
                  <th>ID</th>
                  <th style={{ width: 240 }}>Articolo</th>
                  <th style={{ width: 200 }}>Famiglia</th>
                  <th>Vendor</th>
                  <th style={{ width: 150 }}>Codice vendor</th>
                  <th>Motivo</th>
                  <th>Reparto</th>
                  <th>Stato</th>
                  <th>Codifica finale</th>
                  <th>Agent</th>
                  <th title="Ticket del portale Product Certification">Cert.</th>
                  <th>Creato</th>
                  <th>Modificato</th>
                </tr>
              </thead>
              <tbody>
                {visible.map((t) => {
                  const isOpen = open.has(t.id)
                  return (
                    <Fragment key={t.id}>
                      <tr className="cert-row" onClick={() => toggle(open, t.id, setOpen)}>
                        <td className="nowrap">
                          <span className="wl-caret">{isOpen ? '▾' : '▸'}</span>
                          <a href={t.url} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()}>
                            {t.item_id}
                          </a>
                          {t.has_attachments && (
                            <span title="Con allegati" aria-label="Con allegati">
                              {' '}
                              📎
                            </span>
                          )}
                        </td>
                        <td>{t.description ?? dash}</td>
                        <td>{t.family ?? dash}</td>
                        <td>{t.vendor ?? dash}</td>
                        <td>{t.vendor_code ?? dash}</td>
                        <td>{t.change_reason ?? dash}</td>
                        <td>{t.department ?? dash}</td>
                        <td>{t.status && <span className={`badge ${statusClass(t.status)}`}>{t.status}</span>}</td>
                        <td className={isCode(t.final_coding) ? 'nowrap' : 'muted'}>
                          {isCode(t.final_coding) ? <strong>{t.final_coding}</strong> : (t.final_coding ?? '-')}
                        </td>
                        <td>{t.agent ?? dash}</td>
                        <td className="nowrap">
                          {t.certification_url ? (
                            <a
                              href={t.certification_url}
                              target="_blank"
                              rel="noreferrer"
                              onClick={(e) => e.stopPropagation()}
                            >
                              #{t.certification_ticket}
                            </a>
                          ) : (
                            (t.certification_ticket ?? dash)
                          )}
                        </td>
                        <td className="nowrap">{formatDate(t.created_at)}</td>
                        <td className="nowrap">{formatDate(t.modified_at)}</td>
                      </tr>
                      {isOpen && (
                        <tr className="cert-detail">
                          <td colSpan={13}>
                            <TicketDetail ticket={t} />
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

// Link alla lista SharePoint dei ticket: impostazione personale (un altro
// PJM puo' usare un'altra lista). Vuoto = quella predefinita.
function LinkSettings({ settings, onClose }: { settings: CommercialCodingSettings; onClose: () => void }) {
  const queryClient = useQueryClient()
  const { can } = useAuth()
  const [draft, setDraft] = useState(settings.list_url)
  const save = useMutation({
    mutationFn: (listUrl: string) => api.tools.commercialCoding.updateSettings({ list_url: listUrl }),
    onSuccess: (saved) => {
      queryClient.setQueryData(['commercial-coding-settings'], saved)
      queryClient.invalidateQueries({ queryKey: ['commercial-coding'] })
      setDraft(saved.list_url)
    },
  })
  const dirty = draft.trim() !== settings.list_url
  return (
    <div className="card rda-settings">
      <div className="form-row" style={{ marginBottom: 0 }}>
        <label htmlFor="cc-list-url">Link alla lista SharePoint dei ticket di Commercial Coding</label>
        <div style={{ display: 'flex', gap: 8 }}>
          <input
            id="cc-list-url"
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
          Apri la lista dei ticket in SharePoint e copia qui l'indirizzo dalla barra del browser (es.{' '}
          <code>…sharepoint.com/sites/Development/Lists/Tickets/AllItems.aspx</code>): vanno bene una vista qualsiasi
          e anche i filtri, ma si leggono sempre e solo i ticket creati dall'account Microsoft collegato al browser
          dell'app.
        </span>
        {save.isError && <div className="error-banner">{(save.error as Error).message}</div>}
      </div>
    </div>
  )
}

function TicketDetail({ ticket: t }: { ticket: CommercialCodingTicket }) {
  return (
    <div className="cert-detail-body">
      <div>
        <h4>Dati tecnici dell'articolo</h4>
        <dl className="cert-fields">
          {Object.entries(t.details).map(([label, value]) => (
            <Fragment key={label}>
              <dt>{label}</dt>
              <dd>{value || <span className="muted">-</span>}</dd>
            </Fragment>
          ))}
        </dl>
      </div>
      <p className="muted cert-detail-note">
        Creato da {t.author ?? '-'} · letto il{' '}
        {t.synced_at ? parseBackendDateTime(t.synced_at).toLocaleString('it-IT') : '-'} ·{' '}
        <a href={t.url} target="_blank" rel="noreferrer">
          apri in SharePoint
        </a>
      </p>
    </div>
  )
}
