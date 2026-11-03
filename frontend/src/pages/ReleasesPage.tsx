import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Fragment, useState } from 'react'
import { Link } from 'react-router-dom'
import type { CSSProperties, DragEvent, ReactNode } from 'react'
import { api, saveBlob } from '../api/client'
import { RichText } from '../components/ScopeCard'
import type { Release, ReleaseComponent } from '../api/types'
import { DateInput } from '../components/DateInput'

const BLANK_LABEL = '(vuote)'
// Sfondo dei componenti dell'ultimo rilascio completato (giallo, come nel foglio).
const LATEST_RELEASE_BACKGROUND = '#fff6bf'

type Row = { release: Release; component: ReleaseComponent | null }

type Column = {
  key: string
  label: string
  // Dato della release (cella unica sulle righe dei suoi componenti) o del componente.
  level: 'release' | 'component'
  kind: 'text' | 'multiline' | 'date'
  minWidth: number
  // Testo centrato in orizzontale e in verticale sulle righe che la cella copre.
  centered?: boolean
  // Resta visibile a sinistra scorrendo la tabella in orizzontale.
  sticky?: boolean
}

const COLUMNS: Column[] = [
  { key: 'increment_code', label: 'Increment', level: 'release', kind: 'text', minWidth: 170, centered: true, sticky: true },
  { key: 'pn', label: 'PN', level: 'component', kind: 'text', minWidth: 120, centered: true },
  { key: 'component', label: 'Componente', level: 'component', kind: 'text', minWidth: 210 },
  { key: 'fix_version', label: 'Fix version', level: 'component', kind: 'text', minWidth: 80 },
  { key: 'detail', label: 'Dettaglio', level: 'component', kind: 'multiline', minWidth: 240 },
  { key: 'note', label: 'Note', level: 'component', kind: 'multiline', minWidth: 140 },
  { key: 'objective', label: 'Scopo', level: 'release', kind: 'multiline', minWidth: 280 },
  { key: 'start_date', label: 'Start Date', level: 'release', kind: 'date', minWidth: 125 },
  { key: 'expected_release_date', label: 'Expected Release', level: 'release', kind: 'date', minWidth: 125 },
  { key: 'actual_release_date', label: 'Actual Release', level: 'release', kind: 'date', minWidth: 125 },
  { key: 'duration', label: 'Durata Increment', level: 'release', kind: 'text', minWidth: 120, centered: true },
  { key: 'change_order', label: 'Change Order', level: 'release', kind: 'text', minWidth: 110 },
  { key: 'process', label: 'Process', level: 'release', kind: 'multiline', minWidth: 170 },
  { key: 'ptih_code', label: 'Project ID', level: 'release', kind: 'text', minWidth: 100, centered: true },
]

const formatDate = (value: string) => value.split('-').reverse().join('/')

// Durata di un increment chiuso, da Start Date ad Actual Release, in mesi
// di calendario e giorni (es. 4 mesi 13 giorni). Vuota finche' non e' rilasciato.
function durationLabel(release: Release): string {
  const { start_date: start, actual_release_date: end } = release
  if (!start || !end || end < start) return ''
  const [sy, sm, sd] = start.split('-').map(Number)
  const [ey, em, ed] = end.split('-').map(Number)
  let months = (ey - sy) * 12 + (em - sm)
  // Il mese non e' compiuto se il giorno di fine viene prima di quello di
  // inizio (per i mesi piu' corti vale l'ultimo giorno del mese).
  const anchor = (y: number, m: number) => Math.min(sd, new Date(Date.UTC(y, m, 0)).getUTCDate())
  if (ed < anchor(ey, em)) months -= 1
  const y = sy + Math.floor((sm - 1 + months) / 12)
  const m = ((sm - 1 + months) % 12) + 1
  const from = Date.UTC(y, m - 1, anchor(y, m))
  const days = Math.round((Date.UTC(ey, em - 1, ed) - from) / 86_400_000)
  const parts = []
  if (months > 0) parts.push(months === 1 ? '1 mese' : `${months} mesi`)
  if (days > 0 || months === 0) parts.push(days === 1 ? '1 giorno' : `${days} giorni`)
  return parts.join(' ')
}

