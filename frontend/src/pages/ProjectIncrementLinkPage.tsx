import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { Link } from 'react-router-dom'
import { api } from '../api/client'
import { formatIsoDate } from '../lib/dates'
import { useProjectContext } from './useProjectContext'

// Cosa si collega all'increment: un progetto intero oppure un suo
// sotto-progetto. Nel menu il valore e' "kind:id".
type LinkTarget = { kind: 'progetto' | 'sub'; id: number }

// Tab "Progetti" di un increment: mostra/gestisce quali progetti (entita'
// con codice tipo PTIH-PT13, budget e durata) rendicontano le ore su questo
// increment. Un increment puo' averne piu' di uno (es. un progetto
// "principale" + uno di maintenance). Un progetto si collega per intero -
// e allora appartiene a un solo increment (il lato singolo si gestisce dalla
// pagina del progetto) - oppure tramite i suoi sotto-progetti, ognuno
// collegabile a un increment diverso; mai in entrambi i modi.
export function ProjectIncrementLinkPage() {
  const { project } = useProjectContext()
  const [picked, setPicked] = useState('')
  const queryClient = useQueryClient()

  const { data: allProgetti } = useQuery({ queryKey: ['increments'], queryFn: api.increments.list })

  // projectId null = scollega. previousProjectId: l'increment a cui era
  // collegato prima, se diverso da questo, che lo perde.
  const setLink = useMutation({
    mutationFn: ({ target, projectId }: { target: LinkTarget; projectId: number | null; progettoId: number; previousProjectId?: number | null }) =>
      target.kind === 'progetto'
        ? api.increments.update(target.id, { project_id: projectId })
        : api.subProjects.update(target.id, { project_id: projectId }),
    onSuccess: (_saved, { progettoId, previousProjectId }) => {
      for (const projectId of [project.id, previousProjectId]) {
        if (projectId == null) continue
        queryClient.invalidateQueries({ queryKey: ['project', projectId] })
        // Il budget ore della Dashboard e' la somma di progetti e
        // sotto-progetti collegati.
        queryClient.invalidateQueries({ queryKey: ['dashboard', projectId] })
      }
      queryClient.invalidateQueries({ queryKey: ['increment', progettoId] })
      queryClient.invalidateQueries({ queryKey: ['increments'] })
    },
  })

  const linkedIds = new Set(project.progetti.map((p) => p.id))
  const linkedSubIds = new Set(project.sub_projects.map((s) => s.id))
  const progettoById = new Map((allProgetti ?? []).map((p) => [p.id, p]))

  // Voci del menu: ogni progetto non ancora collegato qui, seguito dai suoi
  // sotto-progetti non ancora collegati qui. Il progetto intero non e'
  // selezionabile se ha sotto-progetti gia' collegati (qui o altrove), e i
  // sotto-progetti non lo sono se il progetto e' gia' collegato per intero.
  const options = (allProgetti ?? []).flatMap((p) => {
    const hasLinkedSubs = p.sub_projects.some((s) => s.project_id !== null)
    const whole = linkedIds.has(p.id)
      ? []
      : [
          {
            value: `progetto:${p.id}`,
            label:
              `${p.code}${p.notes ? ` · ${p.notes}` : ''}` +
              (hasLinkedSubs
                ? ' (collegato tramite sotto-progetti)'
                : p.project_id
                  ? ' (già collegato a un altro increment)'
                  : ''),
            disabled: hasLinkedSubs,
            progettoId: p.id,
            previousProjectId: p.project_id,
          },
        ]
    const subs = p.sub_projects
      .filter((s) => !linkedSubIds.has(s.id))
      .map((s) => ({
        value: `sub:${s.id}`,
        label:
          `${p.code} › ${s.name} · ${s.budget_hours} h` +
          (p.project_id !== null
            ? ' (progetto già collegato per intero)'
            : s.project_id
              ? ' (già collegato a un altro increment)'
              : ''),
        disabled: p.project_id !== null,
        progettoId: p.id,
        previousProjectId: s.project_id,
      }))
    return [...whole, ...subs]
  })

  const handleAttach = () => {
    const option = options.find((o) => o.value === picked)
    if (!option) return
    const [kind, id] = option.value.split(':')
    setLink.mutate({
      target: { kind: kind as LinkTarget['kind'], id: Number(id) },
      projectId: project.id,
      progettoId: option.progettoId,
      previousProjectId: option.previousProjectId,
    })
    setPicked('')
  }

  const nothingLinked = project.progetti.length === 0 && project.sub_projects.length === 0

  return (
    <div className="card">
      <h3 style={{ marginTop: 0 }}>Progetti collegati</h3>
      <p className="muted" style={{ marginTop: 0 }}>
        I progetti su cui vengono rendicontate le ore di questo increment: normalmente uno solo, ma possono essere
        più di uno quando alcune ore vanno rendicontate su un progetto diverso (es. maintenance). Di un progetto
        scomposto in sotto-progetti si collega il singolo sotto-progetto, col suo budget ore.
      </p>
      {setLink.isError && <div className="error-banner">Collegamento non riuscito: {(setLink.error as Error).message}</div>}

      <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 14 }}>
        <select value={picked} onChange={(e) => setPicked(e.target.value)} style={{ flex: 1 }}>
          <option value="">Collega un progetto o un sotto-progetto già creato...</option>
          {options.map((o) => (
            <option key={o.value} value={o.value} disabled={o.disabled}>
              {o.label}
            </option>
          ))}
        </select>
        <button className="btn" disabled={!picked || setLink.isPending} onClick={handleAttach}>
          Collega
        </button>
      </div>

      {nothingLinked && <p className="muted">Nessun progetto collegato ancora: scegline uno esistente qui sopra.</p>}
      {!nothingLinked && (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Progetto</th>
                <th>Descrizione</th>
                <th>Inizio</th>
                <th>Fine</th>
                <th>Budget ore</th>
                <th>Budget materiali</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {project.progetti.map((p) => (
                <tr key={p.id}>
                  <td>
                    <Link to={`/increments/${p.id}`}>{p.code}</Link>
                  </td>
                  <td style={{ whiteSpace: 'normal', minWidth: 200 }}>{p.notes ?? <span className="muted">-</span>}</td>
                  <td>{formatIsoDate(p.start_date) ?? <span className="muted">-</span>}</td>
                  <td>{formatIsoDate(p.end_date) ?? <span className="muted">-</span>}</td>
                  <td>{p.estimated_budget_hours}</td>
                  <td>{p.estimated_budget_material} €</td>
                  <td>
                    <button
                      className="btn"
                      disabled={setLink.isPending}
                      onClick={() =>
                        setLink.mutate({ target: { kind: 'progetto', id: p.id }, projectId: null, progettoId: p.id })
                      }
                    >
                      Scollega
                    </button>
                  </td>
                </tr>
              ))}
              {/* Sotto-progetti: date e descrizione sono quelle del progetto
                  di cui fanno parte, il budget ore e' il loro; i materiali
                  restano sul progetto intero. */}
              {project.sub_projects.map((s) => {
                const parent = progettoById.get(s.increment_id)
                return (
                  <tr key={`sub-${s.id}`}>
                    <td>
                      <Link to={`/increments/${s.increment_id}`}>{s.increment_code}</Link> › {s.name}
                      <div className="muted" style={{ fontSize: 11 }}>
                        Sotto-progetto
                      </div>
                    </td>
                    <td style={{ whiteSpace: 'normal', minWidth: 200 }}>{parent?.notes ?? <span className="muted">-</span>}</td>
                    <td>{formatIsoDate(parent?.start_date) ?? <span className="muted">-</span>}</td>
                    <td>{formatIsoDate(parent?.end_date) ?? <span className="muted">-</span>}</td>
                    <td>{s.budget_hours}</td>
                    <td>
                      <span className="muted">-</span>
                    </td>
                    <td>
                      <button
                        className="btn"
                        disabled={setLink.isPending}
                        onClick={() =>
                          setLink.mutate({ target: { kind: 'sub', id: s.id }, projectId: null, progettoId: s.increment_id })
                        }
                      >
                        Scollega
                      </button>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
