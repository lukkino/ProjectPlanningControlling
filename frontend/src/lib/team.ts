// Chiave della persona per collegare il Team del Carico team agli
// assegnatari Jira e alle persone del Capacity Planner (come team_key nel
// backend): minuscolo, spazi singoli.
export const teamKey = (name: string) => name.trim().split(/\s+/).join(' ').toLowerCase()
