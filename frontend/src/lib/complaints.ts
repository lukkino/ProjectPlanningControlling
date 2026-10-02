// Costanti e funzioni condivise dalle sezioni dell'area Complaints (Elenco, KPI).
import type { Complaint } from '../api/types'

// Le quattro architetture (label Jira) in ordine fisso; i complaint senza
// nessuna di queste label finiscono sotto NO_ARCHITECTURE.
export const ARCHITECTURES = ['Legacy', 'NA5', 'NA6', 'NA7']
export const NO_ARCHITECTURE = 'N/D'

export const architecturesOf = (c: Complaint) => (c.architecture ? c.architecture.split(', ') : [NO_ARCHITECTURE])
