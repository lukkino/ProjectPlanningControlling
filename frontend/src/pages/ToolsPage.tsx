import { Link } from 'react-router-dom'
import { TOOLS } from '../lib/tools'

// Sezione Tools: elenco delle utility (vedi lib/tools.ts).
export function ToolsPage() {
  return (
    <div>
      <div className="page-header">
        <div>
          <h1>Tools</h1>
          <div className="sub">Utility di uso quotidiano, indipendenti da progetti e increment.</div>
        </div>
      </div>
      <div className="tools-grid">
        {TOOLS.map((tool) => (
          <Link key={tool.path} to={tool.path} className="card tool-card">
            <span className="tool-card-icon" aria-hidden>
              {tool.icon}
            </span>
            <span>
              <strong>{tool.name}</strong>
              <span className="muted tool-card-description">{tool.description}</span>
            </span>
          </Link>
        ))}
      </div>
    </div>
  )
}
