"""Release Notice: la mail che annuncia il rilascio di un increment.

Il testo viene da un template Word con segnaposto, modificabile dall'utente
(si scarica, si cambia in Word e si ricarica dal popup): quello predefinito e'
app/templates/release_notice_template.docx, quello caricato sta in
data/templates/ (fuori da git). Vedi PLACEHOLDERS per i segnaposto.

Dal template compilato escono due forme: il .docx e l'HTML da incollare in
Outlook ("Copia per email"), ricavato dal .docx stesso, quindi con gli stessi
testi, grassetti, colori, link ed elenchi.

Dati: codice dell'increment, Scope discorsivo (Dashboard), componenti della
release dell'increment (sezione Releases: PN, nome, sigla, fix version),
Change Order. I link del Service Portal e della Compatibility Matrix cambiano
a ogni release: li scrive l'utente nel popup, come la Nota facoltativa."""

import copy
import datetime as dt
import re
from dataclasses import dataclass
from html import escape
from io import BytesIO
from pathlib import Path

from docx import Document
from docx.opc.constants import RELATIONSHIP_TYPE as RT
from docx.oxml import parse_xml
from docx.oxml.ns import nsdecls, qn

from app import models
from app.services.presentation import _scope_paragraphs

DEFAULT_TEMPLATE = Path(__file__).resolve().parent.parent / "templates" / "release_notice_template.docx"
CUSTOM_TEMPLATE = Path(__file__).resolve().parents[2] / "data" / "templates" / "release_notice_template.docx"

# Segnaposto del template, con la spiegazione mostrata nel popup.
PLACEHOLDERS: list[tuple[str, str]] = [
    ("{{increment}}", "Codice dell'increment (es. PTBSYS-03-003)."),
    ("{{change_order}}", "Change Order dell'increment (es. CO2026-0223), modificabile nel popup."),
    ("{{data}}", "Data di oggi (gg/mm/aaaa)."),
    ("{{scope}}", "Da solo in un paragrafo: lo Scope discorsivo della Dashboard (paragrafi, grassetti, elenchi)."),
    ("{{componenti}}", "Da solo in un paragrafo: elenco puntato dei PN con sotto i componenti (nome + SIGLA_versione in grassetto)."),
    ("{{note}}", "Da solo in un paragrafo: la Nota scritta nel popup, una riga per paragrafo."),
    ("{{pn}}", "Il paragrafo che lo contiene si ripete per ogni PN dei componenti."),
    ("{{link_pn:testo}}", "Nel paragrafo del PN: \"testo\" con il link del Service Portal di quel PN."),
    ("{{link_change_order:testo}}", "\"testo\" con il link del Change Order."),
    ("{{link_matrix:testo}}", "\"testo\" con il link della Compatibility Matrix."),
    ("{{#oggetto}} … {{/oggetto}}", "Paragrafi dell'oggetto: nel .docx restano, in \"Copia per email\" diventano l'oggetto (senza l'etichetta \"Oggetto:\")."),
    ("{{#note}} … {{/note}}", "Paragrafi tenuti solo se la Nota non e' vuota (es. il titolo \"Note:\")."),
]
INLINE = {"increment", "change_order", "data", "pn"}
BLOCKS = {"scope", "componenti", "note"}
LINKS = {"link_pn", "link_change_order", "link_matrix"}
SECTIONS = {"oggetto", "note"}

TOKEN_RE = re.compile(r"\{\{\s*([#/]?)([a-z_]+)(?::([^}]*))?\s*\}\}")
SUBJECT_LABEL_RE = re.compile(r"^\s*(oggetto|subject)\s*:\s*", re.IGNORECASE)
LINK_COLOR = "0563C1"
XML_SPACE = "{http://www.w3.org/XML/1998/namespace}space"
W = qn


class ReleaseNoticeError(ValueError):
    pass


@dataclass
class NoticeComponent:
    pn: str
    name: str
    code: str  # es. "PSDA_6.0.0 (Keycloak 24.2.0 custom)", in grassetto


@dataclass
class NoticeInput:
    increment_code: str
    scope_html: str | None
    fallback_scope: str | None
    components: list[NoticeComponent]
    pn_links: dict[str, str]
    change_order_label: str | None
    change_order_url: str | None
    compatibility_matrix_url: str | None
    note: str | None


# --- Dati ---------------------------------------------------------------------


