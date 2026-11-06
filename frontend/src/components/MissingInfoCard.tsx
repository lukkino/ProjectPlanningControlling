import { useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import { Link } from 'react-router-dom'
import { api } from '../api/client'
import type { BacklogItem, Phase, ProjectDetail } from '../api/types'

// "Da completare": le informazioni dell'increment che di solito si compilano
// (quelle usate da backlog, documenti, Release Notice, forecasting...) e qui
// mancano, ognuna con dove inserirla. Non compare se e' tutto a posto o se
// l'increment e' gia' rilasciato.
type Missing = { key: string; label: string; why: string; where: string; to?: string }

const COLLAPSED_KEY = 'ppc-missing-info-collapsed'

export function MissingInfoCard({
  project,
  phases,
  backlogItems,
}: {
  project: ProjectDetail
  phases: Phase[] | undefined
  backlogItems: BacklogItem[] | undefined
}) {
  // Stessa query (e cache) della tab Components & PN.
  const { data: release } = useQuery({
    queryKey: ['increment-release', project.id],
    queryFn: () => api.incrementComponents.release(project.id),
  })
  const [open, setOpen] = useState(() => {
    try {
      return localStorage.getItem(COLLAPSED_KEY) !== '1'
    } catch {
      return true
    }
  })
  if (project.release_date) return null

  const base = `/projects/${project.id}`
  const missing: Missing[] = []
  if (!project.jira_jql?.trim()) {
    missing.push({
      key: 'jql',
      label: 'JQL Jira',
      why: 'senza, il backlog non si sincronizza da Jira',
      where: 'pulsante Modifica in alto',
    })
  } else if (backlogItems && backlogItems.length === 0) {
    missing.push({
      key: 'backlog',
      label: 'Backlog',
      why: 'ancora vuoto: la JQL c’è ma non è mai stata fatta la sincronizzazione',
      where: 'Sincronizza da Jira, qui sopra',
    })
  }
  const undated = (phases ?? []).filter((p) => !p.planned_date).map((p) => p.name)
  if (undated.length > 0) {
    missing.push({
      key: 'phases',
      label: 'Date delle fasi',
      why: `senza data: ${undated.join(', ')}`,
      where: 'card Fasi increment, qui sotto',
    })
  }
  if (!project.scope?.trim()) {
    missing.push({ key: 'scope', label: 'Scope', why: 'cosa comprende l’increment', where: 'card Scope, qui sotto' })
  }
  if (!project.scope_narrative?.trim()) {
    missing.push({
      key: 'narrative',
      label: 'Scope discorsivo',
      why: 'serve a Change Order e Release Notice',
      where: 'card Scope, qui sotto',
    })
  }
  if (!project.dev_start_date) {
    missing.push({
      key: 'dev-start',
      label: 'Inizio sviluppi',
      why: 'il forecasting conta i PBI chiusi da quella data',
      where: 'tab Forecasting',
      to: `${base}/forecasting`,
    })
  }
  if (!project.change_order_label?.trim()) {
    missing.push({
      key: 'change-order',
      label: 'Change Order',
      why: 'usato da Release Report e Release Notice',
      where: 'tab Documents',
      to: `${base}/documents`,
    })
  }
  if (project.progetti.length === 0 && project.sub_projects.length === 0) {
    missing.push({
      key: 'progetti',
      label: 'Progetti collegati',
      why: 'su quali progetti (PTIH) si rendicontano le ore',
      where: 'tab Progetti',
      to: `${base}/progetti`,
    })
  }
  if (release !== undefined && (release?.components.length ?? 0) === 0) {
    missing.push({
      key: 'components',
      label: 'Componenti e PN',
      why: 'i componenti rilasciati, per Releases e Release Notice',
      where: 'tab Components & PN',
      to: `${base}/components`,
    })
  }
  if (!project.scenarios_folder?.trim()) {
    missing.push({
      key: 'scenarios',
      label: 'Cartella Scenarios',
      why: 'dove stanno le presentazioni degli scenari delle Story',
      where: 'pulsante Modifica in alto',
    })
  }
  if (!project.review_documents_folder?.trim()) {
    missing.push({
      key: 'reviews',
      label: 'Cartella documenti delle review',
      why: 'dove salvare i documenti generati in Documents',
      where: 'pulsante Modifica in alto',
    })
  }
  if (missing.length === 0) return null

  const toggle = () => {
    setOpen((value) => {
      try {
        localStorage.setItem(COLLAPSED_KEY, value ? '1' : '0')
      } catch {
        // storage non disponibile: vale solo per questa pagina
      }
      return !value
    })
  }

  return (
    <div className="card missing-info">
      <button type="button" className="missing-info-header" onClick={toggle} aria-expanded={open}>
        <span>💡 Da completare</span>
        <span className="missing-info-count">{missing.length}</span>
        <span className="muted" style={{ marginLeft: 'auto', fontSize: 12 }}>
          {open ? 'nascondi' : 'mostra'}
        </span>
      </button>
      {open && (
        <ul className="missing-info-list">
          {missing.map((m) => (
            <li key={m.key}>
              <strong>{m.label}</strong>
              <span className="muted"> — {m.why}. </span>
              {m.to ? <Link to={m.to}>{m.where} →</Link> : <span className="muted">Dove: {m.where}.</span>}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
