import { useQuery } from '@tanstack/react-query'
import { useState, type ReactNode } from 'react'
import { api } from '../api/client'
import type { MismatchCase, MismatchCaseReason, MismatchComplaint, MismatchLink } from '../api/types'
import { formatDateTime, formatIsoDate } from '../lib/dates'

// Sezione Disallineamenti dei Complaints: complaint Jira senza Case
// Salesforce e viceversa, Case con il JiraID sbagliato, stati diversi.
// Tutto dai dati dell'ultima "Sincronizza da Jira" (che legge anche
// Salesforce): la pagina non interroga niente da sola.

const JIRA_BROWSE_URL = 'https://inpeco.atlassian.net/browse/'
const caseUrl = (recordId: string) => `https://inpeco-force.lightning.force.com/lightning/r/Case/${recordId}/view`
const JIRA_BADGE_CLASS: Record<string, string> = { Done: 'done', Rejected: 'todo', 'To Do': 'todo' }
const JIRA_KEY_RE = /[A-Z][A-Z0-9]+-\d+/gi

const REASONS: Record<MismatchCaseReason, { label: string; title: string }> = {
  no_jira_key: { label: 'Senza JiraID', title: 'Il Case non ha nessuna chiave Jira: forse risolto senza aprire un bug' },
  other_project: {
    label: 'Altro progetto Jira',
    title: 'Il JiraID del Case è di un altro progetto (PAH, PTB, THUB...): fuori dalla JQL dei complaint',
  },
  not_a_complaint: {
    label: 'Issue PTBSYS non complaint',
    title: 'Il JiraID è un\'issue PTBSYS esclusa dalla JQL dei complaint (tipo diverso da Bug o Source Type diverso da Complaint)',
  },
  linked_elsewhere: {
    label: 'Complaint già su altro Case',
    title: 'Il JiraID è un complaint, ma quel complaint è collegato a un altro Case',
  },
}

// Il JiraID dei Case a volte e' un URL o contiene piu' chiavi: link a
// ognuna; se non c'e' nessuna chiave valida (es. "T-HUB 1727") il testo.
function JiraLink({ issueKey }: { issueKey: string | null }) {
  if (!issueKey) return <span className="muted">-</span>
  const keys = (issueKey.match(JIRA_KEY_RE) ?? []).map((k) => k.toUpperCase())
  if (keys.length === 0) return <span title="Non è una chiave Jira valida">{issueKey}</span>
  return (
    <span title={issueKey}>
      {keys.map((k, i) => (
        <span key={k}>
          {i > 0 && ', '}
          <a href={`${JIRA_BROWSE_URL}${k}`} target="_blank" rel="noreferrer">
            {k}
          </a>
        </span>
      ))}
    </span>
  )
}

const JiraStatus = ({ status }: { status: string | null }) =>
  status ? <span className={`badge ${JIRA_BADGE_CLASS[status] ?? 'progress'}`}>{status}</span> : <span className="muted">-</span>

const SfStatus = ({ status, closed }: { status: string | null; closed: boolean | null }) =>
  status ? (
    <span className={`mm-sf-status mm-sf-status--${closed ? 'closed' : 'open'}`}>{status}</span>
  ) : (
    <span className="muted">-</span>
  )

function Section({
  title,
  count,
  description,
  children,
}: {
  title: string
  count: number
  description: ReactNode
  children: ReactNode
}) {
  return (
    <div className="card">
      <h2 className="mm-title">
        {title} <span className={`mm-count${count > 0 ? ' mm-count--warn' : ''}`}>{count}</span>
      </h2>
      <p className="muted mm-description">{description}</p>
      {count === 0 ? <p className="muted">Nessuno 👍</p> : children}
    </div>
  )
}

