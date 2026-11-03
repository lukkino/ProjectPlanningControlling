"""Budget di un progetto (UI "Progetto" = models.Increment), come nel file
di budget aziendale (templates/budget_template.xlsx):

- budget iniziale ("First budget at budget freezing"):
  - ore: Dettaglio budget ore progetto, alimentato da "Aggiorna ore
    progetto" del Calcolatore: una riga per tipologia di risorsa e societa'
    (SpA/SA/TPM), con il reparto DEV;
  - materiali: Dettaglio materiali progetto, alimentato da "Aggiorna
    materiali progetto" del Budget materiali: righe per categoria e sezione,
    costo unitario x unita' per modulo x numero di moduli;
- "Congela budget" blocca il budget iniziale: da li' in poi cambia solo con
  le review;
- review di budget (fino a 3 nel file): ognuna aggiunge righe di extra, ore
  per reparto e societa' o costi per categoria, anche negativi. Il budget
  che vale e' cumulativo: iniziale + tutte le review.

Il budget che vale va negli snapshot del Consumo risorse progetto (in sola
lettura li'): ore sulla prima voce in ore, materiali sulla voce di spesa
della stessa categoria (creata se manca). Ogni volta che cambia si aggiorna
l'ultimo snapshot; uno snapshot nuovo nasce con questi valori. Finche' una
delle due parti non e' mai stata compilata (progetti con il budget scritto
a mano negli snapshot), quella parte resta com'era."""

from app import models

COMPANIES = ["SpA", "SA", "TPM"]

# Reparti del foglio Hours del template, nell'ordine del foglio.
DEPARTMENTS: list[tuple[str, str]] = [
    ("DEV010", "Conceptual Design"),
    ("DEV160", "Bio Application Engineering"),
    ("DEV020", "Mechanical Design"),
    ("DEV040", "Electrical & Electronic Design"),
    ("DEV030", "HW Prototyping"),
    ("DEV050", "Module Control SW"),
    ("DEV060", "SW Design"),
    ("DEV180", "Simulation Activities"),
    ("DEV171", "Testing HW"),
    ("DEV172", "Testing FW & SW"),
    ("DEV175", "Testing System"),
    ("DEV100", "Test Track Maintenance and Support"),
    ("DEV131", "Cost & Value Engineering"),
    ("DEV130", "Technical Documentation & Manuals"),
    ("DEV132", "Spare Parts Engineering"),
    ("DEV210", "Certification and Directives Compliance"),
    ("DEV110", "Project Management"),
]
DEPARTMENT_CODES = {code for code, _ in DEPARTMENTS}

# Reparto proposto per le tipologie di risorsa di default del Calcolatore.
DEFAULT_DEPARTMENTS = {
    "project management": "DEV110",
    "develop": "DEV060",
    "testing": "DEV172",
    "system testing": "DEV175",
}

# Categorie del foglio Materials and Expenses; le prime quattro hanno le
# sezioni, Consultancies e Travel Expenses no.
MATERIAL_CATEGORIES = [
    "Feasibility",
    "Prototype",
    "Pre Serie",
    "Production Testing Tool",
    "Consultancies",
    "Travel Expenses",
]
MATERIAL_SECTIONS = ["Mechanical", "Electrical", "Cover", "Contingency"]
CATEGORIES_WITHOUT_SECTIONS = {"Consultancies", "Travel Expenses"}

# Nomi gia' usati nelle voci di spesa dello Storico per la stessa categoria.
_LINE_ALIASES = {
    "Pre Serie": {"pre serie", "preserie", "pre-serie"},
    "Travel Expenses": {"travel expenses", "travels", "travel"},
    "Consultancies": {"consultancies", "consultancy"},
    "Production Testing Tool": {"production testing tool", "production testing tools"},
}


def default_department(resource_type_name: str) -> str | None:
    return DEFAULT_DEPARTMENTS.get(resource_type_name.strip().lower())


def material_amount(item) -> float:
    """Costo di una riga materiali: costo unitario x unita' per modulo x
    numero di moduli (Consultancies e Travel Expenses: solo l'importo,
    unita' e moduli a 1)."""
    return (item.unit_cost or 0) * (item.units or 0) * (item.modules or 0)


