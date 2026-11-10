"""Target del Change Order (parte Software dell'Execution) ricavati dai
componenti dell'increment (tab "Components & PN").

Ogni PN dell'increment e' un target: il suo numero va in Change Reason e la
griglia Data Collection ha
- una riga di BOM level 1 per il PN: Old Code = PN della stessa famiglia
  nell'ultima release precedente, New Code = PN dell'increment, Code
  Description fissa per famiglia (FAMILY_DESCRIPTIONS);
- una riga di BOM level 2 per ogni componente del PN: codici
  <SIGLA>_<fix version> (es. PSDA_6.0.0 -> PSDA_7.0.0), dove il vecchio e'
  quello dell'ultima release precedente che contiene lo stesso componente, e
  Code Description = nome del componente.

Gli altri campi del form (Load Type, Old Code Disposition, Backwards
Compatible, Specific Impact...) restano ai valori di default del portale:
se serve li corregge l'utente prima della Review.

Ordine dei target: prima la famiglia PTB-CLN se c'e', poi le altre
nell'ordine della tab Components & PN.
"""

from dataclasses import dataclass, field

from sqlalchemy.orm import Session

from app import models
from app.routers.increment_components import _order_key, _project_release, _release_rows, _split_pn

FAMILY_DESCRIPTIONS = {
    "PTB-CLN": "ProTube Phlebotomy Assistant SW",
    "PTB-SRV": "ProTube System Server components",
    "PTB-LCS": "ProTube Check-in Station",
}
FIRST_FAMILY = "PTB-CLN"


@dataclass
class DataCollectionRow:
    bom_level: int
    old_code: str | None
    new_code: str
    code_description: str | None


@dataclass
class ChangeOrderTarget:
    pn: str
    family: str | None
    # Change Reason del target: il PN nuovo.
    change_reason: str
    rows: list[DataCollectionRow] = field(default_factory=list)
    # Dati mancanti nell'app (sigla, fix version, release precedente...).
    warnings: list[str] = field(default_factory=list)


def _component_code(component: models.ReleaseComponent) -> str | None:
    abbreviation = (component.abbreviation or "").strip()
    version = (component.fix_version or "").strip()
    return f"{abbreviation}_{version}" if abbreviation and version else None


def build_targets(db: Session, project: models.Project) -> list[ChangeOrderTarget]:
    release = _project_release(db, project)
    if release is None:
        return []
    limit = _order_key(release)
    # Release precedenti, in ordine: per ogni famiglia e componente vince l'ultima.
    previous_pn: dict[str, str] = {}
    previous_component: dict[str, models.ReleaseComponent] = {}
    for other, component in _release_rows(db, project.owner_id):
        if _order_key(other) >= limit:
            continue
        parts = _split_pn(component.pn)
        if parts:
            previous_pn[parts[0]] = component.pn.strip()
        if component.component:
            previous_component[component.component.strip().lower()] = component

    targets: dict[str, ChangeOrderTarget] = {}
    for component in release.components:
        pn = (component.pn or "").strip()
        if not pn:
            continue
        target = targets.get(pn)
        if target is None:
            parts = _split_pn(pn)
            family = parts[0] if parts else None
            target = ChangeOrderTarget(pn=pn, family=family, change_reason=pn)
            description = FAMILY_DESCRIPTIONS.get(family or "")
            old_pn = previous_pn.get(family) if family else None
            if description is None:
                target.warnings.append(f"Code Description non nota per la famiglia {family or pn}")
            if old_pn is None:
                target.warnings.append(f"Nessun PN precedente per {family or pn}")
            target.rows.append(DataCollectionRow(1, old_pn, pn, description))
            targets[pn] = target
        name = (component.component or "").strip()
        new_code = _component_code(component)
        if new_code is None:
            target.warnings.append(f"{name}: manca la sigla o la fix version")
            continue
        old = previous_component.get(name.lower())
        old_code = _component_code(old) if old is not None else None
        if old_code is None:
            target.warnings.append(f"{name}: nessuna versione precedente (componente nuovo?)")
        target.rows.append(DataCollectionRow(2, old_code, new_code, name))

    ordered = list(targets.values())
    ordered.sort(key=lambda t: 0 if t.family == FIRST_FAMILY else 1)  # sort stabile
    return ordered