function LinkTable({ links, highlight }: { links: MismatchLink[]; highlight: 'key' | 'status' }) {
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            <th>Case Salesforce</th>
            <th>Status Salesforce</th>
            <th>JiraID nel Case</th>
            <th>Complaint Jira</th>
            <th>Stato Jira</th>
            <th>Summary</th>
          </tr>
        </thead>
        <tbody>
          {links.map((l) => (
            <tr key={`${l.sf_record_id}-${l.complaint.jira_key}`}>
              <td className="nowrap">
                <a href={caseUrl(l.sf_record_id)} target="_blank" rel="noreferrer">
                  {l.sf_case_number ?? l.complaint.salesforce_case_number ?? l.sf_record_id}
                </a>
              </td>
              <td className={highlight === 'status' ? 'mm-hl' : undefined}>
                <SfStatus status={l.sf_status} closed={l.sf_closed} />
              </td>
              <td className={`nowrap${highlight === 'key' ? ' mm-hl' : ''}`}>
                {l.sf_jira_key ? <JiraLink issueKey={l.sf_jira_key} /> : <span className="muted">(vuoto)</span>}
              </td>
              <td className="nowrap">
                <JiraLink issueKey={l.complaint.jira_key} />
              </td>
              <td className={highlight === 'status' ? 'mm-hl' : undefined}>
                <JiraStatus status={l.complaint.jira_status} />
              </td>
              <td>{l.complaint.summary}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function ComplaintTable({ complaints }: { complaints: MismatchComplaint[] }) {
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            <th>Complaint Jira</th>
            <th>Stato Jira</th>
            <th>Creato</th>
            <th>ID Salesforce in Jira</th>
            <th>Summary</th>
          </tr>
        </thead>
        <tbody>
          {complaints.map((c) => (
            <tr key={c.jira_key}>
              <td className="nowrap">
                <JiraLink issueKey={c.jira_key} />
              </td>
              <td>
                <JiraStatus status={c.jira_status} />
              </td>
              <td className="nowrap">{formatIsoDate(c.jira_created) ?? '-'}</td>
              <td className="nowrap">
                {c.salesforce_case_number ?? <span className="muted">(vuoto)</span>}
                {c.legacy_ax && (
                  <span className="mm-tag" title="Ticket del vecchio sistema AX: non può essere in Salesforce">
                    AX
                  </span>
                )}
              </td>
              <td>{c.summary}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function CaseTable({ cases }: { cases: MismatchCase[] }) {
  const reasons = Object.keys(REASONS) as MismatchCaseReason[]
  const counts = new Map<MismatchCaseReason, number>()
  for (const c of cases) counts.set(c.reason, (counts.get(c.reason) ?? 0) + 1)
  const [hidden, setHidden] = useState<Set<string>>(new Set())
  const [onlyOpen, setOnlyOpen] = useState(false)
  const visible = cases.filter((c) => !hidden.has(c.reason) && (!onlyOpen || !c.is_closed))
  const openCount = cases.filter((c) => !c.is_closed).length
  return (
    <>
      <div className="filter-bar">
        <div className="filter-group">
          <span className="filter-group-label">Motivo</span>
          {reasons
            .filter((r) => counts.get(r))
            .map((r) => (
              <button
                key={r}
                type="button"
                className={`btn filter-btn${hidden.has(r) ? '' : ' active'}`}
                aria-pressed={!hidden.has(r)}
                title={REASONS[r].title}
                onClick={() =>
                  setHidden((prev) => {
                    const next = new Set(prev)
                    if (next.has(r)) next.delete(r)
                    else next.add(r)
                    return next
                  })
                }
              >
                {REASONS[r].label} <span className="muted">{counts.get(r)}</span>
              </button>
            ))}
        </div>
        <div className="filter-group">
          <span className="filter-group-label">Status</span>
          <button
            type="button"
            className={`btn filter-btn${onlyOpen ? ' active' : ''}`}
            aria-pressed={onlyOpen}
            onClick={() => setOnlyOpen((v) => !v)}
          >
            Solo aperti <span className="muted">{openCount}</span>
          </button>
        </div>
      </div>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Case Salesforce</th>
              <th>Creato</th>
              <th>Status</th>
              <th>Cliente</th>
              <th>JiraID nel Case</th>
              <th>Motivo</th>
            </tr>
          </thead>
          <tbody>
            {visible.map((c) => (
              <tr key={c.record_id}>
                <td className="nowrap">
                  <a href={caseUrl(c.record_id)} target="_blank" rel="noreferrer">
                    {c.case_number ?? c.record_id}
                  </a>
                </td>
                <td className="nowrap">{formatIsoDate(c.created) ?? '-'}</td>
                <td>
                  <SfStatus status={c.status} closed={c.is_closed} />
                </td>
                <td>{c.account ?? <span className="muted">-</span>}</td>
                <td className="nowrap">
                  <JiraLink issueKey={c.jira_key} />
                </td>
                <td title={REASONS[c.reason].title}>{REASONS[c.reason].label}</td>
              </tr>
            ))}
            {visible.length === 0 && (
              <tr>
                <td colSpan={6} className="muted">
                  Nessun Case con i filtri selezionati.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </>
  )
}

export function ComplaintsMismatchPage() {
  const { data, isLoading, error } = useQuery({ queryKey: ['complaint-mismatches'], queryFn: api.complaints.mismatches })

  if (isLoading) return <p className="muted">Caricamento…</p>
  if (error) return <div className="error-banner">{(error as Error).message}</div>
  if (!data) return null

  const notRead = !data.synced_at
  return (
    <div className="mm-page">
      <p className="muted" style={{ marginTop: 0 }}>
        Confronto tra i complaint Jira e i Case Salesforce, dai dati dell'ultima sincronizzazione
        {data.synced_at ? ` (Salesforce letto il ${formatDateTime(data.synced_at)})` : ''}. Case considerati:{' '}
        <b>{data.scope}</b>, creati dal primo complaint in poi ({data.scope_cases} Case).
      </p>
      {notRead && (
        <div className="error-banner">
          Salesforce non è ancora stato letto: premi <b>⟳ Sincronizza da Jira</b> (legge anche i Case Salesforce).
        </div>
      )}

      <Section
        title="Case con JiraID sbagliato"
        count={data.wrong_jira_link.length}
        description="Il complaint Jira cita questo Case, ma nel Case il campo JiraID è vuoto o punta a un'altra issue: da correggere in Salesforce."
      >
        <LinkTable links={data.wrong_jira_link} highlight="key" />
      </Section>

      <Section
        title="Stato diverso tra Jira e Salesforce"
        count={data.status_mismatch.length}
        description="Complaint chiuso su Jira (Done/Rejected) con il Case ancora aperto in Salesforce (esclusi i Case già Released o in attesa di installazione), oppure Case chiuso con il complaint ancora aperto su Jira."
      >
        <LinkTable links={data.status_mismatch} highlight="status" />
      </Section>

      <Section
        title="Complaint Jira senza Case Salesforce"
        count={data.complaints_without_case.length}
        description="Nessun Case trovato né per id del record, né per numero del case, né per JiraID. I riferimenti AX sono ticket del vecchio sistema, precedenti a Salesforce."
      >
        <ComplaintTable complaints={data.complaints_without_case} />
      </Section>

      <Section
        title="Case Salesforce senza complaint Jira"
        count={data.cases_without_complaint.length}
        description="Case del perimetro che nessun complaint cita e che non sono collegati a un complaint della JQL."
      >
        <CaseTable cases={data.cases_without_complaint} />
      </Section>
    </div>
  )
}