def hours_budget(increment: models.Increment) -> float:
    """Budget ore che vale: iniziale (Dettaglio budget ore) + review."""
    initial = sum(row.hours for row in increment.hours_detail_rows)
    extra = sum(item.spa + item.sa + item.tpm for review in increment.budget_reviews for item in review.hours_items)
    return initial + extra


def material_budget_by_category(increment: models.Increment) -> dict[str, float]:
    """Budget materiali che vale, per categoria: iniziale (Dettaglio
    materiali) + review."""
    totals = {category: 0.0 for category in MATERIAL_CATEGORIES}
    for row in increment.material_budget_rows:
        totals[row.category] = totals.get(row.category, 0) + material_amount(row)
    for review in increment.budget_reviews:
        for item in review.material_items:
            totals[item.category] = totals.get(item.category, 0) + material_amount(item)
    return totals


def has_hours_budget(increment: models.Increment) -> bool:
    return bool(increment.hours_detail_rows) or any(r.hours_items for r in increment.budget_reviews)


def has_material_budget(increment: models.Increment) -> bool:
    return bool(increment.material_budget_rows) or any(r.material_items for r in increment.budget_reviews)


def _line_for_category(increment: models.Increment, category: str) -> models.IncrementBudgetLine | None:
    names = {category.lower()} | _LINE_ALIASES.get(category, set())
    return next(
        (line for line in increment.budget_lines if not line.is_hours and line.category_name.strip().lower() in names),
        None,
    )


def frozen_budget(increment: models.Increment) -> dict[int, float]:
    """Budget per voce dello Storico (id voce -> valore), solo per le parti
    compilate. Le categorie con un importo ma senza voce di spesa nello
    Storico la ottengono (in fondo); servono allora un flush e un nuovo
    snapshot dei valori, fatti da apply_to_snapshot."""
    budget: dict[int, float] = {}
    hours_lines = [line for line in increment.budget_lines if line.is_hours]
    if hours_lines and has_hours_budget(increment):
        budget[hours_lines[0].id] = hours_budget(increment)
    if has_material_budget(increment):
        by_category = material_budget_by_category(increment)
        matched: set[int] = set()
        for category, amount in by_category.items():
            line = _line_for_category(increment, category)
            if line is None:
                continue
            budget[line.id] = budget.get(line.id, 0) + amount
            matched.add(line.id)
        # Le voci di spesa che non corrispondono a nessuna categoria (es.
        # rinominate a mano) vanno a 0: il budget materiali e' tutto qui.
        for line in increment.budget_lines:
            if not line.is_hours and line.id not in matched:
                budget[line.id] = 0
    return budget


def ensure_category_lines(increment: models.Increment) -> bool:
    """Crea nello Storico le voci di spesa delle categorie che hanno un
    importo e non ce l'hanno ancora. True se ne ha create."""
    if not has_material_budget(increment):
        return False
    created = False
    last = max((line.order for line in increment.budget_lines), default=0)
    for category, amount in material_budget_by_category(increment).items():
        if amount and _line_for_category(increment, category) is None:
            last += 1
            increment.budget_lines.append(models.IncrementBudgetLine(category_name=category, is_hours=False, order=last))
            created = True
    return created


def apply_to_snapshot(increment: models.Increment, snapshot: models.IncrementSnapshot) -> None:
    budget = frozen_budget(increment)
    existing = {value.budget_line_id for value in snapshot.values}
    for value in snapshot.values:
        if value.budget_line_id in budget:
            value.budget_value = budget[value.budget_line_id]
    # Voci nate dopo lo snapshot (es. una categoria nuova): il loro valore.
    for line in increment.budget_lines:
        if line.id is not None and line.id not in existing and line.id in budget:
            snapshot.values.append(
                models.IncrementSnapshotValue(budget_line_id=line.id, budget_value=budget[line.id], actual_value=0)
            )


def sync_latest_snapshot(db, increment: models.Increment) -> None:
    """Riporta il budget che vale nell'ultimo snapshot (se ce n'e' uno),
    creando prima le voci di spesa mancanti."""
    if ensure_category_lines(increment):
        db.flush()
    if increment.snapshots:
        latest = max(increment.snapshots, key=lambda s: (s.snapshot_date, s.id))
        apply_to_snapshot(increment, latest)
