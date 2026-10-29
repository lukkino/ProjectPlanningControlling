const CLASS_BY_STATUS: Record<string, string> = {
  'To Do': 'todo',
  'In Progress': 'progress',
  Done: 'done',
}

// Colore dai 3 stati locali (status), testo dallo stato Jira se c'e' (es.
// "Ready" resta To Do per filtri e conteggi, ma si vede come Ready).
export function StatusBadge({ status, jiraStatus }: { status: string; jiraStatus?: string | null }) {
  const label = jiraStatus || status
  const className = label === 'Ready' ? 'ready' : (CLASS_BY_STATUS[status] ?? 'todo')
  return (
    <span className={`badge ${className}`} title={label !== status ? `Stato Jira ${label} (${status})` : undefined}>
      {label}
    </span>
  )
}
