import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { createPortal } from 'react-dom'
import { useNavigate } from 'react-router-dom'
import { api } from '../api/client'
import { useSuggestions } from '../lib/useSuggestions'
import { Suggestion } from './Suggestion'
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
  jira_jql: '',
  scenarios_folder: '',
  review_documents_folder: '',
}

export function ProjectFormModal({ project, onClose }: Props) {
  const suggestions = useSuggestions()
  const [form, setForm] = useState(() =>
    project
      ? {
          code: project.code,
          name: project.name,
          status: project.status,
          scope: project.scope ?? '',
          jira_jql: project.jira_jql ?? '',
          scenarios_folder: project.scenarios_folder ?? '',
          review_documents_folder: project.review_documents_folder ?? '',
        }
      : emptyForm,
  )
  const queryClient = useQueryClient()
  const navigate = useNavigate()

  const save = useMutation({
    mutationFn: () => {
      const payload: Partial<Project> = {
        ...form,
        scope: form.scope || null,
        jira_jql: form.jira_jql || null,
        scenarios_folder: form.scenarios_folder.trim() || null,
        review_documents_folder: form.review_documents_folder.trim() || null,
      }
      // Lo Scope di un increment esistente si modifica direttamente dalla
      // Dashboard (ScopeCard, con formattazione): qui solo alla creazione.
      if (project) delete payload.scope
      return project ? api.projects.update(project.id, payload) : api.projects.create(payload)
    },
    onSuccess: (saved) => {
      queryClient.invalidateQueries({ queryKey: ['projects'] })
      queryClient.invalidateQueries({ queryKey: ['project', saved.id] })
      // Stato delle cartelle Scenarios e review (impostate in questo form).
      queryClient.invalidateQueries({ queryKey: ['scenarios', saved.id] })
      queryClient.invalidateQueries({ queryKey: ['review-folder', saved.id] })
      onClose()
      if (!project) navigate(`/projects/${saved.id}`)
    },
  })

  const set = <K extends keyof typeof form>(key: K, value: (typeof form)[K]) =>
    setForm((f) => ({ ...f, [key]: value }))

  // Nel body, non dove e' aperto: dalla sidebar il velo restava chiuso nel
  // suo livello e la barra in alto ci finiva sopra.
  return createPortal(
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
        {!project && (
          <div className="form-row">
            <label>Scope</label>
            <textarea rows={2} value={form.scope} onChange={(e) => set('scope', e.target.value)} />
          </div>
        )}
        <div className="form-row">
          <label>JQL Jira (issue del backlog di questo increment)</label>
          <textarea
            rows={2}
            value={form.jira_jql}
            onChange={(e) => set('jira_jql', e.target.value)}
            placeholder='project = PTBSYS AND fixVersion = "03-003 - October"'
          />
          {!form.jira_jql.trim() && form.code.trim() && (
            <Suggestion
              value={suggestions?.increment_jql_template?.split('{code}').join(form.code.trim())}
              source={suggestions?.source}
              onUse={(value) => set('jira_jql', value)}
            />
          )}
        </div>

        {/* Cartelle gia' create a mano su file system: qui solo il percorso. */}
        <div className="form-row">
          <label>Cartella Scenarios (presentazioni degli scenari delle Story)</label>
          <input
            value={form.scenarios_folder}
            onChange={(e) => set('scenarios_folder', e.target.value)}
            placeholder="C:\...\PTBSYS-03-003\Scenarios"
          />
        </div>
        <div className="form-row">
          <label>Cartella documenti delle review</label>
          <input
            value={form.review_documents_folder}
            onChange={(e) => set('review_documents_folder', e.target.value)}
            placeholder="C:\...\PTBSYS-03-003\Review"
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
    </div>,
    document.body,
  )
}
