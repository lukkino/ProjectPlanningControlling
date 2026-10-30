import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useRef, useState, type CSSProperties, type MouseEvent as ReactMouseEvent, type ReactNode } from 'react'
import { api, saveBlob } from '../api/client'
import type { Complaint, SalesforceStatus } from '../api/types'
import { ARCHITECTURES, NO_ARCHITECTURE, architecturesOf } from '../lib/complaints'
import { formatIsoDate } from '../lib/dates'

// Link ai case in Salesforce (Lightning). Con l'id tecnico del record
// (campo Jira "Salesforce Case ID") si apre direttamente il case; senza, si
// apre la ricerca di Salesforce sul numero del case.
const SALESFORCE_BASE_URL = 'https://inpeco-force.lightning.force.com'
const salesforceCaseUrl = (caseId: string) => `${SALESFORCE_BASE_URL}/lightning/r/Case/${caseId}/view`
const salesforceSearchUrl = (term: string) =>
  `${SALESFORCE_BASE_URL}/one/one.app#` +
  btoa(JSON.stringify({ componentDef: 'forceSearch:searchPage', attributes: { term, scopeMap: { type: 'TOP_RESULTS' } } }))

// Numeri di case Salesforce nel campo "ID Salesforce", a 8 cifre (in Jira
// spesso mancano gli zeri davanti: "53585" -> "00053585"). Il campo puo'
// averne piu' d'uno ("62995, 62957") o contenere ticket del vecchio sistema
// AX, che non sono in Salesforce: "AX 034877" e i numeri a 6 cifre con lo
// zero davanti ("032104"); in "AX 032314, SF: 50889" vale solo SF.
function salesforceCaseNumbers(value: string | null): string[] {
  if (!value) return []
  const sfPart = value.match(/SF\s*:\s*(.*)$/i)
  const text = sfPart ? sfPart[1] : value.replace(/AX\s*\d+/gi, '')
  return (text.match(/\d+/g) ?? [])
    .filter((n) => n.length <= 8 && !(n.length === 6 && n.startsWith('0')))
    .map((n) => n.padStart(8, '0'))
}

// Colonne della tabella: l'utente puo' nasconderle (menu "Colonne") e
// riordinarle trascinando l'intestazione, come nel Backlog. Ordine e colonne
// nascoste restano nel browser (localStorage); l'ID Jira resta sempre
// visibile, per riconoscere la riga.
const COLUMN_ORDER_STORAGE_KEY = 'complaints.columnOrder'
const HIDDEN_COLUMNS_STORAGE_KEY = 'complaints.hiddenColumns'
// Larghezze delle colonne (trascinando il bordo destro dell'intestazione),
// anche queste nel browser.
const COLUMN_WIDTHS_STORAGE_KEY = 'complaints.columnWidths'
const MIN_COLUMN_WIDTH = 40
const ALWAYS_VISIBLE_COLUMN_KEYS = new Set(['jira_key'])

type ComplaintColumn = {
  key: string
  label: string
  // Larghezza iniziale in pixel, finche' l'utente non la cambia. Senza
  // (Summary) la colonna prende lo spazio che resta nella card, cosi' la
  // tabella parte larga quanto la pagina.
  width?: number
  // Intestazione diversa dalla sola etichetta (colonne ordinabili).
  header?: ReactNode
  title?: string
  ariaSort?: 'ascending' | 'descending'
  className?: string
  style?: (c: Complaint) => CSSProperties | undefined
  render: (c: Complaint) => ReactNode
}

function readStoredList(storageKey: string): string[] | null {
  try {
    const stored = localStorage.getItem(storageKey)
    const parsed: unknown = stored ? JSON.parse(stored) : null
    return Array.isArray(parsed) ? parsed.filter((k): k is string => typeof k === 'string') : null
  } catch {
    // localStorage non disponibile o dato corrotto: valori di default.
    return null
  }
}

function readStoredWidths(): Record<string, number> {
  try {
    const stored = localStorage.getItem(COLUMN_WIDTHS_STORAGE_KEY)
    const parsed: unknown = stored ? JSON.parse(stored) : null
    if (!parsed || typeof parsed !== 'object') return {}
    return Object.fromEntries(
      Object.entries(parsed).filter((entry): entry is [string, number] => typeof entry[1] === 'number'),
    )
  } catch {
    // localStorage non disponibile o dato corrotto: larghezze di default.
    return {}
  }
}

