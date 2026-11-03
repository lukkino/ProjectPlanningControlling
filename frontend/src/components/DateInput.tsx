import { useRef, useState } from 'react'
import type { CSSProperties } from 'react'
import { formatIsoDate } from '../lib/dates'

type Props = {
  // Data in ISO aaaa-mm-gg (come arriva dal backend), null/'' se vuota.
  value: string | null | undefined
  // Chiamata solo a modifica confermata: uscendo dal campo o con Invio se
  // il testo e' una data valida diversa da prima, oppure scegliendo una
  // data dal calendario. Riceve l'ISO, null se il campo e' stato svuotato.
  onChange: (value: string | null) => void
  disabled?: boolean
  title?: string
  min?: string
  max?: string
  style?: CSSProperties
  'aria-label'?: string
}

// "gg/mm/aaaa" (anche g/m/aa, con - o . come separatore) o ISO -> ISO;
// undefined se il testo non e' una data valida.
function parseItalianDate(text: string): string | undefined {
  const trimmed = text.trim()
  let day: number, month: number, year: number
  const iso = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(trimmed)
  const it = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2}|\d{4})$/.exec(trimmed)
  if (iso) {
    ;[year, month, day] = [Number(iso[1]), Number(iso[2]), Number(iso[3])]
  } else if (it) {
    ;[day, month, year] = [Number(it[1]), Number(it[2]), Number(it[3])]
    if (year < 100) year += 2000
  } else {
    return undefined
  }
  const date = new Date(Date.UTC(year, month - 1, day))
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return undefined
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
}

// Campo data in formato italiano gg/mm/aaaa, uguale in tutta l'app: il
// campo data nativo del browser mostra il formato della lingua del browser
// (spesso mm/gg/aaaa), qui invece si scrive e si legge sempre gg/mm/aaaa.
// Il pulsante apre il calendario nativo, nascosto, solo per scegliere.
// Campo non controllato: "key" sul valore lo riallinea quando il valore
// cambia da fuori (salvataggio, ricalcolo).
export function DateInput({ value, onChange, disabled, title, min, max, style, 'aria-label': ariaLabel }: Props) {
  const pickerRef = useRef<HTMLInputElement>(null)
  // Svuotando il campo il valore puo' tornare uguale a prima (es. una data
  // di default presa altrove): si rimonta il campo per mostrarlo di nuovo.
  const [resets, setResets] = useState(0)
  const current = value || null
  const shown = formatIsoDate(current) ?? ''

  const commit = (input: HTMLInputElement) => {
    if (!input.value.trim()) {
      if (current !== null) {
        onChange(null)
        setResets((n) => n + 1)
      }
      return
    }
    const parsed = parseItalianDate(input.value)
    if (parsed === undefined) {
      // Testo non valido: torna il valore di prima.
      input.value = shown
      return
    }
    input.value = formatIsoDate(parsed) ?? ''
    if (parsed !== current) onChange(parsed)
  }

  return (
    <span className="date-input" style={style} title={title}>
      <input
        key={`${current ?? ''}|${resets}`}
        defaultValue={shown}
        placeholder="gg/mm/aaaa"
        disabled={disabled}
        aria-label={ariaLabel}
        onBlur={(e) => commit(e.currentTarget)}
        onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
      />
      <button
        type="button"
        className="date-input-btn"
        title="Scegli dal calendario"
        aria-label="Scegli dal calendario"
        disabled={disabled}
        tabIndex={-1}
        onClick={() => pickerRef.current?.showPicker?.()}
      >
        📅
      </button>
      {/* Invisibile: serve solo ad aprire il calendario nativo. */}
      <input
        ref={pickerRef}
        type="date"
        className="date-input-picker"
        value={current ?? ''}
        min={min}
        max={max}
        onChange={(e) => {
          const picked = e.target.value || null
          if (picked !== current) onChange(picked)
        }}
        tabIndex={-1}
        aria-hidden="true"
      />
    </span>
  )
}
