import base64
import binascii
import datetime as dt
import re

from fastapi import APIRouter, Body, Depends, HTTPException, Query
from fastapi.responses import Response
from sqlalchemy.orm import Session

from app import models, schemas
from app.database import get_db
from app.routers.settings import SETTINGS_ROW_ID
from app.services.design_input import (
    EMPTY_COMPONENTS,
    SHEET_NAME,
    USER_NEEDS_SHEET_NAME,
    DesignInputError,
    ExportResult,
    Story,
    UserNeed,
    add_stories,
    add_user_needs,
    read_ids,
)
from app.services.document_generator import (
    generate_regression_analysis,
    generate_release_report,
    get_regression_analysis_defaults,
    get_release_report_defaults,
)
from app.services.ppr_document import (
    PPR_DOCUMENT_TYPES,
    PprError,
    generate_ppr_deliverables_txt,
    generate_ppr_document,
    get_ppr_defaults,
    inspect_ppr_file,
    previous_phase_of,
)
from app.services.project_folders import existing_folder, file_in_folder, require_folder
from app.services.jira_client import JiraClientError, fetch_requirement_issues
from app.services.kickoff_presentation import generate_kickoff_presentation

router = APIRouter(tags=["documents"])


def _get_project_or_404(db: Session, project_id: int) -> models.Project:
    project = db.get(models.Project, project_id)
    if project is None:
        raise HTTPException(status_code=404, detail="Progetto non trovato")
    return project


