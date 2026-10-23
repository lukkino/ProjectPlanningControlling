import { useState } from 'react'
import type { NonWorkingDay } from '../api/types'
import { formatIsoDate, workingDaysBetween } from '../lib/dates'
import { toIsoLocal } from '../lib/scheduling'

const WEEKDAYS = ['Lun', 'Mar', 'Mer', 'Gio', 'Ven', 'Sab', 'Dom']
const DESCRIPTIONS = ['Ferie', 'Malattia', 'Festività', 'Chiusura aziendale', 'Formazione']

export type NewNonWorkingDay = Pick<NonWorkingDay, 'start_date' | 'end_date' | 'description'>

// Giorni del mese di `month` (primo del mese) in righe da lunedi' a
// domenica; null per le celle vuote prima del primo e dopo l'ultimo giorno.
function monthGrid(month: Date): (Date | null)[][] {
  const first = new Date(month.getFullYear(), month.getMonth(), 1)
  const daysInMonth = new Date(month.getFullYear(), month.getMonth() + 1, 0).getDate()
  const cells: (Date | null)[] = Array((first.getDay() + 6) % 7).fill(null)
  for (let d = 1; d <= daysInMonth; d++) cells.push(new Date(month.getFullYear(), month.getMonth(), d))
  while (cells.length % 7 !== 0) cells.push(null)
  return Array.from({ length: cells.length / 7 }, (_, row) => cells.slice(row * 7, row * 7 + 7))
}

function periodLabel(start: string, end: string): string {
  return start === end ? formatIsoDate(start)! : `${formatIsoDate(start)} → ${formatIsoDate(end)}`
}

/** Elenco dei giorni non lavorativi dell'increment (ferie, malattia,
 *  chiusure) con un calendario per aggiungerne: un clic sul primo giorno e
 *  uno sull'ultimo (o due volte sullo stesso giorno). Salvataggio e
 *  ripianificazione degli item sono del chiamante (onAdd, onRemove), che
 *  restituisce quanti item ha ripianificato. */
