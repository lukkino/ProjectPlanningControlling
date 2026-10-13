"""Presentazione di Kick-off di un increment (MOD-KICK_OFF): parte dal
template ufficiale (TEMPLATE_PATH, una presentazione gia' compilata) e ne
riscrive solo le parti che dipendono dall'increment:

  - copertina: codice e nome dell'increment, data di oggi;
  - "Scope Description": testo discorsivo ricavato dalle Story in scope, con
    gli enhancement citati col loro riferimento e una sezione dedicata a
    ticket/complaint col numero del complaint;
  - "Major Requirements": le Story raggruppate per macro-argomento;
  - "Project Timeline": elenco e grafico delle fasi dell'increment.

Tutte le altre slide (team, mercati, vincoli, product line, effort) restano
quelle del template, da aggiornare a mano. Il testo e' in inglese, come il
template e le Story.
"""

import datetime as dt
import math
import re
from copy import deepcopy
from dataclasses import dataclass, field
from io import BytesIO

from pptx import Presentation
from pptx.dml.color import RGBColor
from pptx.enum.dml import MSO_THEME_COLOR
from pptx.enum.shapes import MSO_CONNECTOR, MSO_SHAPE
from pptx.enum.text import MSO_ANCHOR, PP_ALIGN
from pptx.opc.constants import RELATIONSHIP_TYPE as RT
from pptx.oxml.ns import qn
from pptx.util import Inches, Pt

from app import models
from app.services.document_generator import TEMPLATES_DIR
from app.services.presentation import JIRA_KEY_RE, _scope_paragraphs

TEMPLATE_PATH = TEMPLATES_DIR / "kickoff_template.pptx"

# Posizione (da 0) nel template delle slide riscritte qui.
COVER_SLIDE = 0
TEAM_SLIDE = 2
SCOPE_SLIDE = 4
REQUIREMENTS_SLIDE = 13
TIMELINE_SLIDE = 21

# Forme del template, per nome.
SCOPE_BODY_SHAPE = "Text Placeholder 33"
TIMELINE_TEXT_SHAPE = "TextBox 131"
# Il vecchio grafico della timeline (esportato da MS Project): tutte le forme
# della slide con questi nomi vengono tolte e ridisegnate.
TIMELINE_CHART_SHAPE_RE = re.compile(
    r"^(ProjectBar|Timescale|Taskrect|TaskProgressRect|Shape\d|MilestoneMarker|FloatingTextBox|ConnectingLine|TodayMarker)"
)

BODY_FONT = "Montserrat Light"
CHART_FONT = "Segoe UI"
COLOR_CHART = RGBColor(0x44, 0x44, 0x44)
COLOR_BAR = RGBColor(0xDF, 0xEB, 0xF7)
COLOR_BAR_ELAPSED = RGBColor(0xA8, 0xC9, 0xE9)
COLOR_TODAY = RGBColor(0x31, 0x75, 0x2F)
COLOR_WHITE = RGBColor(0xFF, 0xFF, 0xFF)
COLOR_BODY = RGBColor(0x5B, 0x57, 0x54)

MONTHS = (
    "January", "February", "March", "April", "May", "June",
    "July", "August", "September", "October", "November", "December",
)  # fmt: skip

# Label Jira "out of scope": Story entrate nel backlog fuori dallo scope
# concordato, che nello scope della presentazione non vanno citate.
OUT_OF_SCOPE_LABEL = "oos"
OTHER_TOPIC = "Other requirements"

# Riferimento a un enhancement nel testo di una Story ("ENH 02215",
# "[ENH 02245]", "Enhancement 02464") o dello Scope ("Enh 02215").
ENHANCEMENT_RE = re.compile(r"\benh(?:ancement)?\.?[\s\-–:#]*(\d{4,5})\b", re.IGNORECASE)
# Numero del complaint in testa al summary di un Bug ("[69019] Missing ...").
COMPLAINT_PREFIX_RE = re.compile(r"^\s*\[(\d{4,6})\]\s*")
# Annotazioni tra parentesi quadre nel summary ("[Outsourcing]", "[Expands
# PTBSYS-205]", "[ENH 02245]", "[Draft]") e "(Expands PTBSYS-3543)".
SUMMARY_TAG_RE = re.compile(r"\s*\[[^\]]*\]|\s*\(expands?\b[^)]*\)", re.IGNORECASE)
# Codice di un increment (es. "PTBSYS-03-002") rimasto nel testo del template.
INCREMENT_CODE_RE = re.compile(r"\b[A-Z]{3,}-\d{2}-\d{3}\b")


# --- Contenuti: dalle Story e dai Bug ai testi -------------------------------


@dataclass
class _Topic:
    title: str
    stories: list[models.BacklogItem] = field(default_factory=list)
    # Il titolo e' il summary di un Epic (una user need), non una voce dello Scope.
    epic: bool = False


def _labels(item: models.BacklogItem) -> set[str]:
    return {label.strip().lower() for label in (item.labels or "").split(";") if label.strip()}


