import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { api } from '../api/client'
import type { Complaint, SalesforceStatus } from '../api/types'
import { ARCHITECTURES, NO_ARCHITECTURE, architecturesOf } from '../lib/complaints'
import { formatIsoDate } from '../lib/dates'

// Voce del menu Architettura che annulla la correzione manuale.
const RESET_TO_JIRA = '__jira__'
const SALESFORCE_STATUSES: SalesforceStatus[] = ['Aperto', 'Chiuso']
// Ordine dei pulsanti dello Stato Jira: quello del workflow, non alfabetico.
// Stati non previsti qui finiscono in coda.
const JIRA_STATUS_ORDER = ['To Do', 'Analysis', 'Confirmed', 'In Progress', 'On hold', 'Done', 'Rejected']

// Ordinamento per Severity: dalla piu' grave. Valori non previsti qui
// vengono dopo quelli noti.
const SEVERITY_ORDER = ['High', 'Medium', 'Low']
// Voce del filtro Severity per i complaint che non ce l'hanno.
const NO_SEVERITY = 'N/D'
const severityRank = (c: Complaint) => {
  const index = SEVERITY_ORDER.indexOf(c.severity ?? '')
  return index === -1 ? SEVERITY_ORDER.length : index
}

// Colonna su cui e' ordinata la tabella: desc = dal piu' nuovo (data) o
// dalla piu' grave (Severity).
type SortKey = 'created' | 'severity'
type Sort = { key: SortKey; desc: boolean }

const JIRA_BADGE_CLASS: Record<string, string> = { Done: 'done', Rejected: 'todo', 'To Do': 'todo' }

type FilterGroupProps = {
  label: string
  options: string[]
  counts: Map<string, number>
  selected: Set<string>
  onToggle: (value: string) => void
}

// Gruppo di pulsanti-filtro: piu' valori attivi nello stesso gruppo si
// sommano (OR). Architettura e Severity partono senza nessun valore attivo
// (= nessun filtro) e si accende cio' che si vuole vedere; i due gruppi di
// stato funzionano al contrario: tutti attivi all'inizio, e si spegne cio'
// che si vuole nascondere.
function FilterGroup({ label, options, counts, selected, onToggle }: FilterGroupProps) {
  return (
    <div className="filter-group">
      <span className="filter-group-label">{label}</span>
      {options.map((option) => (
        <button
          key={option}
          className={`btn filter-btn${selected.has(option) ? ' active' : ''}`}
          aria-pressed={selected.has(option)}
          onClick={() => onToggle(option)}
        >
          {option} <span className="muted">{counts.get(option) ?? 0}</span>
        </button>
      ))}
    </div>
  )
}

function countBy(items: Complaint[], keysOf: (c: Complaint) => string[]): Map<string, number> {
  const counts = new Map<string, number>()
  for (const item of items) for (const key of keysOf(item)) counts.set(key, (counts.get(key) ?? 0) + 1)
  return counts
}

function toggled(set: Set<string>, value: string): Set<string> {
  const next = new Set(set)
  if (!next.delete(value)) next.add(value)
  return next
}

function JqlSettings() {
  const queryClient = useQueryClient()
  const { data: settings } = useQuery({ queryKey: ['complaints-settings'], queryFn: api.complaints.getSettings })
  const [draft, setDraft] = useState<string | null>(null)

  const save = useMutation({
    mutationFn: (baseJql: string) => api.complaints.updateSettings({ base_jql: baseJql }),
    onSuccess: (saved) => {
      queryClient.setQueryData(['complaints-settings'], saved)
      setDraft(null)
    },
  })

  if (!settings) return null
  const value = draft ?? settings.base_jql
  const dirty = draft !== null && draft !== settings.base_jql

  return (
    <div className="form-row" style={{ marginBottom: 12 }}>
      <label>JQL base (le issue Jira da considerare complaint)</label>
      <div style={{ display: 'flex', gap: 8, alignItems: 'flex-start' }}>
        <textarea rows={2} style={{ flex: 1 }} value={value} onChange={(e) => setDraft(e.target.value)} />
        <button className="btn" disabled={!dirty || save.isPending} onClick={() => save.mutate(value)}>
          {save.isPending ? 'Salvataggio...' : 'Salva JQL'}
        </button>
      </div>
      {dirty && (
        <span className="muted" style={{ fontSize: 12 }}>
          JQL modificata e non ancora salvata: la sincronizzazione usa quella salvata. Lasciandola vuota si torna a
          quella predefinita.
        </span>
      )}
      {save.isError && <div className="error-banner">{(save.error as Error).message}</div>}
    </div>
  )
}