def release_of(db, project: models.Project) -> models.Release | None:
    return (
        db.query(models.Release)
        .filter(models.Release.increment_code == project.code)
        .order_by(models.Release.sort_order, models.Release.id)
        .first()
    )


def default_components(db, release: models.Release | None) -> list[NoticeComponent]:
    """Componenti proposti: "<nome> <SIGLA>_<fix version>"; senza sigla sul
    componente si usa l'ultima scritta per lo stesso nome in un'altra release."""
    if release is None:
        return []
    known: dict[str, str] = {}
    rows = (
        db.query(models.ReleaseComponent)
        .join(models.Release, models.Release.id == models.ReleaseComponent.release_id)
        .filter(models.ReleaseComponent.abbreviation.isnot(None))
        .order_by(models.Release.sort_order, models.ReleaseComponent.id)
    )
    for row in rows:
        if row.component:
            known[row.component.strip().lower()] = row.abbreviation
    result = []
    for component in release.components:
        if not component.component and not component.pn:
            continue
        name = (component.component or "").strip()
        abbreviation = component.abbreviation or known.get(name.lower())
        version = (component.fix_version or "").strip()
        code = f"{abbreviation}_{version}" if abbreviation and version else (abbreviation or version)
        result.append(NoticeComponent(pn=(component.pn or "").strip(), name=name, code=code))
    return result


def _pns(data: NoticeInput) -> list[str]:
    return list(dict.fromkeys(c.pn for c in data.components if c.pn))


# --- Template -----------------------------------------------------------------


def template_path() -> Path:
    return CUSTOM_TEMPLATE if CUSTOM_TEMPLATE.exists() else DEFAULT_TEMPLATE


def is_custom_template() -> bool:
    return CUSTOM_TEMPLATE.exists()


def template_tokens(content: bytes | None = None) -> list[str]:
    """Segnaposto presenti nel template (testo dei paragrafi), in ordine."""
    document = Document(BytesIO(content) if content is not None else str(template_path()))
    tokens: list[str] = []
    for p in document.element.body.iter(W("w:p")):
        for m in TOKEN_RE.finditer(_paragraph_text(p)):
            tokens.append(m.group(0))
    return tokens


def unknown_tokens(tokens: list[str]) -> list[str]:
    known = INLINE | BLOCKS | LINKS
    bad = []
    for token in tokens:
        m = TOKEN_RE.fullmatch(token)
        prefix, name = m.group(1), m.group(2)
        ok = name in SECTIONS if prefix else name in known
        if not ok and token not in bad:
            bad.append(token)
    return bad


def validate_template(content: bytes) -> list[str]:
    """Controlla che sia un .docx leggibile; restituisce i segnaposto trovati."""
    try:
        return template_tokens(content)
    except Exception as exc:  # file non .docx o rovinato
        raise ReleaseNoticeError("Il file non è un documento Word (.docx) valido.") from exc


def save_custom_template(content: bytes) -> None:
    validate_template(content)
    CUSTOM_TEMPLATE.parent.mkdir(parents=True, exist_ok=True)
    CUSTOM_TEMPLATE.write_bytes(content)


def reset_template() -> None:
    CUSTOM_TEMPLATE.unlink(missing_ok=True)


# --- XML helpers --------------------------------------------------------------


def _text_nodes(p) -> list:
    """w:t del paragrafo (anche dentro i link), non quelli dei paragrafi annidati."""
    return [t for t in p.iter(W("w:t")) if _owner_paragraph(t) is p]


def _owner_paragraph(node):
    parent = node.getparent()
    while parent is not None and parent.tag != W("w:p"):
        parent = parent.getparent()
    return parent


def _paragraph_text(p) -> str:
    return "".join(t.text or "" for t in _text_nodes(p))


def _normalize_tokens(p) -> None:
    """Word spezza spesso un segnaposto su piu' run (correttore, revisioni):
    lo si riporta per intero nel primo run, cosi' ogni segnaposto sta in un w:t."""
    nodes = _text_nodes(p)
    where = [(i, off) for i, t in enumerate(nodes) for off in range(len(t.text or ""))]
    full = "".join(t.text or "" for t in nodes)
    for m in reversed(list(TOKEN_RE.finditer(full))):
        i, off_s = where[m.start()]
        j, off_e = where[m.end() - 1]
        if i == j:
            continue
        _set_text(nodes[i], (nodes[i].text or "")[:off_s] + m.group(0))
        for k in range(i + 1, j):
            _set_text(nodes[k], "")
        _set_text(nodes[j], (nodes[j].text or "")[off_e + 1 :])


