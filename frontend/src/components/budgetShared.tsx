import { useState } from 'react'
import type { BudgetCatalog, MaterialFields } from '../api/types'
import { fmtEuro, fmtNumber, parseDecimal, useBudgetCatalog } from '../lib/budget'

// Componenti comuni del budget di progetto: campi numerici/testo e la
// tabella delle righe materiali, usata sia dal Budget materiali (bozza)
// sia dalle review di budget.

// Campo numerico che si salva uscendo; key sul valore per riallinearlo.
export function NumberCell({
  value,
  label,
  onSave,
  disabled,
}: {
  value: number
  label: string
  onSave: (value: number) => void
  disabled?: boolean
}) {
  return (
    <input
      key={value}
      aria-label={label}
      className="text-right"
      disabled={disabled}
      defaultValue={fmtNumber(value)}
      onBlur={(e) => {
        const parsed = parseDecimal(e.target.value)
        if (parsed === null) e.target.value = fmtNumber(value)
        else if (parsed !== value) onSave(parsed)
      }}
      onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
    />
  )
}

export function TextCell({
  value,
  label,
  onSave,
  disabled,
}: {
  value: string
  label: string
  onSave: (value: string) => void
  disabled?: boolean
}) {
  return (
    <input
      key={value}
      aria-label={label}
      disabled={disabled}
      defaultValue={value}
      onBlur={(e) => {
        const next = e.target.value.trim()
        if (!next) e.target.value = value
        else if (next !== value) onSave(next)
      }}
      onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
    />
  )
}

type MaterialInput = Omit<MaterialFields, 'amount'>
type MaterialRow = MaterialFields & { id: number }

