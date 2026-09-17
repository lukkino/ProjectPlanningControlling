import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { api } from '../api/client'
import type { Increment } from '../api/types'

type Props = {
  increment?: Increment
  onClose: () => void
}

const emptyForm = {
  code: '',
  release_date: '',
  notes: '',
}

export function IncrementFormModal({ increment, onClose }: Props) {
  const [form, setForm] = useState(() =>
    increment
      ? {
          code: increment.code,
          release_date: increment.release_date ?? '',
          notes: increment.notes ?? '',
        }
      : emptyForm,
  )
  const queryClient = useQueryClient()
  const navigate = useNavigate()

  const save = useMutation({
    mutationFn: () => {
      const payload = {
        ...form,
        release_date: form.release_date || null,
        notes: form.notes || null,
      }
      return increment ? api.increments.update(increment.id, payload) : api.increments.create(payload)
    },
    onSuccess: (saved) => {
      queryClient.invalidateQueries({ queryKey: ['increments'] })
      queryClient.invalidateQueries({ queryKey: ['increment', saved.id] })
      onClose()
      if (!increment) navigate(`/increments/${saved.id}`)
    },
  })

  const set = <K extends keyof typeof form>(key: K, value: (typeof form)[K]) =>
    setForm((f) => ({ ...f, [key]: value }))

  return (
    <div className="modal-overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" style={{ width: 480 }} onClick={(e) => e.stopPropagation()}>
        <h3>{increment ? 'Modifica progetto' : 'Nuovo progetto'}</h3>

        <div className="form-row">
          <label>Codice progetto</label>
          <input value={form.code} onChange={(e) => set('code', e.target.value)} placeholder="PTBSYS-03-004" />
        </div>
        <div className="form-row">
          <label>Data di rilascio</label>
          <input type="date" value={form.release_date} onChange={(e) => set('release_date', e.target.value)} />
        </div>
        <div className="form-row">
          <label>Descrizione</label>
          <textarea rows={2} value={form.notes} onChange={(e) => set('notes', e.target.value)} />
        </div>

        {save.isError && <div className="error-banner">{(save.error as Error).message}</div>}

        <div className="form-actions">
          <button className="btn" onClick={onClose}>
            Annulla
          </button>
          <button className="btn btn-primary" disabled={!form.code || save.isPending} onClick={() => save.mutate()}>
            {save.isPending ? 'Salvataggio...' : 'Salva'}
          </button>
        </div>
      </div>
    </div>
  )
}
