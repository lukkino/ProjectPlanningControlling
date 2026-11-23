"""Presentazione mensile "Project Review TTP": aggiorna l'ultima versione
della presentazione dell'utente con i dati dei progetti attivi.

Sorgente: la presentazione scelta dall'utente (UserSettings.ttp_review_path,
con la finestra "Apri file" di Windows). Il risultato si salva accanto, con
data e ora nel nome (es. "Project Review TTP - internal 2026-11-23
15-42.pptx"), e diventa la sorgente dell'export successivo: cosi' le note
scritte a mano nell'export del mese prima restano.

Una slide per progetto (UI "Progetto" = models.Increment), riconosciuta dal
"Project Code: PTIH-..." del riquadro in alto a sinistra. Per ognuna si
aggiornano solo:
- le date della tabella Milestone, dalle fasi dell'increment collegato
  (Planned = data originale, Expected = data aggiornata, Actual = data
  effettiva, DELTA = Expected - Planned); righe abbinate per nome di fase;
- le tabelle Project Cost - Hours e Project Cost: Estimated (budget),
  Actual, % Used e % estimated Completion (= % completamento del backlog
  dell'increment collegato).
Il resto (stato, note, issue, pallini) resta com'e'.

Progetti attivi senza slide: se ne aggiunge una copiando una slide di
progetto (riquadro in alto a sinistra con il nuovo Project Code, Scope e
Major Issues vuoti, note libere tolte, pallini di stato vuoti), dopo
l'ultima slide di progetto.
"""

import datetime as dt
import re
from copy import deepcopy
from io import BytesIO
from pathlib import Path

from pptx import Presentation
from pptx.enum.shapes import MSO_SHAPE, MSO_SHAPE_TYPE
from pptx.opc.constants import RELATIONSHIP_TYPE as RT
from pptx.oxml.ns import qn

from app import models
from app.services.metrics import compute_increment_metrics


class TtpReviewError(Exception):
    pass


CODE_RE = re.compile(r"Project\s+Code\s*:\s*([A-Z][A-Z0-9]*(?:-[A-Z0-9]+)+)", re.I)
MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]
R_NS = "{http://schemas.openxmlformats.org/officeDocument/2006/relationships}"

# Nome della riga Milestone -> nomi di fase equivalenti (minuscolo).
PHASE_ALIASES = {
    "kick-off": {"kick-off", "kickoff", "kick off", "increment start", "project start", "start"},
    "code freeze": {"code freeze"},
}


# ---------------------------------------------------------------- file

def _stem_prefix(path: Path) -> str:
    """Nome base senza un eventuale " AAAA-MM-GG HH-MM" finale."""
    return re.sub(r"\s+\d{4}-\d{2}-\d{2}\s+\d{2}-\d{2}(\s+\(\d+\))?$", "", path.stem)


def source_file(configured: str) -> Path:
    """La presentazione scelta dall'utente (dopo ogni export diventa quella
    appena salvata)."""
    path = Path(configured.strip().strip('"'))
    if path.suffix.lower() != ".pptx":
        raise TtpReviewError("Scegli una presentazione PowerPoint (.pptx)")
    if not path.is_file():
        raise TtpReviewError(f"Presentazione non trovata: {path}")
    return path


def output_path(source: Path, now: dt.datetime) -> Path:
    """Accanto alla sorgente, con data e ora; mai sopra un file esistente."""
    base = f"{_stem_prefix(source)} {now:%Y-%m-%d %H-%M}"
    target = source.with_name(f"{base}.pptx")
    n = 2
    while target.exists():
        target = source.with_name(f"{base} ({n}).pptx")
        n += 1
    return target


# ---------------------------------------------------------------- dati

def _linked_project(increment: models.Increment) -> models.Project | None:
    return increment.project


def is_active(increment: models.Increment, today: dt.date) -> bool:
    """Attivo = l'ultima data nota (fine progetto o fasi dell'increment
    collegato) non e' prima del mese corrente, oppure non c'e' una fine."""
    project = _linked_project(increment)
    dates = [increment.end_date] + [
        d for ph in (project.phases if project else []) for d in (ph.planned_date, ph.original_date, ph.actual_date)
    ]
    dates = [d for d in dates if d]
    if not dates:
        return True
    return max(dates) >= today.replace(day=1)


