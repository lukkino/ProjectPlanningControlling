const CLASS_BY_STATUS: Record<string, string> = {
  'To Do': 'todo',
  'In Progress': 'progress',
  Done: 'done',
}

export function StatusBadge({ status }: { status: string }) {
  return <span className={`badge ${CLASS_BY_STATUS[status] ?? 'todo'}`}>{status}</span>
}
