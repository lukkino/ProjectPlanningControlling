import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useState, type ReactNode, type CSSProperties } from 'react'
import { api } from '../api/client'
import type { BacklogItem } from '../api/types'
import { StatusBadge } from '../components/StatusBadge'
import { countBacklogStats } from '../lib/backlogStats'
import { useProjectContext } from './useProjectContext'

// Giorni lavorativi (lun-ven, festivita' escluse) tra due date, estremi
// inclusi. Restituisce null se una delle due date manca o se fine < inizio.
function workingDaysBetween(startStr: string | null, endStr: string | null): number | null {
  if (!startStr || !endStr) return null
  const start = new Date(`${startStr}T00:00:00`)
  const end = new Date(`${endStr}T00:00:00`)
  if (end < start) return null

  let count = 0
  const cursor = new Date(start)
  while (cursor <= end) {
    const day = cursor.getDay() // 0 = domenica, 6 = sabato
    if (day !== 0 && day !== 6) count++
    cursor.setDate(cursor.getDate() + 1)
  }
  return count
}

const COLUMN_ORDER_STORAGE_KEY = 'backlog-column-order-v1'

type Column = {
  key: string
  label: string
  className?: string
  style?: CSSProperties
  render: (item: BacklogItem) => ReactNode
}

export function BacklogPage() {
  const { project } = useProjectContext()
  const queryClient = useQueryClient()
  const [onlyInScope, setOnlyInScope] = useState(true)
  const [hiddenTypes, setHiddenTypes] = useState<Set<string>>(new Set())
  const [newKey, setNewKey] = useState('')
  const [draggedId, setDraggedId] = useState<number | null>(null)
  const [draggedCol, setDraggedCol] = useState<string | null>(null)

  const { data: items } = useQuery({
    queryKey: ['backlog', project.id],
    queryFn: () => api.backlog.list(project.id),
  })

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ['backlog', project.id] })
    queryClient.invalidateQueries({ queryKey: ['dashboard', project.id] })
  }

  const update = useMutation({
    mutationFn: ({ id, data }: { id: number; data: Partial<BacklogItem> }) => api.backlog.update(id, data),
    onSuccess: invalidate,
  })
  const remove = useMutation({
    mutationFn: (id: number) => api.backlog.remove(id),
    onSuccess: invalidate,
  })
  const create = useMutation({
    mutationFn: () =>
      api.backlog.create(project.id, { jira_key: newKey.trim(), priority_order: (items?.length ?? 0) + 1 }),
    onSuccess: () => {
      setNewKey('')
      invalidate()
    },
  })
  const sync = useMutation({
    mutationFn: () => api.backlog.sync(project.id),
    onSuccess: invalidate,
  })

  const num = (v: string) => (v === '' ? null : Number(v))
  const dateOrNull = (v: string) => v || null

  const columns: Column[] = [
    {
      key: 'priority_order',
      label: '#',
      className: 'editable-cell',
      style: { width: 44 },
      render: (item) => (
        <input
          type="number"
          defaultValue={item.priority_order}
          onBlur={(e) => update.mutate({ id: item.id, data: { priority_order: Number(e.target.value) } })}
        />
      ),
    },
    {
      key: 'jira_key',
      label: 'Jira Key',
      render: (item) =>
        project.jira_jql ? (
          <a href={`https://inpeco.atlassian.net/browse/${item.jira_key}`} target="_blank" rel="noreferrer">
            {item.jira_key}
          </a>
        ) : (
          item.jira_key
        ),
    },
    {
      key: 'summary',
      label: 'Summary',
      style: { whiteSpace: 'normal', minWidth: 220 },
      render: (item) => item.summary ?? <span className="muted">—</span>,
    },
    {
      key: 'parent',
      label: 'Parent',
      style: { minWidth: 140 },
      render: (item) =>
        item.parent_key ? (
          project.jira_jql ? (
            <a
              href={`https://inpeco.atlassian.net/browse/${item.parent_key}`}
              target="_blank"
              rel="noreferrer"
              title={item.parent_summary ?? undefined}
            >
              {item.parent_key}
            </a>
          ) : (
            <span title={item.parent_summary ?? undefined}>{item.parent_key}</span>
          )
        ) : (
          <span className="muted">—</span>
        ),
    },
    { key: 'issue_type', label: 'Tipo', render: (item) => item.issue_type ?? '—' },
    { key: 'jira_status', label: 'Stato Jira', render: (item) => item.jira_status ?? '—' },
    {
      key: 'in_scope',
      label: 'In Scope',
      render: (item) => (
        <input
          type="checkbox"
          checked={item.in_scope}
          onChange={(e) => update.mutate({ id: item.id, data: { in_scope: e.target.checked } })}
        />
      ),
    },
    { key: 'status', label: 'Stato', render: (item) => <StatusBadge status={item.status} /> },
    {
      key: 'refinement_date',
      label: 'Data refinement',
      className: 'editable-cell',
      render: (item) => (
        <input
          defaultValue={item.refinement_date ?? ''}
          placeholder="gg/mm/aaaa o n.a."
          onBlur={(e) => {
            const value = e.target.value.trim() || null
            if (value !== item.refinement_date) update.mutate({ id: item.id, data: { refinement_date: value } })
          }}
        />
      ),
    },
    {
      key: 'ta_date',
      label: 'Data TA',
      className: 'editable-cell',
      style: { minWidth: 130 },
      render: (item) => (
        <input
          defaultValue={item.ta_date ?? ''}
          placeholder="gg/mm/aaaa o n.a."
          onBlur={(e) => {
            const value = e.target.value.trim() || null
            if (value !== item.ta_date) update.mutate({ id: item.id, data: { ta_date: value } })
          }}
        />
      ),
    },
    {
      key: 'planned_duration_days',
      label: 'Sizing (gg)',
      className: 'editable-cell',
      render: (item) => (
        <input
          type="number"
          defaultValue={item.planned_duration_days ?? ''}
          onBlur={(e) => update.mutate({ id: item.id, data: { planned_duration_days: num(e.target.value) } })}
        />
      ),
    },
    {
      key: 'dev_estimate_hours',
      label: 'Dev (h)',
      className: 'editable-cell',
      render: (item) => (
        <input
          type="number"
          defaultValue={item.dev_estimate_hours ?? ''}
          onBlur={(e) => update.mutate({ id: item.id, data: { dev_estimate_hours: num(e.target.value) } })}
        />
      ),
    },
    {
      key: 'test_estimate_hours',
      label: 'Test (h)',
      className: 'editable-cell',
      render: (item) => (
        <input
          type="number"
          defaultValue={item.test_estimate_hours ?? ''}
          onBlur={(e) => update.mutate({ id: item.id, data: { test_estimate_hours: num(e.target.value) } })}
        />
      ),
    },
    {
      key: 'planned_hours',
      label: 'Planned (h)',
      className: 'editable-cell',
      render: (item) => (
        <input
          type="number"
          defaultValue={item.planned_hours ?? ''}
          onBlur={(e) => update.mutate({ id: item.id, data: { planned_hours: num(e.target.value) } })}
        />
      ),
    },
    {
      key: 'planned_start',
      label: 'Start pian.',
      className: 'editable-cell',
      render: (item) => (
        <input
          type="date"
          defaultValue={item.planned_start ?? ''}
          onBlur={(e) => update.mutate({ id: item.id, data: { planned_start: dateOrNull(e.target.value) } })}
        />
      ),
    },
    {
      key: 'expected_finish',
      label: 'Fine pian.',
      className: 'editable-cell',
      render: (item) => (
        <input
          type="date"
          defaultValue={item.expected_finish ?? ''}
          onBlur={(e) => update.mutate({ id: item.id, data: { expected_finish: dateOrNull(e.target.value) } })}
        />
      ),
    },
    {
      key: 'actual_start',
      label: 'Start eff.',
      className: 'editable-cell',
      render: (item) => (
        <input
          type="date"
          defaultValue={item.actual_start ?? ''}
          onBlur={(e) => update.mutate({ id: item.id, data: { actual_start: dateOrNull(e.target.value) } })}
        />
      ),
    },
    {
      key: 'actual_finish',
      label: 'Fine eff.',
      className: 'editable-cell',
      render: (item) => (
        <input
          type="date"
          defaultValue={item.actual_finish ?? ''}
          onBlur={(e) => update.mutate({ id: item.id, data: { actual_finish: dateOrNull(e.target.value) } })}
        />
      ),
    },
    {
      key: 'duration',
      label: 'Durata (gg)',
      className: 'text-right',
      render: (item) => workingDaysBetween(item.actual_start, item.actual_finish) ?? <span className="muted">—</span>,
    },
    {
      key: 'logged_hours',
      label: 'Ore loggate',
      className: 'editable-cell',
      render: (item) => (
        <input
          type="number"
          defaultValue={item.logged_hours ?? ''}
          onBlur={(e) => update.mutate({ id: item.id, data: { logged_hours: num(e.target.value) } })}
        />
      ),
    },
    {
      key: 'notes',
      label: 'Note',
      className: 'editable-cell',
      style: { minWidth: 160 },
      render: (item) => (
        <input
          defaultValue={item.notes ?? ''}
          onBlur={(e) => update.mutate({ id: item.id, data: { notes: e.target.value || null } })}
        />
      ),
    },
  ]
  const defaultColumnOrder = columns.map((c) => c.key)

  const [columnOrder, setColumnOrder] = useState<string[]>(() => {
    try {
      const stored = localStorage.getItem(COLUMN_ORDER_STORAGE_KEY)
      if (stored) {
        const parsed = JSON.parse(stored) as string[]
        const known = parsed.filter((k) => defaultColumnOrder.includes(k))
        const missing = defaultColumnOrder.filter((k) => !known.includes(k))
        return [...known, ...missing]
      }
    } catch {
      // localStorage non disponibile o dato corrotto: usa l'ordine di default
    }
    return defaultColumnOrder
  })

  useEffect(() => {
    try {
      localStorage.setItem(COLUMN_ORDER_STORAGE_KEY, JSON.stringify(columnOrder))
    } catch {
      // ignora: e' solo una comodita' per-browser, non deve bloccare l'uso
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [columnOrder])

  const orderedColumns = columnOrder.map((key) => columns.find((c) => c.key === key)).filter((c): c is Column => !!c)

  const handleColumnDrop = (targetKey: string) => {
    if (draggedCol === null || draggedCol === targetKey) {
      setDraggedCol(null)
      return
    }
    setColumnOrder((prev) => {
      const list = [...prev]
      const fromIndex = list.indexOf(draggedCol)
      const toIndex = list.indexOf(targetKey)
      if (fromIndex === -1 || toIndex === -1) return prev
      const [moved] = list.splice(fromIndex, 1)
      list.splice(toIndex, 0, moved)
      return list
    })
    setDraggedCol(null)
  }

  const { inScopeCount, doneCount, remainingCount } = countBacklogStats(items ?? [])

  const availableTypes = Array.from(
    new Set((items ?? []).map((i) => i.issue_type).filter((t): t is string => !!t)),
  ).sort()
  const typeCounts = (items ?? []).reduce<Record<string, number>>((acc, i) => {
    if (i.issue_type) acc[i.issue_type] = (acc[i.issue_type] ?? 0) + 1
    return acc
  }, {})
  const toggleType = (type: string) => {
    setHiddenTypes((prev) => {
      const next = new Set(prev)
      if (next.has(type)) next.delete(type)
      else next.add(type)
      return next
    })
  }

  const visibleItems = (items ?? []).filter(
    (i) => (!onlyInScope || i.in_scope) && (!i.issue_type || !hiddenTypes.has(i.issue_type)),
  )

  const handleDrop = (targetId: number) => {
    if (draggedId === null || draggedId === targetId) {
      setDraggedId(null)
      return
    }
    const list = [...visibleItems]
    const fromIndex = list.findIndex((i) => i.id === draggedId)
    const toIndex = list.findIndex((i) => i.id === targetId)
    setDraggedId(null)
    if (fromIndex === -1 || toIndex === -1) return

    const [moved] = list.splice(fromIndex, 1)
    list.splice(toIndex, 0, moved)
    const newIndex = list.indexOf(moved)
    const prev = list[newIndex - 1]
    const next = list[newIndex + 1]

    let newOrder: number
    if (prev && next) newOrder = (prev.priority_order + next.priority_order) / 2
    else if (prev) newOrder = prev.priority_order + 1
    else if (next) newOrder = next.priority_order - 1
    else newOrder = 1

    update.mutate({ id: moved.id, data: { priority_order: newOrder } })
  }

  return (
    <div className="card">
      <div className="page-header" style={{ marginBottom: 12 }}>
        <div>
          <h3 style={{ margin: 0 }}>Backlog</h3>
          <span className="sub">
            {project.jira_jql ? (
              <span className="muted">JQL: {project.jira_jql}</span>
            ) : (
              <span className="muted">Nessuna JQL configurata — modificala nella scheda progetto per abilitare la sync.</span>
            )}
          </span>
        </div>
        <button className="btn btn-primary" onClick={() => sync.mutate()} disabled={!project.jira_jql || sync.isPending}>
          {sync.isPending ? 'Sincronizzazione...' : '⟳ Sincronizza da Jira'}
        </button>
      </div>

      <div className="grid-3" style={{ marginBottom: 16 }}>
        <div className="stat">
          <span className="value">{inScopeCount}</span>
          <span className="label">PBI in Scope</span>
        </div>
        <div className="stat">
          <span className="value">{doneCount}</span>
          <span className="label">Done</span>
        </div>
        <div className="stat">
          <span className="value">{remainingCount}</span>
          <span className="label">Rimanenti (In Progress + To Do)</span>
        </div>
      </div>

      {sync.isError && <div className="error-banner">{(sync.error as Error).message}</div>}
      {sync.isSuccess && (
        <div className="error-banner" style={{ background: '#e9f7ee', color: '#1a9c5c', borderColor: '#b8e3c8' }}>
          Sync completata: {sync.data.created} nuove issue, {sync.data.updated} aggiornate (totale trovate:{' '}
          {sync.data.total_matched}).
        </div>
      )}

      <div style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 16, marginBottom: 10, fontSize: 13 }}>
        <label style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <input type="checkbox" checked={onlyInScope} onChange={(e) => setOnlyInScope(e.target.checked)} />
          Mostra solo item "In Scope"
        </label>

        {availableTypes.length > 0 && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <span className="muted">Tipo:</span>
            {availableTypes.map((type) => (
              <label key={type} style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                <input type="checkbox" checked={!hiddenTypes.has(type)} onChange={() => toggleType(type)} />
                {type} ({typeCounts[type]})
              </label>
            ))}
          </div>
        )}
      </div>

      <div className="table-wrap">
        <table className="backlog-table">
          <thead>
            <tr>
              <th />
              {orderedColumns.map((col) => (
                <th
                  key={col.key}
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
                  title="Trascina per riordinare la colonna"
                >
                  {col.label}
                </th>
              ))}
              <th />
            </tr>
          </thead>
          <tbody>
            {visibleItems.map((item) => (
              <tr
                key={item.id}
                onDragOver={(e) => e.preventDefault()}
                onDrop={() => handleDrop(item.id)}
                style={draggedId === item.id ? { opacity: 0.4 } : undefined}
              >
                <td
                  draggable
                  onDragStart={(e) => {
                    setDraggedId(item.id)
                    e.dataTransfer.setData('text/plain', String(item.id))
                    e.dataTransfer.effectAllowed = 'move'
                  }}
                  onDragEnd={() => setDraggedId(null)}
                  className="drag-handle"
                  title="Trascina per riordinare"
                >
                  ⠿
                </td>
                {orderedColumns.map((col) => (
                  <td key={col.key} className={col.className} style={col.style}>
                    {col.render(item)}
                  </td>
                ))}
                <td>
                  <button className="btn btn-danger" onClick={() => remove.mutate(item.id)}>
                    ✕
                  </button>
                </td>
              </tr>
            ))}
            {visibleItems.length === 0 && (
              <tr>
                <td colSpan={orderedColumns.length + 2} className="muted">
                  Nessun item nel backlog. Sincronizza da Jira o aggiungine uno manualmente.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
        <input
          placeholder="Chiave Jira (es. PTBSYS-1234)"
          value={newKey}
          onChange={(e) => setNewKey(e.target.value)}
          style={{ width: 220 }}
        />
        <button className="btn" disabled={!newKey.trim() || create.isPending} onClick={() => create.mutate()}>
          + Aggiungi manualmente
        </button>
      </div>
    </div>
  )
}