export function NonWorkingDaysModal({
  days,
  onAdd,
  onRemove,
  onClose,
}: {
  days: NonWorkingDay[]
  onAdd: (day: NewNonWorkingDay) => Promise<number>
  onRemove: (day: NonWorkingDay) => Promise<number>
  onClose: () => void
}) {
  const today = toIsoLocal(new Date())
  const [month, setMonth] = useState(() => {
    const now = new Date()
    return new Date(now.getFullYear(), now.getMonth(), 1)
  })
  // Selezione in corso: start senza end = in attesa del secondo clic.
  const [start, setStart] = useState<string | null>(null)
  const [end, setEnd] = useState<string | null>(null)
  const [hovered, setHovered] = useState<string | null>(null)
  const [description, setDescription] = useState(DESCRIPTIONS[0])
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const offDescription = new Map<string, string>()
  for (const day of days) {
    const cursor = new Date(`${day.start_date}T00:00:00`)
    const last = new Date(`${day.end_date}T00:00:00`)
    while (cursor <= last) {
      offDescription.set(toIsoLocal(cursor), day.description || 'Non lavorativo')
      cursor.setDate(cursor.getDate() + 1)
    }
  }

  // Estremi della selezione mostrata: col solo primo clic, fino al giorno
  // sotto il mouse.
  const selectionEnd = end ?? hovered ?? start
  const [selFrom, selTo] = start && selectionEnd ? [start, selectionEnd].sort() : [null, null]

  const clickDay = (iso: string) => {
    setMessage(null)
    setError(null)
    if (!start || end) {
      setStart(iso)
      setEnd(null)
    } else {
      const [from, to] = [start, iso].sort()
      setStart(from)
      setEnd(to)
    }
  }

  const run = async (action: () => Promise<number>, done: string) => {
    setBusy(true)
    setError(null)
    try {
      const replanned = await action()
      setMessage(
        replanned > 0
          ? `${done} Date pianificate ricalcolate per ${replanned} item.`
          : `${done} Nessun item da ripianificare.`,
      )
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const add = () => {
    if (!start || !end) return
    const day = { start_date: start, end_date: end, description: description.trim() || null }
    run(async () => {
      const replanned = await onAdd(day)
      setStart(null)
      setEnd(null)
      return replanned
    }, `Aggiunto ${periodLabel(day.start_date, day.end_date)}.`)
  }

  const renderMonth = (monthStart: Date) => (
    <div key={monthStart.toISOString()} style={{ flex: 1, minWidth: 0 }}>
      <div style={{ textAlign: 'center', fontWeight: 600, marginBottom: 6, textTransform: 'capitalize' }}>
        {monthStart.toLocaleString('it-IT', { month: 'long', year: 'numeric' })}
      </div>
      <table className="nwd-calendar">
        <thead>
          <tr>
            {WEEKDAYS.map((w) => (
              <th key={w}>{w}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {monthGrid(monthStart).map((week, row) => (
            <tr key={row}>
              {week.map((date, col) => {
                if (!date) return <td key={col} />
                const iso = toIsoLocal(date)
                const off = offDescription.get(iso)
                const selected = selFrom !== null && selTo !== null && iso >= selFrom && iso <= selTo
                const classes = [
                  'nwd-day',
                  col >= 5 && 'nwd-weekend',
                  off && 'nwd-off',
                  selected && 'nwd-selected',
                  iso === today && 'nwd-today',
                ]
                return (
                  <td key={col}>
                    <button
                      type="button"
                      className={classes.filter(Boolean).join(' ')}
                      title={off}
                      onClick={() => clickDay(iso)}
                      onMouseEnter={() => setHovered(iso)}
                      onMouseLeave={() => setHovered(null)}
                    >
                      {date.getDate()}
                    </button>
                  </td>
                )
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )

  const nextMonth = new Date(month.getFullYear(), month.getMonth() + 1, 1)
  const shiftMonth = (delta: number) => setMonth((m) => new Date(m.getFullYear(), m.getMonth() + delta, 1))
  const selectedWorkingDays = start && end ? workingDaysBetween(start, end) : null

  return (
    <div className="modal-overlay" onMouseDown={(e) => e.target === e.currentTarget && !busy && onClose()}>
      <div className="modal" style={{ width: 640 }} onClick={(e) => e.stopPropagation()}>
        <h3 style={{ marginTop: 0 }}>Giorni non lavorativi</h3>
        <p className="muted" style={{ fontSize: 13, marginTop: -4 }}>
          Ferie, malattia, chiusure: la pianificazione (Sizing → Fine pian., cascata, predecessori) li salta come i
          weekend. Clicca il primo e l'ultimo giorno del periodo (due volte lo stesso giorno per un giorno solo).
        </p>

        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12 }}>
          <button className="btn" onClick={() => shiftMonth(-1)} aria-label="Mese precedente">
            ◀
          </button>
          {renderMonth(month)}
          {renderMonth(nextMonth)}
          <button className="btn" onClick={() => shiftMonth(1)} aria-label="Mese successivo">
            ▶
          </button>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 8, marginTop: 12, fontSize: 13 }}>
          <span style={{ minWidth: 220 }}>
            {start && end ? (
              <>
                <strong>{periodLabel(start, end)}</strong>
                <span className="muted"> · {selectedWorkingDays} gg lavorativi</span>
              </>
            ) : start ? (
              <span className="muted">Dal {formatIsoDate(start)}: clicca l'ultimo giorno</span>
            ) : (
              <span className="muted">Nessun periodo selezionato</span>
            )}
          </span>
          <input
            list="nwd-descriptions"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="Motivo (es. Ferie Mario)"
            style={{ flex: 1, minWidth: 160 }}
          />
          <datalist id="nwd-descriptions">
            {DESCRIPTIONS.map((d) => (
              <option key={d} value={d} />
            ))}
          </datalist>
          <button className="btn btn-primary" disabled={!start || !end || busy} onClick={add}>
            Aggiungi
          </button>
        </div>

        {message && (
          <div className="error-banner" style={{ background: '#e9f7ee', color: '#1a9c5c', borderColor: '#b8e3c8', marginTop: 10 }}>
            {message}
          </div>
        )}
        {error && (
          <div className="error-banner" style={{ marginTop: 10 }}>
            {error}
          </div>
        )}

        <table style={{ marginTop: 14 }}>
          <thead>
            <tr>
              <th>Periodo</th>
              <th className="text-right">Gg lavorativi</th>
              <th>Motivo</th>
              <th style={{ width: 36 }} />
            </tr>
          </thead>
          <tbody>
            {days.map((day) => (
              <tr key={day.id}>
                <td>{periodLabel(day.start_date, day.end_date)}</td>
                <td className="text-right">{workingDaysBetween(day.start_date, day.end_date)}</td>
                <td>{day.description ?? <span className="muted">—</span>}</td>
                <td>
                  <button
                    className="link-btn"
                    disabled={busy}
                    title="Elimina"
                    onClick={() => run(() => onRemove(day), `Eliminato ${periodLabel(day.start_date, day.end_date)}.`)}
                  >
                    ✕
                  </button>
                </td>
              </tr>
            ))}
            {days.length === 0 && (
              <tr>
                <td colSpan={4} className="muted" style={{ textAlign: 'center' }}>
                  Nessun giorno non lavorativo.
                </td>
              </tr>
            )}
          </tbody>
        </table>

        <div className="form-actions">
          <button className="btn" disabled={busy} onClick={onClose}>
            Chiudi
          </button>
        </div>
      </div>
    </div>
  )
}