def _enhancement(text: str | None) -> str | None:
    """Riferimento all'enhancement citato nel testo, come "ENH 02215"."""
    match = ENHANCEMENT_RE.search(text or "")
    return f"ENH {match.group(1).zfill(5)}" if match else None


def _story_enhancement(story: models.BacklogItem) -> str | None:
    return _enhancement(story.summary) or _enhancement(story.description)


def _clean_summary(summary: str | None) -> str:
    """Il summary senza annotazioni tra parentesi e senza punto finale (e non
    tutto in maiuscolo, se e' stato scritto cosi')."""
    text = re.sub(r"\s{2,}", " ", SUMMARY_TAG_RE.sub("", summary or "")).strip().rstrip(".").strip()
    return text.capitalize() if text.isupper() else text


def _clause(story: models.BacklogItem) -> str:
    """Il requisito della Story come proposizione da inserire in una frase:
    "The ProTube System shall expose ..." -> "the ProTube System will expose
    ...", "As a User I need to see ..." -> "the User will be able to see ..."."""
    text = _clean_summary(story.summary) or story.jira_key
    if match := re.match(r"As (?:an? )?(.+?),? I (?:need|want) that (.+)", text, flags=re.IGNORECASE):
        text = re.sub(r"\bis able to\b", "will be able to", match.group(2), count=1)
    elif match := re.match(r"As (?:an? )?(.+?),? I (?:need|want)(?: to be able)? to (.+)", text, flags=re.IGNORECASE):
        text = f"the {match.group(1)} will be able to {match.group(2)}"
    elif match := re.match(r"As (?:an? )?(.+?),? I (need|want) (.+)", text, flags=re.IGNORECASE):
        text = f"the {match.group(1)} {match.group(2).lower()}s {match.group(3)}"
    text = re.sub(r"\bshall\b", "will", text, count=1)
    return re.sub(r"^the( the)?\b", "the", text, flags=re.IGNORECASE)


def _join(parts: list[str]) -> str:
    """Elenco in una frase: "a", "a and b", "a, b and c"."""
    if len(parts) <= 1:
        return "".join(parts)
    return ", ".join(parts[:-1]) + " and " + parts[-1]


def _requirement_stories(project: models.Project) -> list[models.BacklogItem]:
    return sorted(
        (
            i
            for i in project.backlog_items
            if i.in_scope and i.issue_type == "Story" and OUT_OF_SCOPE_LABEL not in _labels(i)
        ),
        key=lambda i: i.priority_order,
    )


def _topics(project: models.Project, stories: list[models.BacklogItem]) -> list[_Topic]:
    """Le Story raggruppate per macro-argomento. I macro-argomenti sono le
    voci di primo livello dello Scope della Dashboard: una Story appartiene
    alla voce che la cita (per chiave Jira o per numero di enhancement), a
    quella che si chiama come una sua label ("Board redesign" e
    "Board_Redesign"), oppure a quella di un'altra Story con lo stesso Epic.
    Le Story rimaste fuori vanno per Epic, se almeno due lo condividono,
    altrimenti in OTHER_TOPIC."""
    # (titolo, chiavi Jira citate, enhancement citati) per ogni voce di primo
    # livello, con dentro anche cio' che citano le sue sottovoci.
    scope_topics: list[tuple[str, set[str], set[str]]] = []
    for paragraph in _scope_paragraphs(project.scope):
        keys = set(JIRA_KEY_RE.findall(paragraph.text))
        enhancements = {f"ENH {n.zfill(5)}" for n in ENHANCEMENT_RE.findall(paragraph.text)}
        if paragraph.level == 0 or not scope_topics:
            title = re.sub(r"[\s\-–+:]+$", "", JIRA_KEY_RE.sub("", paragraph.text)).strip()
            scope_topics.append((title or paragraph.text.strip(), keys, enhancements))
        else:
            scope_topics[-1][1].update(keys)
            scope_topics[-1][2].update(enhancements)

    def normalized(text: str) -> str:
        return re.sub(r"[^a-z0-9]", "", text.lower())

    topic_of: dict[str, int] = {}
    for story in stories:
        enhancement = _story_enhancement(story)
        labels = {normalized(label) for label in _labels(story)}
        candidates = [
            n
            for n, (title, keys, enhancements) in enumerate(scope_topics)
            if story.jira_key in keys
            or (enhancement is not None and enhancement in enhancements)
            or normalized(title) in labels
        ]
        if candidates:
            # Citata da piu' voci: vince la piu' specifica (meno issue).
            topic_of[story.jira_key] = min(candidates, key=lambda n: len(scope_topics[n][1]))
    by_epic = {s.parent_key: topic_of[s.jira_key] for s in stories if s.parent_key and s.jira_key in topic_of}
    for story in stories:
        if story.jira_key not in topic_of and story.parent_key in by_epic:
            topic_of[story.jira_key] = by_epic[story.parent_key]

    topics = [_Topic(title) for title, _, _ in scope_topics]
    for story in stories:
        if story.jira_key in topic_of:
            topics[topic_of[story.jira_key]].stories.append(story)
    # Le Story che lo Scope non cita: per Epic, nell'ordine del Backlog.
    left = [story for story in stories if story.jira_key not in topic_of]
    epic_topics: dict[str, _Topic] = {}
    other = _Topic(OTHER_TOPIC)
    for story in left:
        shared = sum(1 for s in left if s.parent_key == story.parent_key) > 1
        if story.parent_key and story.parent_summary and shared:
            title = story.parent_summary.strip().rstrip(".")
            epic_topics.setdefault(story.parent_key, _Topic(title, epic=True)).stories.append(story)
        else:
            other.stories.append(story)
    return [topic for topic in [*topics, *epic_topics.values(), other] if topic.stories]


