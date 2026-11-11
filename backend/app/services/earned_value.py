"""Earned Value dell'increment (PV / EV / AC, SPI / CPI, stima a finire).

Regole (stesse di frontend/src/lib/earnedValue.ts per la % in Backlog e Gantt):
- perimetro: i PBI del piano (in scope, code freeze o attivita' per Release),
  non archiviati, senza le milestone;
- budget di un PBI: stima dev + stima test; se mancano, Sizing (gg) x 8 h;
- % di completamento: Done = 100%; altrimenti ore loggate / budget, al
  massimo 95% finche' non e' Done;
- PV: il budget distribuito sui giorni lavorativi della baseline (se manca,
  le date aggiornate; per un PBI chiuso senza piano, le date effettive);
- EV = budget x % completamento; AC = ore loggate su Jira.

L'andamento nel tempo di EV e AC e' ricostruito: il valore di ogni PBI e'
distribuito in modo lineare tra Start eff. e Fine eff. (oggi se e' aperto).
"""

from __future__ import annotations

import datetime as dt
from dataclasses import dataclass, field

from app import models

HOURS_PER_DAY = 8.0
MAX_OPEN_COMPLETION = 0.95
MIN_EV_FOR_FORECAST = 0.10


def item_budget(item: models.BacklogItem) -> tuple[float | None, str | None]:
    estimate = (item.dev_estimate_hours or 0) + (item.test_estimate_hours or 0)
    if estimate > 0:
        return estimate, "stima"
    if item.planned_duration_days and item.planned_duration_days > 0:
        return item.planned_duration_days * HOURS_PER_DAY, "sizing"
    return None, None


def item_completion(item: models.BacklogItem, budget: float | None) -> float | None:
    if item.status == "Done":
        return 1.0
    if not budget:
        return None
    return min((item.logged_hours or 0) / budget, MAX_OPEN_COMPLETION)


def in_earned_value_scope(item: models.BacklogItem) -> bool:
    return item.archived_at is None and item.is_in_plan and not models.is_milestone(item.labels)


class _Calendar:
    def __init__(self, project: models.Project):
        self.off = [(r.start_date, r.end_date) for r in project.non_working_days]

    def working(self, day: dt.date) -> bool:
        return day.weekday() < 5 and not any(a <= day <= b for a, b in self.off)

    def working_days(self, first: dt.date, last: dt.date) -> list[dt.date]:
        days, day = [], first
        while day <= last:
            if self.working(day):
                days.append(day)
            day += dt.timedelta(days=1)
        return days


def _spread(target: dict[dt.date, float], cal: _Calendar, first: dt.date, last: dt.date, value: float) -> None:
    """Distribuisce value in parti uguali sui giorni lavorativi [first, last]
    (tutto su first se non ce ne sono)."""
    if value == 0:
        return
    if last < first:
        first, last = last, first
    days = cal.working_days(first, last) or [first]
    share = value / len(days)
    for day in days:
        target[day] = target.get(day, 0.0) + share


@dataclass
class EvItem:
    id: int
    jira_key: str
    summary: str | None
    issue_type: str | None
    status: str
    assignee: str | None
    budget: float | None
    budget_source: str | None
    completion: float | None
    pv: float
    ev: float
    ac: float
    plan_start: dt.date | None
    plan_finish: dt.date | None
    plan_source: str | None

    @property
    def sv(self) -> float:
        return self.ev - self.pv

    @property
    def cpi(self) -> float | None:
        return self.ev / self.ac if self.ac > 0 else None


@dataclass
class EvPoint:
    day: dt.date
    pv: float
    ev: float | None
    ac: float | None