def _month(d: dt.date | None) -> str:
    return f"{MONTHS[d.month - 1]} ’{d:%y}" if d else ""


def _delta(planned: dt.date | None, expected: dt.date | None) -> str:
    if not planned or not expected:
        return ""
    days = (expected - planned).days
    if days == 0:
        return ""
    sign = "+" if days > 0 else "−"
    days = abs(days)
    if days < 60:
        return f"{sign} {days} day{'s' if days != 1 else ''}"
    months = round(days / 30.4)
    return f"{sign} {months} months"


def _pct(value: float | None) -> str:
    return "n.a." if value is None else f"{round(value * 100)}%"


def _euro(value: float) -> str:
    return "€ " + f"{round(value):,}".replace(",", ".")


# ---------------------------------------------------------------- pptx

def _set_cell(cell, text: str) -> None:
    """Testo della cella mantenendo la formattazione del primo run (o, se
    vuota, quella di fine paragrafo)."""
    tf = cell.text_frame
    paragraphs = tf.paragraphs
    first = paragraphs[0]
    for extra in paragraphs[1:]:
        extra._p.getparent().remove(extra._p)
    runs = first.runs
    if runs:
        runs[0].text = text
        for r in runs[1:]:
            r._r.getparent().remove(r._r)
        return
    if not text:
        return
    run = first.add_run()
    run.text = text
    end = first._p.find(qn("a:endParaRPr"))
    if end is not None:
        rpr = deepcopy(end)
        rpr.tag = qn("a:rPr")
        old = run._r.find(qn("a:rPr"))
        if old is not None:
            run._r.remove(old)
        run._r.insert(0, rpr)
        # endParaRPr deve restare dopo i run.
        first._p.remove(end)
        first._p.append(end)


def _cell_text(cell) -> str:
    return " ".join(cell.text_frame.text.split())


def _tables(slide):
    return [sh for sh in slide.shapes if sh.has_table]


def _header(table) -> list[str]:
    return [_cell_text(c).lower() for c in table.rows[0].cells]


def _milestone_table(slide):
    return next((sh for sh in _tables(slide) if _header(sh.table) and _header(sh.table)[0].startswith("milestone")), None)


def _cost_tables(slide):
    """Le due tabelle Estimated/Actual/% Used: ore (in alto) e costi."""
    tables = [
        sh
        for sh in _tables(slide)
        if any(h.startswith("estimated") for h in _header(sh.table)) and "actual" in _header(sh.table)
    ]
    return sorted(tables, key=lambda sh: sh.top)


def _slide_code(slide) -> str | None:
    for sh in slide.shapes:
        if sh.has_text_frame:
            match = CODE_RE.search(sh.text_frame.text)
            if match:
                return match.group(1).upper()
    return None


def _fill_costs(slide, metrics) -> None:
    tables = _cost_tables(slide)
    completion = metrics.percent_complete if metrics.project else None
    rows = [
        (metrics.budget_hours_total, metrics.logged_hours_total, lambda v: f"{round(v)}"),
        (metrics.budget_material_total, metrics.actual_material_total, _euro),
    ]
    for shape, (budget, actual, fmt) in zip(tables, rows):
        table = shape.table
        header = _header(table)
        if len(table.rows) < 2:
            continue
        cells = table.rows[1].cells
        for i, name in enumerate(header):
            if name.startswith("estimated") and "completion" not in name:
                _set_cell(cells[i], fmt(budget))
            elif name == "actual":
                _set_cell(cells[i], fmt(actual))
            elif "used" in name:
                _set_cell(cells[i], _pct(actual / budget) if budget else "n.a.")
            elif "completion" in name and completion is not None:
                _set_cell(cells[i], _pct(completion))


def _phase_for(name: str, phases: list[models.Phase]) -> models.Phase | None:
    key = name.strip().lower()
    names = PHASE_ALIASES.get(key, {key})
    return next((ph for ph in phases if ph.name.strip().lower() in names), None)


