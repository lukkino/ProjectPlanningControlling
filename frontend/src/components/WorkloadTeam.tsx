import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { api } from '../api/client'
import type { AbsenceKind, TeamResource, TeamRole } from '../api/types'
import { teamKey } from '../lib/team'
import { useAuth } from './authContext'
import { AbsencesCell } from './HoursCalculatorCard'

// Team del Carico team, come il Capacity Planner di un progetto ma valido
// per tutti gli increment: un elenco di persone, ognuna con il ruolo
// (Project Manager, Developer...), le ore al giorno e le assenze. Il nome
// della persona deve essere quello dell'assegnatario in Jira: e' cosi' che il
// carico la riconosce (e il Capacity Planner ne usa le ferie).

const todayIso = () => {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

// Giorni lavorativi (lun-ven) di assenza da oggi in poi.
function upcomingAbsenceDays(r: TeamResource): number {
  const today = todayIso()
  const days = new Set<string>()
  for (const a of r.absences) {
    if (a.end_date < today) continue
    const cursor = new Date(`${a.start_date > today ? a.start_date : today}T00:00:00`)
    const last = new Date(`${a.end_date}T00:00:00`)
    while (cursor <= last) {
      const wd = cursor.getDay()
      if (wd !== 0 && wd !== 6) days.add(cursor.toDateString())
      cursor.setDate(cursor.getDate() + 1)
    }
  }
  return days.size
}

function parseHours(text: string): number | null {
  const n = Number(text.trim().replace(',', '.'))
  return Number.isFinite(n) && n > 0 && n <= 24 ? n : null
}

const formatHours = (value: number) => String(value).replace('.', ',')

export function WorkloadTeam({ assignees }: { assignees: string[] }) {
  const { can } = useAuth()
  const editable = can('editor')
  const queryClient = useQueryClient()
  const { data: roles, isLoading } = useQuery({ queryKey: ['team'], queryFn: api.team.list })
  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ['team'] })
    void queryClient.invalidateQueries({ queryKey: ['workload'] })
    // Le assenze del Team valgono anche nel Capacity Planner dei progetti.
    void queryClient.invalidateQueries({ queryKey: ['hours-calculator'] })
  }
  const run = useMutation({ mutationFn: (action: () => Promise<unknown>) => action(), onSuccess: refresh })
  const [roleFilter, setRoleFilter] = useState<number | null>(null)

  if (isLoading || !roles) return <p className="muted">Caricamento…</p>

  // Elenco unico: per ruolo (nell'ordine dei ruoli), poi per nome.
  const people = roles
    .flatMap((role) => role.resources.map((r) => ({ ...r, roleOrder: role.order })))
    .sort((a, b) => a.roleOrder - b.roleOrder || a.name.localeCompare(b.name, 'it'))
  const visible = roleFilter === null ? people : people.filter((p) => p.role_id === roleFilter)
  const inTeam = new Set(people.map((p) => teamKey(p.name)))
  const missing = assignees.filter((a) => !inTeam.has(teamKey(a)))

  return (
    <div className="card team-card">
      <p className="muted" style={{ marginTop: 0 }}>
        Le persone del tuo team con il <b>ruolo</b>, le <b>ore lavorative al giorno</b> e le <b>assenze</b> (ferie,
        malattia…): nel carico la disponibilità di ogni settimana diventa (giorni lavorativi − assenze) × ore al giorno,
        e le ore degli item vanno solo sui giorni in cui la persona c'è. Il <b>nome</b> deve essere quello
        dell'assegnatario in Jira. Le assenze valgono anche nel Capacity Planner dei progetti, per la persona con lo
        stesso nome. Chi non è nel team usa le ore/giorno impostate nella scheda Carico.
      </p>
      {run.isError && <div className="error-banner">{(run.error as Error).message}</div>}

      <RolesBar
        roles={roles}
        editable={editable}
        selected={roleFilter}
        onSelect={setRoleFilter}
        run={(action) => run.mutate(action)}
      />

      {missing.length > 0 && (
        <p className="team-missing">
          <b>Assegnatari non nel team</b> ({missing.length}): {missing.join(', ')}.
        </p>
      )}

      <table className="team-table">
        <thead>
          <tr>
            <th>Persona (assegnatario Jira)</th>
            <th>Ruolo</th>
            <th className="num">Ore/giorno</th>
            <th>Assenze</th>
            <th className="num" title="Giorni lavorativi di assenza da oggi in poi">
              Prossime
            </th>
            {editable && <th />}
          </tr>
        </thead>
        <tbody>
          {visible.map((r) => (
            <PersonRow key={r.id} person={r} roles={roles} editable={editable} run={(action) => run.mutate(action)} />
          ))}
          {visible.length === 0 && (
            <tr>
              <td colSpan={editable ? 6 : 5} className="muted">
                {people.length === 0 ? 'Nessuna persona nel team.' : 'Nessuna persona con questo ruolo.'}
              </td>
            </tr>
          )}
        </tbody>
      </table>

      {editable && (
        <AddPerson
          roles={roles}
          suggestions={missing}
          defaultRoleId={roleFilter}
          run={(action) => run.mutate(action)}
        />
      )}
    </div>
  )
}

