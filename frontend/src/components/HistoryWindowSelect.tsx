import { HISTORY_WINDOWS, type HistoryWindow } from '../lib/historyWindow'
import { DateInput } from './DateInput'

const FROM_DATE = 'from'

// Scelta della finestra storica: ultimi 3/6/12 mesi oppure "Dalla data..."
// (fino a ieri). Passando a "Dalla data..." propone un anno fa.
export function HistoryWindowSelect({
  value,
  onChange,
  compact = false,
}: {
  value: HistoryWindow
  onChange: (value: HistoryWindow) => void
  compact?: boolean
}) {
  const yearAgo = () => {
    const d = new Date()
    d.setFullYear(d.getFullYear() - 1)
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
  }
  return (
    <span className="history-window">
      <select
        value={value.historyFrom ? FROM_DATE : value.historyDays}
        onChange={(e) =>
          e.target.value === FROM_DATE
            ? onChange({ historyDays: value.historyDays, historyFrom: yearAgo() })
            : onChange({ historyDays: Number(e.target.value), historyFrom: null })
        }
      >
        {HISTORY_WINDOWS.map((w) => (
          <option key={w.days} value={w.days}>
            {compact ? w.label.toLowerCase() : w.label}
          </option>
        ))}
        <option value={FROM_DATE}>{compact ? 'dalla data…' : 'Dalla data…'}</option>
      </select>
      {value.historyFrom && (
        <>
          <DateInput
            value={value.historyFrom}
            onChange={(date) => date && onChange({ historyDays: value.historyDays, historyFrom: date })}
          />
          <span className="muted">a ieri</span>
        </>
      )}
    </span>
  )
}