def _fill_milestones(slide, project: models.Project | None, rewrite_names: bool) -> None:
    shape = _milestone_table(slide)
    if shape is None or project is None:
        return
    table = shape.table
    header = _header(table)
    phases = sorted(project.phases, key=lambda ph: (ph.order, ph.id))
    if rewrite_names:
        # Slide nuova: le milestone come nelle altre slide, senza Code freeze.
        phases = [ph for ph in phases if ph.name.strip().lower() != "code freeze"]
    data_rows = list(table.rows)[1:]
    for index, row in enumerate(data_rows):
        cells = row.cells
        if rewrite_names:
            phase = phases[index] if index < len(phases) else None
            _set_cell(cells[0], phase.name if phase else "")
            # Niente barrato ereditato dalla riga del modello (fase chiusa).
            for rpr in cells[0]._tc.iter(qn("a:rPr"), qn("a:endParaRPr")):
                rpr.attrib.pop("strike", None)
        else:
            phase = _phase_for(_cell_text(cells[0]), phases)
            if phase is None:
                continue
        for i, name in enumerate(header):
            if i == 0 or name == "status":
                continue
            if phase is None:
                _set_cell(cells[i], "")
            elif name == "planned":
                _set_cell(cells[i], _month(phase.original_date))
            elif name == "expected":
                _set_cell(cells[i], _month(phase.planned_date or phase.original_date))
            elif name == "actual":
                _set_cell(cells[i], phase.actual_date.strftime("%d/%m/%Y") if phase.actual_date else "")
            elif name == "delta":
                _set_cell(cells[i], _delta(phase.original_date, phase.planned_date))


def _duplicate_slide(prs, source):
    new = prs.slides.add_slide(source.slide_layout)
    tree = new.shapes._spTree
    for shape in list(new.shapes):
        tree.remove(shape._element)
    rid_map = {}
    for rid, rel in source.part.rels.items():
        if rel.reltype in (RT.SLIDE_LAYOUT, RT.NOTES_SLIDE):
            continue
        if rel.is_external:
            rid_map[rid] = new.part.relate_to(rel.target_ref, rel.reltype, is_external=True)
        else:
            rid_map[rid] = new.part.relate_to(rel.target_part, rel.reltype)
    skip = {qn("p:nvGrpSpPr"), qn("p:grpSpPr"), qn("p:extLst")}
    for element in source.shapes._spTree.iterchildren():
        if element.tag in skip:
            continue
        copy = deepcopy(element)
        for node in copy.iter():
            for attr, value in list(node.attrib.items()):
                if attr.startswith(R_NS) and value in rid_map:
                    node.set(attr, rid_map[value])
        tree.append(copy)
    bg = source._element.cSld.bg
    if bg is not None:
        new._element.cSld.insert(0, deepcopy(bg))
    return new


def _move_slide(prs, slide, position: int) -> None:
    ids = prs.slides._sldIdLst
    entry = next(e for e in ids if e.rId == prs.part.relate_to(slide.part, RT.SLIDE))
    ids.remove(entry)
    ids.insert(position, entry)


def _prepare_new_slide(slide, increment: models.Increment, project: models.Project | None, slide_height: int) -> None:
    """Slide copiata per un progetto nuovo: titolo, Project Code, Scope e
    Major Issues vuoti, note libere tolte, pallini di stato vuoti."""
    milestone = _milestone_table(slide)
    costs = _cost_tables(slide)
    keep_ids = {sh.shape_id for sh in [milestone, *costs] if sh is not None}
    for shape in list(slide.shapes):
        if shape.shape_id in keep_ids:
            continue
        if shape.has_table:
            header = _header(shape.table)
            if header and header[0].startswith("major issues"):
                for row in list(shape.table.rows)[1:]:
                    for cell in row.cells:
                        _set_cell(cell, "")
            continue
        if not shape.has_text_frame:
            continue
        text = shape.text_frame.text
        if CODE_RE.search(text):
            _rewrite_info_box(shape, increment.code)
        elif shape.name.lower().startswith("title"):
            title = f"{project.code} – {project.name}" if project else increment.code
            _replace_text(shape, title)
        elif shape.shape_type == MSO_SHAPE_TYPE.AUTO_SHAPE and not text.strip():
            # Ovale vuoto = pallino di stato: senza riempimento.
            if shape.auto_shape_type == MSO_SHAPE.OVAL:
                shape.fill.background()
        elif (
            text.strip()
            and shape.shape_type == MSO_SHAPE_TYPE.TEXT_BOX
            and not re.match(r"^\s*project cost", text, re.I)
            and shape.top < slide_height * 0.3
        ):
            # Note libere in alto (budget per voce, review, asterischi).
            _replace_text(shape, "")


