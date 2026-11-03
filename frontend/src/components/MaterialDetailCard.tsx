import { useQuery } from '@tanstack/react-query'
import { api } from '../api/client'
import { parseBackendDateTime } from '../lib/dates'
import { fmtEuro, useBudgetCatalog } from '../lib/budget'

type Props = { incrementId: number }

const fmtDateTime = (value: string) =>
  parseBackendDateTime(value).toLocaleString('it-IT', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })

// Dettaglio materiali progetto: il budget materiali iniziale (copiato dal
// Budget materiali con "Aggiorna materiali progetto"), per categoria, con i
// costi extra delle review di budget e il totale che vale.
export function MaterialDetailCard({ incrementId }: Props) {
  const { data: catalog } = useBudgetCatalog()
  const { data: budget } = useQuery({
    queryKey: ['material-budget', incrementId],
    queryFn: () => api.materialCosts.budget(incrementId),
  })
  const { data: reviews } = useQuery({
    queryKey: ['budget-reviews', incrementId],
    queryFn: () => api.budget.reviews(incrementId),
  })
  if (!budget || !catalog) return null

  const initialOf = (category: string) =>
    budget.rows.filter((r) => r.category === category).reduce((sum, r) => sum + r.amount, 0)
  const extraOf = (reviewIndex: number, category: string) =>
    (reviews?.[reviewIndex]?.material_items ?? []).filter((i) => i.category === category).reduce((sum, i) => sum + i.amount, 0)
  const totalOf = (category: string) =>
    initialOf(category) + (reviews ?? []).reduce((sum, _r, i) => sum + extraOf(i, category), 0)
  const grand = (fn: (category: string) => number) => catalog.categories.reduce((sum, c) => sum + fn(c), 0)

  return (
    <div className="card">
      <h3 style={{ marginTop: 0 }}>Dettaglio materiali progetto</h3>
      <p className="muted" style={{ marginTop: 0, fontSize: 13 }}>
        Il budget materiali iniziale, da "Aggiorna materiali progetto" del Budget materiali più sotto
        {budget.published_at ? ` (aggiornato il ${fmtDateTime(budget.published_at)})` : ''}, con i costi extra delle
        review di budget. Il totale è il Budget materiali del progetto e va negli snapshot del Consumo risorse progetto.
      </p>
      {budget.rows.length === 0 && (reviews ?? []).every((r) => r.material_items.length === 0) ? (
        <p className="muted" style={{ margin: 0 }}>
          Ancora vuoto: compila il Budget materiali e premi "Aggiorna materiali progetto".
        </p>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Categoria</th>
                <th className="text-right">Budget iniziale</th>
                {(reviews ?? []).map((r) => (
                  <th key={r.id} className="text-right">
                    {r.name}
                  </th>
                ))}
                <th className="text-right">Totale</th>
              </tr>
            </thead>
            <tbody>
              {catalog.categories.map((category) => (
                <tr key={category}>
                  <td>{category}</td>
                  <td className="text-right">{fmtEuro(initialOf(category))}</td>
                  {(reviews ?? []).map((r, i) => (
                    <td key={r.id} className="text-right">
                      {extraOf(i, category) ? `${extraOf(i, category) > 0 ? '+' : ''}${fmtEuro(extraOf(i, category))}` : '—'}
                    </td>
                  ))}
                  <td className="text-right">
                    <strong>{fmtEuro(totalOf(category))}</strong>
                  </td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr>
                <td>
                  <strong>Totale</strong>
                </td>
                <td className="text-right">
                  <strong>{fmtEuro(grand(initialOf))}</strong>
                </td>
                {(reviews ?? []).map((r, i) => (
                  <td key={r.id} className="text-right">
                    <strong>{fmtEuro(grand((c) => extraOf(i, c)))}</strong>
                  </td>
                ))}
                <td className="text-right">
                  <strong>{fmtEuro(grand(totalOf))}</strong>
                </td>
              </tr>
            </tfoot>
          </table>
        </div>
      )}
      {budget.rows.length > 0 && (
        <details style={{ marginTop: 10 }}>
          <summary style={{ cursor: 'pointer', fontSize: 13 }}>Righe del budget iniziale ({budget.rows.length})</summary>
          <div className="table-wrap" style={{ marginTop: 8 }}>
            <table>
              <thead>
                <tr>
                  <th>Categoria</th>
                  <th>Sezione</th>
                  <th>Descrizione</th>
                  <th className="text-right">Costo unitario</th>
                  <th className="text-right">Unità</th>
                  <th className="text-right">Moduli</th>
                  <th className="text-right">Totale</th>
                </tr>
              </thead>
              <tbody>
                {budget.rows.map((r, i) => (
                  <tr key={i}>
                    <td>{r.category}</td>
                    <td>{r.section ?? '—'}</td>
                    <td style={{ whiteSpace: 'normal' }}>{r.description}</td>
                    <td className="text-right">{fmtEuro(r.unit_cost)}</td>
                    <td className="text-right">{r.units}</td>
                    <td className="text-right">{r.modules}</td>
                    <td className="text-right">{fmtEuro(r.amount)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </details>
      )}
    </div>
  )
}