def _complaint_number(bug: models.BacklogItem, complaint_numbers: dict[str, str]) -> str | None:
    """Numero del case Salesforce del Bug: dall'area Complaints, altrimenti
    dal prefisso "[12345]" del summary."""
    number = (complaint_numbers.get(bug.jira_key) or "").strip().lstrip("0")
    if number:
        return number
    match = COMPLAINT_PREFIX_RE.match(bug.summary or "")
    return match.group(1) if match else None


# Un paragrafo dello scope: i suoi tratti di testo, (testo, grassetto).
_Runs = list[tuple[str, bool]]

TOPIC_OPENERS = ("Regarding {}, ", "On the {} side, ", "As for {}, ", "Concerning {}, ")
# Quanti requisiti di un macro-argomento vengono citati uno per uno nel testo.
MAX_CLAUSES = 6


def _scope_text(project: models.Project, topics: list[_Topic], complaint_numbers: dict[str, str]) -> list[_Runs]:
    """Lo scope in forma discorsiva: un paragrafo d'apertura con i
    macro-argomenti, uno per macro-argomento con i suoi requisiti, uno per gli
    enhancement (ognuno col suo riferimento, in grassetto) e la sezione
    "Tickets / Complaints" (ogni complaint col suo numero, in grassetto)."""
    paragraphs: list[_Runs] = []
    named = [topic.title for topic in topics if topic.title != OTHER_TOPIC and not topic.epic]
    if len(named) > 1:
        paragraphs.append([(f"The release {project.code} centers on {named[0]}, alongside {_join(named[1:])}.", False)])
    elif named:
        paragraphs.append([(f"The release {project.code} centers on {named[0]}.", False)])

    enhancements = [(story, ref) for topic in topics for story in topic.stories if (ref := _story_enhancement(story))]
    with_enhancement = {story.jira_key for story, _ in enhancements}
    opener = 0
    for topic in topics:
        clauses = [_clause(story) for story in topic.stories if story.jira_key not in with_enhancement]
        if not clauses:
            continue
        if len(clauses) > MAX_CLAUSES:
            # Un elenco piu' lungo non si legge piu' come una frase: il resto
            # e' comunque nella slide Major Requirements.
            hidden = len(clauses) - MAX_CLAUSES
            clauses = clauses[:MAX_CLAUSES] + [f"{hidden} further requirement{'s' if hidden > 1 else ''}"]
        if topic.title == OTHER_TOPIC:
            lead = "In addition, " if paragraphs else ""
        elif topic.epic:
            lead = f"Under the user need “{topic.title}”, "
        else:
            lead = TOPIC_OPENERS[opener % len(TOPIC_OPENERS)].format(topic.title)
            opener += 1
        text = lead + _join(clauses) + "."
        paragraphs.append([(text[0].upper() + text[1:], False)])

    if enhancements:
        runs: _Runs = [
            (
                "The release also delivers the following customer "
                + ("enhancements: " if len(enhancements) > 1 else "enhancement: "),
                False,
            )
        ]
        for n, (story, ref) in enumerate(enhancements):
            runs += [(f"{_clause(story)} (", False), (f"Enhancement {ref}", True), (")", False)]
            runs.append((_separator(n, len(enhancements)), False))
        paragraphs.append(runs)

    bugs = sorted(
        (i for i in project.backlog_items if i.in_scope and i.issue_type == "Bug"), key=lambda i: i.priority_order
    )
    numbered = [(bug, number) for bug in bugs if (number := _complaint_number(bug, complaint_numbers))]
    others = [bug for bug in bugs if _complaint_number(bug, complaint_numbers) is None]
    if bugs:
        paragraphs.append([("Tickets / Complaints", True)])
        runs = []
        if numbered:
            runs.append(("The following " + ("complaints" if len(numbered) > 1 else "complaint") + " will be solved: ", False))
            for n, (bug, number) in enumerate(numbered):
                summary = _clean_summary(COMPLAINT_PREFIX_RE.sub("", bug.summary or "")) or bug.jira_key
                runs += [(f"“{summary}” (", False), (f"Complaint {number}", True), (")", False)]
                runs.append((_separator(n, len(numbered)), False))
        if others:
            runs.append(
                (
                    (" In addition, the" if numbered else "The")
                    + " following "
                    + ("bugs" if len(others) > 1 else "bug")
                    + " will be fixed: ",
                    False,
                )
            )
            for n, bug in enumerate(others):
                runs.append((f"“{_clean_summary(bug.summary) or bug.jira_key}” ({bug.jira_key})", False))
                runs.append((_separator(n, len(others)), False))
        paragraphs.append(runs)

    if not paragraphs:
        paragraphs.append([("No Story or Bug in scope for this increment.", False)])
    return paragraphs