def _run_of(t):
    return t.getparent()


def _set_text(t, text: str) -> None:
    t.text = text
    t.set(XML_SPACE, "preserve")


def _split_run(t, start: int, end: int):
    """Divide il run di t in (prima, [start:end], dopo); restituisce il run centrale."""
    run = _run_of(t)
    text = t.text or ""
    before, middle, after = text[:start], text[start:end], text[end:]
    _set_text(t, middle)

    def plain_copy(value: str):
        r = copy.deepcopy(run)
        for child in list(r):
            if child.tag != W("w:rPr"):
                r.remove(child)
        new_t = parse_xml(f"<w:t {nsdecls('w')}/>")
        _set_text(new_t, value)
        r.append(new_t)
        return r

    if before:
        run.addprevious(plain_copy(before))
    if after:
        run.addnext(plain_copy(after))
    return run


def _make_link(part, run, url: str) -> None:
    rpr = run.find(W("w:rPr"))
    if rpr is None:
        rpr = run.makeelement(W("w:rPr"), {})
        run.insert(0, rpr)
    if rpr.find(W("w:color")) is None:
        _rpr_add(rpr, parse_xml(f'<w:color {nsdecls("w")} w:val="{LINK_COLOR}"/>'))
    if rpr.find(W("w:u")) is None:
        _rpr_add(rpr, parse_xml(f'<w:u {nsdecls("w")} w:val="single"/>'))
    rid = part.relate_to(url, RT.HYPERLINK, is_external=True)
    hyperlink = parse_xml(f'<w:hyperlink {nsdecls("w", "r")} r:id="{rid}" w:history="1"/>')
    run.addprevious(hyperlink)
    hyperlink.append(run)


# Ordine degli elementi di w:rPr (schema OOXML), per inserire nel posto giusto.
_RPR_ORDER = [
    "rStyle", "rFonts", "b", "bCs", "i", "iCs", "caps", "smallCaps", "strike", "dstrike", "outline", "shadow",
    "emboss", "imprint", "noProof", "snapToGrid", "vanish", "webHidden", "color", "spacing", "w", "kern",
    "position", "sz", "szCs", "highlight", "u", "effect", "bdr", "shd", "fitText", "vertAlign", "rtl", "cs",
    "em", "lang", "eastAsianLayout", "specVanish", "oMath",
]


def _rpr_add(rpr, element) -> None:
    name = element.tag.split("}")[1]
    order = _RPR_ORDER.index(name) if name in _RPR_ORDER else len(_RPR_ORDER)
    for i, child in enumerate(rpr):
        child_name = child.tag.split("}")[1]
        if child_name in _RPR_ORDER and _RPR_ORDER.index(child_name) > order:
            rpr.insert(i, element)
            return
    rpr.append(element)


# --- Elenchi generati (scope, componenti) ------------------------------------


class _Numbering:
    """Elenchi puntato e numerato aggiunti al numbering.xml del documento:
    non dipendono da quelli (eventuali) del template."""

    def __init__(self, document) -> None:
        self.root = document.part.numbering_part.element
        abstract_ids = [int(a.get(W("w:abstractNumId"))) for a in self.root.findall(W("w:abstractNum"))]
        self.next_abstract = max(abstract_ids, default=-1) + 1
        num_ids = [int(n.get(W("w:numId"))) for n in self.root.findall(W("w:num"))]
        self.next_num = max(num_ids, default=0) + 1
        self.bullet_abstract = self._add_abstract(
            [("bullet", "", "Symbol"), ("bullet", "o", "Courier New"), ("bullet", "", "Wingdings")] * 3
        )
        self.number_abstract = self._add_abstract(
            [("decimal", "%1.", None), ("lowerLetter", "%2.", None), ("lowerRoman", "%3.", None)] * 3, levels_text=True
        )
        self.bullet = self.new_num(self.bullet_abstract)

    def _add_abstract(self, levels, levels_text: bool = False) -> int:
        aid = self.next_abstract
        self.next_abstract += 1
        xml = f'<w:abstractNum {nsdecls("w")} w:abstractNumId="{aid}"><w:multiLevelType w:val="hybridMultilevel"/>'
        for ilvl, (fmt, text, font) in enumerate(levels):
            if levels_text:
                text = f"%{ilvl + 1}."
            fonts = f'<w:rPr><w:rFonts w:ascii="{font}" w:hAnsi="{font}" w:hint="default"/></w:rPr>' if font else ""
            xml += (
                f'<w:lvl w:ilvl="{ilvl}"><w:start w:val="1"/><w:numFmt w:val="{fmt}"/>'
                f'<w:lvlText w:val="{escape(text)}"/><w:lvlJc w:val="left"/>'
                f'<w:pPr><w:ind w:left="{720 * (ilvl + 1)}" w:hanging="360"/></w:pPr>{fonts}</w:lvl>'
            )
        xml += "</w:abstractNum>"
        element = parse_xml(xml)
        first_num = self.root.find(W("w:num"))
        if first_num is not None:
            first_num.addprevious(element)
        else:
            self.root.append(element)
        return aid

    def new_num(self, abstract_id: int) -> int:
        nid = self.next_num
        self.next_num += 1
        self.root.append(
            parse_xml(
                f'<w:num {nsdecls("w")} w:numId="{nid}"><w:abstractNumId w:val="{abstract_id}"/>'
                '<w:lvlOverride w:ilvl="0"><w:startOverride w:val="1"/></w:lvlOverride></w:num>'
            )
        )
        return nid


