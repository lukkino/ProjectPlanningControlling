// Riga "💡 Suggerimento" sotto un campo vuoto, con il pulsante per usarlo.
export function Suggestion({
  value,
  source,
  onUse,
}: {
  value: string | null | undefined
  source: string | null | undefined
  onUse: (value: string) => void
}) {
  if (!value) return null
  return (
    <div className="suggestion">
      <span className="suggestion-label">💡 Suggerimento{source ? ` (come configurato da ${source})` : ''}:</span>
      <code className="suggestion-value">{value}</code>
      <button type="button" className="link-btn" onClick={() => onUse(value)}>
        Usa
      </button>
    </div>
  )
}
