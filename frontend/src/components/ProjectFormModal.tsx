import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { api } from '../api/client'
import type { Project } from '../api/types'

type Props = {
  project?: Project
  // Precompila il progetto collegato quando il modale viene aperto dalla
  // pagina di dettaglio di un progetto ("+ Nuovo increment in questo
  // progetto"), ignorato se si sta modificando un increment esistente.
  defaultIncrementId?: number
  onClose: () => void
}

const emptyForm = {
  code: '',
  name: '',
  status: 'Kick-off',
  scope: '',
  start_date: '',
  code_freeze_date: '',
  planned_finish_date: '',
  jira_jql: '',
  increment_id: null as number | null,
}

export function ProjectFormModal({ project, defaultIncrementId, onClose }: Props) {
  const [form, setForm] = useState(() =>
    project
      ? {
          code: project.code,
          name: project.name,
          status: project.status,
          scope: project.scope ?? '',
          start_date: project.start_date ?? '',
          code_freeze_date: project.code_freeze_date ?? '',
          planned_finish_date: project.planned_finish_date ?? '',
          jira_jql: project.jira_jql ?? '',
          increment_id: project.increment_id,
        }
      : { ...emptyForm, increment_id: defaultIncrementId ?? null },
  )
  const queryClient = useQueryClient()
  const navigate = useNavigate()

  const save = useMutation({
    mutationFn: () => {
      const payload = {
        ...form,
        start_date: form.start_date || null,
        code_freeze_date: form.code_freeze_date || null,
        planned_finish_date: form.planned_finish_date || null,
        scope: form.scope || null,
        jira_jql: form.jira_jql || null,
      }
      return project ? api.projects.update(project.id, payload) : api.projects.create(payload)
    },
    onSuccess: (saved) => {
      queryClient.invalidateQueries({ queryKey: ['projects'] })
      queryClient.invalidateQueries({ queryKey: ['project', saved.id] })
      if (saved.increment_id) queryClient.invalidateQueries({ queryKey: ['increment', saved.increment_id] })
      if (project?.increment_id && project.increment_id !== saved.increment_id) {
        queryClient.invalidateQueries({ queryKey: ['increment', project.increment_id] })
      }
      onClose()
      if (!project) navigate(`/projects/${saved.id}`)
    },
  })

  const set = <K extends keyof typeof form>(key: K, value: (typeof form)[K]) =>
    setForm((f) => ({ ...f, [key]: value }))

  return (
    // onMouseDown (non onClick) con controllo target===currentTarget: un
    // trascinamento per selezionare testo che parte dentro il modale e
    // termina fuori farebbe altrimenti scattare la chiusura, perche' il
    // click viene attribuito all'antenato comune (l'overlay) tra dove parte
    // il drag e dove finisce. Il mousedown invece e' valutato subito,
    // sull'elemento sotto il cursore in quel momento: chiude solo se il
    // press e' partito proprio sull'overlay (click "fuori" genuino).
    <div className="modal-overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" style={{ width: 560 }} onClick={(e) => e.stopPropagation()}>
        <h3>{project ? 'Modifica increment' : 'Nuovo increment'}</h3>

        <div className="form-row">
          <label>Codice increment</label>
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
        <div className="grid-3">
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
          <div className="form-row">
            <label>Planned finish</label>
            <input
              type="date"
              value={form.planned_finish_date}
              onChange={(e) => set('planned_finish_date', e.target.value)}
            />
          </div>
        </div>
        <div className="form-row">
          <label>JQL Jira (issue del backlog di questo increment)</label>
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