@dataclass
class _Line:
    runs: list[tuple[str, bool]]
    kind: str | None = None  # None, "bullet", "number"
    level: int = 0
    group: int = 0


def _scope_lines(data: NoticeInput) -> list[_Line]:
    lines: list[_Line] = []
    source = _scope_paragraphs(data.scope_html)
    if not source and data.fallback_scope:
        source = _scope_paragraphs(data.fallback_scope)
    group = 0
    previous_kind = None
    previous_title = False
    for p in source:
        marker = p.marker
        if marker == "• ":
            kind = "bullet"
        elif marker.endswith(". ") and marker[:-2].isdigit():
            kind = "number"
        else:
            kind = None
        if kind is None or previous_kind is None:
            group += 1
            # Righe vuote tra paragrafi e prima/dopo un elenco, non dopo un titolo.
            if lines and not (kind and previous_kind) and not previous_title:
                lines.append(_Line([]))
        runs = [(text, bold or p.heading) for text, bold in p.runs]
        if kind is None and marker:
            runs.insert(0, (marker, False))
        lines.append(_Line(runs, kind, p.level if kind else 0, group))
        previous_kind = kind
        previous_title = kind is None and all(b for t, b in runs if t.strip())
    return lines


def _component_lines(data: NoticeInput) -> list[_Line]:
    by_pn: dict[str, list[NoticeComponent]] = {}
    for component in data.components:
        by_pn.setdefault(component.pn, []).append(component)
    lines = []
    for pn, components in by_pn.items():
        if pn:
            lines.append(_Line([(pn, True)], "bullet", 0, 1))
        for component in components:
            runs = [(component.name, False)] if component.name else []
            if component.code:
                runs.append(((" " if component.name else "") + component.code, True))
            lines.append(_Line(runs, "bullet", 1 if pn else 0, 1))
    return lines


def _note_lines(data: NoticeInput) -> list[_Line]:
    return [_Line([(line, False)]) for line in (data.note or "").strip().splitlines()]