const rawValue = (row: Row, column: Column): string => {
  if (column.key === 'duration') return durationLabel(row.release)
  const source = column.level === 'release' ? row.release : row.component
  if (!source) return ''
  return ((source as Record<string, unknown>)[column.key] as string | null) ?? ''
}

// Il valore come si legge: e' quello che usano filtri e ricerca.
const displayValue = (row: Row, column: Column): string => {
  const value = rawValue(row, column)
  if (column.kind === 'date' && value) return formatDate(value)
  return value
}

// Testo che si salva uscendo dal campo; key sul valore per riallinearlo dopo
// il salvataggio.
function EditableField({
  value,
  kind,
  label,
  onSave,
}: {
  value: string
  kind: Column['kind']
  label: string
  onSave: (value: string | null) => void
}) {
  const save = (next: string) => {
    if (next.trim() !== value) onSave(next.trim() || null)
  }
  if (kind === 'date') {
    return <DateInput value={value} aria-label={label} onChange={onSave} />
  }
  if (kind === 'multiline') {
    return (
      <textarea
        key={value}
        aria-label={label}
        defaultValue={value}
        rows={Math.max(1, value.split('\n').length)}
        onBlur={(e) => save(e.target.value)}
      />
    )
  }
  return (
    <input
      key={value}
      aria-label={label}
      defaultValue={value}
      onBlur={(e) => save(e.target.value)}
      onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
    />
  )
}

type OpenFilter = { column: Column; left: number; top: number }

