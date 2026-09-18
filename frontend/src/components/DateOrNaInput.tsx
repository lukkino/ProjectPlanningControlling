import { useRef } from 'react'

type Props = {
  value: string | null
  onChange: (value: string | null) => void
}

// "gg/mm/aaaa" <-> "aaaa-mm-gg" (formato richiesto da <input type="date">):
// pura manipolazione di stringa (niente Date/fuso orario), come
// formatIsoDate in lib/dates.ts. Stringa vuota se il testo non e' in quel
// formato (es. "n.a." o vuoto) - l'input type="date" lo mostra vuoto.
function ddmmyyyyToIso(value: string | null): string {
  if (!value) return ''
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(value.trim())
  if (!m) return ''
  const [, d, mo, y] = m
  return `${y}-${mo.padStart(2, '0')}-${d.padStart(2, '0')}`
}
function isoToDdmmyyyy(value: string): string | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value)
  if (!m) return null
  const [, y, mo, d] = m
  return `${d}/${mo}/${y}`
}

// Campo testo libero (puo' contenere "n.a." oltre a una data in gg/mm/aaaa,
// vedi models.BacklogItem.refinement_date/ta_date) con in piu' un bottone
// calendario che apre il date picker nativo del browser: la data scelta li'
// viene scritta nel campo testo, che resta comunque modificabile a mano.
// L'input testo e' incontrollato (defaultValue, commit su blur, come gli
// altri campi testo della tabella Backlog): "key" forza il remount quando
// il valore cambia da fuori (es. dopo aver scelto una data dal calendario),
// cosi' il defaultValue si aggiorna senza serve stato interno ne' effetti.
export function DateOrNaInput({ value, onChange }: Props) {
  const dateInputRef = useRef<HTMLInputElement>(null)

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 2 }}>
      <input
        key={value ?? ''}
        defaultValue={value ?? ''}
        placeholder="gg/mm/aaaa o n.a."
        onBlur={(e) => {
          const trimmed = e.target.value.trim()
          if (trimmed !== (value ?? '')) onChange(trimmed || null)
        }}
        style={{ minWidth: 0, width: 'auto', flex: 1 }}
      />
      <button
        type="button"
        className="btn"
        style={{ padding: '2px 6px', flex: '0 0 auto' }}
        title="Scegli data dal calendario"
        onClick={() => dateInputRef.current?.showPicker?.()}
      >
        📅
      </button>
      {/* Invisibile: serve solo da "motore" per il date picker nativo,
          aperto via showPicker() dal bottone qui sopra. */}
      <input
        ref={dateInputRef}
        type="date"
        value={ddmmyyyyToIso(value)}
        onChange={(e) => onChange(isoToDdmmyyyy(e.target.value))}
        style={{ position: 'absolute', width: 0, height: 0, opacity: 0, pointerEvents: 'none' }}
        tabIndex={-1}
        aria-hidden="true"
      />
    </div>
  )
}