def _build_paragraphs(template_p, lines: list[_Line], numbering: _Numbering) -> list:
    """Paragrafi generati con lo stile del paragrafo segnaposto (pPr e rPr del
    suo primo run), con elenchi dell'app."""
    base_ppr = template_p.find(W("w:pPr"))
    first_run = template_p.find(W("w:r"))
    base_rpr = first_run.find(W("w:rPr")) if first_run is not None else None
    numbers: dict[int, int] = {}
    out = []
    for line in lines:
        p = parse_xml(f"<w:p {nsdecls('w')}/>")
        ppr = copy.deepcopy(base_ppr) if base_ppr is not None else parse_xml(f"<w:pPr {nsdecls('w')}/>")
        for tag in ("w:numPr", "w:ind"):
            for el in ppr.findall(W(tag)):
                ppr.remove(el)
        if line.kind:
            if line.kind == "number":
                if line.group not in numbers:
                    numbers[line.group] = numbering.new_num(numbering.number_abstract)
                num_id = numbers[line.group]
            else:
                num_id = numbering.bullet
            num_pr = parse_xml(
                f'<w:numPr {nsdecls("w")}><w:ilvl w:val="{line.level}"/><w:numId w:val="{num_id}"/></w:numPr>'
            )
            style = ppr.find(W("w:pStyle"))
            if style is not None:
                style.addnext(num_pr)
            else:
                ppr.insert(0, num_pr)
        p.append(ppr)
        for text, bold in line.runs or [(" ", False)]:
            r = parse_xml(f"<w:r {nsdecls('w')}/>")
            rpr = copy.deepcopy(base_rpr) if base_rpr is not None else parse_xml(f"<w:rPr {nsdecls('w')}/>")
            for tag in ("w:b", "w:bCs"):
                for el in rpr.findall(W(tag)):
                    rpr.remove(el)
            if bold:
                _rpr_add(rpr, parse_xml(f'<w:b {nsdecls("w")}/>'))
                _rpr_add(rpr, parse_xml(f'<w:bCs {nsdecls("w")}/>'))
            r.append(rpr)
            t = parse_xml(f"<w:t {nsdecls('w')}/>")
            _set_text(t, text)
            r.append(t)
            p.append(r)
        out.append(p)
    return out


# --- Compilazione -------------------------------------------------------------


@dataclass
class _Filled:
    document: object
    subject_paragraphs: list  # paragrafi della sezione {{#oggetto}}


def _fill(data: NoticeInput) -> _Filled:
    document = Document(str(template_path()))
    part = document.part
    body = document.element.body
    numbering = _Numbering(document)
    values = {
        "increment": data.increment_code,
        "change_order": (data.change_order_label or "").strip(),
        "data": dt.date.today().strftime("%d/%m/%Y"),
    }
    links = {
        "link_change_order": (data.change_order_url or "").strip(),
        "link_matrix": (data.compatibility_matrix_url or "").strip(),
    }
    has_note = bool((data.note or "").strip())

    for p in body.iter(W("w:p")):
        _normalize_tokens(p)

    # 1. Sezioni {{#nome}} ... {{/nome}} (solo paragrafi del corpo).
    subject_paragraphs = []
    children = [c for c in body if c.tag in (W("w:p"), W("w:tbl"))]
    stack: list[str] = []
    for child in children:
        text = _paragraph_text(child).strip() if child.tag == W("w:p") else ""
        m = TOKEN_RE.fullmatch(text)
        if m and m.group(1) in ("#", "/") and m.group(2) in SECTIONS:
            if m.group(1) == "#":
                stack.append(m.group(2))
            elif stack and stack[-1] == m.group(2):
                stack.pop()
            body.remove(child)
            continue
        if "note" in stack and not has_note:
            body.remove(child)
        elif "oggetto" in stack:
            subject_paragraphs.append(child)

    # 2. Blocchi ({{scope}}, {{componenti}}, {{note}}) e paragrafi ripetuti per PN.
    for child in [c for c in body if c.tag == W("w:p")]:
        text = _paragraph_text(child).strip()
        m = TOKEN_RE.fullmatch(text)
        if m and not m.group(1) and m.group(2) in BLOCKS:
            lines = {"scope": _scope_lines, "componenti": _component_lines, "note": _note_lines}[m.group(2)](data)
            for new in _build_paragraphs(child, lines, numbering):
                child.addprevious(new)
            body.remove(child)
            continue
        names = {m.group(2) for m in TOKEN_RE.finditer(text) if not m.group(1)}
        if names & {"pn", "link_pn"}:
            for pn in _pns(data):
                clone = copy.deepcopy(child)
                child.addprevious(clone)
                _fill_inline(part, clone, {**values, "pn": pn}, {**links, "link_pn": (data.pn_links.get(pn) or "").strip()})
            body.remove(child)

    # 3. Segnaposto nel testo (anche in tabelle) e link.
    for p in list(body.iter(W("w:p"))):
        _fill_inline(part, p, values, links)
    return _Filled(document, subject_paragraphs)


