import { useMutation, useQueryClient } from '@tanstack/react-query'
import { api } from '../api/client'
import type { BacklogItem } from '../api/types'

// Controllo dopo la sync Jira: ogni Story e Bug in scope deve essere nel code
// freeze, altrimenti non compare nei numeri (e, col filtro "solo code freeze",
// nemmeno in tabella), e un item nuovo puo' passare inosservato. Un item da
// non lavorare va messo fuori scope o tolto dalla fix version su Jira.
// Restano fuori dal controllo le Attivita' per Release (fuori dal code freeze
// per scelta) e i bug CVE (esclusi di default, vedi routers/backlog.py).
const CVE_PATTERN = /\bCVE\b/i

function itemsMissingFromCodeFreeze(items: BacklogItem[]): BacklogItem[] {
  return items.filter((i) => {
    const type = i.issue_type?.toLowerCase()
    if (type !== 'story' && type !== 'bug') return false
    if (!i.in_scope || i.included_in_codefreeze || i.is_activity) return false
    return !(type === 'bug' && CVE_PATTERN.test(i.summary ?? ''))
  })
}

export function CodeFreezeCheck({ projectId, items }: { projectId: number; items: BacklogItem[] | undefined }) {
  const queryClient = useQueryClient()
  const include = useMutation({
    mutationFn: (missing: BacklogItem[]) =>
      api.backlog.bulkUpdate(
        projectId,
        missing.map((i) => ({ id: i.id, included_in_codefreeze: true })),
      ),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['backlog', projectId] })
      queryClient.invalidateQueries({ queryKey: ['dashboard', projectId] })
    },
  })
  const missing = itemsMissingFromCodeFreeze(items ?? [])
  if (missing.length === 0) return null

  return (
    <div className="warning-banner codefreeze-check">
      <div>
        <strong>
          ⚠ {missing.length === 1 ? '1 Story/Bug in scope non è' : `${missing.length} Story/Bug in scope non sono`} nel
          code freeze
        </strong>{' '}
        <span>
          — non contano nei numeri e il filtro "Incluso in codefreeze" li nasconde. Se non vanno lavorati mettili fuori
          scope o cambia la fix version su Jira.
        </span>
      </div>
      <ul>
        {missing.map((i) => (
          <li key={i.id}>
            <strong>{i.jira_key}</strong> <span className="muted">({i.issue_type})</span> {i.summary}
          </li>
        ))}
      </ul>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <button className="btn btn-primary" disabled={include.isPending} onClick={() => include.mutate(missing)}>
          {include.isPending ? 'Salvataggio…' : 'Includi tutti nel code freeze'}
        </button>
        {include.isError && <span className="error-text">{(include.error as Error).message}</span>}
      </div>
    </div>
  )
}