def _xlsx_response(content: bytes, filename_stem: str) -> Response:
    filename = f"{filename_stem}.xlsx"
    return Response(
        content=content,
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


def _resolve(
    version: int | None, revision_text: str | None, defaults: tuple[int, str]
) -> tuple[int, str]:
    default_version, default_text = defaults
    return (
        version if version is not None else default_version,
        revision_text if revision_text is not None else default_text,
    )


@router.get("/api/projects/{project_id}/documents/regression-analysis/meta", response_model=schemas.DocumentRevisionMeta)
def regression_analysis_meta(project_id: int, db: Session = Depends(get_db)):
    project = _get_project_or_404(db, project_id)
    next_version, last_revision_text = get_regression_analysis_defaults(project)
    return schemas.DocumentRevisionMeta(next_version=next_version, last_revision_text=last_revision_text)


@router.get("/api/projects/{project_id}/documents/regression-analysis")
def download_regression_analysis(
    project_id: int,
    version: int | None = Query(None),
    revision_text: str | None = Query(None),
    db: Session = Depends(get_db),
):
    project = _get_project_or_404(db, project_id)
    resolved_version, resolved_text = _resolve(version, revision_text, get_regression_analysis_defaults(project))
    content, filename_stem = generate_regression_analysis(project, resolved_version, resolved_text)
    return _xlsx_response(content, filename_stem)


@router.get("/api/projects/{project_id}/documents/release-report/meta", response_model=schemas.DocumentRevisionMeta)
def release_report_meta(project_id: int, db: Session = Depends(get_db)):
    """Valori proposti (modificabili) per il popup di generazione: prossima
    versione (ultima usata + 1) e testo di revisione (ultimo usato)."""
    project = _get_project_or_404(db, project_id)
    next_version, last_revision_text = get_release_report_defaults(project)
    return schemas.DocumentRevisionMeta(next_version=next_version, last_revision_text=last_revision_text)


@router.get("/api/projects/{project_id}/documents/release-report")
def download_release_report(
    project_id: int,
    version: int | None = Query(None),
    revision_text: str | None = Query(None),
    db: Session = Depends(get_db),
):
    project = _get_project_or_404(db, project_id)
    resolved_version, resolved_text = _resolve(version, revision_text, get_release_report_defaults(project))

    content, filename_stem = generate_release_report(project, resolved_version, resolved_text)

    # La versione/testo usati diventano il default proposto alla prossima
    # generazione (incrementale rispetto a questa) - solo per la RR, che a
    # differenza di REA/PPR e' uno storico cumulativo di sistema.
    project.rr_last_version = resolved_version
    project.rr_last_revision_note = resolved_text
    db.commit()

    return _xlsx_response(content, filename_stem)


def _get_ppr_type_or_404(doc_type: str) -> None:
    if doc_type not in PPR_DOCUMENT_TYPES:
        raise HTTPException(status_code=404, detail=f"Tipo documento sconosciuto: {doc_type}")


@router.get("/api/projects/{project_id}/documents/ppr/{doc_type}/meta", response_model=schemas.PprDocumentMeta)
def ppr_meta(project_id: int, doc_type: str, db: Session = Depends(get_db)):
    """Valori proposti all'apertura del popup, prima di caricare i documenti
    precedenti (versione e Deliverable Check si aggiornano poi da quelli,
    vedi ppr_inspect)."""
    _get_ppr_type_or_404(doc_type)
    project = _get_project_or_404(db, project_id)
    return schemas.PprDocumentMeta(**get_ppr_defaults(project, doc_type))


def _decode_b64(value: str, what: str) -> bytes:
    try:
        return base64.b64decode(value, validate=True)
    except (binascii.Error, ValueError) as exc:
        raise HTTPException(status_code=400, detail=f"{what}: file non valido") from exc


@router.post("/api/projects/{project_id}/documents/ppr/{doc_type}/inspect", response_model=schemas.PprInspection)
def ppr_inspect(project_id: int, doc_type: str, payload: schemas.PprInspectRequest, db: Session = Depends(get_db)):
    """Controlla un documento scelto nel popup (che sia del tipo giusto, coi
    fogli che servono) e ne legge ultima versione e descrizione della
    Revision History, per proporre la prossima. Il file non viene salvato."""
    _get_ppr_type_or_404(doc_type)
    _get_project_or_404(db, project_id)
    try:
        return inspect_ppr_file(doc_type, payload.role, _decode_b64(payload.file_b64, "Documento"))
    except PprError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@router.get("/api/projects/{project_id}/documents/ppr/{doc_type}/candidates", response_model=list[schemas.PprCandidate])
def ppr_candidates(
    project_id: int,
    doc_type: str,
    role: str = Query(..., pattern="^(previous|previous_phase)$"),
    db: Session = Depends(get_db),
):
    """Documenti della cartella review dell'increment che possono fare da
    ultima versione (role=previous) o da fase precedente (previous_phase):
    gli .xlsx il cui nome inizia col codice del documento (es.
    "TIH-EXECUTION-PTBSYS.16-approved.xlsx"), ciascuno gia' controllato come
    se lo si caricasse nel popup. Dal piu' recente; vuoto senza cartella."""
    _get_ppr_type_or_404(doc_type)
    project = _get_project_or_404(db, project_id)
    expected_type = doc_type if role == "previous" else previous_phase_of(doc_type)
    folder = existing_folder(project.review_documents_folder)
    if folder is None or expected_type is None:
        return []
    prefix = PPR_DOCUMENT_TYPES[expected_type].filename.lower()
    files = [
        p
        for p in folder.iterdir()
        if p.is_file() and p.suffix.lower() == ".xlsx" and p.name.lower().startswith(prefix)
    ]
    candidates = []
    for path in sorted(files, key=lambda p: p.stat().st_mtime, reverse=True):
        candidate = schemas.PprCandidate(
            filename=path.name, modified=dt.datetime.fromtimestamp(path.stat().st_mtime)
        )
        try:
            candidate.info = schemas.PprInspection(**inspect_ppr_file(doc_type, role, path.read_bytes()))
        except (PprError, OSError) as exc:
            candidate.error = str(exc)
        candidates.append(candidate)
    return candidates


def _previous_content(project: models.Project, b64: str | None, filename: str | None, what: str) -> bytes | None:
    """Documento precedente del popup: caricato dal disco (base64) o scelto
    tra quelli della cartella review."""
    if b64:
        return _decode_b64(b64, what)
    if filename:
        path = file_in_folder(require_folder(project.review_documents_folder, "documenti delle review"), filename)
        if not path.is_file():
            raise HTTPException(status_code=404, detail=f"{what}: file non trovato nella cartella review: {filename}")
        return path.read_bytes()
    return None


@router.post("/api/projects/{project_id}/documents/ppr/{doc_type}")
def download_ppr_document(
    project_id: int, doc_type: str, payload: schemas.PprGenerateRequest, db: Session = Depends(get_db)
):
    """Genera il documento PPR (vedi services/ppr_document.py) dai documenti
    precedenti caricati nel popup (in base64 nel corpo) o scelti nella
    cartella review: il documento generato torna nella risposta, a salvarlo
    nella cartella ci pensa il frontend (vedi routers/review_folder.py)."""
    _get_ppr_type_or_404(doc_type)
    project = _get_project_or_404(db, project_id)
    previous = _previous_content(project, payload.previous_b64, payload.previous_filename, "Ultima versione")
    previous_phase = _previous_content(
        project, payload.previous_phase_b64, payload.previous_phase_filename, "Fase precedente"
    )
    try:
        content, filename_stem = generate_ppr_document(
            project,
            doc_type,
            payload.version,
            payload.revision_text,
            [d.model_dump() for d in payload.deliverables or []],
            previous,
            previous_phase,
        )
    except PprError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return _xlsx_response(content, filename_stem)


@router.get("/api/projects/{project_id}/documents/ppr/{doc_type}/deliverables-txt")
def download_ppr_deliverables_txt(project_id: int, doc_type: str, db: Session = Depends(get_db)):
    """Elenco dei documenti attesi alla review con il loro owner (dal Task
    Guideline), scaricato insieme al documento PPR. Non c'e' per il
    Planning, i cui Deliverable Check si compilano nel popup."""
    _get_ppr_type_or_404(doc_type)
    if doc_type == "planning":
        raise HTTPException(status_code=404, detail="Elenco non previsto per il Planning")
    project = _get_project_or_404(db, project_id)
    content, filename = generate_ppr_deliverables_txt(project, doc_type)
    return Response(
        content=content,
        media_type="text/plain; charset=utf-8",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


@router.get("/api/projects/{project_id}/documents/kickoff-presentation")
def download_kickoff_presentation(project_id: int, db: Session = Depends(get_db)):
    """Presentazione di Kick-off (.pptx) dal template ufficiale, con scope,
    major requirements e timeline compilati dai dati dell'increment (vedi
    services/kickoff_presentation.py)."""
    project = _get_project_or_404(db, project_id)
    # Numero del case Salesforce dei Bug dell'increment che sono complaint.
    bug_keys = [i.jira_key for i in project.backlog_items if i.issue_type == "Bug"]
    complaint_numbers = {
        c.jira_key: c.salesforce_case_number or ""
        for c in db.query(models.Complaint).filter(models.Complaint.jira_key.in_(bug_keys))
    }
    content, filename_stem = generate_kickoff_presentation(project, complaint_numbers)
    return Response(
        content=content,
        media_type="application/vnd.openxmlformats-officedocument.presentationml.presentation",
        headers={"Content-Disposition": f'attachment; filename="{filename_stem}.pptx"'},
    )


@router.post("/api/projects/{project_id}/documents/design-input")
def add_stories_to_design_input(
    project_id: int,
    filename: str = Query("TIH-DI-PTBSYS.xlsx"),
    workbook: bytes = Body(..., media_type="application/octet-stream"),
    db: Session = Depends(get_db),
):
    """Riceve il documento Design Input corrente (il file .xlsx cosi' com'e',
    nel corpo della richiesta) e lo restituisce con le Story di questo
    increment aggiunte in cima al foglio "Design Input - Stories". Le Story
    dell'increment sono lette da Jira: quelle con la fix version
    dell'increment, in qualunque stato (anche non ancora Done), escluse
    quelle obsolete, che vengono solo segnalate. Il file non viene salvato
    sul server."""
    project = _get_project_or_404(db, project_id)
    own, excluded, obsolete = _increment_requirements(db, project, "Story")
    stories = [
        Story(
            key=issue["key"],
            title=issue["summary"],
            description=issue["description"],
            components=", ".join(issue["components"]) or EMPTY_COMPONENTS,
            labels=", ".join(sorted(issue["labels"])),
        )
        for issue in own
    ]
    try:
        result = add_stories(workbook, stories, notes=f"Increment {project.code}", obsolete=obsolete)
    except DesignInputError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    stem = re.sub(r"[^\w\-. ()+]", "_", filename.rsplit(".", 1)[0], flags=re.ASCII) or "TIH-DI-PTBSYS"
    response = _xlsx_response(result.content, f"{stem} - {project.code}")
    _set_export_headers(response, "X-Stories", result, excluded)
    return response


def _set_export_headers(response: Response, prefix: str, result: ExportResult, excluded: list[str]) -> None:
    response.headers[f"{prefix}-Added"] = ", ".join(result.added_keys)
    response.headers[f"{prefix}-Skipped"] = str(result.skipped)
    # Lasciate fuori perche' il documento ha gia' lo stesso contenuto sotto
    # un altro ID: "NUOVO=ESISTENTE, ...".
    response.headers[f"{prefix}-Duplicates"] = ", ".join(f"{new}={old}" for new, old in result.duplicates)
    # Nuova versione del documento (revision history aggiornata); vuoto se la
    # Cover non e' stata aggiornata.
    response.headers[f"{prefix}-Version"] = str(result.version or "")
    # Issue con la fix version dell'increment lasciate fuori: "CHIAVE (motivo), ...".
    response.headers[f"{prefix}-Excluded"] = ", ".join(excluded)
    # Obsolete presenti nel foglio (le righe non vengono cancellate): quelle
    # scritte come "Removed" nella nuova revisione, e quelle gia' dichiarate
    # in una revisione precedente ma ancora presenti.
    response.headers[f"{prefix}-Removed"] = ", ".join(result.removed)
    response.headers[f"{prefix}-Still-Present"] = ", ".join(result.still_present)


def _issue_number(jira_key: str) -> int:
    number = jira_key.rsplit("-", 1)[-1]
    return int(number) if number.isdigit() else 0


@router.post("/api/projects/{project_id}/documents/user-needs")
def add_user_needs_to_document(
    project_id: int,
    filename: str = Query("TIH-UN-PTBSYS.xlsx"),
    workbook: bytes = Body(..., media_type="application/octet-stream"),
    db: Session = Depends(get_db),
):
    """Come il Design Input, per il documento User Needs (TIH-UN): riceve il
    file .xlsx corrente e lo restituisce con le User Need di questo increment
    aggiunte in cima al foglio "User Needs". Le User Need dell'increment sono
    lette da Jira: gli Epic con Epic Category "UN" e la fix version
    dell'increment, in qualunque stato (anche non ancora Done), escluse
    quelle obsolete. Gli Epic con quella fix version lasciati fuori (non
    User Need, oppure obsoleti) vengono solo segnalati."""
    project = _get_project_or_404(db, project_id)
    own, excluded, obsolete = _increment_requirements(db, project, "Epic")
    try:
        result = add_user_needs(
            workbook,
            [UserNeed(key=issue["key"], text=issue["summary"]) for issue in own],
            notes=f"Increment {project.code}",
            obsolete=obsolete,
        )
    except DesignInputError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    stem = re.sub(r"[^\w\-. ()+]", "_", filename.rsplit(".", 1)[0], flags=re.ASCII) or "TIH-UN-PTBSYS"
    response = _xlsx_response(result.content, f"{stem} - {project.code}")
    _set_export_headers(response, "X-User-Needs", result, excluded)
    return response


def _fetch_requirements(db: Session, project: models.Project, issue_type: str) -> list[dict]:
    """Issue di un tipo (Epic per le User Need, Story per i Design Input) del
    progetto Jira dell'increment (es. PTBSYS), lette da Jira."""
    jira_settings = db.get(models.AppSettings, SETTINGS_ROW_ID)
    try:
        return fetch_requirement_issues(
            (jira_settings.jira_base_url if jira_settings else None) or "",
            (jira_settings.jira_email if jira_settings else None) or "",
            (jira_settings.jira_api_token if jira_settings else None) or "",
            project.code.split("-", 1)[0],
            issue_type,
        )
    except JiraClientError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc


def _in_increment(issue: dict, project: models.Project) -> bool:
    """L'issue ha la fix version di questo increment. Su Jira il nome della
    fix version puo' avere un suffisso dopo il codice (es. "PTBSYS-03-004 -
    December 26" per l'increment PTBSYS-03-004)."""
    return any(
        name == project.code or name.startswith((f"{project.code} ", f"{project.code}-"))
        for name in issue["fix_versions"]
    )


def _increment_requirements(
    db: Session, project: models.Project, issue_type: str
) -> tuple[list[dict], list[str], set[str]]:
    """Issue da aggiungere al documento per questo increment: quelle con la
    sua fix version, in qualunque stato, dalla piu' recente (numero di issue
    piu' alto) come nel documento. Restituisce anche quelle con la stessa fix
    version lasciate fuori, come "CHIAVE (motivo)", e le chiavi di tutte le
    issue obsolete (di qualunque increment), che nel documento non devono
    esserci."""
    everything = _fetch_requirements(db, project, issue_type)
    obsolete = {issue["key"] for issue in everything if issue["eligible"] and issue["obsolete"]}
    issues = [issue for issue in everything if _in_increment(issue, project)]
    own = sorted(
        (issue for issue in issues if issue["eligible"] and not issue["obsolete"]),
        key=lambda issue: _issue_number(issue["key"]),
        reverse=True,
    )
    excluded = [
        f"{issue['key']} ({'obsoleta' if issue['eligible'] else 'Epic Category ' + (issue['category'] or 'vuota')})"
        for issue in issues
        if not issue["eligible"] or issue["obsolete"]
    ]
    return own, excluded, obsolete


@router.post("/api/projects/{project_id}/documents/user-needs/check", response_model=schemas.RequirementsCheck)
def check_user_needs_document(
    project_id: int,
    workbook: bytes = Body(..., media_type="application/octet-stream"),
    db: Session = Depends(get_db),
):
    """Confronta il foglio "User Needs" del file ricevuto con le User Need su
    Jira: vedi _check_requirements."""
    return _check_requirements(db, _get_project_or_404(db, project_id), workbook, USER_NEEDS_SHEET_NAME, "Epic")


@router.post("/api/projects/{project_id}/documents/design-input/check", response_model=schemas.RequirementsCheck)
def check_design_input_document(
    project_id: int,
    workbook: bytes = Body(..., media_type="application/octet-stream"),
    db: Session = Depends(get_db),
):
    """Confronta il foglio "Design Input - Stories" del file ricevuto con le
    Story su Jira: vedi _check_requirements."""
    return _check_requirements(db, _get_project_or_404(db, project_id), workbook, SHEET_NAME, "Story")


def _check_requirements(
    db: Session, project: models.Project, workbook: bytes, sheet_name: str, issue_type: str
) -> schemas.RequirementsCheck:
    """Confronta gli ID di un foglio (User Needs o Design Input) con le issue
    su Jira (sola lettura): il documento dovrebbe contenere tutte e sole
    quelle non obsolete che sono in Done oppure hanno la fix version di
    questo increment (nuove, anche se non ancora Done). Un'issue sostituita
    da un'altra ("is expanded by") resta in Done su Jira ma nel documento
    non deve esserci. Il file non viene modificato ne' salvato."""
    try:
        document_ids = read_ids(workbook, sheet_name)
    except DesignInputError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    issues = _fetch_requirements(db, project, issue_type)
    all_by_key = {issue["key"]: issue for issue in issues}
    by_key = {key: issue for key, issue in all_by_key.items() if issue["eligible"]}
    in_document = set(document_ids)
    current = {issue["key"] for issue in issues if _in_increment(issue, project)}

    def item(key: str) -> schemas.RequirementCheckItem:
        issue = all_by_key[key]
        return schemas.RequirementCheckItem(
            key=key,
            summary=issue["summary"],
            status=issue["status"],
            category=issue["category"],
            expanded_by=issue["expanded_by"],
            current_increment=key in current,
        )

    def newest_first(keys) -> list[str]:
        return sorted(keys, key=_issue_number, reverse=True)

    valid = {k for k, issue in by_key.items() if issue["done"] and not issue["obsolete"]}
    expected = valid | {k for k, issue in by_key.items() if k in current and not issue["obsolete"]}
    known = in_document & set(by_key)
    return schemas.RequirementsCheck(
        jira_project=project.code.split("-", 1)[0],
        document_count=len(document_ids),
        jira_valid_count=len(valid),
        jira_obsolete_count=sum(1 for issue in by_key.values() if issue["done"] and issue["obsolete"]),
        missing=[item(k) for k in newest_first(expected - in_document)],
        obsolete_in_document=[item(k) for k in newest_first(k for k in known if by_key[k]["obsolete"])],
        not_done_in_document=[
            item(k) for k in newest_first(k for k in known if not by_key[k]["done"] and not by_key[k]["obsolete"])
        ],
        wrong_category_in_document=[item(k) for k in newest_first((in_document & set(all_by_key)) - known)],
        unknown_in_document=newest_first(in_document - set(all_by_key)),
        repeated_in_document=newest_first({k for k in document_ids if document_ids.count(k) > 1}),
    )
