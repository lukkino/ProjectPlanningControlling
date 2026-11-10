import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { api } from '../api/client'
import type { IncrementComponent } from '../api/types'
import { formatIsoDate } from '../lib/dates'
import { useProjectContext } from './useProjectContext'

const NEW_COMPONENT = '__new__'

// Testo che si salva uscendo dal campo; key sul valore per riallinearlo dopo
// il salvataggio.
function CellInput({
  value,
  label,
  multiline,
  onSave,
}: {
  value: string | null
  label: string
  multiline?: boolean
  onSave: (value: string | null) => void
}) {
  const current = value ?? ''
  const save = (next: string) => {
    if (next.trim() !== current) onSave(next.trim() || null)
  }
  if (multiline) {
    return (
      <textarea
        key={current}
        aria-label={label}
        defaultValue={current}
        rows={Math.max(1, current.split('\n').length)}
        onBlur={(e) => save(e.target.value)}
      />
    )
  }
  return (
    <input
      key={current}
      aria-label={label}
      defaultValue={current}
      onBlur={(e) => save(e.target.value)}
      onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
    />
  )
}

// Tab "Components & PN" di un increment: i componenti impattati e il loro
// Part Number. Sono i componenti della sua riga nella sezione Releases, che
// si aggiungono solo da qui. Il menu dei componenti viene dalla sezione Releases (solo i
// nomi) piu' quelli creati qui; aggiungendone uno si propone il PN successivo
// al piu' alto della sua famiglia (PTB-SRV, PTB-CLN, ...) tra le release che
// nella sezione Releases vengono prima di questo increment.
export function IncrementComponentsPage() {
  const { project } = useProjectContext()
  const queryClient = useQueryClient()
  const [picked, setPicked] = useState('')
  const [newName, setNewName] = useState('')
  const [newFamily, setNewFamily] = useState('')
  const [actionError, setActionError] = useState<string | null>(null)

  const componentsKey = ['increment-components', project.id]
  const { data: components, isLoading, error } = useQuery({
    queryKey: componentsKey,
    queryFn: () => api.incrementComponents.list(project.id),
  })
  const { data: catalog } = useQuery({
    queryKey: ['component-catalog', project.id],
    queryFn: () => api.incrementComponents.catalog(project.id),
  })
  const releaseKey = ['increment-release', project.id]
  const { data: release } = useQuery({ queryKey: releaseKey, queryFn: () => api.incrementComponents.release(project.id) })

  const onError = (e: Error) => setActionError(e.message)
  const refresh = () => {
    setActionError(null)
    queryClient.invalidateQueries({ queryKey: ['releases'] })
    queryClient.invalidateQueries({ queryKey: releaseKey })
    return queryClient.invalidateQueries({ queryKey: componentsKey })
  }
  const syncRelease = useMutation({
    mutationFn: () => api.incrementComponents.syncRelease(project.id),
    onSuccess: refresh,
    onError,
  })
  const addComponent = useMutation({
    mutationFn: (name: string) => api.incrementComponents.create(project.id, name),
    onSuccess: () => {
      setPicked('')
      return refresh()
    },
    onError,
  })
  const updateComponent = useMutation({
    mutationFn: ({ id, data }: { id: number; data: Partial<Omit<IncrementComponent, 'id' | 'pn_used_by'>> }) =>
      api.incrementComponents.update(id, data),
    onSuccess: refresh,
    onError,
  })
  const removeComponent = useMutation({
    mutationFn: (id: number) => api.incrementComponents.remove(id),
    onSuccess: refresh,
    onError,
  })
  const createCatalogEntry = useMutation({
    mutationFn: () => api.incrementComponents.createCatalogEntry({ name: newName.trim(), pn_family: newFamily.trim() || null }),
    onSuccess: async (entry) => {
      setNewName('')
      setNewFamily('')
      setActionError(null)
      await queryClient.invalidateQueries({ queryKey: ['component-catalog'] })
      setPicked(entry.name)
    },
    onError,
  })

  const usedNames = new Set((components ?? []).map((c) => c.name))
  const available = (catalog ?? []).filter((entry) => !usedNames.has(entry.name))
  const families = Array.from(new Set((catalog ?? []).flatMap((entry) => (entry.pn_family ? [entry.pn_family] : [])))).sort()
  const pickedEntry = (catalog ?? []).find((entry) => entry.name === picked)

  return (
    <div className="card">
      <h3 style={{ marginTop: 0 }}>Components &amp; PN</h3>
      <p className="muted" style={{ marginTop: 0 }}>
        I componenti impattati da questo increment e i loro Part Number. Aggiungendo un componente il PN proposto è il
        successivo al più alto della sua famiglia (PTB-SRV, PTB-CLN, PTB-LCS...) tra gli increment che nella sezione
        Releases vengono prima di questo (l'ordine si cambia lì con le frecce); si può correggere a mano. Sono gli stessi componenti che la sezione Releases mostra per questo
        increment. Le modifiche si salvano uscendo dal campo.
      </p>
      {(error || actionError) && <div className="error-banner">{actionError ?? (error as Error).message}</div>}

      {/* La riga dell'increment nella sezione Releases: si aggiorna da sola
          aggiungendo un componente, o col pulsante. */}
      {release && (
        <div
          className="card"
          style={{ background: 'var(--bg)', marginBottom: 14, display: 'flex', gap: 18, alignItems: 'center', flexWrap: 'wrap' }}
        >
          <strong style={{ fontSize: 13 }}>In Releases</strong>
          {[
            ['Project ID', release.ptih_code],
            ['Start Date', formatIsoDate(release.start_date)],
            ['Expected Release', formatIsoDate(release.expected_release_date)],
            ['Actual Release', formatIsoDate(release.actual_release_date)],
            ['Change Order', release.change_order],
          ].map(([label, value]) => (
            <span key={label} style={{ fontSize: 13 }}>
              <span className="muted">{label}: </span>
              {value || <span className="muted">—</span>}
            </span>
          ))}
          <button
            className="btn"
            style={{ marginLeft: 'auto' }}
            title="Riporta in Releases Project ID, date e Change Order di questo increment"
            disabled={syncRelease.isPending}
            onClick={() => syncRelease.mutate()}
          >
            ↻ Aggiorna dati in Releases
          </button>
        </div>
      )}

      <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 14, flexWrap: 'wrap' }}>
        <select
          aria-label="Componente da aggiungere"
          value={picked}
          onChange={(e) => setPicked(e.target.value)}
          style={{ flex: 1, minWidth: 260 }}
        >
          <option value="">Scegli un componente impattato...</option>
          {available.map((entry) => (
            <option key={entry.name} value={entry.name}>
              {entry.name}
              {entry.next_pn ? ` — ${entry.next_pn}` : entry.pn_family ? ` — ${entry.pn_family}` : ''}
            </option>
          ))}
          <option value={NEW_COMPONENT}>+ Nuovo componente...</option>
        </select>
        <button
          className="btn btn-primary"
          disabled={!picked || picked === NEW_COMPONENT || addComponent.isPending}
          onClick={() => addComponent.mutate(picked)}
        >
          + Aggiungi componente
        </button>
      </div>
      {pickedEntry && !pickedEntry.next_pn && (
        <p className="muted" style={{ marginTop: -6, fontSize: 13 }}>
          Nessun PN da proporre per {pickedEntry.name}: la famiglia non è nota o non compare negli increment precedenti.
          Il PN si compila a mano.
        </p>
      )}

      {picked === NEW_COMPONENT && (
        <form
          className="card"
          style={{ display: 'flex', gap: 8, alignItems: 'flex-end', flexWrap: 'wrap', background: 'var(--bg)', marginBottom: 14 }}
          onSubmit={(e) => {
            e.preventDefault()
            createCatalogEntry.mutate()
          }}
        >
          <label style={{ display: 'flex', flexDirection: 'column', gap: 4, flex: 1, minWidth: 220 }}>
            <span className="muted" style={{ fontSize: 12 }}>Nome del componente</span>
            <input value={newName} onChange={(e) => setNewName(e.target.value)} autoFocus />
          </label>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 4, width: 180 }}>
            <span className="muted" style={{ fontSize: 12 }}>Famiglia PN</span>
            <input list="pn-families" value={newFamily} placeholder="es. PTB-SRV" onChange={(e) => setNewFamily(e.target.value)} />
            <datalist id="pn-families">
              {families.map((family) => (
                <option key={family} value={family} />
              ))}
            </datalist>
          </label>
          <button type="submit" className="btn btn-primary" disabled={!newName.trim() || createCatalogEntry.isPending}>
            Crea
          </button>
          <button type="button" className="btn" onClick={() => setPicked('')}>
            Annulla
          </button>
        </form>
      )}

      {isLoading && <p className="muted">Caricamento...</p>}
      {components && components.length === 0 && (
        <p className="muted">Nessun componente impattato ancora: aggiungilo dal menu qui sopra.</p>
      )}
      {components && components.length > 0 && (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Componente</th>
                <th>PN</th>
                <th title="Sigla del componente nella Release Notice (es. PSDA → PSDA_6.0.0)">Sigla</th>
                <th>Fix version</th>
                <th title="Link all'artefatto del componente su Artifactory">Artifactory</th>
                <th>Dettaglio</th>
                <th>Note</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {components.map((component) => {
                const save = (field: 'pn' | 'abbreviation' | 'fix_version' | 'artifactory_url' | 'detail' | 'note') => (value: string | null) =>
                  updateComponent.mutate({ id: component.id, data: { [field]: value } })
                return (
                  <tr key={component.id}>
                    <td style={{ minWidth: 220 }}>{component.name}</td>
                    <td className="editable-cell" style={{ minWidth: 150, whiteSpace: 'normal' }}>
                      <CellInput value={component.pn} label="PN" onSave={save('pn')} />
                      {component.pn_used_by.length > 0 && (
                        <div style={{ fontSize: 11, color: '#b45309' }} title="Lo stesso PN compare già altrove">
                          ⚠ già usato da {component.pn_used_by.join(', ')}
                        </div>
                      )}
                    </td>
                    <td className="editable-cell" style={{ minWidth: 80 }}>
                      <CellInput value={component.abbreviation} label="Sigla" onSave={save('abbreviation')} />
                    </td>
                    <td className="editable-cell" style={{ minWidth: 100 }}>
                      <CellInput value={component.fix_version} label="Fix version" onSave={save('fix_version')} />
                    </td>
                    <td className="editable-cell" style={{ minWidth: 220 }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                        <CellInput value={component.artifactory_url} label="Link Artifactory" onSave={save('artifactory_url')} />
                        {component.artifactory_url && (
                          <a
                            href={component.artifactory_url}
                            target="_blank"
                            rel="noreferrer"
                            title="Apri l'artefatto su Artifactory"
                            aria-label={`Apri ${component.name} su Artifactory`}
                          >
                            ↗
                          </a>
                        )}
                      </div>
                    </td>
                    <td className="editable-cell" style={{ minWidth: 240, width: '50%', whiteSpace: 'normal' }}>
                      <CellInput value={component.detail} label="Dettaglio" multiline onSave={save('detail')} />
                    </td>
                    <td className="editable-cell" style={{ minWidth: 200, width: '50%', whiteSpace: 'normal' }}>
                      <CellInput value={component.note} label="Note" multiline onSave={save('note')} />
                    </td>
                    <td>
                      <button
                        className="btn"
                        title="Togli il componente dall'increment"
                        aria-label={`Togli ${component.name}`}
                        onClick={() => {
                          if (window.confirm(`Togliere ${component.name} da ${project.code}?`)) removeComponent.mutate(component.id)
                        }}
                      >
                        🗑
                      </button>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