// Ruoli: filtro dell'elenco (clic), rinomina (doppio clic), togli, aggiungi.
function RolesBar({
  roles,
  editable,
  selected,
  onSelect,
  run,
}: {
  roles: TeamRole[]
  editable: boolean
  selected: number | null
  onSelect: (id: number | null) => void
  run: (action: () => Promise<unknown>) => void
}) {
  const [newRole, setNewRole] = useState('')
  const [renaming, setRenaming] = useState<number | null>(null)
  const total = roles.reduce((sum, r) => sum + r.resources.length, 0)
  const addRole = () => {
    if (!newRole.trim()) return
    run(() => api.team.createRole(newRole.trim()))
    setNewRole('')
  }

  return (
    <div className="team-roles">
      <span className="filter-group-label">Ruoli</span>
      {roles.length > 0 && (
        <button
          type="button"
          className={`btn filter-btn${selected === null ? ' active' : ''}`}
          onClick={() => onSelect(null)}
        >
          Tutti <span className="muted">{total}</span>
        </button>
      )}
      {roles.map((role) =>
        renaming === role.id ? (
          <input
            key={role.id}
            className="team-role-rename"
            autoFocus
            defaultValue={role.name}
            aria-label="Nuovo nome del ruolo"
            onBlur={(e) => {
              const value = e.target.value.trim()
              if (value && value !== role.name) run(() => api.team.updateRole(role.id, { name: value }))
              setRenaming(null)
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') e.currentTarget.blur()
              if (e.key === 'Escape') setRenaming(null)
            }}
          />
        ) : (
          <span key={role.id} className="team-role-chip">
            <button
              type="button"
              className={`btn filter-btn${selected === role.id ? ' active' : ''}`}
              title={editable ? 'Clic: mostra solo questo ruolo · doppio clic: rinomina' : 'Mostra solo questo ruolo'}
              onClick={() => onSelect(selected === role.id ? null : role.id)}
              onDoubleClick={() => editable && setRenaming(role.id)}
            >
              {role.name} <span className="muted">{role.resources.length}</span>
            </button>
            {editable && (
              <button
                type="button"
                className="link-btn team-remove"
                title={`Togli il ruolo ${role.name}`}
                onClick={() => {
                  if (
                    role.resources.length === 0 ||
                    confirm(`Togliere il ruolo ${role.name}? Toglie anche le sue ${role.resources.length} persone.`)
                  ) {
                    if (selected === role.id) onSelect(null)
                    run(() => api.team.removeRole(role.id))
                  }
                }}
              >
                ✕
              </button>
            )}
          </span>
        ),
      )}
      {editable && roles.length === 0 && (
        <button className="btn btn-primary" onClick={() => run(api.team.createDefaultRoles)}>
          Crea i ruoli Project Manager, Developer, Tester
        </button>
      )}
      {editable && (
        <span className="team-add-role">
          <input
            placeholder="Nuovo ruolo"
            value={newRole}
            onChange={(e) => setNewRole(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && addRole()}
            aria-label="Nome del nuovo ruolo"
          />
          <button className="btn" disabled={!newRole.trim()} onClick={addRole}>
            + Ruolo
          </button>
        </span>
      )}
    </div>
  )
}

function PersonRow({
  person: r,
  roles,
  editable,
  run,
}: {
  person: TeamResource
  roles: TeamRole[]
  editable: boolean
  run: (action: () => Promise<unknown>) => void
}) {
  const roleName = roles.find((role) => role.id === r.role_id)?.name ?? '-'
  if (!editable) {
    return (
      <tr>
        <td>{r.name}</td>
        <td>{roleName}</td>
        <td className="num">{formatHours(r.hours_per_day)}</td>
        <td>{r.absences.map((a) => `${a.start_date} – ${a.end_date}`).join(', ') || '-'}</td>
        <td className="num">{upcomingAbsenceDays(r) || ''}</td>
      </tr>
    )
  }
  return (
    <tr>
      <td>
        <input
          defaultValue={r.name}
          key={r.name}
          aria-label="Nome"
          onBlur={(e) => {
            const value = e.target.value.trim()
            if (value && value !== r.name) run(() => api.team.updateResource(r.id, { name: value }))
            else e.target.value = r.name
          }}
        />
      </td>
      <td>
        <select
          value={r.role_id}
          aria-label={`Ruolo di ${r.name}`}
          onChange={(e) => run(() => api.team.updateResource(r.id, { role_id: Number(e.target.value) }))}
        >
          {roles.map((role) => (
            <option key={role.id} value={role.id}>
              {role.name}
            </option>
          ))}
        </select>
      </td>
      <td className="num">
        <input
          className="team-hours"
          defaultValue={formatHours(r.hours_per_day)}
          key={r.hours_per_day}
          aria-label={`Ore al giorno di ${r.name}`}
          onBlur={(e) => {
            const value = parseHours(e.target.value)
            if (value !== null && value !== r.hours_per_day) run(() => api.team.updateResource(r.id, { hours_per_day: value }))
            else e.target.value = formatHours(r.hours_per_day)
          }}
        />
      </td>
      <td>
        <AbsencesCell
          absences={r.absences}
          periodStart={todayIso()}
          periodEnd="9999-12-31"
          onAdd={(start, end, kind: AbsenceKind) =>
            run(() => api.team.addAbsence(r.id, { start_date: start, end_date: end, kind }))
          }
          onRemove={(id) => run(() => api.team.removeAbsence(id))}
        />
      </td>
      <td className="num">{upcomingAbsenceDays(r) || ''}</td>
      <td>
        <button
          className="link-btn team-remove"
          title="Togli dal team"
          onClick={() => confirm(`Togliere ${r.name} dal team?`) && run(() => api.team.removeResource(r.id))}
        >
          ✕
        </button>
      </td>
    </tr>
  )
}

function AddPerson({
  roles,
  suggestions,
  defaultRoleId,
  run,
}: {
  roles: TeamRole[]
  suggestions: string[]
  defaultRoleId: number | null
  run: (action: () => Promise<unknown>) => void
}) {
  const [name, setName] = useState('')
  const [hours, setHours] = useState('8')
  const [roleId, setRoleId] = useState<number | null>(null)
  // Ruolo proposto: quello scelto, se no quello filtrato, se no il primo.
  const role = roleId ?? defaultRoleId ?? roles[0]?.id ?? null
  const valid = !!name.trim() && parseHours(hours) !== null && role !== null
  const add = () => {
    const h = parseHours(hours)
    if (!valid || h === null || role === null) return
    run(() => api.team.addResource(role, { name: name.trim(), hours_per_day: h }))
    setName('')
  }

  return (
    <div className="team-add">
      <span className="team-add-label">Aggiungi persona:</span>
      <input
        className="team-add-name"
        list="team-assignees"
        placeholder="Nome come in Jira (es. Mario Rossi)"
        value={name}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => e.key === 'Enter' && add()}
        aria-label="Nome della persona da aggiungere"
      />
      <datalist id="team-assignees">
        {suggestions.map((s) => (
          <option key={s} value={s} />
        ))}
      </datalist>
      <select
        value={role ?? ''}
        disabled={roles.length === 0}
        onChange={(e) => setRoleId(Number(e.target.value))}
        aria-label="Ruolo della nuova persona"
      >
        {roles.length === 0 && <option value="">crea prima un ruolo</option>}
        {roles.map((r) => (
          <option key={r.id} value={r.id}>
            {r.name}
          </option>
        ))}
      </select>
      <label>
        <input
          className="team-hours"
          value={hours}
          onChange={(e) => setHours(e.target.value)}
          aria-label="Ore al giorno della nuova persona"
        />{' '}
        h/giorno
      </label>
      <button className="btn" disabled={!valid} onClick={add}>
        + Aggiungi persona
      </button>
    </div>
  )
}
