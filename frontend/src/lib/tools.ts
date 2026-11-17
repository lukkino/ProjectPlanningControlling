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
    path: '/tools/complaints',
    icon: '📣',
    name: 'Complaints',
    description:
      'I bug Jira nati da un case Salesforce: elenco con i case collegati, KPI e disallineamenti tra Jira e Salesforce, sincronizzati con un clic.',
  },
  {
    path: '/tools/rda',
    icon: '🛒',
    name: 'RDA',
    description:
      'Le tue richieste di acquisto in Dynamics 365: stato, progetto, righe, fornitori e importi, lette con un clic e filtrabili.',
  },
  {
    path: '/tools/certificazioni',
    icon: '🏷️',
    name: 'Ticket certificazioni',
    description:
      'I tuoi ticket del portale Product Certification (Freshservice): stato, articolo, manufacturer e codici, letti dal portale con un clic.',
  },
  {
    path: '/tools/enhancements',
    icon: '💡',
    name: 'Enhancements',
    description:
      'Gli Enhancement di una list view Salesforce (di default Enhancement ProTube) e il loro corrispettivo su Jira: in quale increment sono e quali non ce l\'hanno ancora.',
  },
  {
    path: '/tools/commercial-coding',
    icon: '🔖',
    name: 'Commercial Coding',
    description:
      'I tuoi ticket di Commercial Coding (lista Tickets di SharePoint Development): articolo, vendor, famiglia, stato e codifica finale, letti con un clic.',
  },
  {
    path: '/tools/spedizioni',
    icon: '🚚',
    name: 'Modulo Spedizioni',
    description:
      'Compila il modulo di spedizione (materiale, mittente, destinatario, causale, data) dalle rubriche indirizzi e persone; esporta in Excel o copia la tabella per la mail.',
  },
]