export function ComplaintsPage() {
  const queryClient = useQueryClient()
  const { data: complaints, isLoading } = useQuery({ queryKey: ['complaints'], queryFn: api.complaints.list })

  const [architectureFilter, setArchitectureFilter] = useState<Set<string>>(new Set())
  // Stati nascosti (pulsante spento): vuoto = si vedono tutti.
  const [salesforceHidden, setSalesforceHidden] = useState<Set<string>>(new Set())
  const [jiraHidden, setJiraHidden] = useState<Set<string>>(new Set())
  const [severityFilter, setSeverityFilter] = useState<Set<string>>(new Set())
  const [sort, setSort] = useState<Sort>({ key: 'created', desc: true })
  // Clic sull'intestazione: inverte il verso se la tabella e' gia' ordinata
  // su quella colonna, altrimenti ordina su quella (dal piu' nuovo / dalla
  // piu' grave).
  const sortBy = (key: SortKey) => setSort((s) => (s.key === key ? { key, desc: !s.desc } : { key, desc: true }))

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ['complaints'] })

  const update = useMutation({
    mutationFn: ({ id, data }: { id: number; data: Partial<Pick<Complaint, 'salesforce_status' | 'architecture' | 'customer_site'>> }) =>
      api.complaints.update(id, data),
    onSuccess: invalidate,
  })

  const all = complaints ?? []

  const architectureCounts = countBy(all, architecturesOf)
  const salesforceCounts = countBy(all, (c) => [c.salesforce_status])
  const jiraCounts = countBy(all, (c) => [c.jira_status ?? ''])
  const severityCounts = countBy(all, (c) => [c.severity ?? NO_SEVERITY])

  const architectureOptions = architectureCounts.has(NO_ARCHITECTURE) ? [...ARCHITECTURES, NO_ARCHITECTURE] : ARCHITECTURES
  const jiraOptions = [...jiraCounts.keys()]
    .filter(Boolean)
    .sort((a, b) => {
      const ia = JIRA_STATUS_ORDER.indexOf(a)
      const ib = JIRA_STATUS_ORDER.indexOf(b)
      return (ia === -1 ? JIRA_STATUS_ORDER.length : ia) - (ib === -1 ? JIRA_STATUS_ORDER.length : ib) || a.localeCompare(b)
    })

  // Dalla piu' grave; eventuali valori non previsti dopo quelli noti e N/D,
  // se serve, per ultimo.
  const severityOptions = [
    ...SEVERITY_ORDER,
    ...[...severityCounts.keys()].filter((s) => !SEVERITY_ORDER.includes(s) && s !== NO_SEVERITY).sort(),
    ...(severityCounts.has(NO_SEVERITY) ? [NO_SEVERITY] : []),
  ]

  // Ordinamento per data di creazione Jira (stringhe ISO yyyy-mm-dd,
  // confrontabili direttamente); a parita' di data per numero di issue, nello
  // stesso verso. I complaint senza data restano sempre in fondo.
  // Ordinando per Severity, quelli senza Severity restano sempre in fondo e a
  // parita' di Severity vale la data, dal piu' nuovo.
  const direction = sort.key === 'severity' || sort.desc ? -1 : 1
  const severityDirection = sort.desc ? 1 : -1
  const visible = all
    .filter(
      (c) =>
        (architectureFilter.size === 0 || architecturesOf(c).some((a) => architectureFilter.has(a))) &&
        !salesforceHidden.has(c.salesforce_status) &&
        !jiraHidden.has(c.jira_status ?? '') &&
        (severityFilter.size === 0 || severityFilter.has(c.severity ?? NO_SEVERITY)),
    )
    .sort((a, b) => {
      if (sort.key === 'severity' && a.severity !== b.severity) {
        if (!a.severity || !b.severity) return (a.severity ? 0 : 1) - (b.severity ? 0 : 1)
        return severityDirection * (severityRank(a) - severityRank(b) || a.severity.localeCompare(b.severity))
      }
      if (!a.jira_created || !b.jira_created) return (a.jira_created ? 0 : 1) - (b.jira_created ? 0 : 1)
      return (
        direction *
        (a.jira_created.localeCompare(b.jira_created) || a.jira_key.localeCompare(b.jira_key, undefined, { numeric: true }))
      )
    })
  const filtersActive = architectureFilter.size + salesforceHidden.size + jiraHidden.size + severityFilter.size > 0
  const clearFilters = () => {
    setArchitectureFilter(new Set())
    setSalesforceHidden(new Set())
    setJiraHidden(new Set())
    setSeverityFilter(new Set())
  }

  return (
    <div>
      <div className="card">
        <JqlSettings />

        {update.isError && <div className="error-banner">Salvataggio non riuscito: {(update.error as Error).message}</div>}

        <div className="filter-bar">
          <FilterGroup
            label="Architettura"
            options={architectureOptions}
            counts={architectureCounts}
            selected={architectureFilter}
            onToggle={(v) => setArchitectureFilter((s) => toggled(s, v))}
          />
          <FilterGroup
            label="Stato Salesforce"
            options={SALESFORCE_STATUSES}
            counts={salesforceCounts}
            selected={new Set(SALESFORCE_STATUSES.filter((s) => !salesforceHidden.has(s)))}
            onToggle={(v) => setSalesforceHidden((s) => toggled(s, v))}
          />
          <FilterGroup
            label="Stato Jira"
            options={jiraOptions}
            counts={jiraCounts}
            selected={new Set(jiraOptions.filter((s) => !jiraHidden.has(s)))}
            onToggle={(v) => setJiraHidden((s) => toggled(s, v))}
          />
          <FilterGroup
            label="Severity"
            options={severityOptions}
            counts={severityCounts}
            selected={severityFilter}
            onToggle={(v) => setSeverityFilter((s) => toggled(s, v))}
          />
        </div>

        <p className="muted" style={{ fontSize: 13 }}>
          {visible.length} di {all.length} complaint
          {filtersActive && (
            <>
              {' · '}
              <button className="link-btn" onClick={clearFilters}>
                Azzera filtri
              </button>
            </>
          )}
        </p>

        <div className="table-wrap table-wrap--scroll">
          <table className="complaints-table">
            <thead>
              <tr>
                <th>ID Salesforce</th>
                <th>Summary</th>
                <th>Stato Salesforce</th>
                <th>ID Jira</th>
                <th>Stato Jira</th>
                <th aria-sort={sort.key !== 'severity' ? undefined : sort.desc ? 'descending' : 'ascending'}>
                  <button
                    className="sort-btn"
                    title={
                      sort.key !== 'severity'
                        ? 'Clicca per ordinare per Severity, dalla più grave'
                        : sort.desc
                          ? 'Dalla più grave alla meno grave: clicca per invertire'
                          : 'Dalla meno grave alla più grave: clicca per invertire'
                    }
                    onClick={() => sortBy('severity')}
                  >
                    Severity{sort.key === 'severity' && (sort.desc ? ' ▼' : ' ▲')}
                  </button>
                </th>
                <th aria-sort={sort.key !== 'created' ? undefined : sort.desc ? 'descending' : 'ascending'}>
                  <button
                    className="sort-btn"
                    title={
                      sort.key !== 'created'
                        ? 'Clicca per ordinare per data di creazione, dal più nuovo'
                        : sort.desc
                          ? 'Dal più nuovo al più vecchio: clicca per invertire'
                          : 'Dal più vecchio al più nuovo: clicca per invertire'
                    }
                    onClick={() => sortBy('created')}
                  >
                    Creato su Jira{sort.key === 'created' && (sort.desc ? ' ▼' : ' ▲')}
                  </button>
                </th>
                <th>Architettura</th>
                <th>Sito Cliente</th>
              </tr>
            </thead>
            <tbody>
              {visible.map((c) => (
                <tr key={c.id}>
                  <td title={c.salesforce_case_id ? `Salesforce Case ID: ${c.salesforce_case_id}` : undefined}>
                    {c.salesforce_case_number ?? <span className="muted">-</span>}
                  </td>
                  <td style={{ whiteSpace: 'normal', minWidth: 320 }}>{c.summary}</td>
                  <td className="editable-cell">
                    <select
                      className={`sf-status sf-status--${c.salesforce_status === 'Chiuso' ? 'closed' : 'open'}`}
                      value={c.salesforce_status}
                      aria-label={`Stato Salesforce di ${c.jira_key}`}
                      onChange={(e) =>
                        update.mutate({ id: c.id, data: { salesforce_status: e.target.value as SalesforceStatus } })
                      }
                    >
                      {SALESFORCE_STATUSES.map((s) => (
                        <option key={s}>{s}</option>
                      ))}
                    </select>
                  </td>
                  <td>
                    <a href={`https://inpeco.atlassian.net/browse/${c.jira_key}`} target="_blank" rel="noreferrer">
                      {c.jira_key}
                    </a>
                  </td>
                  <td>
                    {c.jira_status && (
                      <span className={`badge ${JIRA_BADGE_CLASS[c.jira_status] ?? 'progress'}`}>{c.jira_status}</span>
                    )}
                  </td>
                  <td style={c.severity === 'High' ? { color: 'var(--danger)', fontWeight: 600 } : undefined}>
                    {c.severity ?? <span className="muted">-</span>}
                  </td>
                  <td>{formatIsoDate(c.jira_created) ?? <span className="muted">-</span>}</td>
                  <td className="editable-cell">
                    <select
                      value={c.architecture ?? ''}
                      aria-label={`Architettura di ${c.jira_key}`}
                      title={
                        c.architecture_manual
                          ? 'Impostata a mano: scegli "Valore da Jira" per tornare a quella ricavata dalle label'
                          : 'Ricavata dalle label Jira: scegli un valore per correggerla'
                      }
                      onChange={(e) =>
                        update.mutate({
                          id: c.id,
                          data: { architecture: e.target.value === RESET_TO_JIRA ? '' : e.target.value },
                        })
                      }
                    >
                      {!c.architecture && <option value="">-</option>}
                      {/* Valore da Jira fuori elenco (es. due label: "NA5, NA6"). */}
                      {c.architecture && !ARCHITECTURES.includes(c.architecture) && <option>{c.architecture}</option>}
                      {ARCHITECTURES.map((a) => (
                        <option key={a}>{a}</option>
                      ))}
                      {c.architecture_manual && <option value={RESET_TO_JIRA}>↺ Valore da Jira</option>}
                    </select>
                  </td>
                  {/* key: campo non controllato, va ricreato quando il valore salvato cambia. */}
                  <td className="editable-cell" style={{ minWidth: 190 }} key={c.customer_site ?? ''}>
                    <input
                      defaultValue={c.customer_site ?? ''}
                      placeholder="-"
                      title={
                        c.customer_site_manual
                          ? 'Inserito a mano: svuota il campo per tornare al valore ricavato dalle label Jira'
                          : 'Ricavato dalle label Jira: modificalo per correggerlo'
                      }
                      aria-label={`Sito Cliente di ${c.jira_key}`}
                      onBlur={(e) => {
                        const value = e.target.value.trim()
                        if (value !== (c.customer_site ?? '')) update.mutate({ id: c.id, data: { customer_site: value } })
                      }}
                    />
                  </td>
                </tr>
              ))}
              {visible.length === 0 && (
                <tr>
                  <td colSpan={9} className="muted">
                    {isLoading
                      ? 'Caricamento...'
                      : all.length === 0
                        ? 'Nessun complaint: premi "Sincronizza da Jira" per caricarli.'
                        : 'Nessun complaint corrisponde ai filtri selezionati.'}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  )
}
