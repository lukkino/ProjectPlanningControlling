// 📌 per fissare un progetto/increment nella sidebar.
export function PinButton({ pinned, onToggle, label }: { pinned: boolean; onToggle: () => void; label: string }) {
  return (
    <button
      className={`pin-btn${pinned ? ' pinned' : ''}`}
      title={pinned ? `Togli ${label} dalla sidebar` : `Mostra ${label} nella sidebar`}
      aria-label={pinned ? `Togli ${label} dalla sidebar` : `Mostra ${label} nella sidebar`}
      aria-pressed={pinned}
      onClick={onToggle}
    >
      📌
    </button>
  )
}
