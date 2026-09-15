import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { api } from '../api/client'
import type { Project } from '../api/types'

type Props = {
  project?: Project
  onClose: () => void
}

const emptyForm = {
  code: '',
  name: '',
  status: 'Kick-off',
  scope: '',
  start_date: '',
  code_freeze_date: '',
  estimated_budget_hours: 0,
  estimated_budget_material: 0,
  jira_jql: '',
}

export function ProjectFormModal({ project, onClose }: Props) {
  const [form, setForm] = useState(() =>
    project
      ? {
          code: project.code,
          name: project.name,
          status: project.status,
          scope: project.scope ?? '',
          start_date: project.start_date ?? '',
          code_freeze_date: project.code_freeze_date ?? '',
          estimated_budget_hours: project.estimated_budget_hours,
          estimated_budget_material: project.estimated_budget_material,
          jira_jql: project.jira_jql ?? '',
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
        code_freeze_date: form.code_freeze_date || null,
        scope: form.scope || null,
        jira_jql: form.jira_jql || null,
      }
      return project ? api.projects.update(project.id, payload) : api.projects.create(payload)
    },
    onSuccess: (saved) => {
      queryClient.invalidateQueries({ queryKey: ['projects'] })
      queryClient.invalidateQueries({ queryKey: ['project', saved.id] })
      onClose()
      if (!project) navigate(`/projects/${saved.id}`)
    },
  })

  const set = <K extends keyof typeof form>(key: K, value: (typeof form)[K]) =>
    setForm((f) => ({ ...f, [key]: value }))

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h3>{project ? 'Modifica progetto' : 'Nuovo progetto'}</h3>

        <div className="form-row">
          <label>Codice progetto</label>
          <input value={form.code} onChange={(e) => set('code', e.target.value)} placeholder="PTBSYS-03-003" />
        </div>
        <div className="form-row">
          <label>Nome</label>
          <input value={form.name} onChange={(e) => set('name', e.target.value)} placeholder="ProTube System Project" />
        </div>
        <div className="form-row">
          <label>Scope</label>
          <textarea rows={2} value={form.scope} onChange={(e) => set('scope', e.target.value)} />
        </div>
        <div className="grid-2">
          <div className="form-row">
            <label>Project start</label>
            <input type="date" value={form.start_date} onChange={(e) => set('start_date', e.target.value)} />
          </div>
          <div className="form-row">
            <label>Code freeze</label>
            <input
              type="date"
              value={form.code_freeze_date}
              onChange={(e) => set('code_freeze_date', e.target.value)}
            />
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
        <div className="form-row">
          <label>JQL Jira (issue del backlog di questo progetto)</label>
          <textarea
            rows={2}
            value={form.jira_jql}
            onChange={(e) => set('jira_jql', e.target.value)}
            placeholder='project = PTBSYS AND fixVersion = "03-003 - October"'
          />
        </div>

        {save.isError && <div className="error-banner">{(save.error as Error).message}</div>}

        <div className="form-actions">
          <button className="btn" onClick={onClose}>
            Annulla
          </button>
          <button className="btn btn-primary" disabled={!form.code || !form.name || save.isPending} onClick={() => save.mutate()}>
            {save.isPending ? 'Salvataggio...' : 'Salva'}
          </button>
        </div>
      </div>
    </div>
  )
}
