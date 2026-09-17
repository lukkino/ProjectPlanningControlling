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
  start_date: '',
  end_date: '',
  notes: '',
  estimated_budget_hours: 0,
  estimated_budget_material: 0,
}

export function IncrementFormModal({ increment, onClose }: Props) {
  const [form, setForm] = useState(() =>
    increment
      ? {
          code: increment.code,
          start_date: increment.start_date ?? '',
          end_date: increment.end_date ?? '',
          notes: increment.notes ?? '',
          estimated_budget_hours: increment.estimated_budget_hours,
          estimated_budget_material: increment.estimated_budget_material,
        }
      : emptyForm,
  )
  const queryClient = useQueryClient()
  const navigate = useNavigate()

  const save = useMutation({
    mutationFn: () => {
      const payload = {
        ...form,
        start_date: form.start_date || null,
        end_date: form.end_date || null,
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
          <input value={form.code} onChange={(e) => set('code', e.target.value)} placeholder="PTIH-PT13" />
        </div>
        <div className="form-row">
          <label>Descrizione</label>
          <textarea rows={2} value={form.notes} onChange={(e) => set('notes', e.target.value)} />
        </div>
        <div className="grid-2">
          <div className="form-row">
            <label>Data inizio</label>
            <input type="date" value={form.start_date} onChange={(e) => set('start_date', e.target.value)} />
          </div>
          <div className="form-row">
            <label>Data fine</label>
            <input type="date" value={form.end_date} onChange={(e) => set('end_date', e.target.value)} />
          </div>
        </div>
        <div className="grid-2">
          <div className="form-row">
            <label>Budget ore stimate</label>
            <input
              type="number"
              value={form.estimated_budget_hours}
              onChange={(e) => set('estimated_budget_hours', Number(e.target.value))}
            />
          </div>
          <div className="form-row">
            <label>Budget materiali (€)</label>
            <input
              type="number"
              value={form.estimated_budget_material}
              onChange={(e) => set('estimated_budget_material', Number(e.target.value))}
            />
          </div>
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