def _separator(index: int, count: int) -> str:
    """Cosa segue la voce index di un elenco di count voci in una frase."""
    if index == count - 1:
        return "."
    return " and " if index == count - 2 else ", "


# --- Presentazione ------------------------------------------------------------


def _remove(shape) -> None:
    shape._element.getparent().remove(shape._element)


def _shape(slide, name: str, placeholder: bool | None = None):
    return next(
        s for s in slide.shapes if s.name == name and (placeholder is None or s.is_placeholder == placeholder)
    )


def _set_text(shape, text: str) -> None:
    """Sostituisce il testo di una forma tenendo la formattazione del suo
    primo tratto (text_frame.text la perderebbe)."""
    paragraphs = shape.text_frame.paragraphs
    for paragraph in paragraphs[1:]:
        paragraph._p.getparent().remove(paragraph._p)
    runs = paragraphs[0].runs
    if not runs:
        paragraphs[0].add_run().text = text
        return
    runs[0].text = text
    for run in runs[1:]:
        run._r.getparent().remove(run._r)


def _replace_increment_code(prs, code: str) -> None:
    """Il template e' la presentazione di un increment precedente: ovunque
    resti scritto il suo codice ci va quello di questo increment."""
    if not INCREMENT_CODE_RE.fullmatch(code):
        return
    for slide in prs.slides:
        for shape in slide.shapes:
            if not shape.has_text_frame:
                continue
            for paragraph in shape.text_frame.paragraphs:
                for run in paragraph.runs:
                    if INCREMENT_CODE_RE.search(run.text):
                        run.text = INCREMENT_CODE_RE.sub(code, run.text)


def _fill_cover(slide, project: models.Project) -> None:
    for shape in slide.shapes:
        if not shape.has_text_frame:
            continue
        text = shape.text_frame.text.strip()
        if re.fullmatch(r"\d{2}/\d{2}/\d{4}", text):
            _set_text(shape, f"{dt.date.today():%d/%m/%Y}")
        elif not shape.is_placeholder and INCREMENT_CODE_RE.match(text):
            # Casella "<codice> – <titolo dell'increment>".
            _set_text(shape, f"{project.code} – {project.name}")


def _fill_timesheet_codes(slide, project: models.Project) -> None:
    """"Project Code for Timesheet": i progetti (e sotto-progetti) collegati
    all'increment, su cui si rendicontano le sue ore. Senza progetti
    collegati resta il testo del template."""
    codes = [progetto.code for progetto in project.progetti]
    codes += [f"{sub.increment_code} ({sub.name})" for sub in project.sub_projects]
    if not codes:
        return
    for shape in slide.shapes:
        if shape.has_text_frame and shape.text_frame.text.strip().lower().startswith("project code for timesheet"):
            _set_text(shape, "Project Code for Timesheet:  " + ", ".join(codes))


def _fill_scope(slide, paragraphs: list[_Runs]) -> None:
    body = _shape(slide, SCOPE_BODY_SHAPE, placeholder=True)
    existing = body.text_frame.paragraphs
    # Il primo paragrafo e' il titolo "Description"; il secondo fa da modello
    # (allineamento, interlinea, font) per quelli nuovi.
    model = deepcopy(existing[1]._p)
    model_r_pr = deepcopy(existing[1].runs[0]._r.rPr)
    for attribute in ("b", "err"):
        model_r_pr.attrib.pop(attribute, None)
    for paragraph in existing[1:]:
        paragraph._p.getparent().remove(paragraph._p)
    for child in list(model):
        if child.tag != qn("a:pPr"):
            model.remove(child)

    # Il carattere piu' grande (fino a quello del template) con cui il testo
    # sta nel riquadro: righe stimate dalla larghezza media di un carattere.
    box_width, box_height = body.width / 914400, body.height / 914400
    for size in (9, 8.5, 8, 7.5, 7):
        chars_per_line = int(box_width * 72 / (size * 0.56))
        line_height = size * 1.2 * 1.5 / 72
        lines = sum(math.ceil(len("".join(t for t, _ in runs)) / chars_per_line) or 1 for runs in paragraphs)
        # Titolo "Description" e spazio tra un paragrafo e l'altro.
        if (lines + 1) * line_height + (len(paragraphs) + 1) * line_height * 0.65 <= box_height:
            break

    title_p = existing[0]._p
    for run in existing[0].runs:
        run.font.size = Pt(size)
    for runs in reversed(paragraphs):
        p = deepcopy(model)
        for text, bold in runs:
            r = p.makeelement(qn("a:r"), {})
            r_pr = deepcopy(model_r_pr)
            r_pr.set("sz", str(int(size * 100)))
            if bold:
                r_pr.set("b", "1")
            r.append(r_pr)
            t = r.makeelement(qn("a:t"), {})
            t.text = text
            r.append(t)
            p.append(r)
        title_p.addnext(p)