@dataclass
class EarnedValue:
    today: dt.date
    has_baseline: bool
    bac: float
    pv: float
    ev: float
    ac: float
    spi: float | None
    cpi: float | None
    eac: float | None
    etc: float | None
    vac: float | None
    plan_start: dt.date | None
    plan_finish: dt.date | None
    earned_schedule: dt.date | None
    schedule_delay_days: float | None
    forecast_finish: dt.date | None
    items_without_budget: int
    items_without_plan: int
    done_without_hours: int
    unbudgeted_logged_hours: float
    items: list[EvItem] = field(default_factory=list)
    curve: list[EvPoint] = field(default_factory=list)

    @property
    def sv(self) -> float:
        return self.ev - self.pv

    @property
    def cv(self) -> float:
        return self.ev - self.ac


def _cumulate(daily: dict[dt.date, float], days: list[dt.date]) -> dict[dt.date, float]:
    """Valore cumulato a fine giornata per ognuno dei giorni (ordinati)."""
    ordered = sorted(daily.items())
    result, total, index = {}, 0.0, 0
    for day in days:
        while index < len(ordered) and ordered[index][0] <= day:
            total += ordered[index][1]
            index += 1
        result[day] = total
    return result


def compute_earned_value(project: models.Project, today: dt.date | None = None) -> EarnedValue:
    today = today or dt.date.today()
    cal = _Calendar(project)
    items = [i for i in project.all_backlog_items if in_earned_value_scope(i)]
    has_baseline = any(i.baseline_start is not None for i in items)

    pv_daily: dict[dt.date, float] = {}
    ev_daily: dict[dt.date, float] = {}
    ac_daily: dict[dt.date, float] = {}
    rows: list[EvItem] = []
    without_budget = without_plan = done_without_hours = 0
    unbudgeted_logged = 0.0
    item_pv_daily: list[tuple[EvItem, dict[dt.date, float]]] = []

    for item in sorted(items, key=lambda i: i.priority_order):
        budget, source = item_budget(item)
        completion = item_completion(item, budget)
        logged = item.logged_hours or 0.0
        if budget is None:
            without_budget += 1
            unbudgeted_logged += logged
        done = item.status == "Done"

        if item.baseline_start and item.baseline_finish:
            plan, plan_source = (item.baseline_start, item.baseline_finish), "baseline"
        elif item.planned_start and item.expected_finish:
            plan, plan_source = (item.planned_start, item.expected_finish), "aggiornata"
        elif done and (item.actual_start or item.actual_finish):
            plan = (item.actual_start or item.actual_finish, item.actual_finish or item.actual_start)
            plan_source = "effettiva"
        else:
            plan, plan_source = None, None

        ev = (budget or 0) * (completion or 0)
        ac = logged if budget is not None else 0.0
        row = EvItem(
            id=item.id,
            jira_key=item.jira_key,
            summary=item.summary,
            issue_type=item.issue_type,
            status=item.status,
            assignee=item.assignee,
            budget=budget,
            budget_source=source,
            completion=completion,
            pv=0.0,
            ev=ev,
            ac=ac,
            plan_start=plan[0] if plan else None,
            plan_finish=plan[1] if plan else None,
            plan_source=plan_source,
        )
        rows.append(row)
        if budget is None:
            continue
        if done and logged == 0:
            done_without_hours += 1

        if plan is None:
            without_plan += 1
        else:
            own: dict[dt.date, float] = {}
            _spread(own, cal, plan[0], plan[1], budget)
            item_pv_daily.append((row, own))
            for day, value in own.items():
                pv_daily[day] = pv_daily.get(day, 0.0) + value

        # Ricostruzione di EV e AC nel tempo: lineare tra l'inizio effettivo e
        # la fine effettiva (oggi, se aperto).
        end = item.actual_finish if done and item.actual_finish else today
        start = item.actual_start or end
        if start > today:
            start = today
        if end > today:
            end = today
        _spread(ev_daily, cal, start, end, ev)
        _spread(ac_daily, cal, start, end, ac)

    for row, own in item_pv_daily:
        row.pv = sum(v for d, v in own.items() if d <= today)

    bac = sum(r.budget or 0 for r in rows)
    pv = sum(r.pv for r in rows)
    ev = sum(r.ev for r in rows)
    ac = sum(r.ac for r in rows)
    spi = ev / pv if pv > 0 else None
    cpi = ev / ac if ac > 0 else None
    eac = bac / cpi if cpi else None
    etc = eac - ac if eac is not None else None
    vac = bac - eac if eac is not None else None

    # Curva: dall'inizio dell'increment (o del primo valore) alla fine del
    # piano (o a oggi), un punto a settimana piu' oggi e l'ultimo giorno.
    pv_days = sorted(pv_daily)
    plan_start = pv_days[0] if pv_days else None
    plan_finish = pv_days[-1] if pv_days else None
    candidates = [d for d in (project.start_date, plan_start, *ev_daily, *ac_daily) if d]
    curve: list[EvPoint] = []
    earned_schedule = delay = forecast = None
    if candidates:
        first = min(candidates)
        last = max(d for d in (plan_finish, today, project.code_freeze_date) if d)
        points = []
        day = first
        while day < last:
            points.append(day)
            day += dt.timedelta(days=7)
        points = sorted({*points, last, *([today] if first <= today <= last else [])})
        pv_cum = _cumulate(pv_daily, points)
        ev_cum = _cumulate(ev_daily, points)
        ac_cum = _cumulate(ac_daily, points)
        curve = [
            EvPoint(day=d, pv=pv_cum[d], ev=ev_cum[d] if d <= today else None, ac=ac_cum[d] if d <= today else None)
            for d in points
        ]

    # Earned Schedule: il giorno del piano in cui il PV era uguale all'EV di
    # oggi. Ritardo = giorni lavorativi tra quel giorno e oggi; la fine
    # prevista allunga la durata del piano dello stesso rapporto (SPI(t)).
    if plan_start and plan_finish and ev > 0:
        plan_days = cal.working_days(plan_start, plan_finish)
        cumulative, es_index = 0.0, None
        for index, day in enumerate(plan_days):
            before = cumulative
            cumulative += pv_daily.get(day, 0.0)
            if cumulative >= ev - 1e-9:
                today_part = pv_daily.get(day, 0.0)
                fraction = (ev - before) / today_part if today_part else 1.0
                es_index = index + fraction
                earned_schedule = day
                break
        if es_index is None:
            es_index = float(len(plan_days))
            earned_schedule = plan_finish
        elapsed = len(cal.working_days(plan_start, today))
        if elapsed > 0 and es_index > 0:
            delay = elapsed - es_index
        # Con meno del 10% del valore guadagnato la proiezione non e'
        # significativa (all'inizio SPI(t) basso porta a date assurde).
        if elapsed > 0 and es_index > 0 and ev >= MIN_EV_FOR_FORECAST * bac:
            # SPI(t) = tempo guadagnato / tempo trascorso: la durata totale
            # prevista e' quella del piano diviso SPI(t).
            total = round(len(plan_days) * elapsed / es_index)
            forecast, counted = plan_start, 1
            while counted < total:
                forecast += dt.timedelta(days=1)
                if cal.working(forecast):
                    counted += 1
            if ev < bac - 1e-9 and forecast < today:
                forecast = today
        elif elapsed <= 0:
            forecast = plan_finish

    return EarnedValue(
        today=today,
        has_baseline=has_baseline,
        bac=bac,
        pv=pv,
        ev=ev,
        ac=ac,
        spi=spi,
        cpi=cpi,
        eac=eac,
        etc=etc,
        vac=vac,
        plan_start=plan_start,
        plan_finish=plan_finish,
        earned_schedule=earned_schedule,
        schedule_delay_days=delay,
        forecast_finish=forecast,
        items_without_budget=without_budget,
        items_without_plan=without_plan,
        done_without_hours=done_without_hours,
        unbudgeted_logged_hours=unbudgeted_logged,
        items=rows,
        curve=curve,
    )
