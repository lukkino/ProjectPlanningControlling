import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Fragment, useRef, useState } from 'react'
import { api, saveBlob, type WorkbookExportResult } from '../api/client'
import type {
  DocumentRevisionMeta,
  ImplementedByTask,
  PprDeliverable,
  PprInspection,
  Project,
  RequirementCheckItem,
  RequirementsCheck,
} from '../api/types'
import { StatusBadge } from '../components/StatusBadge'
import { useProjectContext } from './useProjectContext'

const DOCUMENT_TYPES = ['Story', 'Bug']

// Una sottosezione della pagina per ogni review, ognuna con il proprio
// documento PPR e gli altri documenti che servono per quella review.
const PPR_TYPES: { docType: string; label: string }[] = [
  { docType: 'planning', label: 'Planning Review' },
  { docType: 'execution', label: 'Execution Review' },
  { docType: 'deployment', label: 'Deployment Review' },
  { docType: 'release-to-market', label: 'Release to Market Review' },
]

// "Execution Review" -> "Execution" e il nome del suo file
// ("TIH-EXECUTION-PTBSYS.xlsx"), per dire chiaramente cosa caricare.
const pprDocName = (label: string) => label.replace(/ Review$/, '')
const pprFileName = (label: string) => `TIH-${pprDocName(label).toUpperCase().replace(/ /g, '_')}-PTBSYS.xlsx`