function CategorySection({
  catalog,
  category,
  section,
  onChange,
  disabled,
}: {
  catalog: BudgetCatalog
  category: string
  section: string | null
  onChange: (data: { category?: string; section?: string | null }) => void
  disabled?: boolean
}) {
  const noSections = catalog.categories_without_sections.includes(category)
  return (
    <>
      <td className="editable-cell">
        <select
          aria-label="Categoria"
          value={category}
          disabled={disabled}
          onChange={(e) => onChange({ category: e.target.value })}
        >
          {catalog.categories.map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </select>
      </td>
      <td className="editable-cell">
        {noSections ? (
          <span className="muted">—</span>
        ) : (
          <select
            aria-label="Sezione"
            value={section ?? catalog.sections[0]}
            disabled={disabled}
            onChange={(e) => onChange({ section: e.target.value })}
          >
            {catalog.sections.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        )}
      </td>
    </>
  )
}

// Tabella di righe materiali come nel foglio Materials and Expenses: per
// Consultancies e Travel Expenses conta solo l'importo (unita' e moduli a 1).
export function MaterialTable({
  rows,
  onAdd,
  onUpdate,
  onRemove,
  disabled,
  emptyText,
}: {
  rows: MaterialRow[]
  onAdd: (data: Partial<MaterialInput>) => void
  onUpdate: (id: number, data: Partial<MaterialInput>) => void
  onRemove: (row: MaterialRow) => void
  disabled?: boolean
  emptyText?: string
}) {
  const { data: catalog } = useBudgetCatalog()
  const [draft, setDraft] = useState<{ category: string | null; section: string | null; description: string; unitCost: string }>({
    category: null,
    section: null,
    description: '',
    unitCost: '',
  })
  if (!catalog) return null
  const category = draft.category ?? catalog.categories[1]
  const noSections = catalog.categories_without_sections.includes(category)
  const unitCost = parseDecimal(draft.unitCost)
  const canAdd = !!draft.description.trim() && unitCost !== null && !disabled
  const add = () => {
    if (!canAdd) return
    onAdd({
      category,
      section: noSections ? null : (draft.section ?? catalog.sections[0]),
      description: draft.description.trim(),
      unit_cost: unitCost ?? 0,
    })
    setDraft((d) => ({ ...d, description: '', unitCost: '' }))
  }
  const total = rows.reduce((sum, r) => sum + r.amount, 0)

  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            <th>Categoria</th>
            <th>Sezione</th>
            <th style={{ minWidth: 200 }}>Descrizione</th>
            <th className="text-right">Costo unitario</th>
            <th className="text-right">Unità per modulo</th>
            <th className="text-right">N. moduli</th>
            <th className="text-right">Totale</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const rowNoSections = catalog.categories_without_sections.includes(row.category)
            return (
              <tr key={row.id}>
                <CategorySection
                  catalog={catalog}
                  category={row.category}
                  section={row.section}
                  disabled={disabled}
                  onChange={(data) => onUpdate(row.id, data)}
                />
                <td className="editable-cell">
                  <TextCell
                    value={row.description}
                    label="Descrizione"
                    disabled={disabled}
                    onSave={(description) => onUpdate(row.id, { description })}
                  />
                </td>
                <td className="editable-cell">
                  <NumberCell
                    value={row.unit_cost}
                    label="Costo unitario"
                    disabled={disabled}
                    onSave={(unit_cost) => onUpdate(row.id, { unit_cost })}
                  />
                </td>
                <td className={rowNoSections ? undefined : 'editable-cell'}>
                  {rowNoSections ? (
                    <span className="muted">—</span>
                  ) : (
                    <NumberCell value={row.units} label="Unità per modulo" disabled={disabled} onSave={(units) => onUpdate(row.id, { units })} />
                  )}
                </td>
                <td className={rowNoSections ? undefined : 'editable-cell'}>
                  {rowNoSections ? (
                    <span className="muted">—</span>
                  ) : (
                    <NumberCell value={row.modules} label="N. moduli" disabled={disabled} onSave={(modules) => onUpdate(row.id, { modules })} />
                  )}
                </td>
                <td className="text-right">
                  <strong>{fmtEuro(row.amount)}</strong>
                </td>
                <td>
                  {!disabled && (
                    <button className="btn" title="Elimina la riga" aria-label={`Elimina ${row.description}`} onClick={() => onRemove(row)}>
                      🗑
                    </button>
                  )}
                </td>
              </tr>
            )
          })}
          {rows.length === 0 && emptyText && (
            <tr>
              <td colSpan={8} className="muted">
                {emptyText}
              </td>
            </tr>
          )}
          {!disabled && (
            <tr>
              <CategorySection
                catalog={catalog}
                category={category}
                section={draft.section}
                onChange={(data) =>
                  setDraft((d) => ({
                    ...d,
                    ...(data.category !== undefined ? { category: data.category } : {}),
                    ...(data.section !== undefined ? { section: data.section } : {}),
                  }))
                }
              />
              <td className="editable-cell">
                <input
                  aria-label="Descrizione della nuova riga"
                  placeholder="Nuova riga, es. Pannellatura"
                  value={draft.description}
                  onChange={(e) => setDraft((d) => ({ ...d, description: e.target.value }))}
                  onKeyDown={(e) => e.key === 'Enter' && add()}
                />
              </td>
              <td className="editable-cell">
                <input
                  aria-label="Costo unitario della nuova riga"
                  placeholder="0,00"
                  className="text-right"
                  value={draft.unitCost}
                  onChange={(e) => setDraft((d) => ({ ...d, unitCost: e.target.value }))}
                  onKeyDown={(e) => e.key === 'Enter' && add()}
                />
              </td>
              <td className="muted text-right">1</td>
              <td className="muted text-right">1</td>
              <td />
              <td>
                <button className="btn btn-primary" disabled={!canAdd} onClick={add} title={unitCost === null ? 'Importo non valido' : undefined}>
                  + Aggiungi
                </button>
              </td>
            </tr>
          )}
        </tbody>
        <tfoot>
          <tr>
            <td colSpan={6}>
              <strong>Totale</strong>
            </td>
            <td className="text-right">
              <strong>{fmtEuro(total)}</strong>
            </td>
            <td />
          </tr>
        </tfoot>
      </table>
    </div>
  )
}
