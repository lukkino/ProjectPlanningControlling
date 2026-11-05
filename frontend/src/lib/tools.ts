// Catalogo della sezione Tools: utility indipendenti dai progetti. Per
// aggiungere un tool: una voce qui, una route in App.tsx e la sua pagina in
// pages/tools/.
export type ToolInfo = {
  path: string
  icon: string
  name: string
  description: string
}

export const TOOLS: ToolInfo[] = [
  {
    path: '/tools/spedizioni',
    icon: '🚚',
    name: 'Modulo Spedizioni',
    description:
      'Compila il modulo di spedizione (materiale, mittente, destinatario, causale, data) dalle rubriche indirizzi e persone; esporta in Excel o copia la tabella per la mail.',
  },
]