// Popup unico (stessa UI per tutti i documenti generati) per inserire
// versione e testo di revisione prima del download: i valori proposti
// (loadMeta) arrivano freschi dal backend ogni volta che si apre, cosi'
// riflettono l'eventuale ultima generazione fatta (es. la RR incrementa il
// proprio contatore lato server).
function DocumentDownloadButton({
  label,
  loadMeta,
  download,
}: {
  label: string
  loadMeta: () => Promise<DocumentRevisionMeta>
  download: (version: number, revisionText: string) => Promise<{ blob: Blob; filename: string }>
}) {
  const [open, setOpen] = useState(false)
  const [version, setVersion] = useState('')
  const [revisionText, setRevisionText] = useState('')

  const prepare = useMutation({
    mutationFn: loadMeta,
    onSuccess: (meta) => {
      setVersion(String(meta.next_version))
      setRevisionText(meta.last_revision_text)
      setOpen(true)
    },
  })

  const confirm = useMutation({
    mutationFn: () => download(Number(version) || 1, revisionText),
    onSuccess: ({ blob, filename }) => {
      saveBlob(blob, filename)
      setOpen(false)
    },
  })

  const close = () => {
    if (!confirm.isPending) setOpen(false)
  }

  return (
    <>
      <button className="btn btn-primary" disabled={prepare.isPending} onClick={() => prepare.mutate()}>
        {prepare.isPending ? 'Preparazione…' : `⬇ Scarica ${label} (.xlsx)`}
      </button>
      {open && (
        // onMouseDown (non onClick): un drag di selezione testo che parte
        // dentro il modale e termina fuori chiuderebbe il popup per
        // errore, perche' il click va all'antenato comune (l'overlay).
        <div className="modal-overlay" onMouseDown={(e) => e.target === e.currentTarget && close()}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h3 style={{ marginTop: 0 }}>{label}</h3>
            <div className="form-row">
              <label>Versione</label>
              <input type="number" value={version} onChange={(e) => setVersion(e.target.value)} />
            </div>
            <div className="form-row">
              <label>Descrizione revisione</label>
              <textarea rows={3} value={revisionText} onChange={(e) => setRevisionText(e.target.value)} />
            </div>
            {confirm.isError && <div className="error-banner">{(confirm.error as Error).message}</div>}
            <div className="form-actions">
              <button className="btn" onClick={close} disabled={confirm.isPending}>
                Annulla
              </button>
              <button className="btn btn-primary" onClick={() => confirm.mutate()} disabled={confirm.isPending}>
                {confirm.isPending ? 'Generazione…' : 'Genera e scarica'}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  )
}

// Spiegazione, mostrata dalla "i" accanto al pulsante, di come il backend
// compila in automatico il documento (services/document_generator.py): da
// tenere allineata a quel codice.
type DocumentInfo = { intro: string; sections: { title: string; points: string[] }[] }

const REGRESSION_ANALYSIS_INFO: DocumentInfo = {
  intro:
    'Il documento parte dal template ufficiale e viene compilato con i dati del Backlog di questo increment, così come sono dopo l\'ultima sincronizzazione con Jira.',
  sections: [
    {
      title: 'Cover',
      points: [
        'Titolo: "REGRESSION ANALYSIS", ProTube System, codice e nome dell\'increment.',
        'Firmatari: Project Manager, Quality Manager e Development Manager, sempre gli stessi.',
        'Revisione: versione e descrizione inserite nel popup, data di oggi e Project Manager come autore. Il popup propone versione 1 e un testo con il Change Order.',
      ],
    },
    {
      title: 'Foglio "Regression Analysis"',
      points: [
        'Una riga per ogni Story e Bug in scope: prima le Story, poi i Bug, nell\'ordine di priorità del Backlog.',
        'Colonna A: nome del Change Order configurato in questa pagina.',
        'Colonne B e C: ID Jira e tipo (Story o Bug).',
        'Colonna D: per le Story la description di Jira (il summary se è vuota); per i Bug il campo Jira "Change Description", oppure "n.a." se non è compilato.',
        'Le altre colonne restano vuote. Le righe di esempio del template vengono eliminate.',
      ],
    },
    {
      title: 'Numero di documento e nome del file',
      points: [
        'TIH-REA-PTBSYS-<anno>-<codice del Change Order>.<versione>, ad esempio TIH-REA-PTBSYS-2026-0129.1 per CO2026-0129. Compare anche nell\'intestazione di stampa.',
        'Se il nome del Change Order non è nel formato CO<anno>-<codice>, viene usato il codice dell\'increment.',
      ],
    },
  ],
}

const RELEASE_REPORT_INFO: DocumentInfo = {
  intro:
    'Il documento parte dal template ufficiale, che contiene lo storico degli increment precedenti, e viene compilato con i dati del Backlog di questo increment, così come sono dopo l\'ultima sincronizzazione con Jira.',
  sections: [
    {
      title: 'Cover',
      points: [
        'Titolo: "RELEASE REPORT", ProTube System, codice dell\'increment.',
        'Revision history: viene aggiunta una riga in fondo con versione e descrizione inserite nel popup e il Project Manager come autore.',
        'Il popup propone la versione successiva all\'ultima generata da qui e l\'ultima descrizione usata; la prima volta li prende dall\'ultima riga del template.',
      ],
    },
    {
      title: 'Foglio "Release Report": Bug',
      points: [
        'Una riga per ogni Bug in scope, nell\'ordine di priorità del Backlog. Le Story non hanno una riga propria.',
        'Colonne A-C: "Bug", ID Jira, summary.',
        'Colonna D: campo Jira "Problem Cause". Colonna E: campo Jira "Change Description". Se sono vuoti viene scritto "n.a.".',
        'Colonna F: components. Colonna G: "Version: <codice dell\'increment>, Labels: <label del Bug>".',
        'Colonne H e I: "n.a.".',
      ],
    },
    {
      title: 'Foglio "Release Report": Task',
      points: [
        'Dopo i Bug, una riga per ogni Task collegato con il link Jira "is implemented by" a una Story o a un Bug in scope: gli stessi Task della tabella in fondo a questa pagina.',
        'Colonne A-C: "Task", ID Jira, summary. Colonne D, E e H: "n.a.".',
        'Colonna F: components del Task. Colonna G: "Version: <fix version del Task>, Labels: <label del Task>".',
        'Colonna I: ID della Story o del Bug che il Task implementa.',
      ],
    },
    {
      title: 'Numero di documento e nome del file',
      points: [
        'Il file si chiama sempre TIH-RR-PTBSYS.xlsx. La versione compare solo nel numero di documento (TIH-RR-PTBSYS.<versione>), nel titolo del foglio e nell\'intestazione di stampa.',
      ],
    },
  ],
}

// Da tenere allineata a services/kickoff_presentation.py.
const KICKOFF_PRESENTATION_INFO: DocumentInfo = {
  intro:
    'La presentazione parte dal template ufficiale di Kick-off (MOD-KICK_OFF) e ne riscrive solo le slide che dipendono dall\'increment, con i dati del Backlog così come sono dopo l\'ultima sincronizzazione con Jira. Il testo è in inglese, come il template.',
  sections: [
    {
      title: 'Copertina e Team Members',
      points: [
        'Copertina: codice e nome dell\'increment, data di oggi.',
        'Team Members: in "Project Code for Timesheet" i progetti e i sotto-progetti collegati all\'increment.',
      ],
    },
    {
      title: 'Scope Description',
      points: [
        'Testo discorsivo ricavato dai summary delle Story in scope, escluse quelle con la label "oos": un paragrafo d\'apertura con i macro-argomenti e uno per ogni macro-argomento.',
        'Enhancement: le Story che citano un enhancement nel summary o nella description (es. "ENH 02215") hanno un paragrafo a parte, ognuna col suo riferimento in grassetto.',
        'Tickets / Complaints: i Bug in scope, ognuno col numero del complaint in grassetto (dall\'area Complaints, oppure dal prefisso "[12345]" del summary); i Bug che non sono complaint sono citati con l\'ID Jira.',
      ],
    },
    {
      title: 'Major Requirements',
      points: [
        'Le stesse Story, raggruppate per macro-argomento: i macro-argomenti sono le voci di primo livello dello Scope della Dashboard.',
        'Una Story va nella voce che la cita (ID Jira o numero di enhancement), in quella che si chiama come una sua label, oppure in quella di un\'altra Story con lo stesso Epic. Le altre sono raggruppate per Epic, o finiscono in "Other requirements".',
        'Se non stanno in una slide, l\'elenco continua su altre slide.',
      ],
    },
    {
      title: 'Project Timeline',
      points: [
        'Elenco delle fasi dell\'increment con il mese di scadenza, e grafico con una milestone per fase: conta la data effettiva se c\'è, altrimenti quella pianificata.',
        'Nella barra dell\'increment: lo sviluppo fino al Code Freeze e i progetti collegati che hanno date di inizio e fine, con la parte già trascorsa più scura.',
      ],
    },
    {
      title: 'Slide non modificate',
      points: [
        'Agenda, mercati, vincoli, volumi, product line ed effort restano quelli del template: vanno aggiornati a mano.',
      ],
    },
  ],
}

// Presentazione .pptx: nessun dato da chiedere, si scarica subito.
function PresentationDownloadButton({
  label,
  download,
}: {
  label: string
  download: () => Promise<{ blob: Blob; filename: string }>
}) {
  const run = useMutation({
    mutationFn: download,
    onSuccess: ({ blob, filename }) => saveBlob(blob, filename),
  })

  return (
    <>
      <button className="btn btn-primary" disabled={run.isPending} onClick={() => run.mutate()}>
        {run.isPending ? 'Generazione…' : `⬇ Scarica ${label} (.pptx)`}
      </button>
      {run.isError && (
        <div className="modal-overlay" onMouseDown={(e) => e.target === e.currentTarget && run.reset()}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h3 style={{ marginTop: 0 }}>{label}</h3>
            <div className="error-banner">{(run.error as Error).message}</div>
            <div className="form-actions">
              <button className="btn btn-primary" onClick={() => run.reset()}>
                Chiudi
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  )
}

// "i" accanto a un pulsante di download: apre un popup con la spiegazione.
function DocumentInfoButton({ label, info }: { label: string; info: DocumentInfo }) {
  const [open, setOpen] = useState(false)

  return (
    <>
      <button
        type="button"
        className="info-icon"
        style={{ background: 'none', padding: 0, cursor: 'pointer' }}
        title={`Come viene compilato ${label}`}
        aria-label={`Come viene compilato ${label}`}
        onClick={() => setOpen(true)}
      >
        i
      </button>
      {open && (
        // onMouseDown (non onClick): vedi commento in DocumentDownloadButton.
        <div className="modal-overlay" onMouseDown={(e) => e.target === e.currentTarget && setOpen(false)}>
          <div className="modal" style={{ width: 620 }} onClick={(e) => e.stopPropagation()}>
            <h3 style={{ marginTop: 0 }}>Come viene compilato {label}</h3>
            <p style={{ marginTop: 0 }}>{info.intro}</p>
            {info.sections.map((section) => (
              <div key={section.title}>
                <strong>{section.title}</strong>
                <ul style={{ marginTop: 4, paddingLeft: 20 }}>
                  {section.points.map((point) => (
                    <li key={point}>{point}</li>
                  ))}
                </ul>
              </div>
            ))}
            <div className="form-actions">
              <button className="btn btn-primary" onClick={() => setOpen(false)}>
                Chiudi
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  )
}

// File scelto dall'utente -> base64 (senza il prefisso "data:...;base64,"),
// per mandarlo al backend dentro un JSON.
function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result).split(',', 2)[1] ?? '')
    reader.onerror = () => reject(reader.error ?? new Error('Lettura del file non riuscita'))
    reader.readAsDataURL(file)
  })
}

type PprUpload = { name: string; b64: string; info: PprInspection }

// Scelta di un documento PPR precedente (.xlsx): appena scelto, il backend
// controlla che sia del tipo giusto e ne legge l'ultima versione.
function PprFilePicker({
  docLabel,
  fileName,
  purpose,
  hint,
  upload,
  inspect,
  onLoad,
  onClear,
}: {
  docLabel: string
  fileName: string
  purpose: string
  hint: string
  upload: PprUpload | null
  inspect: (fileB64: string) => Promise<PprInspection>
  onLoad: (upload: PprUpload) => void
  onClear: () => void
}) {
  const fileRef = useRef<HTMLInputElement>(null)
  const check = useMutation({
    mutationFn: async (file: File) => {
      const b64 = await fileToBase64(file)
      return { name: file.name, b64, info: await inspect(b64) }
    },
    onSuccess: onLoad,
  })

  return (
    // Riquadro col tipo di documento ben in vista: i file da caricare si
    // somigliano (TIH-PLANNING-PTBSYS, TIH-EXECUTION-PTBSYS...).
    <div
      className="form-row"
      style={{ border: '1px solid var(--border)', borderRadius: 6, padding: '8px 10px' }}
    >
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap', marginBottom: 6 }}>
        <span>Ultimo</span>
        <strong
          style={{
            fontSize: 15,
            textTransform: 'uppercase',
            padding: '1px 8px',
            borderRadius: 4,
            background: 'var(--primary)',
            color: '#fff',
          }}
        >
          {docLabel}
        </strong>
        <span className="muted">
          ({fileName}) · {purpose}
        </span>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', fontSize: 13 }}>
        <input
          ref={fileRef}
          type="file"
          accept=".xlsx"
          style={{ display: 'none' }}
          onChange={(e) => {
            const file = e.target.files?.[0]
            e.target.value = ''
            if (file) check.mutate(file)
          }}
        />
        <button className="btn" type="button" disabled={check.isPending} onClick={() => fileRef.current?.click()}>
          {check.isPending ? 'Controllo…' : upload ? 'Cambia file' : 'Scegli file…'}
        </button>
        {upload ? (
          <>
            <span>📄 {upload.name}</span>
            <span className="muted">
              · ultima versione {upload.info.last_version ?? '—'}
              {upload.info.last_description && `: ${upload.info.last_description}`}
            </span>
            {upload.info.old_template && (
              <span className="muted" style={{ color: '#b45309' }}>
                · vecchio template: presi solo versione e Revision History
              </span>
            )}
            <button className="link-btn" type="button" title="Togli il file" onClick={onClear}>
              ✕
            </button>
          </>
        ) : (
          <span className="muted">{hint}</span>
        )}
      </div>
      {check.isError && (
        <div className="error-banner" style={{ marginTop: 6 }}>
          {(check.error as Error).message}
        </div>
      )}
    </div>
  )
}

// Documento PPR (Planning, Execution, Deployment, Release to Market): si
// caricano l'ultima versione dello stesso documento (Cover e Revision
// History, facoltativa la prima volta) e, tranne che per il Planning,
// l'ultimo documento della fase precedente (fogli delle review precedenti
// e Action Items). Per il Planning anche la sezione "Deliverable Check",
// precompilata dall'ultimo Planning se caricato.
function PprDownloadButton({
  projectId,
  docType,
  label,
  previousLabel,
}: {
  projectId: number
  docType: string
  label: string
  previousLabel: string | null
}) {
  const [open, setOpen] = useState(false)
  const [defaultVersion, setDefaultVersion] = useState(1)
  const [version, setVersion] = useState('')
  const [revisionText, setRevisionText] = useState('')
  const [deliverables, setDeliverables] = useState<PprDeliverable[]>([])
  const [defaultDeliverables, setDefaultDeliverables] = useState<PprDeliverable[]>([])
  const [previous, setPrevious] = useState<PprUpload | null>(null)
  const [previousPhase, setPreviousPhase] = useState<PprUpload | null>(null)
  const isPlanning = docType === 'planning'

  const prepare = useMutation({
    mutationFn: () => api.documents.pprMeta(projectId, docType),
    onSuccess: (meta) => {
      setDefaultVersion(meta.next_version)
      setVersion(String(meta.next_version))
      setRevisionText(meta.last_revision_text)
      setDeliverables(meta.deliverables)
      setDefaultDeliverables(meta.deliverables)
      setPrevious(null)
      setPreviousPhase(null)
      setGenerated(null)
      setOpen(true)
    },
  })

  // Tranne che per il Planning, col documento si prepara anche l'elenco dei
  // documenti attesi alla review con i loro owner (.txt). Non lo si scarica
  // in automatico: un secondo download senza clic, a fine generazione,
  // viene bloccato dal browser. Il popup resta aperto col pulsante.
  const [generated, setGenerated] = useState<{
    filename: string
    list: { blob: Blob; filename: string }
  } | null>(null)

  const confirm = useMutation({
    mutationFn: async () => {
      const document = await api.documents.ppr(projectId, docType, {
        version: Number(version) || 1,
        revision_text: revisionText,
        deliverables: isPlanning ? deliverables : null,
        previous_b64: previous?.b64 ?? null,
        previous_phase_b64: previousPhase?.b64 ?? null,
      })
      const list = isPlanning ? null : await api.documents.pprDeliverablesTxt(projectId, docType)
      return { document, list }
    },
    onSuccess: ({ document, list }) => {
      saveBlob(document.blob, document.filename)
      if (list) setGenerated({ filename: document.filename, list })
      else setOpen(false)
    },
  })

  const close = () => {
    if (!confirm.isPending) {
      setOpen(false)
      setGenerated(null)
    }
  }

  const updateDeliverable = (row: number, patch: Partial<PprDeliverable>) => {
    setDeliverables((prev) => prev.map((d) => (d.row === row ? { ...d, ...patch } : d)))
  }

  const missingPreviousPhase = previousLabel !== null && previousPhase === null

  return (
    <>
      <button className="btn btn-primary" disabled={prepare.isPending} onClick={() => prepare.mutate()}>
        {prepare.isPending ? 'Preparazione…' : `⬇ Scarica ${label} (.xlsx)`}
      </button>
      {open && generated && (
        <div className="modal-overlay" onMouseDown={(e) => e.target === e.currentTarget && close()}>
          <div className="modal" style={{ width: 520 }} onClick={(e) => e.stopPropagation()}>
            <h3 style={{ marginTop: 0 }}>{label}</h3>
            <p style={{ marginTop: 0 }}>✓ Scaricato {generated.filename}</p>
            <p className="muted">
              Elenco dei documenti attesi alla review, con l'owner di ciascuno preso dal Task Guideline.
            </p>
            <div className="form-actions">
              <button className="btn" onClick={close}>
                Chiudi
              </button>
              <button
                className="btn btn-primary"
                onClick={() => {
                  saveBlob(generated.list.blob, generated.list.filename)
                  close()
                }}
              >
                ⬇ Scarica {generated.list.filename}
              </button>
            </div>
          </div>
        </div>
      )}
      {open && !generated && (
        // onMouseDown (non onClick): vedi commento in DocumentDownloadButton.
        <div className="modal-overlay" onMouseDown={(e) => e.target === e.currentTarget && close()}>
          <div className="modal" style={{ width: 680 }} onClick={(e) => e.stopPropagation()}>
            <h3 style={{ marginTop: 0 }}>Genera {label}</h3>
            <p className="muted" style={{ marginTop: 0 }}>Documenti precedenti da caricare:</p>
            <PprFilePicker
              docLabel={pprDocName(label)}
              fileName={pprFileName(label)}
              purpose="firmatari e Revision History"
              hint="Facoltativo: senza, la Revision History parte dalla versione indicata sotto (primo documento di questo tipo)"
              upload={previous}
              inspect={(b64) => api.documents.pprInspect(projectId, docType, 'previous', b64)}
              onLoad={(upload) => {
                setPrevious(upload)
                setVersion(String((upload.info.last_version ?? 0) + 1))
                if (upload.info.deliverables) setDeliverables(upload.info.deliverables)
              }}
              onClear={() => {
                setPrevious(null)
                setVersion(String(defaultVersion))
                setDeliverables(defaultDeliverables)
              }}
            />
            {previousLabel && (
              <PprFilePicker
                docLabel={pprDocName(previousLabel)}
                fileName={pprFileName(previousLabel)}
                purpose="fogli delle review precedenti e Action Items"
                hint="Obbligatorio"
                upload={previousPhase}
                inspect={(b64) => api.documents.pprInspect(projectId, docType, 'previous_phase', b64)}
                onLoad={setPreviousPhase}
                onClear={() => setPreviousPhase(null)}
              />
            )}
            <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
              <div className="form-row" style={{ width: 100 }}>
                <label>Versione</label>
                <input type="number" value={version} onChange={(e) => setVersion(e.target.value)} />
              </div>
              <div className="form-row" style={{ flex: 1, minWidth: 260 }}>
                <label>Descrizione revisione</label>
                <textarea rows={2} value={revisionText} onChange={(e) => setRevisionText(e.target.value)} />
              </div>
            </div>
            {isPlanning && (
              <div className="form-row">
                <label>
                  Deliverable Check (foglio Planning Review)
                  {previous?.info.deliverables && <span className="muted"> · precompilato dall'ultimo Planning</span>}
                </label>
                <div className="table-wrap" style={{ maxHeight: 320, overflowY: 'auto' }}>
                  <table>
                    <thead>
                      <tr>
                        <th style={{ width: 28 }}></th>
                        <th>Documento</th>
                        <th style={{ width: 150 }}>Nome file</th>
                        <th style={{ width: 200 }}>Note</th>
                      </tr>
                    </thead>
                    <tbody>
                      {deliverables.map((d) => (
                        <tr key={d.row}>
                          <td>
                            <input
                              type="checkbox"
                              checked={d.included}
                              onChange={(e) => updateDeliverable(d.row, { included: e.target.checked })}
                            />
                          </td>
                          <td style={{ whiteSpace: 'normal' }}>{d.name}</td>
                          <td>
                            <input
                              value={d.filename}
                              disabled={!d.included}
                              placeholder={d.included ? 'es. FL-UN.1' : 'N/A'}
                              onChange={(e) => updateDeliverable(d.row, { filename: e.target.value })}
                            />
                          </td>
                          <td>
                            <input
                              value={d.notes}
                              onChange={(e) => updateDeliverable(d.row, { notes: e.target.value })}
                            />
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}
            {confirm.isError && <div className="error-banner">{(confirm.error as Error).message}</div>}
            <div className="form-actions">
              <button className="btn" onClick={close} disabled={confirm.isPending}>
                Annulla
              </button>
              <button
                className="btn btn-primary"
                title={missingPreviousPhase ? `Carica prima l'ultimo ${previousLabel}` : undefined}
                onClick={() => confirm.mutate()}
                disabled={confirm.isPending || missingPreviousPhase}
              >
                {confirm.isPending ? 'Generazione… (Excel, qualche secondo)' : 'Genera e scarica'}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  )
}

// Esporta Design Input / User Needs: si sceglie il documento corrente
// (.xlsx), il backend vi aggiunge in cima le righe di questo increment e
// restituisce il file aggiornato, scaricato subito; poi un popup riassume
// cosa e' stato aggiunto e quali righe obsolete sono state dichiarate
// "Removed" nella revision history. `noun` e' come chiamare le righe aggiunte
// nei messaggi ("story", "user need").
function WorkbookExportButton({
  label,
  title,
  noun,
  exportFile,
}: {
  label: string
  title: string
  noun: string
  exportFile: (file: File) => Promise<WorkbookExportResult>
}) {
  const fileRef = useRef<HTMLInputElement>(null)
  const run = useMutation({
    mutationFn: exportFile,
    onSuccess: (result) => {
      // Il file cambia se ha righe nuove o una nuova riga di revisione.
      if (result.added.length > 0 || result.removed.length > 0) saveBlob(result.blob, result.filename)
    },
  })
  const changed = run.isSuccess && (run.data.added.length > 0 || run.data.removed.length > 0)

  return (
    <>
      <button className="btn btn-primary" title={title} onClick={() => fileRef.current?.click()} disabled={run.isPending}>
        {run.isPending ? 'Esportazione...' : `📄 Esporta ${label}`}
      </button>
      <input
        ref={fileRef}
        type="file"
        accept=".xlsx"
        style={{ display: 'none' }}
        onChange={(e) => {
          const file = e.target.files?.[0]
          // Svuotato subito: scegliere di nuovo lo stesso file deve far ripartire l'esportazione.
          e.target.value = ''
          if (file) run.mutate(file)
        }}
      />
      {/* flexBasis 100%: il messaggio va a capo sotto i pulsanti della sottosezione. */}
      {run.isError && (
        <div className="error-banner" style={{ flexBasis: '100%', marginBottom: 0 }}>
          Esportazione {label} non riuscita: {(run.error as Error).message}
        </div>
      )}
      {run.isSuccess && (
        // Riepilogo di cio' che l'esportazione ha fatto, mostrato dopo il
        // salvataggio del file. onMouseDown: vedi DocumentDownloadButton.
        <div className="modal-overlay" onMouseDown={(e) => e.target === e.currentTarget && run.reset()}>
          <div className="modal" style={{ width: 640 }} onClick={(e) => e.stopPropagation()}>
            <h3 style={{ marginTop: 0 }}>{label}: riepilogo</h3>
            {changed ? (
              <p style={{ marginTop: 0 }}>
                File salvato: <strong>{run.data.filename}</strong>.{' '}
                {run.data.version != null
                  ? `Documento portato alla versione ${run.data.version}, con la nuova riga nella revision history.`
                  : 'Versione e revision history non aggiornate (Cover non riconosciuta): da fare a mano.'}
              </p>
            ) : (
              <p style={{ marginTop: 0 }}>Nessuna modifica da fare: il file non è stato salvato.</p>
            )}
            <ExportSummaryList title={`Aggiunte in cima al foglio (${noun})`} keys={run.data.added} />
            <ExportSummaryList
              title="Obsolete: scritte come “Removed” nella revision history"
              keys={run.data.removed}
              note="Le righe NON sono state cancellate: sono ancora nel documento, da togliere a mano dopo il controllo."
            />
            <ExportSummaryList
              title="Obsolete già dichiarate “Removed” in una revisione precedente, ma ancora nel documento"
              keys={run.data.stillPresent}
              note="Da togliere a mano."
            />
            {run.data.duplicates.length > 0 && (
              <div style={{ marginTop: 10 }}>
                <strong>Non aggiunte: stesso contenuto già presente con un altro ID ({run.data.duplicates.length})</strong>
                <div>{run.data.duplicates.map((d) => `${d.key} (uguale a ${d.existing})`).join(', ')}</div>
              </div>
            )}
            {run.data.excluded.length > 0 && (
              <div style={{ marginTop: 10 }}>
                <strong>Non aggiunte pur avendo la fix version dell'increment ({run.data.excluded.length})</strong>
                <div>{run.data.excluded.join(', ')}</div>
              </div>
            )}
            {run.data.skipped > 0 && (
              <div className="muted" style={{ marginTop: 10 }}>
                {run.data.skipped} {noun} dell'increment erano già nel documento.
              </div>
            )}
            <div className="form-actions">
              <button className="btn btn-primary" onClick={() => run.reset()}>
                Chiudi
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  )
}

// Una voce del riepilogo dell'esportazione: titolo, chiavi Jira e nota.
function ExportSummaryList({ title, keys, note }: { title: string; keys: string[]; note?: string }) {
  if (keys.length === 0) return null
  return (
    <div style={{ marginTop: 10 }}>
      <strong>
        {title} ({keys.length})
      </strong>
      <div>
        {keys.map((key, index) => (
          <Fragment key={key}>
            {index > 0 && ', '}
            {jiraLink(key)}
          </Fragment>
        ))}
      </div>
      {note && <div className="muted">{note}</div>}
    </div>
  )
}

const jiraLink = (key: string) => (
  <a href={`https://inpeco.atlassian.net/browse/${key}`} target="_blank" rel="noreferrer">
    {key}
  </a>
)

// Una voce dell'esito della verifica: titolo e, sotto, l'elenco delle issue.
function RequirementsCheckList({
  title,
  items,
  detail,
}: {
  title: string
  items: RequirementCheckItem[]
  detail?: (item: RequirementCheckItem) => string
}) {
  if (items.length === 0) return null
  return (
    <div style={{ marginTop: 8 }}>
      <strong>
        {title} ({items.length})
      </strong>
      <ul style={{ margin: '4px 0 0', paddingLeft: 20 }}>
        {items.map((item) => (
          <li key={item.key}>
            {jiraLink(item.key)} {item.summary}
            {detail && <span className="muted"> — {detail(item)}</span>}
          </li>
        ))}
      </ul>
    </div>
  )
}

// Verifica Design Input / User Needs: si sceglie il documento (.xlsx, quello
// di partenza o quello appena esportato) e il backend lo confronta con Jira.
// Il documento dovrebbe contenere tutte e sole le issue non obsolete che
// sono in Done oppure hanno la fix version di questo increment (un'issue
// sostituita da un'altra, "is expanded by", resta in Done ma non deve
// esserci). Il file non viene modificato. `noun` e' come chiamare le righe
// nei messaggi ("Story", "User Need").
function RequirementsCheckButton({
  label,
  code,
  noun,
  checkFile,
}: {
  label: string
  code: string
  noun: string
  checkFile: (file: File) => Promise<RequirementsCheck>
}) {
  const fileRef = useRef<HTMLInputElement>(null)
  const run = useMutation({ mutationFn: checkFile })
  const check = run.data

  // Anomalie: tutto tranne le issue di questo increment (fix version) ancora da chiudere.
  const pending = check?.not_done_in_document.filter((i) => i.current_increment) ?? []
  const notDone = check?.not_done_in_document.filter((i) => !i.current_increment) ?? []
  const problems = check
    ? check.missing.length +
      check.obsolete_in_document.length +
      notDone.length +
      check.wrong_category_in_document.length +
      check.unknown_in_document.length +
      check.repeated_in_document.length
    : 0

  return (
    <>
      <button
        className="btn"
        title={`Scegli un documento ${label} (${code}, .xlsx): viene confrontato con le ${noun} su Jira, senza modificarlo`}
        onClick={() => fileRef.current?.click()}
        disabled={run.isPending}
      >
        {run.isPending ? 'Verifica...' : `🔍 Verifica ${label}`}
      </button>
      <input
        ref={fileRef}
        type="file"
        accept=".xlsx"
        style={{ display: 'none' }}
        onChange={(e) => {
          const file = e.target.files?.[0]
          e.target.value = ''
          if (file) run.mutate(file)
        }}
      />
      {run.isError && (
        <div className="error-banner" style={{ flexBasis: '100%', marginBottom: 0 }}>
          Verifica {label} non riuscita: {(run.error as Error).message}
        </div>
      )}
      {check && (
        <div
          className="error-banner"
          style={{
            flexBasis: '100%',
            marginBottom: 0,
            ...(problems === 0 ? { background: '#e9f7ee', color: '#1a9c5c', borderColor: '#b8e3c8' } : {}),
          }}
        >
          <div>
            <strong>
              {problems === 0
                ? `Verifica ${label}: il documento è allineato a Jira.`
                : `Verifica ${label}: ${problems} ${problems === 1 ? 'anomalia' : 'anomalie'} da controllare.`}
            </strong>
          </div>
          <div>
            Nel documento: {check.document_count} {noun}. Su Jira ({check.jira_project}) in Done e valide:{' '}
            {check.jira_valid_count}
            {check.jira_obsolete_count > 0 && `, più ${check.jira_obsolete_count} in Done ma obsolete (sostituite da un'altra)`}
            .
            {pending.length > 0 &&
              ` Il documento ne ha ${pending.length} in più perché hanno la fix version di questo increment e non sono ancora in Done.`}
          </div>
          <RequirementsCheckList
            title="Attese ma mancanti nel documento"
            items={check.missing}
            detail={(i) => (i.current_increment ? `di questo increment, stato ${i.status}` : i.status)}
          />
          <RequirementsCheckList
            title="Nel documento, ma obsolete su Jira: da togliere"
            items={check.obsolete_in_document}
            detail={(i) => (i.expanded_by.length > 0 ? `sostituita da ${i.expanded_by.join(', ')}` : 'Expand Status = INVALID')}
          />
          <RequirementsCheckList
            title="Nel documento, ma non in Done su Jira e senza la fix version di questo increment"
            items={notDone}
            detail={(i) => i.status}
          />
          <RequirementsCheckList
            title={`Nel documento, ma su Jira non sono ${noun}`}
            items={check.wrong_category_in_document}
            detail={(i) => `Epic Category = ${i.category || 'vuota'}, stato ${i.status}`}
          />
          {check.unknown_in_document.length > 0 && (
            <div style={{ marginTop: 8 }}>
              <strong>Nel documento, ma non trovate su Jira:</strong> {check.unknown_in_document.join(', ')}
            </div>
          )}
          {check.repeated_in_document.length > 0 && (
            <div style={{ marginTop: 8 }}>
              <strong>Ripetute nel documento:</strong> {check.repeated_in_document.join(', ')}
            </div>
          )}
          <RequirementsCheckList
            title="Con la fix version di questo increment, non ancora in Done (attese nel documento)"
            items={pending}
            detail={(i) => i.status}
          />
        </div>
      )}
    </>
  )
}

function parseImplementedBy(json: string | null): ImplementedByTask[] {
  if (!json) return []
  try {
    const parsed = JSON.parse(json)
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

export function DocumentsPage() {
  const { project } = useProjectContext()
  const queryClient = useQueryClient()
  const [hiddenTypes, setHiddenTypes] = useState<Set<string>>(new Set())
  // Box di configurazione del Change Order: aperto di default solo se non
  // ancora configurato, altrimenti la pagina mostra solo il nome cliccabile
  // (si riapre col bottone "Modifica").
  const [editingChangeOrder, setEditingChangeOrder] = useState(!project.change_order_url)
  const [coUrl, setCoUrl] = useState(project.change_order_url ?? '')
  const [coLabel, setCoLabel] = useState(project.change_order_label ?? '')

  const { data: items } = useQuery({
    queryKey: ['backlog', project.id],
    queryFn: () => api.backlog.list(project.id),
  })

  const updateProject = useMutation({
    mutationFn: (data: Partial<Project>) => api.projects.update(project.id, data),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['project', project.id] }),
  })

  const toggleType = (type: string) => {
    setHiddenTypes((prev) => {
      const next = new Set(prev)
      if (next.has(type)) next.delete(type)
      else next.add(type)
      return next
    })
  }

  const documentItems = (items ?? []).filter(
    (i) => i.in_scope && i.issue_type && DOCUMENT_TYPES.includes(i.issue_type) && !hiddenTypes.has(i.issue_type),
  )

  return (
    <div>
      <div className="card">
        <div className="page-header" style={{ marginBottom: 0 }}>
          <div>
            <h3 style={{ margin: 0 }}>Documents</h3>
            <span className="sub muted">
              Story e Bug in scope del Backlog, con il parent (Epic) e i Task collegati che li implementano (link
              Jira "is implemented by").
            </span>
          </div>
        </div>
      </div>

      <div className="card">
        <h3 style={{ marginTop: 0 }}>Change Order</h3>
        {!editingChangeOrder && project.change_order_url ? (
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <a href={project.change_order_url} target="_blank" rel="noreferrer" className="btn btn-primary">
              {project.change_order_label || project.change_order_url}
            </a>
            <button
              className="btn"
              onClick={() => {
                setCoUrl(project.change_order_url ?? '')
                setCoLabel(project.change_order_label ?? '')
                setEditingChangeOrder(true)
              }}
            >
              Modifica
            </button>
          </div>
        ) : (
          <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'flex-end' }}>
            <div className="form-row" style={{ marginBottom: 0, minWidth: 260, flex: 1 }}>
              <label>URL Change Order</label>
              <input placeholder="https://..." value={coUrl} onChange={(e) => setCoUrl(e.target.value)} />
            </div>
            <div className="form-row" style={{ marginBottom: 0, minWidth: 200, flex: 1 }}>
              <label>Nome Change Order</label>
              <input placeholder="es. CO2026-0123" value={coLabel} onChange={(e) => setCoLabel(e.target.value)} />
            </div>
            <div style={{ display: 'flex', gap: 8 }}>
              {project.change_order_url && (
                <button className="btn" onClick={() => setEditingChangeOrder(false)} disabled={updateProject.isPending}>
                  Annulla
                </button>
              )}
              <button
                className="btn btn-primary"
                disabled={!coUrl.trim() || updateProject.isPending}
                onClick={() =>
                  updateProject.mutate(
                    { change_order_url: coUrl.trim() || null, change_order_label: coLabel.trim() || null },
                    { onSuccess: () => setEditingChangeOrder(false) },
                  )
                }
              >
                {updateProject.isPending ? 'Salvataggio…' : 'Salva'}
              </button>
            </div>
          </div>
        )}
        {updateProject.isError && <div className="error-banner">{(updateProject.error as Error).message}</div>}
      </div>

      {PPR_TYPES.map(({ docType, label }, index) => (
        <div className="card" key={docType}>
          <h3 style={{ marginTop: 0 }}>{label}</h3>
          <p className="muted" style={{ marginTop: 0 }}>
            {index === 0
              ? "Documento di review dal template MOD-PPR: Cover e Revision History proseguono dall'ultimo Planning caricato, il foglio Planning Review è nuovo, col Deliverable Check compilato dal popup."
              : `Documento di review dal template MOD-PPR: Cover e Revision History proseguono dall'ultimo ${label} caricato, il foglio ${label} è nuovo, mentre ${PPR_TYPES.slice(0, index)
                  .map((t) => t.label)
                  .join(', ')} e Action Items vengono dall'ultimo ${PPR_TYPES[index - 1].label}.`}
          </p>
          <div style={{ display: 'flex', gap: '0.75rem', flexWrap: 'wrap' }}>
            <PprDownloadButton
              projectId={project.id}
              docType={docType}
              label={label}
              previousLabel={index > 0 ? PPR_TYPES[index - 1].label : null}
            />
            {docType === 'planning' && (
              <>
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                  <PresentationDownloadButton
                    label="presentazione Kick-off"
                    download={() => api.documents.kickoffPresentation(project.id)}
                  />
                  <DocumentInfoButton label="la presentazione Kick-off" info={KICKOFF_PRESENTATION_INFO} />
                </span>
                <WorkbookExportButton
                  label="Design Input"
                  noun="story"
                  title={`Scegli il documento Design Input (TIH-DI, .xlsx): le Story di questo increment (lette da Jira: fix version ${project.code}, anche non ancora in Done, escluse le obsolete) vengono aggiunte in cima al foglio "Design Input - Stories", con "Increment ${project.code}" nella colonna Notes`}
                  exportFile={(file) => api.documents.designInput(project.id, file)}
                />
                <WorkbookExportButton
                  label="User Needs"
                  noun="user need"
                  title={`Scegli il documento User Needs (TIH-UN, .xlsx): le User Need di questo increment (lette da Jira: Epic con Epic Category "UN" e fix version ${project.code}, anche non ancora in Done, escluse le obsolete) vengono aggiunte in cima al foglio "User Needs", con "Increment ${project.code}" nella colonna Notes`}
                  exportFile={(file) => api.documents.userNeeds(project.id, file)}
                />
                <RequirementsCheckButton
                  label="Design Input"
                  code="TIH-DI"
                  noun="Story"
                  checkFile={(file) => api.documents.designInputCheck(project.id, file)}
                />
                <RequirementsCheckButton
                  label="User Needs"
                  code="TIH-UN"
                  noun="User Need"
                  checkFile={(file) => api.documents.userNeedsCheck(project.id, file)}
                />
              </>
            )}
            {/* Regression Analysis e Release Report: compilano Cover e foglio
                dati dei template Excel ufficiali con i dati dell'increment. */}
            {docType === 'execution' && (
              <>
                {/* Pulsante e "i" in un unico blocco: non si separano quando la riga va a capo. */}
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                  <DocumentDownloadButton
                    label="Regression Analysis"
                    loadMeta={() => api.documents.regressionAnalysisMeta(project.id)}
                    download={(version, revisionText) => api.documents.regressionAnalysis(project.id, version, revisionText)}
                  />
                  <DocumentInfoButton label="Regression Analysis" info={REGRESSION_ANALYSIS_INFO} />
                </span>
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                  <DocumentDownloadButton
                    label="Release Report"
                    loadMeta={() => api.documents.releaseReportMeta(project.id)}
                    download={(version, revisionText) => api.documents.releaseReport(project.id, version, revisionText)}
                  />
                  <DocumentInfoButton label="Release Report" info={RELEASE_REPORT_INFO} />
                </span>
              </>
            )}
          </div>
        </div>
      ))}

      <div className="card">
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 12, fontSize: 13 }}>
          <span className="muted">Tipo:</span>
          {DOCUMENT_TYPES.map((type) => (
            <label key={type} style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
              <input type="checkbox" checked={!hiddenTypes.has(type)} onChange={() => toggleType(type)} />
              {type}
            </label>
          ))}
        </div>

        <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th style={{ width: 110 }}>ID</th>
              <th>Summary</th>
              <th>Tipo</th>
              <th>Stato</th>
              <th style={{ width: 140 }}>Parent</th>
              <th style={{ width: 110 }}>Task</th>
              <th>Task Summary</th>
              <th style={{ width: 120 }}>Fix Version</th>
            </tr>
          </thead>
          <tbody>
            {documentItems.map((item) => {
              const tasks = parseImplementedBy(item.implemented_by_json)
              const rowCount = Math.max(1, tasks.length)
              return (
                <Fragment key={item.id}>
                  {Array.from({ length: rowCount }).map((_, idx) => {
                    const task = tasks[idx]
                    return (
                      <tr key={`${item.id}-${idx}`}>
                        {idx === 0 && (
                          <>
                            <td rowSpan={rowCount}>
                              <a
                                href={`https://inpeco.atlassian.net/browse/${item.jira_key}`}
                                target="_blank"
                                rel="noreferrer"
                              >
                                {item.jira_key}
                              </a>
                            </td>
                            <td rowSpan={rowCount} style={{ whiteSpace: 'normal', minWidth: 260 }}>
                              {item.summary ?? <span className="muted">—</span>}
                            </td>
                            <td rowSpan={rowCount}>{item.issue_type}</td>
                            <td rowSpan={rowCount}>
                              <StatusBadge status={item.status} />
                            </td>
                            <td rowSpan={rowCount}>
                              {item.parent_key ? (
                                <a
                                  href={`https://inpeco.atlassian.net/browse/${item.parent_key}`}
                                  target="_blank"
                                  rel="noreferrer"
                                  title={item.parent_summary ?? undefined}
                                >
                                  {item.parent_key}
                                </a>
                              ) : (
                                <span className="muted">—</span>
                              )}
                            </td>
                          </>
                        )}
                        <td>
                          {task ? (
                            <a href={`https://inpeco.atlassian.net/browse/${task.key}`} target="_blank" rel="noreferrer">
                              {task.key}
                            </a>
                          ) : (
                            <span className="muted">—</span>
                          )}
                        </td>
                        <td style={{ whiteSpace: 'normal', minWidth: 220 }}>
                          {task ? task.summary ?? <span className="muted">—</span> : <span className="muted">—</span>}
                        </td>
                        <td>{task ? task.fix_version ?? <span className="muted">—</span> : <span className="muted">—</span>}</td>
                      </tr>
                    )
                  })}
                </Fragment>
              )
            })}
            {documentItems.length === 0 && (
              <tr>
                <td colSpan={8} className="muted">
                  Nessun item Story/Bug in scope trovato (o nascosto dal filtro tipo).
                </td>
              </tr>
            )}
          </tbody>
        </table>
        </div>
      </div>
    </div>
  )
}
