import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { api } from '../api/client'
import type { Project } from '../api/types'
import { useAuth } from './authContext'

// JQL proposte (dal foglio Excel del Forecasting): PBI chiusi dopo l'inizio
// sviluppi, senza le label di servizio; Planned = "planned" e non "oos",
// Unplanned = "oos".
const BASE_JQL =
  'project = PTBSYS AND issuetype in (Activity, Bug, Story) AND status changed to DONE after "{inizio_sviluppi}" ' +
  'AND (labels not in (test-analysis, skip, action_item, "PTB_Master_HW&SW", Board_Redesign) OR labels is EMPTY)'
const PROPOSALS = {
  planned: `${BASE_JQL} AND labels in (planned) and labels not in (oos) ORDER BY resolutiondate`,
  unplanned: `${BASE_JQL} AND labels in (oos) ORDER BY resolutiondate`,
}

type Pair = { planned: string; unplanned: string }
const LABELS: Record<keyof Pair, string> = { planned: 'Planned PBI Done', unplanned: 'Unplanned PBI Done' }

function JqlFields({
  value,
  onChange,
  editable,
  emptyHint,
}: {
  value: Pair
  onChange: (value: Pair) => void
  editable: boolean
  emptyHint: string
}) {
  return (
    <>
      {(['planned', 'unplanned'] as const).map((part) => (
        <div key={part} className="form-row">
          <label>
            JQL {LABELS[part]}{' '}
            {editable && value[part].trim() !== PROPOSALS[part] && (
              <button type="button" className="link-btn" onClick={() => onChange({ ...value, [part]: PROPOSALS[part] })}>
                usa la proposta
              </button>
            )}
          </label>
          <textarea
            rows={3}
            value={value[part]}
            disabled={!editable}
            placeholder={emptyHint}
            onChange={(e) => onChange({ ...value, [part]: e.target.value })}
          />
        </div>
      ))}
    </>
  )
}

// Criterio dei Planned/Unplanned #PBI Done delle nuove simulazioni: JQL
// predefinite (una volta per tutti gli increment), JQL dell'increment (solo
// se serve una query diversa) o, se mancano entrambe, le label del backlog.
export function DoneJqlSettings({
  project,
  onSave,
  saving,
}: {
  project: Project
  onSave: (data: Pick<Project, 'planned_done_jql' | 'unplanned_done_jql'>) => void
  saving: boolean
}) {
  const { can } = useAuth()
  const editable = can('editor')
  const queryClient = useQueryClient()
  const { data: defaults } = useQuery({ queryKey: ['done-jql-defaults'], queryFn: api.forecasting.doneJqlDefaults })
  const saveDefaults = useMutation({
    mutationFn: (value: Pair) =>
      api.forecasting.updateDoneJqlDefaults({
        planned_done_jql: value.planned.trim() || null,
        unplanned_done_jql: value.unplanned.trim() || null,
      }),
    onSuccess: (saved) => {
      queryClient.setQueryData(['done-jql-defaults'], saved)
      queryClient.invalidateQueries({ queryKey: ['done-counts'] })
    },
  })

  const own = { planned: project.planned_done_jql ?? '', unplanned: project.unplanned_done_jql ?? '' }
  const hasOwn = !!(own.planned.trim() || own.unplanned.trim())
  const savedDefaults = { planned: defaults?.planned_done_jql ?? '', unplanned: defaults?.unplanned_done_jql ?? '' }
  const hasDefaults = !!(savedDefaults.planned.trim() || savedDefaults.unplanned.trim())

  const [open, setOpen] = useState(false)
  const [defaultsDraft, setDefaultsDraft] = useState<Pair | null>(null)
  const [ownDraft, setOwnDraft] = useState<Pair | null>(null)
  const [override, setOverride] = useState<boolean | null>(null)
  const defaultsValue = defaultsDraft ?? savedDefaults
  const ownValue = ownDraft ?? own
  const overriding = override ?? hasOwn
  const same = (a: Pair, b: Pair) => a.planned.trim() === b.planned.trim() && a.unplanned.trim() === b.unplanned.trim()
  const defaultsDirty = !same(defaultsValue, savedDefaults)
  const ownDirty = overriding && !same(ownValue, own)
  const unsaved = defaultsDirty || ownDirty

  const status = hasOwn
    ? "dalle JQL di questo increment"
    : hasDefaults
      ? 'dalle JQL predefinite (valgono per tutti i tuoi increment)'
      : 'dalle label del backlog ("planned" → Planned, "oos" → Unplanned; se presenti entrambe vince "oos")'

  return (
    <div className="done-jql">
      <p className="muted" style={{ fontSize: 12, margin: '-6px 0 8px' }}>
        Planned/Unplanned #PBI Done delle nuove simulazioni, completati dall'Inizio sviluppi effettivo: <b>{status}</b>.{' '}
        {unsaved && <span className="done-jql-unsaved">⚠ JQL modificate ma non salvate. </span>}
        <button type="button" className="link-btn" onClick={() => setOpen((v) => !v)}>
          {open ? 'Chiudi' : '⚙ Query dei PBI Done'}
        </button>
      </p>
      {open && (
        <div className="done-jql-form">
          <h4>JQL predefinite · tutti i tuoi increment</h4>
          <JqlFields
            value={defaultsValue}
            onChange={setDefaultsDraft}
            editable={editable}
            emptyHint="Vuota = criterio delle label del backlog"
          />
          {editable && (
            <button
              className="btn"
              disabled={!defaultsDirty || saveDefaults.isPending}
              onClick={() => saveDefaults.mutate(defaultsValue, { onSuccess: () => setDefaultsDraft(null) })}
            >
              {saveDefaults.isPending ? 'Salvataggio…' : 'Salva le JQL predefinite'}
            </button>
          )}
          {defaultsDirty && <span className="done-jql-unsaved"> ⚠ modifiche non salvate</span>}
          {saveDefaults.isError && <div className="error-banner">{(saveDefaults.error as Error).message}</div>}

          <h4 style={{ marginTop: 16 }}>Solo per questo increment</h4>
          <label className="done-jql-override">
            <input
              type="checkbox"
              checked={overriding}
              disabled={!editable}
              onChange={(e) => {
                setOverride(e.target.checked)
                if (!e.target.checked && hasOwn) {
                  onSave({ planned_done_jql: null, unplanned_done_jql: null })
                  setOwnDraft(null)
                }
              }}
            />{' '}
            Usa JQL diverse da quelle predefinite per {project.code}
          </label>
          {overriding && (
            <>
              <JqlFields
                value={ownValue}
                onChange={setOwnDraft}
                editable={editable}
                emptyHint="Vuota = la JQL predefinita"
              />
              {editable && (
                <button
                  className="btn"
                  disabled={same(ownValue, own) || saving}
                  onClick={() => {
                    onSave({ planned_done_jql: ownValue.planned.trim() || null, unplanned_done_jql: ownValue.unplanned.trim() || null })
                    setOwnDraft(null)
                  }}
                >
                  {saving ? 'Salvataggio…' : "Salva le JQL dell'increment"}
                </button>
              )}
              {ownDirty && <span className="done-jql-unsaved"> ⚠ modifiche non salvate</span>}
            </>
          )}
          <p className="muted" style={{ fontSize: 12, margin: '10px 0 0' }}>
            <code>{'{inizio_sviluppi}'}</code> diventa l'Inizio sviluppi effettivo di ogni increment (o il suo Project start),
            nel formato AAAA/MM/GG: la stessa JQL vale per tutti gli increment, ognuno con la sua data.
          </p>
        </div>
      )}
    </div>
  )
}