def _clone_slide(prs, source):
    """Copia di una slide subito dopo l'originale (python-pptx non lo
    prevede): stesso layout, stesse forme, stesse immagini."""
    clone = prs.slides.add_slide(source.slide_layout)
    for shape in list(clone.shapes):
        _remove(shape)
    r_ids: dict[str, str] = {}
    for rel in source.part.rels.values():
        if rel.reltype in (RT.SLIDE_LAYOUT, RT.NOTES_SLIDE):
            continue
        if rel.is_external:
            r_ids[rel.rId] = clone.part.relate_to(rel.target_ref, rel.reltype, is_external=True)
        else:
            r_ids[rel.rId] = clone.part.relate_to(rel.target_part, rel.reltype)
    relationship_ns = "{http://schemas.openxmlformats.org/officeDocument/2006/relationships}"
    for element in source.shapes._spTree:
        if element.tag in (qn("p:nvGrpSpPr"), qn("p:grpSpPr")):
            continue
        copy = deepcopy(element)
        for node in copy.iter():
            for name, value in node.attrib.items():
                if name.startswith(relationship_ns) and value in r_ids:
                    node.set(name, r_ids[value])
        clone.shapes._spTree.append(copy)

    slide_ids = prs.slides._sldIdLst
    new_id = slide_ids[-1]
    source_id = next(s for s in slide_ids if prs.part.related_part(s.rId) is source.part)
    slide_ids.remove(new_id)
    source_id.addnext(new_id)
    return clone


def _plain_text(slide, left, top, width, height, lines, align=PP_ALIGN.LEFT, anchor=MSO_ANCHOR.MIDDLE, wrap=False):
    """Casella di testo senza margini. lines: una riga per elemento, ognuna
    una lista di tratti (testo, dimensione, grassetto, colore)."""
    frame = slide.shapes.add_textbox(left, top, width, height).text_frame
    frame.word_wrap = wrap
    frame.vertical_anchor = anchor
    frame.margin_left = frame.margin_right = frame.margin_top = frame.margin_bottom = 0
    for n, runs in enumerate(lines):
        paragraph = frame.paragraphs[0] if n == 0 else frame.add_paragraph()
        paragraph.alignment = align
        for text, size, bold, color in runs:
            run = paragraph.add_run()
            run.text = text
            run.font.name = CHART_FONT
            run.font.size = Pt(size)
            run.font.bold = bold
            run.font.color.rgb = color
    return frame