def _fill_inline(part, p, values: dict[str, str], links: dict[str, str]) -> None:
    for _ in range(500):  # un segnaposto per giro (i link spezzano i run)
        found = None
        for t in _text_nodes(p):
            for m in TOKEN_RE.finditer(t.text or ""):
                if not m.group(1) and (m.group(2) in values or m.group(2) in links):
                    found = (t, m)
                    break
            if found:
                break
        if found is None:
            return
        t, m = found
        name, text = m.group(2), t.text or ""
        if name in values:
            _set_text(t, text[: m.start()] + values[name] + text[m.end() :])
            continue
        label = m.group(3) if m.group(3) is not None else "link"
        _set_text(t, text[: m.start()] + label + text[m.end() :])
        if links[name] and label:
            run = _split_run(t, m.start(), m.start() + len(label))
            if run.getparent().tag != W("w:hyperlink"):
                _make_link(part, run, links[name])


def _clean_subject(paragraphs) -> str:
    text = " ".join(_paragraph_text(p).strip() for p in paragraphs if _paragraph_text(p).strip())
    return SUBJECT_LABEL_RE.sub("", text.replace(" ", " ")).strip()


def subject(data: NoticeInput) -> str:
    filled = _fill(data)
    return _clean_subject(filled.subject_paragraphs) or f"Release Notice {data.increment_code}"


def generate_docx(data: NoticeInput) -> tuple[bytes, str]:
    filled = _fill(data)
    buffer = BytesIO()
    filled.document.save(buffer)
    return buffer.getvalue(), _clean_subject(filled.subject_paragraphs) or f"Release Notice {data.increment_code}"


# --- HTML per Outlook (dal .docx compilato) ----------------------------------


def _on(el) -> bool:
    return el is not None and el.get(W("w:val")) not in ("0", "false", "none")


def _run_style(rpr) -> str:
    if rpr is None:
        return ""
    style = []
    fonts = rpr.find(W("w:rFonts"))
    if fonts is not None and fonts.get(W("w:ascii")):
        style.append(f"font-family:'{fonts.get(W('w:ascii'))}',Calibri,Arial,sans-serif")
    size = rpr.find(W("w:sz"))
    if size is not None and size.get(W("w:val"), "").isdigit():
        style.append(f"font-size:{int(size.get(W('w:val'))) / 2:g}pt")
    if _on(rpr.find(W("w:b"))):
        style.append("font-weight:bold")
    if _on(rpr.find(W("w:i"))):
        style.append("font-style:italic")
    if _on(rpr.find(W("w:u"))):
        style.append("text-decoration:underline")
    color = rpr.find(W("w:color"))
    if color is not None and re.fullmatch(r"[0-9A-Fa-f]{6}", color.get(W("w:val"), "")):
        style.append(f"color:#{color.get(W('w:val'))}")
    highlight = rpr.find(W("w:highlight"))
    if highlight is not None and highlight.get(W("w:val")) not in (None, "none"):
        style.append(f"background-color:{highlight.get(W('w:val'))}")
    return ";".join(style)


def _runs_html(p, rels) -> tuple[str, str]:
    html, text = [], []

    def run_html(r, link: str | None = None) -> None:
        pieces = []
        for child in r:
            if child.tag == W("w:t"):
                pieces.append(escape(child.text or "", quote=False))
                text.append(child.text or "")
            elif child.tag == W("w:tab"):
                pieces.append("&emsp;")
                text.append("\t")
            elif child.tag in (W("w:br"), W("w:cr")):
                pieces.append("<br>")
                text.append("\n")
        if not pieces:
            return
        content = "".join(pieces)
        style = _run_style(r.find(W("w:rPr")))
        if style:
            content = f'<span style="{style}">{content}</span>'
        if link:
            content = f'<a href="{escape(link)}">{content}</a>'
            text.append(f" ({link})")
        html.append(content)

    for child in p:
        if child.tag == W("w:r"):
            run_html(child)
        elif child.tag == W("w:hyperlink"):
            rid = child.get(qn("r:id"))
            url = rels[rid].target_ref if rid in rels else None
            for r in child.findall(W("w:r")):
                run_html(r, url)
        elif child.tag in (W("w:ins"), W("w:smartTag"), W("w:customXml")):
            for r in child.iter(W("w:r")):
                run_html(r)
    return "".join(html), "".join(text)


