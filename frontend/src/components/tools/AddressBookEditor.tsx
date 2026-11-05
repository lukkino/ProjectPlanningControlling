import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'

export type BookField<T> = { key: keyof T & string; label: string; multiline?: boolean }

// Gestione di una rubrica (indirizzi o persone): elenco a sinistra con
// ricerca, modulo della voce selezionata a destra. Il primo campo e'
// obbligatorio e identifica la voce.
export function AddressBookEditor<T extends { id: number }>({
  entries,
  fields,
  display,
  queryKey,
  create,
  update,
  remove,
}: {
  entries: T[]
  fields: BookField<Omit<T, 'id'>>[]
  display: (entry: T) => string
  queryKey: unknown[]
  create: (data: Omit<T, 'id'>) => Promise<T>
  update: (id: number, data: Omit<T, 'id'>) => Promise<T>
  remove: (id: number) => Promise<void>
}) {
  const queryClient = useQueryClient()
  const blank = () => Object.fromEntries(fields.map((f) => [f.key, ''])) as Omit<T, 'id'>
  const [selectedId, setSelectedId] = useState<number | null>(null)
  const [draft, setDraft] = useState<Omit<T, 'id'>>(blank)
  const [search, setSearch] = useState('')
  const [message, setMessage] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const done = (text: string) => {
    setError(null)
    setMessage(text)
    queryClient.invalidateQueries({ queryKey })
  }
  const save = useMutation({
    mutationFn: () => (selectedId === null ? create(draft) : update(selectedId, draft)),
    onSuccess: (saved) => {
      setSelectedId(saved.id)
      done(`"${display(saved)}" salvata in rubrica.`)
    },
    onError: (e: Error) => setError(e.message),
  })
  const del = useMutation({
    mutationFn: (id: number) => remove(id),
    onSuccess: () => {
      setSelectedId(null)
      setDraft(blank())
      done('Voce eliminata.')
    },
    onError: (e: Error) => setError(e.message),
  })

  const select = (entry: T) => {
    setSelectedId(entry.id)
    const { id: _id, ...rest } = entry
    setDraft(rest as Omit<T, 'id'>)
    setMessage(null)
    setError(null)
  }
  const reset = () => {
    setSelectedId(null)
    setDraft(blank())
    setMessage(null)
    setError(null)
  }
  const query = search.trim().toLowerCase()
  const shown = entries.filter((e) => !query || display(e).toLowerCase().includes(query))
  const selected = entries.find((e) => e.id === selectedId)
  const keyField = fields[0]
  const canSave = !!String(draft[keyField.key] ?? '').trim() && !save.isPending

  return (
    <div className="book-editor">
      <div className="book-editor-list">
        <input type="search" placeholder="Cerca…" aria-label="Cerca in rubrica" value={search} onChange={(e) => setSearch(e.target.value)} />
        <nav>
          {shown.map((entry) => (
            <button key={entry.id} className={entry.id === selectedId ? 'active' : ''} onClick={() => select(entry)}>
              {display(entry)}
            </button>
          ))}
          {shown.length === 0 && <p className="muted" style={{ fontSize: 13, margin: 8 }}>Nessuna voce.</p>}
        </nav>
        <button className="btn" onClick={reset}>
          + Nuova voce
        </button>
      </div>
      <div className="book-editor-form">
        <h3 style={{ marginTop: 0 }}>{selected ? display(selected) : 'Nuova voce'}</h3>
        {fields.map((field) => {
          const value = String(draft[field.key] ?? '')
          const onChange = (v: string) => setDraft((d) => ({ ...d, [field.key]: v }))
          return (
            <div key={field.key} className="form-row">
              <label htmlFor={`book-${field.key}`}>
                {field.label}
                {field === keyField && ' *'}
              </label>
              {field.multiline ? (
                <textarea id={`book-${field.key}`} rows={4} value={value} onChange={(e) => onChange(e.target.value)} />
              ) : (
                <input id={`book-${field.key}`} value={value} onChange={(e) => onChange(e.target.value)} />
              )}
            </div>
          )
        })}
        {error && <div className="error-banner">{error}</div>}
        {message && <p className="muted" style={{ fontSize: 13 }}>{message}</p>}
        <div className="form-actions">
          {selected && (
            <button
              className="btn btn-danger"
              disabled={del.isPending}
              onClick={() => confirm(`Eliminare "${display(selected)}" dalla rubrica?`) && del.mutate(selected.id)}
            >
              Elimina
            </button>
          )}
          <button className="btn btn-primary" disabled={!canSave} onClick={() => save.mutate()}>
            Salva voce
          </button>
        </div>
      </div>
    </div>
  )
}