def _fill_requirements(prs, slide, topics: list[_Topic]) -> None:
    """Major Requirements: per ogni macro-argomento una linguetta col titolo
    e, sotto, l'elenco delle sue Story (lo stesso disegno dello SmartArt del
    template, che viene tolto: python-pptx non sa modificarlo). Se non stanno
    in una slide si continua su copie della slide."""
    for shape in list(slide.shapes):
        if shape._element.tag == qn("p:graphicFrame"):
            _remove(shape)
    for rel in list(slide.part.rels.values()):
        if "diagram" in rel.reltype:
            slide.part.drop_rel(rel.rId)

    left, top, width = Inches(0.33), Inches(1.48), Inches(12.67)
    bottom = Inches(6.85)
    font_size = 11
    tab_height, tab_gap, group_gap = Inches(0.42), Inches(0.08), Inches(0.14)
    line_height = int(Pt(font_size * 1.2))
    bullet_gap = int(Pt(5))
    chars_per_line = int(width / Pt(font_size * 0.56))

    def bullet(story: models.BacklogItem) -> str:
        text = _clean_summary(story.summary) or story.jira_key
        enhancement = _story_enhancement(story)
        return f"{text} ({enhancement})" if enhancement else text

    def bullet_height(text: str) -> int:
        return (math.ceil(len(text) / chars_per_line) or 1) * line_height + bullet_gap

    # Pagine: [(titolo, [voci])]. Un macro-argomento passa alla slide dopo se
    # non ci sta per intero; se e' piu' lungo di una slide viene spezzato.
    pages: list[list[tuple[str, list[str]]]] = [[]]
    used = 0
    for topic in topics:
        bullets = [bullet(story) for story in topic.stories]
        title = topic.title
        while bullets:
            head = tab_height + tab_gap + group_gap
            # Lo spazio dopo l'ultimo gruppo della slide non serve: non conta.
            available = bottom - top + group_gap
            if pages[-1] and used + head + sum(bullet_height(b) for b in bullets) > available:
                pages.append([])
                used = 0
            fitting = []
            height = head
            for text in bullets:
                if fitting and used + height + bullet_height(text) > available:
                    break
                fitting.append(text)
                height += bullet_height(text)
            pages[-1].append((title, fitting))
            used += height
            bullets = bullets[len(fitting) :]
            if bullets:
                title = f"{topic.title} (cont.)"
                pages.append([])
                used = 0

    slides = [slide]
    for _ in pages[1:]:
        slides.append(_clone_slide(prs, slides[-1]))
    for index, (page_slide, groups) in enumerate(zip(slides, pages)):
        if len(pages) > 1:
            for shape in page_slide.placeholders:
                if shape.placeholder_format.idx == 1:
                    _set_text(shape, f"Major Requirements ({index + 1}/{len(pages)})")
        if not groups:
            _plain_text(
                page_slide, left, top, width, Inches(0.4), [[("No Story in scope for this increment.", 12, False, COLOR_BODY)]]
            )
            continue
        y = top
        for title, bullets in groups:
            tab_width = min(max(Inches(3.35), int(Pt(font_size * 0.6) * len(title)) + Inches(0.4)), width)
            tab = page_slide.shapes.add_shape(MSO_SHAPE.ROUND_2_SAME_RECTANGLE, left, y, tab_width, tab_height)
            tab.fill.solid()
            tab.fill.fore_color.theme_color = MSO_THEME_COLOR.ACCENT_1
            tab.line.color.theme_color = MSO_THEME_COLOR.ACCENT_1
            tab.shadow.inherit = False
            frame = tab.text_frame
            frame.word_wrap = False
            frame.vertical_anchor = MSO_ANCHOR.MIDDLE
            frame.margin_left = Inches(0.08)
            frame.paragraphs[0].alignment = PP_ALIGN.LEFT
            run = frame.paragraphs[0].add_run()
            run.text = title
            run.font.name = BODY_FONT
            run.font.size = Pt(font_size)
            run.font.color.rgb = COLOR_WHITE
            line = page_slide.shapes.add_connector(
                MSO_CONNECTOR.STRAIGHT, left, y + tab_height, left + width, y + tab_height
            )
            line.line.color.theme_color = MSO_THEME_COLOR.ACCENT_1
            line.line.width = Pt(1)

            list_top = y + tab_height + tab_gap
            list_height = sum(bullet_height(b) for b in bullets)
            frame = page_slide.shapes.add_textbox(left, list_top, width, list_height).text_frame
            frame.word_wrap = True
            frame.margin_left = frame.margin_right = Inches(0.03)
            frame.margin_top = frame.margin_bottom = 0
            for n, text in enumerate(bullets):
                paragraph = frame.paragraphs[0] if n == 0 else frame.add_paragraph()
                paragraph.space_after = Pt(5)
                p_pr = paragraph._p.get_or_add_pPr()
                p_pr.set("marL", str(Inches(0.14)))
                p_pr.set("indent", str(-Inches(0.14)))
                p_pr.append(p_pr.makeelement(qn("a:buChar"), {"char": "•"}))
                run = paragraph.add_run()
                run.text = text
                run.font.name = BODY_FONT
                run.font.size = Pt(font_size)
                run.font.color.rgb = COLOR_BODY
            y = list_top + list_height + group_gap


def _phase_label(name: str) -> str:
    lowered = name.strip().lower()
    if lowered in ("kick-off", "kick off", "kickoff"):
        return "Kick-off meeting"
    if lowered == "code freeze":
        return "Code freeze"
    return f"{name.strip()} review"


def _day(day: dt.date) -> str:
    return f"{day:%a %d/%m/%y}"