def _list_info(p, numbering_root) -> tuple[str, int] | None:
    num_pr = p.find(W("w:pPr") + "/" + W("w:numPr")) if p.find(W("w:pPr")) is not None else None
    if num_pr is None:
        return None
    ilvl_el, num_el = num_pr.find(W("w:ilvl")), num_pr.find(W("w:numId"))
    if num_el is None or num_el.get(W("w:val")) == "0":
        return None
    level = int(ilvl_el.get(W("w:val"))) if ilvl_el is not None else 0
    fmt = "bullet"
    num = next((n for n in numbering_root.findall(W("w:num")) if n.get(W("w:numId")) == num_el.get(W("w:val"))), None)
    if num is not None:
        aid = num.find(W("w:abstractNumId")).get(W("w:val"))
        abstract = next(
            (a for a in numbering_root.findall(W("w:abstractNum")) if a.get(W("w:abstractNumId")) == aid), None
        )
        if abstract is not None:
            lvl = next((lv for lv in abstract.findall(W("w:lvl")) if lv.get(W("w:ilvl")) == str(level)), None)
            if lvl is not None and lvl.find(W("w:numFmt")) is not None:
                fmt = lvl.find(W("w:numFmt")).get(W("w:val"))
    if fmt == "bullet":
        return "ul", level
    return ("ol type=\"a\"" if fmt == "lowerLetter" else "ol type=\"i\"" if fmt == "lowerRoman" else "ol"), level


def generate_html(data: NoticeInput) -> tuple[str, str, str]:
    """(oggetto, html, testo semplice) del corpo della mail: la sezione
    {{#oggetto}} non c'e', diventa l'oggetto."""
    filled = _fill(data)
    document = filled.document
    subject_text = _clean_subject(filled.subject_paragraphs) or f"Release Notice {data.increment_code}"
    for p in filled.subject_paragraphs:
        if p.getparent() is not None:
            p.getparent().remove(p)
    rels = document.part.rels
    numbering_root = document.part.numbering_part.element
    body = document.element.body

    # Righe vuote in testa (dopo l'oggetto tolto) non servono nella mail.
    children = [c for c in body if c.tag in (W("w:p"), W("w:tbl"))]
    while children and children[0].tag == W("w:p") and not _paragraph_text(children[0]).strip("  \t"):
        children.pop(0)

    html: list[str] = []
    text_lines: list[str] = []
    stack: list[str] = []
    p_style = "margin:0"

    def close_to(depth: int) -> None:
        while len(stack) > depth:
            html.append(f"</li></{stack.pop().split(' ')[0]}>")

    for child in children:
        if child.tag == W("w:tbl"):
            close_to(0)
            rows = []
            for tr in child.iter(W("w:tr")):
                cells = []
                for tc in tr.findall(W("w:tc")):
                    cell = "".join(_runs_html(p, rels)[0] for p in tc.findall(W("w:p")))
                    cells.append(f'<td style="border:1px solid #999;padding:2px 6px">{cell}</td>')
                rows.append("<tr>" + "".join(cells) + "</tr>")
                text_lines.append(" | ".join(_paragraph_text(tc) for tc in tr.findall(W("w:tc"))))
            html.append('<table style="border-collapse:collapse">' + "".join(rows) + "</table>")
            continue
        content, text = _runs_html(child, rels)
        info = _list_info(child, numbering_root)
        if info is None:
            close_to(0)
            jc = child.find(W("w:pPr") + "/" + W("w:jc")) if child.find(W("w:pPr")) is not None else None
            align = f";text-align:{'center' if jc.get(W('w:val')) == 'center' else 'right' if jc.get(W('w:val')) in ('right', 'end') else 'left'}" if jc is not None else ""
            html.append(f'<p style="{p_style}{align}">{content if content.strip() else "&nbsp;"}</p>')
            text_lines.append(text.replace(" ", " ").rstrip())
            continue
        tag, level = info
        depth = level + 1
        if len(stack) >= depth and stack[depth - 1] != tag:
            close_to(depth - 1)
        if len(stack) >= depth:
            close_to(depth)
            html.append("</li>")
        while len(stack) < depth:
            html.append(f'<{tag} style="margin-top:0;margin-bottom:0">')
            stack.append(tag)
        html.append(f"<li>{content}")
        text_lines.append("    " * level + ("- " if tag == "ul" else "* ") + text)
    close_to(0)

    fonts = body.find(".//" + W("w:rFonts"))
    font = fonts.get(W("w:ascii")) if fonts is not None and fonts.get(W("w:ascii")) else "Calibri"
    wrapper = f"font-family:'{font}',Calibri,Arial,sans-serif;font-size:11pt"
    return subject_text, f'<div style="{wrapper}">' + "".join(html) + "</div>", "\n".join(text_lines).strip() + "\n"