function writeStoredList(storageKey: string, value: string[]) {
  try {
    localStorage.setItem(storageKey, JSON.stringify(value))
  } catch {
    // localStorage non disponibile: la scelta vale solo fino al ricaricamento.
  }
}

// Ordine salvato, senza le colonne che non esistono piu' e con quelle nuove
// inserite dopo la colonna che le precede nell'ordine di default.
function mergeColumnOrder(stored: string[] | null, defaults: string[]): string[] {
  if (!stored) return defaults
  const order = stored.filter((k) => defaults.includes(k))
  defaults.forEach((key, index) => {
    if (order.includes(key)) return
    const at = index === 0 ? -1 : order.indexOf(defaults[index - 1])
    order.splice(at + 1, 0, key)
  })
  return order
}

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
// Voce del filtro Fix Version per i complaint che non ce l'hanno.
const NO_FIX_VERSION = 'N/D'
// Le fix version di un complaint (su Jira possono essere piu' d'una, qui
// separate da ", "): conta per ognuna, nei conteggi e nel filtro.
const fixVersionsOf = (c: Complaint) => (c.fix_versions ? c.fix_versions.split(', ') : [NO_FIX_VERSION])

// Filtro TSB: complaint con o senza un'activity TSB collegata.
const WITH_TSB = 'Con TSB'
const WITHOUT_TSB = 'Senza TSB'
const TSB_OPTIONS = [WITH_TSB, WITHOUT_TSB]
const tsbOf = (c: Complaint) => (c.tsb_activities.length > 0 ? WITH_TSB : WITHOUT_TSB)
const severityRank = (c: Complaint) => {
  const index = SEVERITY_ORDER.indexOf(c.severity ?? '')
  return index === -1 ? SEVERITY_ORDER.length : index
}

// Colonna su cui e' ordinata la tabella: desc = dal piu' nuovo (data) o
// dalla piu' grave (Severity).
type SortKey = 'created' | 'severity'
type Sort = { key: SortKey; desc: boolean }

const JIRA_BADGE_CLASS: Record<string, string> = { Done: 'done', Rejected: 'todo', 'To Do': 'todo' }

