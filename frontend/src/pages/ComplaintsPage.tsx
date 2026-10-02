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

const JIRA_BADGE_CLASS: Record<string, string> = { Done: 'done', Rejected: 'todo', 'To Do': 'todo' }

type FilterGroupProps = {
  label: string
  options: string[]
  counts: Map<string, number>
  selected: Set<string>
  onToggle: (value: string) => void
}

// Gruppo di pulsanti-filtro: piu' valori attivi nello stesso gruppo si
// sommano (OR), nessuno attivo = nessun filtro su quel gruppo.
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
  const [salesforceFilter, setSalesforceFilter] = useState<Set<string>>(new Set())
  const [jiraFilter, setJiraFilter] = useState<Set<string>>(new Set())
  const [newestFirst, setNewestFirst] = useState(true)

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

  const architectureOptions = architectureCounts.has(NO_ARCHITECTURE) ? [...ARCHITECTURES, NO_ARCHITECTURE] : ARCHITECTURES
  const jiraOptions = [...jiraCounts.keys()]
    .filter(Boolean)
    .sort((a, b) => {
      const ia = JIRA_STATUS_ORDER.indexOf(a)
      const ib = JIRA_STATUS_ORDER.indexOf(b)
      return (ia === -1 ? JIRA_STATUS_ORDER.length : ia) - (ib === -1 ? JIRA_STATUS_ORDER.length : ib) || a.localeCompare(b)
    })

  // Ordinamento per data di creazione Jira (stringhe ISO yyyy-mm-dd,
  // confrontabili direttamente); a parita' di data per numero di issue, nello
  // stesso verso. I complaint senza data restano sempre in fondo.
  const direction = newestFirst ? -1 : 1
  const visible = all
    .filter(
      (c) =>
        (architectureFilter.size === 0 || architecturesOf(c).some((a) => architectureFilter.has(a))) &&
        (salesforceFilter.size === 0 || salesforceFilter.has(c.salesforce_status)) &&
        (jiraFilter.size === 0 || jiraFilter.has(c.jira_status ?? '')),
    )
    .sort((a, b) => {
      if (!a.jira_created || !b.jira_created) return (a.jira_created ? 0 : 1) - (b.jira_created ? 0 : 1)
      return (
        direction *
        (a.jira_created.localeCompare(b.jira_created) || a.jira_key.localeCompare(b.jira_key, undefined, { numeric: true }))
      )
    })
  const filtersActive = architectureFilter.size + salesforceFilter.size + jiraFilter.size > 0
  const clearFilters = () => {
    setArchitectureFilter(new Set())
    setSalesforceFilter(new Set())
    setJiraFilter(new Set())
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
            selected={salesforceFilter}
            onToggle={(v) => setSalesforceFilter((s) => toggled(s, v))}
          />
          <FilterGroup
            label="Stato Jira"
            options={jiraOptions}
            counts={jiraCounts}
            selected={jiraFilter}
            onToggle={(v) => setJiraFilter((s) => toggled(s, v))}
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
                <th aria-sort={newestFirst ? 'descending' : 'ascending'}>
                  <button
                    className="sort-btn"
                    title={
                      newestFirst
                        ? 'Dal più nuovo al più vecchio: clicca per invertire'
                        : 'Dal più vecchio al più nuovo: clicca per invertire'
                    }
                    onClick={() => setNewestFirst((v) => !v)}
                  >
                    Creato su Jira {newestFirst ? '▼' : '▲'}
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
                  <td colSpan={8} className="muted">
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