def _fill_timeline(slide, project: models.Project) -> None:
    """Project Timeline: l'elenco delle fasi con la loro scadenza e, sotto, il
    grafico - la barra dell'increment dall'inizio alla fine con dentro le
    attivita' (sviluppo fino al code freeze, progetti collegati) e una
    milestone per ogni fase. Una fase conta alla data effettiva se c'e'
    gia', altrimenti a quella pianificata."""
    for shape in list(slide.shapes):
        if TIMELINE_CHART_SHAPE_RE.match(shape.name):
            _remove(shape)

    # (nome, data, gia' avvenuta)
    phases = [
        (p.name, p.actual_date or p.planned_date, p.actual_date is not None)
        for p in project.phases
        if (p.actual_date or p.planned_date) is not None
    ]

    text_box = _shape(slide, TIMELINE_TEXT_SHAPE)
    paragraphs = text_box.text_frame.paragraphs
    # Modello per le righe nuove: la prima voce dell'elenco del template
    # ("Kick-off meeting: within May '26"), nome normale e scadenza in grassetto.
    first_item = next(p for p in paragraphs[1:] if any(r.font.bold for r in p.runs))
    model = deepcopy(first_item._p)
    plain_r_pr = next(r._r.rPr for r in first_item.runs if not r.font.bold)
    bold_r_pr = next(r._r.rPr for r in first_item.runs if r.font.bold)
    for paragraph in paragraphs[1:]:
        paragraph._p.getparent().remove(paragraph._p)
    for child in list(model):
        if child.tag != qn("a:pPr"):
            model.remove(child)
    # Tabulazione fissa: le scadenze restano incolonnate anche con nomi di
    # fase di lunghezza diversa. Spazio dopo ogni riga al posto dei paragrafi
    # vuoti del template, che con molte fasi porterebbero l'elenco sul grafico.
    p_pr = model.find(qn("a:pPr"))
    tabs = p_pr.makeelement(qn("a:tabLst"), {})
    tabs.append(tabs.makeelement(qn("a:tab"), {"pos": str(Inches(2.8)), "algn": "l"}))
    p_pr.append(tabs)
    space_after = p_pr.makeelement(qn("a:spcAft"), {})
    space_after.append(space_after.makeelement(qn("a:spcPts"), {"val": "600"}))
    p_pr.insert(0, space_after)
    paragraphs[0].space_after = Pt(6)
    anchor = paragraphs[0]._p
    if not phases:
        _set_text(text_box, "No phase with a date has been defined for this increment yet.")
    for name, day, done in reversed(phases):
        p = deepcopy(model)
        due = f"done on {day:%d/%m/%Y}" if done else f"within {MONTHS[day.month - 1]} ’{day:%y}"
        for text, r_pr in ((f"{_phase_label(name)}:\t", plain_r_pr), (due, bold_r_pr)):
            r = p.makeelement(qn("a:r"), {})
            r.append(deepcopy(r_pr))
            t = r.makeelement(qn("a:t"), {})
            t.text = text
            r.append(t)
            p.append(r)
        anchor.addnext(p)

    days = [d for d in (project.start_date, project.dev_start_date, project.planned_finish_date) if d is not None]
    days += [day for _, day, _ in phases]
    if len(set(days)) < 2:
        return
    start, finish = min(days), max(days)
    span = (finish - start).days

    # Attivita' dentro la barra: (nome, inizio, fine), tagliate sull'increment.
    tasks: list[tuple[str, dt.date, dt.date]] = []
    development_start = project.dev_start_date or project.start_date
    if development_start is not None and project.code_freeze_date is not None:
        tasks.append(("Development", development_start, project.code_freeze_date))
    for progetto in project.progetti:
        if progetto.start_date is not None and progetto.end_date is not None:
            tasks.append((progetto.code, progetto.start_date, progetto.end_date))
    tasks = [(name, max(a, start), min(b, finish)) for name, a, b in tasks if max(a, start) < min(b, finish)]

    left, width = Inches(2.61), Inches(7.31)
    # Il grafico sta sotto l'elenco delle fasi, che si allunga con loro.
    chart_top = max(Inches(3.72), text_box.top + Inches(0.29) * (len(phases) + 1) + Inches(0.25))
    frame_top = chart_top + Inches(0.43)
    row_height = Inches(0.34)
    frame_height = row_height * max(len(tasks), 1) + Inches(0.02)
    frame_bottom = frame_top + frame_height
    today = dt.date.today()

    def x_of(day: dt.date) -> int:
        return left + int(width * (day - start).days / span)

    def rectangle(x: int, y: int, w: int, h: int, fill: RGBColor, outline: RGBColor | None = None):
        shape = slide.shapes.add_shape(MSO_SHAPE.RECTANGLE, x, y, w, h)
        shape.fill.solid()
        shape.fill.fore_color.rgb = fill
        if outline is None:
            shape.line.fill.background()
        else:
            shape.line.color.rgb = outline
            shape.line.width = Pt(1)
        shape.shadow.inherit = False
        return shape

    def line(x1: int, y1: int, x2: int, y2: int, color: RGBColor = COLOR_CHART) -> None:
        connector = slide.shapes.add_connector(MSO_CONNECTOR.STRAIGHT, x1, y1, x2, y2)
        connector.line.color.rgb = color
        connector.line.width = Pt(1)

    rectangle(left, frame_top, width, frame_height, COLOR_WHITE, outline=COLOR_CHART)
    _plain_text(
        slide, left - Inches(0.98), frame_top - Inches(0.04), Inches(0.9), Inches(0.33),
        [[("Start", 8, False, COLOR_CHART)], [(_day(start), 8, False, COLOR_CHART)]], align=PP_ALIGN.RIGHT,
    )  # fmt: skip
    _plain_text(
        slide, left + width + Inches(0.08), frame_top - Inches(0.04), Inches(0.9), Inches(0.33),
        [[("Finish", 8, False, COLOR_CHART)], [(_day(finish), 8, False, COLOR_CHART)]],
    )  # fmt: skip

    # Scala dei tempi: una tacca ogni tante settimane (di lunedi'), quante ne
    # servono per non averne piu' di una decina.
    weeks = max(math.ceil(span / 7 / 9), 1)
    tick = start + dt.timedelta(days=(7 - start.weekday()) % 7 or 7)
    while tick < finish and x_of(tick) + Inches(0.62) <= left + width:
        line(x_of(tick), frame_top - Inches(0.15), x_of(tick), frame_top)
        _plain_text(
            slide, x_of(tick) + Inches(0.03), frame_top - Inches(0.19), Inches(0.62), Inches(0.19),
            [[(f"{tick:%d %b '%y}", 8, False, COLOR_CHART)]],
        )  # fmt: skip
        tick += dt.timedelta(weeks=weeks)

    for row, (name, task_start, task_finish) in enumerate(tasks):
        y = frame_top + Inches(0.01) + row * row_height
        height = row_height - Inches(0.01)
        rectangle(x_of(task_start), y, x_of(task_finish) - x_of(task_start), height, COLOR_BAR)
        # La parte gia' trascorsa, piu' scura.
        elapsed_until = min(today, task_finish)
        if elapsed_until > task_start:
            rectangle(x_of(task_start), y, x_of(elapsed_until) - x_of(task_start), height, COLOR_BAR_ELAPSED)
        # Nome e date partono dall'inizio dell'attivita'; se li' non ci stanno
        # (attivita' a fine barra) si appoggiano al bordo destro.
        label_width = Inches(2.6)
        label_left = x_of(task_start) + Inches(0.03)
        at_end = label_left + label_width > left + width
        _plain_text(
            slide, left + width - label_width - Inches(0.03) if at_end else label_left, y, label_width, height,
            [[(name, 8, True, COLOR_CHART)], [(f"{_day(task_start)} - {_day(task_finish)}", 8, False, COLOR_CHART)]],
            align=PP_ALIGN.RIGHT if at_end else PP_ALIGN.LEFT,
        )  # fmt: skip

    # Milestone delle fasi sotto la barra: un tratto verticale dalla data e,
    # alla sua sinistra, nome e data. Le fasi vicine nel tempo scendono a
    # scala (la prima piu' in alto), cosi' nessun tratto attraversa
    # un'etichetta: quelle delle fasi successive stanno piu' in basso.
    label_width, label_height, level_height = Inches(1.2), Inches(0.34), Inches(0.36)
    marker = Inches(0.12)
    placed: list[tuple[int, int]] = []  # (x, livello) delle milestone gia' messe
    for name, day, done in sorted(phases, key=lambda phase: phase[1]):
        x = x_of(day)
        level = max((lvl + 1 for other_x, lvl in placed if other_x > x - label_width - Inches(0.05)), default=0)
        placed.append((x, level))
        label_top = frame_bottom + Inches(0.14) + level * level_height
        line(x, frame_bottom, x, label_top + label_height, RGBColor(0, 0, 0))
        diamond = slide.shapes.add_shape(MSO_SHAPE.DIAMOND, x - marker // 2, frame_bottom - marker // 2, marker, marker)
        diamond.fill.solid()
        diamond.fill.fore_color.rgb = COLOR_CHART
        diamond.line.color.rgb = COLOR_WHITE
        diamond.line.width = Pt(1)
        diamond.shadow.inherit = False
        _plain_text(
            slide, x - label_width - Inches(0.05), label_top, label_width, label_height,
            [[(("✔" if done else "") + name, 10, False, COLOR_CHART)], [(_day(day), 8, False, COLOR_CHART)]],
            align=PP_ALIGN.RIGHT,
        )  # fmt: skip

    if start <= today <= finish:
        x = x_of(today)
        flag = rectangle(x - Inches(0.26), chart_top, Inches(0.52), Inches(0.17), COLOR_TODAY)
        flag.text_frame.margin_left = flag.text_frame.margin_right = 0
        flag.text_frame.margin_top = flag.text_frame.margin_bottom = 0
        flag.text_frame.vertical_anchor = MSO_ANCHOR.MIDDLE
        flag.text_frame.paragraphs[0].alignment = PP_ALIGN.CENTER
        run = flag.text_frame.paragraphs[0].add_run()
        run.text = "Today"
        run.font.name = CHART_FONT
        run.font.size = Pt(8)
        run.font.bold = True
        run.font.color.rgb = COLOR_WHITE
        line(x, chart_top + Inches(0.17), x, frame_bottom, RGBColor(0, 0, 0))


def generate_kickoff_presentation(project: models.Project, complaint_numbers: dict[str, str]) -> tuple[bytes, str]:
    """Presentazione di Kick-off dell'increment. complaint_numbers: numero
    del case Salesforce per chiave Jira, dall'area Complaints. Restituisce il
    contenuto del .pptx e il nome file (senza estensione)."""
    prs = Presentation(str(TEMPLATE_PATH))
    slides = list(prs.slides)
    _replace_increment_code(prs, project.code)

    topics = _topics(project, _requirement_stories(project))
    _fill_cover(slides[COVER_SLIDE], project)
    _fill_timesheet_codes(slides[TEAM_SLIDE], project)
    _fill_scope(slides[SCOPE_SLIDE], _scope_text(project, topics, complaint_numbers))
    _fill_requirements(prs, slides[REQUIREMENTS_SLIDE], topics)
    _fill_timeline(slides[TIMELINE_SLIDE], project)

    buffer = BytesIO()
    prs.save(buffer)
    # Stesso nome del documento ufficiale: "TIH-KICK_OFF-PTBSYS".
    return buffer.getvalue(), f"TIH-KICK_OFF-{project.code.split('-', 1)[0]}"