// Ricerca libera: ogni parola deve comparire (senza distinzione di
// maiuscole) in uno dei campi testuali del complaint, ID compresi (anche i
// numeri di case a 8 cifre, se in Jira mancano gli zeri davanti).
const searchableText = (c: Complaint) =>
  [
    c.salesforce_case_number,
    ...salesforceCaseNumbers(c.salesforce_case_number),
    c.salesforce_case_id,
    c.jira_key,
    c.summary,
    c.customer_site,
    c.fix_versions,
    ...c.tsb_activities.map((a) => a.key),
    c.labels,
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase()
const matchesSearch = (c: Complaint, words: string[]) => {
  if (words.length === 0) return true
  const text = searchableText(c)
  return words.every((w) => text.includes(w))
}

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

// Stesso filtro di FilterGroup (nessun valore scelto = nessun filtro, piu'
// valori si sommano) ma in un menu a tendina con le checkbox: per i gruppi
// con molti valori (Fix Version), che a pulsanti occuperebbero piu' righe.
function FilterMenu({ label, options, counts, selected, onToggle, onClear }: FilterGroupProps & { onClear: () => void }) {
  const [open, setOpen] = useState(false)
  const summary = selected.size === 0 ? 'Tutte' : selected.size === 1 ? [...selected][0] : `${selected.size} selezionate`
  return (
    <div className="filter-group">
      <span className="filter-group-label">{label}</span>
      <div className="column-menu filter-menu">
        <button
          className={`btn filter-btn${selected.size > 0 ? ' active' : ''}`}
          aria-expanded={open}
          onClick={() => setOpen((o) => !o)}
        >
          {summary} ▾
        </button>
        {open && (
          <>
            <div className="column-menu-backdrop" onClick={() => setOpen(false)} />
            <div className="column-menu-panel">
              {options.map((option) => (
                <label key={option}>
                  <input type="checkbox" checked={selected.has(option)} onChange={() => onToggle(option)} />
                  {option} <span className="muted">{counts.get(option) ?? 0}</span>
                </label>
              ))}
              <button className="link-btn" disabled={selected.size === 0} onClick={onClear}>
                Mostra tutte
              </button>
            </div>
          </>
        )}
      </div>
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
  const [fixVersionFilter, setFixVersionFilter] = useState<Set<string>>(new Set())
  const [tsbFilter, setTsbFilter] = useState<Set<string>>(new Set())
  const [search, setSearch] = useState('')
  const searchWords = search.trim().toLowerCase().split(/\s+/).filter(Boolean)
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

  const exportExcel = useMutation({
    mutationFn: api.complaints.exportExcel,
    onSuccess: ({ blob, filename }) => saveBlob(blob, filename),
  })

  const all = complaints ?? []

  const architectureCounts = countBy(all, architecturesOf)
  const salesforceCounts = countBy(all, (c) => [c.salesforce_status])
  const jiraCounts = countBy(all, (c) => [c.jira_status ?? ''])
  const severityCounts = countBy(all, (c) => [c.severity ?? NO_SEVERITY])
  const fixVersionCounts = countBy(all, fixVersionsOf)
  const tsbCounts = countBy(all, (c) => [tsbOf(c)])

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

  // In ordine di nome (quindi di release: "PTBSYS-02-017" prima di
  // "PTBSYS-03-003"), con N/D per ultimo.
  const fixVersionOptions = [
    ...[...fixVersionCounts.keys()]
      .filter((v) => v !== NO_FIX_VERSION)
      .sort((a, b) => a.localeCompare(b, undefined, { numeric: true })),
    ...(fixVersionCounts.has(NO_FIX_VERSION) ? [NO_FIX_VERSION] : []),
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
        (severityFilter.size === 0 || severityFilter.has(c.severity ?? NO_SEVERITY)) &&
        (fixVersionFilter.size === 0 || fixVersionsOf(c).some((v) => fixVersionFilter.has(v))) &&
        (tsbFilter.size === 0 || tsbFilter.has(tsbOf(c))) &&
        matchesSearch(c, searchWords),
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
  const filtersActive =
    architectureFilter.size +
      salesforceHidden.size +
      jiraHidden.size +
      severityFilter.size +
      fixVersionFilter.size +
      tsbFilter.size >
      0 ||
    searchWords.length > 0
  const clearFilters = () => {
    setSearch('')
    setArchitectureFilter(new Set())
    setSalesforceHidden(new Set())
    setJiraHidden(new Set())
    setSeverityFilter(new Set())
    setFixVersionFilter(new Set())
    setTsbFilter(new Set())
  }

  const sortHeader = (key: SortKey, label: string, ascTitle: string, descTitle: string, clickTitle: string) => (
    <button
      className="sort-btn"
      title={sort.key !== key ? clickTitle : sort.desc ? descTitle : ascTitle}
      onClick={() => sortBy(key)}
    >
      {label}
      {sort.key === key && (sort.desc ? ' ▼' : ' ▲')}
    </button>
  )
  const ariaSortOf = (key: SortKey) => (sort.key !== key ? undefined : sort.desc ? 'descending' : 'ascending')

  const columns: ComplaintColumn[] = [
    { key: 'salesforce_case', label: 'ID Salesforce', width: 95, render: (c) => <SalesforceCaseLinks complaint={c} /> },
    { key: 'summary', label: 'Summary', render: (c) => c.summary },
    {
      key: 'salesforce_status',
      label: 'Stato Salesforce',
      width: 100,
      className: 'editable-cell',
      render: (c) => (
        <select
          className={`sf-status sf-status--${c.salesforce_status === 'Chiuso' ? 'closed' : 'open'}`}
          value={c.salesforce_status}
          aria-label={`Stato Salesforce di ${c.jira_key}`}
          onChange={(e) => update.mutate({ id: c.id, data: { salesforce_status: e.target.value as SalesforceStatus } })}
        >
          {SALESFORCE_STATUSES.map((s) => (
            <option key={s}>{s}</option>
          ))}
        </select>
      ),
    },
    {
      key: 'jira_key',
      label: 'ID Jira',
      width: 100,
      render: (c) => (
        <a href={`https://inpeco.atlassian.net/browse/${c.jira_key}`} target="_blank" rel="noreferrer">
          {c.jira_key}
        </a>
      ),
    },
    {
      key: 'jira_status',
      label: 'Stato Jira',
      width: 95,
      render: (c) =>
        c.jira_status && <span className={`badge ${JIRA_BADGE_CLASS[c.jira_status] ?? 'progress'}`}>{c.jira_status}</span>,
    },
    {
      key: 'fix_versions',
      label: 'Fix Version',
      width: 115,
      render: (c) => c.fix_versions ?? <span className="muted">-</span>,
    },
    {
      key: 'tsb',
      label: 'TSB',
      width: 100,
      title: 'Activity Jira collegata con "relates to" che riporta i dettagli del TSB',
      render: (c) =>
        c.tsb_activities.length === 0 ? (
          <span className="muted">-</span>
        ) : (
          c.tsb_activities.map((a, i) => (
            <span key={a.key}>
              {i > 0 && ', '}
              <a href={`https://inpeco.atlassian.net/browse/${a.key}`} target="_blank" rel="noreferrer" title={a.summary}>
                {a.key}
              </a>
            </span>
          ))
        ),
    },
    {
      key: 'tsb_status',
      label: 'TSB Status',
      width: 85,
      title: "Stato Jira dell'activity TSB",
      render: (c) =>
        c.tsb_activities.length === 0 ? (
          <span className="muted">-</span>
        ) : (
          c.tsb_activities.map((a) => (
            <div key={a.key} title={c.tsb_activities.length > 1 ? a.key : undefined}>
              {a.status ? (
                <span className={`badge ${JIRA_BADGE_CLASS[a.status] ?? 'progress'}`}>{a.status}</span>
              ) : (
                <span className="muted">-</span>
              )}
            </div>
          ))
        ),
    },
    {
      key: 'severity',
      label: 'Severity',
      width: 80,
      header: sortHeader(
        'severity',
        'Severity',
        'Dalla meno grave alla più grave: clicca per invertire',
        'Dalla più grave alla meno grave: clicca per invertire',
        'Clicca per ordinare per Severity, dalla più grave',
      ),
      ariaSort: ariaSortOf('severity'),
      style: (c) => (c.severity === 'High' ? { color: 'var(--danger)', fontWeight: 600 } : undefined),
      render: (c) => c.severity ?? <span className="muted">-</span>,
    },
    {
      key: 'created',
      label: 'Creato su Jira',
      width: 90,
      header: sortHeader(
        'created',
        'Creato su Jira',
        'Dal più vecchio al più nuovo: clicca per invertire',
        'Dal più nuovo al più vecchio: clicca per invertire',
        'Clicca per ordinare per data di creazione, dal più nuovo',
      ),
      ariaSort: ariaSortOf('created'),
      render: (c) => formatIsoDate(c.jira_created) ?? <span className="muted">-</span>,
    },
    {
      key: 'architecture',
      label: 'Architettura',
      width: 95,
      className: 'editable-cell',
      render: (c) => (
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
      ),
    },
    {
      key: 'customer_site',
      label: 'Sito Cliente',
      width: 140,
      className: 'editable-cell',
      // key: campo non controllato, va ricreato quando il valore salvato cambia.
      render: (c) => (
        <input
          key={c.customer_site ?? ''}
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
      ),
    },
  ]
  const defaultColumnOrder = columns.map((c) => c.key)

  const [columnOrder, setColumnOrder] = useState<string[]>(() =>
    mergeColumnOrder(readStoredList(COLUMN_ORDER_STORAGE_KEY), defaultColumnOrder),
  )
  useEffect(() => writeStoredList(COLUMN_ORDER_STORAGE_KEY, columnOrder), [columnOrder])
  const [hiddenColumns, setHiddenColumns] = useState<Set<string>>(
    () =>
      new Set(
        (readStoredList(HIDDEN_COLUMNS_STORAGE_KEY) ?? []).filter(
          (k) => defaultColumnOrder.includes(k) && !ALWAYS_VISIBLE_COLUMN_KEYS.has(k),
        ),
      ),
  )
  useEffect(() => writeStoredList(HIDDEN_COLUMNS_STORAGE_KEY, [...hiddenColumns]), [hiddenColumns])
  const [columnMenuOpen, setColumnMenuOpen] = useState(false)
  const [draggedCol, setDraggedCol] = useState<string | null>(null)

  const [columnWidths, setColumnWidths] = useState<Record<string, number>>(readStoredWidths)
  useEffect(() => {
    try {
      localStorage.setItem(COLUMN_WIDTHS_STORAGE_KEY, JSON.stringify(columnWidths))
    } catch {
      // localStorage non disponibile: la larghezza vale fino al ricaricamento.
    }
  }, [columnWidths])
  const widthOf = (col: ComplaintColumn): number | undefined => columnWidths[col.key] ?? col.width

  // Bordo destro dell'intestazione trascinato: nuova larghezza della colonna.
  const handleResizeStart = (e: ReactMouseEvent, key: string, startWidth: number) => {
    e.preventDefault()
    e.stopPropagation()
    const startX = e.clientX
    const onMouseMove = (moveEvent: MouseEvent) => {
      const nextWidth = Math.max(MIN_COLUMN_WIDTH, Math.round(startWidth + (moveEvent.clientX - startX)))
      setColumnWidths((prev) => ({ ...prev, [key]: nextWidth }))
    }
    const onMouseUp = () => {
      document.removeEventListener('mousemove', onMouseMove)
      document.removeEventListener('mouseup', onMouseUp)
      document.body.style.cursor = ''
    }
    document.body.style.cursor = 'col-resize'
    document.addEventListener('mousemove', onMouseMove)
    document.addEventListener('mouseup', onMouseUp)
  }

  // Intestazione sempre in vista scorrendo la pagina, come nel Backlog: con
  // larghezze fisse la tabella puo' superare la card e scorre in orizzontale
  // dentro .table-wrap, a cui si aggancerebbe lo sticky (in verticale non
  // scorre mai). Il "top" delle intestazioni (--thead-top) e' quindi quanto la
  // tabella e' gia' uscita dal bordo superiore della finestra.
  const tableWrapRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const updateTop = () => {
      const wrap = tableWrapRef.current
      if (wrap) wrap.style.setProperty('--thead-top', `${Math.max(0, -wrap.getBoundingClientRect().top)}px`)
    }
    updateTop()
    window.addEventListener('scroll', updateTop, { passive: true })
    window.addEventListener('resize', updateTop)
    return () => {
      window.removeEventListener('scroll', updateTop)
      window.removeEventListener('resize', updateTop)
    }
  }, [])

  const allOrderedColumns = columnOrder
    .map((key) => columns.find((c) => c.key === key))
    .filter((c): c is ComplaintColumn => !!c)
  const shownColumns = allOrderedColumns.filter((c) => !hiddenColumns.has(c.key))

  // Colonna trascinata sull'intestazione di un'altra: prende il suo posto.
  const handleColumnDrop = (targetKey: string) => {
    if (draggedCol !== null && draggedCol !== targetKey) {
      setColumnOrder((prev) => {
        const list = [...prev]
        const fromIndex = list.indexOf(draggedCol)
        const toIndex = list.indexOf(targetKey)
        if (fromIndex === -1 || toIndex === -1) return prev
        const [moved] = list.splice(fromIndex, 1)
        list.splice(toIndex, 0, moved)
        return list
      })
    }
    setDraggedCol(null)
  }

  return (
    <div>
      <div className="card">
        <JqlSettings />

        {update.isError && <div className="error-banner">Salvataggio non riuscito: {(update.error as Error).message}</div>}

        <div className="filter-bar">
          <div className="filter-group">
            <span className="filter-group-label">Cerca</span>
            <input
              type="search"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="ID Salesforce, ID Jira o testo…"
              aria-label="Cerca nei complaint"
              title="Cerca nell'ID Salesforce, nell'ID Jira, nel Summary, nel Sito Cliente, nelle Fix Version e nelle label. Più parole: devono comparire tutte."
              style={{ width: 280 }}
            />
          </div>
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
          <FilterMenu
            label="Fix Version"
            options={fixVersionOptions}
            counts={fixVersionCounts}
            selected={fixVersionFilter}
            onToggle={(v) => setFixVersionFilter((s) => toggled(s, v))}
            onClear={() => setFixVersionFilter(new Set())}
          />
          <FilterGroup
            label="TSB"
            options={TSB_OPTIONS}
            counts={tsbCounts}
            selected={tsbFilter}
            onToggle={(v) => setTsbFilter((s) => toggled(s, v))}
          />
        </div>

        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12 }}>
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
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <div className="column-menu">
            <button
              className="btn"
              aria-expanded={columnMenuOpen}
              title="Scegli quali colonne mostrare in tabella; per spostarle trascina le intestazioni"
              onClick={() => setColumnMenuOpen((open) => !open)}
            >
              Colonne{hiddenColumns.size > 0 && ` (${hiddenColumns.size} nascoste)`} ▾
            </button>
            {columnMenuOpen && (
              <>
                <div className="column-menu-backdrop" onClick={() => setColumnMenuOpen(false)} />
                <div className="column-menu-panel">
                  {allOrderedColumns.map((col) => (
                    <label key={col.key}>
                      <input
                        type="checkbox"
                        checked={!hiddenColumns.has(col.key)}
                        disabled={ALWAYS_VISIBLE_COLUMN_KEYS.has(col.key)}
                        onChange={() => setHiddenColumns((prev) => toggled(prev, col.key))}
                      />
                      {col.label}
                    </label>
                  ))}
                  <button className="link-btn" disabled={hiddenColumns.size === 0} onClick={() => setHiddenColumns(new Set())}>
                    Mostra tutte
                  </button>
                  <button
                    className="link-btn"
                    disabled={columnOrder.join() === defaultColumnOrder.join()}
                    onClick={() => setColumnOrder(defaultColumnOrder)}
                  >
                    Ripristina ordine
                  </button>
                  <button
                    className="link-btn"
                    disabled={Object.keys(columnWidths).length === 0}
                    onClick={() => setColumnWidths({})}
                  >
                    Ripristina larghezze
                  </button>
                </div>
              </>
            )}
          </div>
          <button
            className="btn"
            title="Scarica tutti i complaint in un file Excel con le intestazioni filtrabili (i filtri qui sopra non contano)"
            disabled={exportExcel.isPending || all.length === 0}
            onClick={() => exportExcel.mutate()}
          >
            {exportExcel.isPending ? 'Esportazione…' : '⬇ Esporta in Excel (.xlsx)'}
          </button>
          </div>
        </div>
        {exportExcel.isError && (
          <div className="error-banner">Esportazione non riuscita: {(exportExcel.error as Error).message}</div>
        )}

        <div className="table-wrap" ref={tableWrapRef}>
          <table className="complaints-table">
            <colgroup>
              {shownColumns.map((col) => (
                <col key={col.key} style={{ width: widthOf(col) }} />
              ))}
            </colgroup>
            <thead>
              <tr>
                {shownColumns.map((col) => (
                  <th
                    key={col.key}
                    aria-sort={col.ariaSort}
                    draggable
                    onDragStart={(e) => {
                      setDraggedCol(col.key)
                      e.dataTransfer.setData('text/plain', col.key)
                      e.dataTransfer.effectAllowed = 'move'
                    }}
                    onDragOver={(e) => e.preventDefault()}
                    onDrop={() => handleColumnDrop(col.key)}
                    onDragEnd={() => setDraggedCol(null)}
                    className="draggable-col"
                    style={draggedCol === col.key ? { opacity: 0.4 } : undefined}
                    title={`${col.title ? `${col.title}. ` : ''}Trascina per spostare la colonna`}
                  >
                    {col.header ?? col.label}
                    <span
                      className="col-resize-handle"
                      draggable={false}
                      onMouseDown={(e) => handleResizeStart(e, col.key, e.currentTarget.parentElement?.offsetWidth ?? 100)}
                      onDoubleClick={() =>
                        setColumnWidths((prev) => Object.fromEntries(Object.entries(prev).filter(([k]) => k !== col.key)))
                      }
                      onClick={(e) => e.stopPropagation()}
                      title="Trascina per ridimensionare la colonna (doppio clic: larghezza iniziale)"
                    />
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {visible.map((c) => (
                <tr key={c.id}>
                  {shownColumns.map((col) => (
                    <td key={col.key} className={col.className} style={col.style?.(c)}>
                      {col.render(c)}
                    </td>
                  ))}
                </tr>
              ))}
              {visible.length === 0 && (
                <tr>
                  <td colSpan={shownColumns.length} className="muted">
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

// Cella "ID Salesforce": link al case (diretto con il Case ID, altrimenti
// alla ricerca per numero a 8 cifre); i ticket AX restano testo semplice.
function SalesforceCaseLinks({ complaint: c }: { complaint: Complaint }) {
  if (c.salesforce_case_id) {
    return (
      <a
        href={salesforceCaseUrl(c.salesforce_case_id)}
        target="_blank"
        rel="noreferrer"
        title={`Apri il case in Salesforce (Case ID ${c.salesforce_case_id})`}
      >
        {c.salesforce_case_number ?? c.salesforce_case_id}
      </a>
    )
  }
  const numbers = salesforceCaseNumbers(c.salesforce_case_number)
  if (numbers.length === 0) return c.salesforce_case_number ?? <span className="muted">-</span>
  return (
    <span title={c.salesforce_case_number ?? undefined}>
      {numbers.map((n, i) => (
        <span key={n}>
          {i > 0 && ', '}
          <a href={salesforceSearchUrl(n)} target="_blank" rel="noreferrer" title={`Cerca il case ${n} in Salesforce`}>
            {n}
          </a>
        </span>
      ))}
    </span>
  )
}