def _replace_text(shape, text: str) -> None:
    tf = shape.text_frame
    first = tf.paragraphs[0]
    for extra in tf.paragraphs[1:]:
        extra._p.getparent().remove(extra._p)
    runs = first.runs
    if runs:
        runs[0].text = text
        for r in runs[1:]:
            r._r.getparent().remove(r._r)
    elif text:
        first.add_run().text = text
    # Interruzioni di riga rimaste nel paragrafo.
    for br in first._p.findall(qn("a:br")):
        first._p.remove(br)


def _rewrite_info_box(shape, code: str) -> None:
    """Riquadro in alto a sinistra: nuovo Project Code, Scope vuoto (resta
    l'etichetta "Project Scope:")."""
    paragraphs = shape.text_frame.paragraphs
    scope_index = None
    for index, p in enumerate(paragraphs):
        text = "".join(r.text for r in p.runs)
        if re.search(r"project\s+code\s*:", text, re.I):
            runs = p.runs
            label_end = next((i for i, r in enumerate(runs) if ":" in r.text), None)
            if label_end is not None:
                rest = runs[label_end + 1 :]
                if rest:
                    rest[0].text = " " + code
                    for r in rest[1:]:
                        r._r.getparent().remove(r._r)
                else:
                    runs[label_end].text = re.sub(r":.*$", ": " + code, runs[label_end].text)
        if re.search(r"project\s+scope\s*:", text, re.I):
            scope_index = index
            runs = p.runs
            label_end = next((i for i, r in enumerate(runs) if ":" in r.text), None)
            if label_end is not None:
                runs[label_end].text = re.sub(r":.*$", ": ", runs[label_end].text)
                for r in runs[label_end + 1 :]:
                    r._r.getparent().remove(r._r)
    if scope_index is not None:
        for p in paragraphs[scope_index + 1 :]:
            p._p.getparent().remove(p._p)


# ---------------------------------------------------------------- export

def generate(source: Path, increments: list[models.Increment], today: dt.date) -> tuple[bytes, dict]:
    prs = Presentation(str(source))
    slides_by_code = {}
    for slide in prs.slides:
        code = _slide_code(slide)
        if code and code not in slides_by_code:
            slides_by_code[code] = slide
    if not slides_by_code:
        raise TtpReviewError("Nella presentazione non trovo slide di progetto (riquadro con \"Project Code: ...\")")

    updated, added, skipped = [], [], []
    active = [i for i in increments if is_active(i, today)]
    for increment in increments:
        slide = slides_by_code.get(increment.code.upper())
        if slide is None:
            continue
        if increment not in active:
            skipped.append(increment.code)
            continue
        metrics = compute_increment_metrics(increment)
        _fill_costs(slide, metrics)
        _fill_milestones(slide, _linked_project(increment), rewrite_names=False)
        updated.append(increment.code)

    # Modello per le nuove: la slide con la tabella Milestone piu' completa
    # (Planned, Expected, Actual), a parita' l'ultima.
    def template_score(item):
        index, slide = item
        shape = _milestone_table(slide)
        header = _header(shape.table) if shape else []
        return (("planned" in header) + ("expected" in header) + ("actual" in header), index)

    project_slides = [(i, s) for i, s in enumerate(prs.slides) if _slide_code(s)]
    template = max(project_slides, key=template_score)[1]
    insert_at = max(i for i, _ in project_slides) + 1
    for increment in active:
        if increment.code.upper() in slides_by_code:
            continue
        project = _linked_project(increment)
        slide = _duplicate_slide(prs, template)
        _prepare_new_slide(slide, increment, project, prs.slide_height)
        metrics = compute_increment_metrics(increment)
        _fill_costs(slide, metrics)
        _fill_milestones(slide, project, rewrite_names=True)
        _move_slide(prs, slide, insert_at)
        insert_at += 1
        added.append(increment.code)

    buffer = BytesIO()
    prs.save(buffer)
    return buffer.getvalue(), {"updated": updated, "added": added, "skipped": skipped}
