// Tool Modulo Spedizioni: dai dati del modulo ai riquadri del foglio
// (stessi per anteprima, copia negli appunti ed export Excel, che li riceve
// dal backend). Ogni riquadro e' una lista di righe con uno stile.

export type LineStyle = 'header' | 'bold' | 'normal' | 'link'
export type Line = { text: string; style: LineStyle }
export type Block = Line[]

export type Party = { company: string; address: string; contact: string; email: string; phone: string }

export type ShippingForm = {
  mittente: Party
  destinatario: Party
  materiale: string
  dimensioniPeso: string
  causale: string
  // ISO aaaa-mm-gg
  data: string | null
}

export const CAUSALI = ['Movimentazione interna', 'Conto visione', 'Restituzione Conto Visione']
export const LINK_COLOR = '#0563C1'

export const emptyParty = (): Party => ({ company: '', address: '', contact: '', email: '', phone: '' })

const isoToItalian = (iso: string | null) => {
  if (!iso) return ''
  const [y, m, d] = iso.split('-')
  return `${d}/${m}/${y}`
}

export function buildBlocks(f: ShippingForm): Block[] {
  const lines = (text: string, style: LineStyle = 'normal'): Line[] =>
    text.trim() ? text.trim().split('\n').map((t) => ({ text: t, style })) : []
  const party = (p: Party, withContacts = false): Line[] => [
    { text: p.company.trim(), style: 'bold' },
    ...lines(p.address),
    ...lines(p.contact),
    ...(withContacts ? [...lines(p.email, 'link'), ...lines(p.phone)] : []),
  ]
  const blank: Line = { text: '', style: 'normal' }
  const materiale: Line[] = [blank, ...lines(f.materiale)]
  if (f.dimensioniPeso.trim()) materiale.push(blank, ...lines(f.dimensioniPeso))
  materiale.push(blank)

  return [
    [{ text: '1. Elenco materiale da spedire', style: 'header' }],
    materiale,
    [blank],
    party(f.mittente),
    [{ text: '2. Indirizzo di spedizione e persona di riferimento', style: 'header' }],
    party(f.destinatario, true),
    [{ text: '3. Causale Spedizione', style: 'header' }],
    [{ text: f.causale.trim(), style: 'normal' }],
    [{ text: '4. Data di spedizione prevista', style: 'header' }],
    [blank, { text: isoToItalian(f.data), style: 'normal' }, blank],
  ]
}

export const blocksToText = (blocks: Block[]) => blocks.flatMap((b) => b.map((l) => l.text)).join('\n')

const escapeHtml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

// Tabella HTML come il foglio Excel, da incollare in Outlook o in Excel.
export function blocksToHtml(blocks: Block[]): string {
  const font = 'font-family:Calibri,Arial,sans-serif;font-size:11pt;'
  const rows = blocks.map((block) => {
    const header = block[0]?.style === 'header'
    const content = block
      .map(({ text, style }) => {
        const t = text ? escapeHtml(text) : '&nbsp;'
        if (style === 'header' || style === 'bold') return `<b>${t}</b>`
        if (style === 'link') return `<a href="mailto:${escapeHtml(text)}" style="color:${LINK_COLOR};">${t}</a>`
        return t
      })
      .join('<br>')
    return `<tr><td style="border:1px solid #000;padding:2px 6px;${font}text-align:${header ? 'left' : 'center'};">${content}</td></tr>`
  })
  return `<table style="border-collapse:collapse;width:600px;">${rows.join('')}</table>`
}

export async function copyBlocks(blocks: Block[]): Promise<void> {
  const html = blocksToHtml(blocks)
  const text = blocksToText(blocks)
  if (typeof ClipboardItem !== 'undefined' && navigator.clipboard?.write) {
    await navigator.clipboard.write([
      new ClipboardItem({
        'text/html': new Blob([html], { type: 'text/html' }),
        'text/plain': new Blob([text], { type: 'text/plain' }),
      }),
    ])
  } else {
    await navigator.clipboard.writeText(text)
  }
}
