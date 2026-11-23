import { useQuery } from '@tanstack/react-query'
import { Link, useSearchParams } from 'react-router-dom'
import { api } from '../../api/client'
import { HoursCalculatorCard } from '../../components/HoursCalculatorCard'

// Tool Capacity Planner: il calcolatore delle ore di un progetto (team,
// ferie, periodo), scelto dal menu. I dati restano del progetto; "Copia nel
// Budget ore" riempie la tabella Budget ore del progetto, che poi vale con
// "Aggiorna ore progetto".
export function CapacityPlannerPage() {
  const [params, setParams] = useSearchParams()
  const selectedId = Number(params.get('progetto')) || null
  const { data: increments, isLoading } = useQuery({ queryKey: ['increments'], queryFn: api.increments.list })
  const selected = increments?.find((i) => i.id === selectedId) ?? null

  return (
    <div>
      <div className="page-header">
        <h2 style={{ margin: 0 }}>🧮 Capacity Planner</h2>
      </div>
      <div className="card">
        <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
          <label htmlFor="capacity-project">
            <strong>Progetto</strong>
          </label>
          <select
            id="capacity-project"
            value={selectedId ?? ''}
            onChange={(e) => setParams(e.target.value ? { progetto: e.target.value } : {})}
            style={{ minWidth: 260 }}
          >
            <option value="">{isLoading ? 'Caricamento…' : 'Scegli un progetto…'}</option>
            {increments?.map((i) => (
              <option key={i.id} value={i.id}>
                {i.code}
              </option>
            ))}
          </select>
          {selected && <Link to={`/increments/${selected.id}`}>Apri il progetto ↗</Link>}
        </div>
        <p className="muted" style={{ marginBottom: 0, fontSize: 13 }}>
          Calcola le ore disponibili di un progetto da team, ferie e periodo. I dati restano salvati sul progetto;
          "Copia nel Budget ore" sostituisce le righe della tabella Budget ore del progetto, che diventano il budget con
          "Aggiorna ore progetto".
        </p>
      </div>
      {selected && (
        <HoursCalculatorCard
          key={selected.id}
          incrementId={selected.id}
          projectStartDate={selected.start_date}
          projectEndDate={selected.end_date}
        />
      )}
    </div>
  )
}