function ColumnFilter({
  filter,
  options,
  selected,
  onToggle,
  onClear,
  onClose,
}: {
  filter: OpenFilter
  options: string[]
  selected: Set<string>
  onToggle: (value: string) => void
  onClear: () => void
  onClose: () => void
}) {
  return (
    <>
      <div className="releases-backdrop" onMouseDown={onClose} />
      <div className="releases-filter" style={{ left: filter.left, top: filter.top }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
          <strong>{filter.column.label}</strong>
          <button className="btn" onClick={onClear} disabled={selected.size === 0}>
            Azzera
          </button>
        </div>
        <div className="releases-filter-list">
          {options.map((value) => (
            <label key={value} title={value}>
              <input type="checkbox" checked={selected.has(value)} onChange={() => onToggle(value)} />
              <span>{value || BLANK_LABEL}</span>
            </label>
          ))}
        </div>
      </div>
    </>
  )
}

// Quante righe occupa la cella del PN: sulla prima di componenti consecutivi
// con lo stesso PN tutte quelle, sulle altre nessuna. PN vuoto: mai unito.
function pnSpan(rows: Row[], index: number): number {
  const pn = rows[index].component?.pn
  if (!pn) return 1
  if (rows[index - 1]?.component?.pn === pn) return 0
  let span = 1
  while (rows[index + span]?.component?.pn === pn) span += 1
  return span
}

// L'ultimo rilascio completato: la release con l'Actual Release piu' recente
// (date ISO, confrontabili come stringhe). Stessa regola dell'export Excel.
function latestCompletedReleaseId(releases: Release[]): number | null {
  let latest: Release | null = null
  for (const release of releases) {
    if (release.actual_release_date && (!latest || release.actual_release_date > (latest.actual_release_date as string))) {
      latest = release
    }
  }
  return latest?.id ?? null
}

// Righe visibili raggruppate per release, nell'ordine in cui arrivano.
function groupByRelease(rows: Row[]): Row[][] {
  const groups: Row[][] = []
  for (const row of rows) {
    const last = groups[groups.length - 1]
    if (last && last[0].release.id === row.release.id) last.push(row)
    else groups.push([row])
  }
  return groups
}

// Sezione Releases: release e componenti del sistema, modificabili qui.
// Nata dal foglio PTBSYS-03 del file dei componenti, importato una volta sola:
// ora il dato sta nell'app e il foglio si ottiene con "Esporta Excel".
export function ReleasesPage() {
  const queryClient = useQueryClient()
  const { data: releases, isLoading, error } = useQuery({ queryKey: ['releases'], queryFn: api.releases.list })
  const [search, setSearch] = useState('')
  const [filters, setFilters] = useState<Record<string, Set<string>>>({})
  const [openFilter, setOpenFilter] = useState<OpenFilter | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)

  const mutationOptions = {
    onSuccess: () => {
      setActionError(null)
      return queryClient.invalidateQueries({ queryKey: ['releases'] })
    },
    onError: (e: Error) => setActionError(e.message),
  }
  const updateRelease = useMutation({
    mutationFn: ({ id, field, value }: { id: number; field: string; value: string | null }) =>
      api.releases.update(id, { [field]: value }),
    ...mutationOptions,
  })
  const updateComponent = useMutation({
    mutationFn: ({ id, field, value }: { id: number; field: string; value: string | null }) =>
      api.releases.updateComponent(id, { [field]: value }),
    ...mutationOptions,
  })
  // Ordine delle release: e' anche quello in cui si susseguono i PN (il PN
  // proposto nella tab Components & PN segue quelli delle release sopra).
  const reorder = useMutation({
    mutationFn: (releaseIds: number[]) => api.releases.reorder(releaseIds),
    onSuccess: () => {
      setActionError(null)
      queryClient.invalidateQueries({ queryKey: ['component-catalog'] })
      return queryClient.invalidateQueries({ queryKey: ['releases'] })
    },
    onError: (e: Error) => setActionError(e.message),
  })
  // Trascinamento come nel Gantt del Backlog: si afferra la maniglia nella
  // cella Increment e si rilascia su un'altra release; la linea blu indica
  // dove finira' (sotto se si scende, sopra se si sale).
  const [dragId, setDragId] = useState<number | null>(null)
  const [dropId, setDropId] = useState<number | null>(null)
  const releaseIds = (releases ?? []).map((r) => r.id)
  const endDrag = () => {
    setDragId(null)
    setDropId(null)
  }
  const moveRelease = (movedId: number, targetId: number) => {
    const ids = [...releaseIds]
    const from = ids.indexOf(movedId)
    const to = ids.indexOf(targetId)
    if (from < 0 || to < 0 || from === to) return
    ids.splice(from, 1)
    ids.splice(to, 0, movedId)
    reorder.mutate(ids)
  }
  const dropHandlers = (releaseId: number) => ({
    onDragOver: (e: DragEvent<HTMLTableSectionElement>) => {
      if (dragId === null) return
      e.preventDefault()
      if (dropId !== releaseId) setDropId(releaseId)
    },
    onDrop: (e: DragEvent<HTMLTableSectionElement>) => {
      e.preventDefault()
      if (dragId !== null) moveRelease(dragId, releaseId)
      endDrag()
    },
  })
  // Lato della release su cui disegnare la linea blu, se e' quella sotto il
  // mouse durante il trascinamento.
  const dropSide = (releaseId: number): 'top' | 'bottom' | null => {
    if (dragId === null || dropId !== releaseId || dragId === releaseId) return null
    return releaseIds.indexOf(dragId) < releaseIds.indexOf(releaseId) ? 'bottom' : 'top'
  }
  const exportExcel = useMutation({
    mutationFn: api.releases.exportExcel,
    onSuccess: ({ blob, filename }) => saveBlob(blob, filename),
    onError: (e: Error) => setActionError(e.message),
  })

  const latestReleaseId = latestCompletedReleaseId(releases ?? [])
  const rows = (releases ?? []).flatMap<Row>((release) =>
    release.components.length > 0
      ? release.components.map((component) => ({ release, component }))
      : [{ release, component: null }],
  )

  const needle = search.trim().toLowerCase()
  const visibleRows = rows.filter(
    (row) =>
      COLUMNS.every((column) => {
        const selected = filters[column.key]
        return !selected || selected.size === 0 || selected.has(displayValue(row, column))
      }) && (!needle || COLUMNS.some((column) => displayValue(row, column).toLowerCase().includes(needle))),
  )
  const hasFilters = !!needle || Object.values(filters).some((selected) => selected.size > 0)

  const toggleValue = (key: string, value: string) => {
    setFilters((prev) => {
      const next = new Set(prev[key])
      if (next.has(value)) next.delete(value)
      else next.add(value)
      return { ...prev, [key]: next }
    })
  }

  const openColumnFilter = (column: Column, button: HTMLElement) => {
    const box = button.getBoundingClientRect()
    setOpenFilter({ column, left: Math.min(box.left, window.innerWidth - 280), top: box.bottom + 4 })
  }

  // covered: le righe che la cella copre (piu' di una se unita); la modifica
  // di una cella di componente unita vale per tutti i componenti coperti.
  const renderCell = (covered: Row[], column: Column, group: Row[]): ReactNode => {
    const row = covered[0]
    const style: CSSProperties = {
      whiteSpace: 'normal',
      // Le celle della release coprono tutte le sue righe: centrate in verticale.
      verticalAlign: column.centered || column.level === 'release' ? 'middle' : 'top',
      minWidth: column.minWidth,
    }
    const { release, component } = row
    const side = dropSide(release.id)
    if (side === 'top' && covered[0] === group[0]) style.boxShadow = 'inset 0 3px 0 var(--primary)'
    if (side === 'bottom' && covered[covered.length - 1] === group[group.length - 1]) {
      style.boxShadow = 'inset 0 -3px 0 var(--primary)'
    }
    if (column.level === 'component' && !component) {
      return (
        <td key={column.key} className="muted" style={style}>
          —
        </td>
      )
    }
    const components = covered.map((r) => r.component as ReleaseComponent)
    if (column.level === 'component' && release.id === latestReleaseId) {
      style.background = LATEST_RELEASE_BACKGROUND
    }
    // Durata: calcolata dalle date, si aggiorna da sola quando l'increment
    // viene rilasciato (Actual Release).
    if (column.key === 'duration') {
      return (
        <td
          key={column.key}
          rowSpan={covered.length > 1 ? covered.length : undefined}
          style={{ ...style, textAlign: 'center' }}
          title="Da Start Date ad Actual Release: calcolata quando l'increment è rilasciato"
        >
          {rawValue(row, column) || <span className="muted">—</span>}
        </td>
      )
    }
    // Scopo discorsivo dell'increment: sostituisce quello della release, qui
    // solo lettura (si modifica nella Dashboard dell'increment).
    if (column.key === 'objective' && release.scope_narrative && release.project_id != null) {
      return (
        <td key={column.key} rowSpan={covered.length > 1 ? covered.length : undefined} style={style}>
          <div
            className="releases-scope"
            title={`Scopo discorsivo dell'increment ${release.increment_code}: si modifica nella sua Dashboard`}
          >
            <RichText text={release.scope_narrative} />
          </div>
          <Link to={`/projects/${release.project_id}`} style={{ fontSize: 11 }}>
            Modifica nell'increment
          </Link>
        </td>
      )
    }
    // Date di un increment dell'app: vengono dall'increment, qui solo lettura.
    if (column.kind === 'date' && release.project_id != null) {
      const value = rawValue(row, column)
      return (
        <td key={column.key} rowSpan={covered.length > 1 ? covered.length : undefined} style={style}>
          <Link
            to={`/projects/${release.project_id}`}
            title={`Data dell'increment ${release.increment_code}: si modifica nell'increment (inizio dell'increment, fase Release to Market)`}
            style={{ color: 'inherit' }}
          >
            {value ? formatDate(value) : <span className="muted">—</span>}
          </Link>
        </td>
      )
    }
    const save = (value: string | null) => {
      if (column.level === 'release') {
        updateRelease.mutate({ id: release.id, field: column.key, value })
      } else {
        components.forEach((c) => updateComponent.mutate({ id: c.id, field: column.key, value }))
      }
    }
    return (
      <td
        key={column.key}
        className={`editable-cell${column.centered ? ' releases-centered' : ''}${column.sticky ? ' releases-sticky' : ''}`}
        rowSpan={covered.length > 1 ? covered.length : undefined}
        style={style}
      >
        {column.key === 'increment_code' ? (
          // Maniglia a sinistra del codice, per trascinare la release.
          <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
            <div
              className="releases-drag-handle"
              draggable={!reorder.isPending}
              title="Trascina per spostare la release: l'ordine è anche quello in cui si susseguono i PN"
              onDragStart={(e) => {
                setDragId(release.id)
                e.dataTransfer.setData('text/plain', String(release.id))
                e.dataTransfer.effectAllowed = 'move'
              }}
              onDragEnd={endDrag}
            >
              ⠿
            </div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <EditableField value={rawValue(row, column)} kind={column.kind} label={column.label} onSave={save} />
            </div>
          </div>
        ) : (
          <EditableField value={rawValue(row, column)} kind={column.kind} label={column.label} onSave={save} />
        )}
      </td>
    )
  }

  return (
    <div>
      <div className="card">
        <div className="page-header" style={{ marginBottom: 0 }}>
          <div>
            <h3 style={{ margin: 0 }}>Releases</h3>
            <span className="sub muted">Contenuto componenti PTBSYS-03 (New Architecture NA7). Le modifiche si salvano uscendo dal campo; le date degli increment vengono dall'increment. In giallo l'ultimo rilascio completato. Trascinando ⠿ si cambia l'ordine degli increment, che è anche quello in cui si susseguono i PN.</span>
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <button className="btn" onClick={() => exportExcel.mutate()} disabled={exportExcel.isPending}>
              {exportExcel.isPending ? 'Esportazione...' : '⬇ Esporta Excel'}
            </button>
          </div>
        </div>
      </div>

      <div className="card">
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap', marginBottom: 12 }}>
          <input
            type="search"
            placeholder="Cerca in tutte le colonne..."
            aria-label="Cerca in tutte le colonne"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            style={{ width: 320, maxWidth: '100%' }}
          />
          <span className="muted" style={{ fontSize: 13 }}>
            {visibleRows.length} righe su {rows.length}
          </span>
          {hasFilters && (
            <button
              className="btn"
              onClick={() => {
                setFilters({})
                setSearch('')
              }}
            >
              Azzera filtri
            </button>
          )}
        </div>

        {(error || actionError) && (
          <div className="error-banner">{actionError ?? (error as Error).message}</div>
        )}
        {isLoading && <p className="muted" style={{ margin: 0 }}>Caricamento...</p>}

        {releases && (
          <div className="table-wrap table-wrap--scroll" style={{ maxHeight: 'calc(100vh - 260px)' }}>
            <table>
              <thead>
                <tr>
                  {COLUMNS.map((column) => (
                    <th key={column.key} className={`releases-th${column.sticky ? ' releases-sticky' : ''}`}>
                      {column.label}{' '}
                      <button
                        type="button"
                        className={`releases-filter-btn${(filters[column.key]?.size ?? 0) > 0 ? ' active' : ''}`}
                        title={`Filtra ${column.label}`}
                        aria-label={`Filtra ${column.label}`}
                        onClick={(e) => openColumnFilter(column, e.currentTarget)}
                      >
                        ▾
                      </button>
                    </th>
                  ))}
                </tr>
              </thead>
              {/* Un tbody per release: il riquadro che la isola dalle altre. */}
              {groupByRelease(visibleRows).map((group, groupIndex) => (
                <Fragment key={group[0].release.id}>
                {groupIndex > 0 && (
                  <tbody className="releases-gap" aria-hidden="true">
                    <tr>
                      <td colSpan={COLUMNS.length} />
                    </tr>
                  </tbody>
                )}
                <tbody
                  className="releases-group"
                  style={dragId === group[0].release.id ? { opacity: 0.4 } : undefined}
                  {...dropHandlers(group[0].release.id)}
                >
                {group.map((row, index) => {
                  const first = index === 0
                  const { release, component } = row
                  return (
                    <tr key={`${release.id}-${component?.id ?? 'none'}`}>
                      {COLUMNS.map((column) => {
                        if (column.level === 'release') return first ? renderCell(group, column, group) : null
                        if (column.key !== 'pn') return renderCell([row], column, group)
                        const pnRows = pnSpan(group, index)
                        return pnRows > 0 ? renderCell(group.slice(index, index + pnRows), column, group) : null
                      })}
                    </tr>
                  )
                })}
                </tbody>
                </Fragment>
              ))}
              {visibleRows.length === 0 && (
                <tbody>
                  <tr>
                    <td colSpan={COLUMNS.length} className="muted">
                      Nessuna riga corrisponde ai filtri.
                    </td>
                  </tr>
                </tbody>
              )}
            </table>
          </div>
        )}
      </div>

      {openFilter && (
        <ColumnFilter
          filter={openFilter}
          options={Array.from(new Set(rows.map((row) => displayValue(row, openFilter.column))))}
          selected={filters[openFilter.column.key] ?? new Set()}
          onToggle={(value) => toggleValue(openFilter.column.key, value)}
          onClear={() => setFilters((prev) => ({ ...prev, [openFilter.column.key]: new Set() }))}
          onClose={() => setOpenFilter(null)}
        />
      )}
    </div>
  )
}
