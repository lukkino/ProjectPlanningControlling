import { Fragment, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link } from 'react-router-dom'
import { api } from '../../api/client'
import type { CertificationTicket } from '../../api/types'
import { SyncProgressModal } from '../../components/SyncProgressModal'
import { useAuth } from '../../components/authContext'
import { formatDateTime, parseBackendDateTime } from '../../lib/dates'

// Tool Ticket certificazioni: i ticket del portale Product Certification
// (Freshservice), letti dal portale col browser dell'app (vedi
// backend/app/services/tools/certification_tickets.py).

// Colore dello stato: chiusi/risolti in verde, in attesa in arancione.
function statusClass(status: string | null): string {
  const s = (status ?? '').toLowerCase()
  if (s.includes('chius') || s.includes('soluzione') || s.includes('risolt')) return 'done'
  if (s.includes('attesa') || s.includes('sospeso')) return 'progress'
  return 'todo'
}

const field = (t: CertificationTicket, label: string) => t.item[label] || t.ticket[label] || null

const searchable = (t: CertificationTicket) =>
  [t.display_id, t.subject, t.status, t.assigned_to, ...Object.values(t.item), ...Object.values(t.ticket)]
    .filter(Boolean)
    .join(' ')
    .toLowerCase()

// Data di creazione nel portale (ora locale italiana, salvata cosi').
const formatCreated = (value: string | null) =>
  value ? new Date(value).toLocaleString('it-IT', { dateStyle: 'short', timeStyle: 'short' }) : '-'

const isUrl = (value: string) => /^https?:\/\//i.test(value)

const COLUMNS: { label: string; value: (t: CertificationTicket) => string | null; width?: number }[] = [
  // Nel portale "Articolo" e' la categoria (come la Sottocategoria): la
  // descrizione dell'articolo e' nel campo "Descrizione".
  { label: 'Articolo', value: (t) => field(t, 'Descrizione'), width: 220 },
  { label: 'Categoria', value: (t) => field(t, 'Sottocategoria') ?? field(t, 'Articolo'), width: 140 },
  { label: 'Manufacturer', value: (t) => field(t, 'Manufacturer'), width: 130 },
  { label: 'Codice Manufacturer', value: (t) => field(t, 'Codice Manufacturer'), width: 150 },
  { label: 'Inpeco Code', value: (t) => field(t, 'Inpeco Code'), width: 110 },
  { label: 'Linea di Prodotto', value: (t) => field(t, 'Linea di Prodotto'), width: 120 },
  { label: 'Priorità', value: (t) => field(t, 'Priorità'), width: 80 },
]

export function CertificationTicketsPage() {
  const { can } = useAuth()
  const queryClient = useQueryClient()
  const { data: tickets, isLoading, error } = useQuery({
    queryKey: ['certification-tickets'],
    queryFn: api.tools.certifications.list,
  })
  const sync = useMutation({
    mutationFn: api.tools.certifications.sync,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['certification-tickets'] }),
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

  return (
    <div>
      <div className="page-header">
        <div>
          <div className="sub">
            <Link to="/tools">Tools</Link> ›
          </div>
          <h1>🏷️ Ticket certificazioni</h1>
          <div className="sub">
            Portale{' '}
            <a href="https://inpeco-prodcertification.freshservice.com/support/tickets" target="_blank" rel="noreferrer">
              Product Certification
            </a>{' '}
            · Ultimo aggiornamento:{' '}
            {lastSync ? formatDateTime(lastSync) : 'mai'}
          </div>
        </div>
        {can('editor') && (
          <button className="btn btn-primary" onClick={() => sync.mutate()} disabled={sync.isPending}>
            {sync.isPending ? 'Lettura...' : '⟳ Aggiorna dal portale'}
          </button>
        )}
      </div>

      {sync.isPending && (
        <SyncProgressModal
          title="Ticket certificazioni"
          queryKey={['certification-tickets-progress']}
          fetchProgress={api.tools.certifications.syncProgress}
        />
      )}
      {sync.isError && <div className="error-banner">{(sync.error as Error).message}</div>}
      {sync.isSuccess && (
        <p className="muted" style={{ marginTop: 0 }}>
          Letti {sync.data.total} ticket: {sync.data.created} nuovi, {sync.data.updated} aggiornati
          {sync.data.removed > 0 && `, ${sync.data.removed} rimossi (non più nel portale)`}.
        </p>
      )}
      {error && <div className="error-banner">{(error as Error).message}</div>}

      <div className="card">
        <div className="cert-toolbar">
          <input
            type="search"
            placeholder="Cerca articolo, codice, manufacturer…"
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
            Nessun ticket salvato: premi <b>⟳ Aggiorna dal portale</b> per leggerli. Il login al portale avviene da solo
            con l'accesso Microsoft del browser dell'app (lo stesso dei Change Order).
          </p>
        ) : (
          <div className="table-wrap">
            <table className="cert-table">
              <thead>
                <tr>
                  <th>Ticket</th>
                  {COLUMNS.map((c) => (
                    <th key={c.label} style={{ width: c.width }}>
                      {c.label}
                    </th>
                  ))}
                  <th>Stato</th>
                  <th>Soluzione</th>
                  <th>Assegnato a</th>
                  <th>Creato</th>
                  <th title="Risposte nel ticket">💬</th>
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
                            {t.display_id ?? `#${t.ticket_id}`}
                          </a>
                        </td>
                        {COLUMNS.map((c) => (
                          <td key={c.label}>{c.value(t) ?? <span className="muted">-</span>}</td>
                        ))}
                        <td>{t.status && <span className={`badge ${statusClass(t.status)}`}>{t.status}</span>}</td>
                        <td>
                          {field(t, 'Soluzione Implementata') ? (
                            <span className="cert-clamp" title={field(t, 'Soluzione Implementata') ?? ''}>
                              {field(t, 'Soluzione Implementata')}
                            </span>
                          ) : (
                            <span className="muted">-</span>
                          )}
                        </td>
                        <td>{t.assigned_to ?? <span className="muted">-</span>}</td>
                        <td className="nowrap">{formatCreated(t.created_at)}</td>
                        <td className="num">{t.replies || ''}</td>
                      </tr>
                      {isOpen && (
                        <tr className="cert-detail">
                          <td colSpan={COLUMNS.length + 6}>
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

function TicketDetail({ ticket: t }: { ticket: CertificationTicket }) {
  const render = (value: string | null) =>
    !value ? <span className="muted">-</span> : isUrl(value) ? (
      <a href={value} target="_blank" rel="noreferrer">
        {value}
      </a>
    ) : (
      value
    )
  const group = (title: string, fields: Record<string, string | null>) => (
    <div>
      <h4>{title}</h4>
      <dl className="cert-fields">
        {Object.entries(fields).map(([label, value]) => (
          <Fragment key={label}>
            <dt>{label}</dt>
            <dd>{render(value)}</dd>
          </Fragment>
        ))}
      </dl>
    </div>
  )
  return (
    <div className="cert-detail-body">
      {group(`Richiesta${t.stage ? ` · fase ${t.stage}` : ''}`, t.item)}
      {group('Campi del ticket', t.ticket)}
      <p className="muted cert-detail-note">
        {t.subject} · letto il {t.synced_at ? parseBackendDateTime(t.synced_at).toLocaleString('it-IT') : '-'} ·{' '}
        <a href={t.url} target="_blank" rel="noreferrer">
          apri nel portale
        </a>
      </p>
    </div>
  )
}
