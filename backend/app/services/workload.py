"""Carico per assegnatario: le ore che restano sugli item aperti di tutti gli
increment, distribuite sulle settimane in cui sono pianificati.

Regole:
- item: quelli del piano (stesso perimetro dell'Earned Value: in scope, code
  freeze o attivita' per Release, non archiviati, senza milestone), non Done;
- ore rimanenti: budget x (1 - % completamento), con budget e % dell'Earned
  Value (stima dev + test, se manca Sizing x 8 h; ore loggate / budget, al
  massimo 95% finche' non e' Done);
- distribuite in modo uniforme sui giorni lavorativi tra Start pian. (o oggi,
  se e' gia' passato) e Fine pian.; un item con Fine pian. gia' passata e'
  scaduto: le sue ore non vanno sulle settimane (andrebbero tutte su oggi)
  ma nel totale "scadute", finche' non viene ripianificato;
- capacita': giorni lavorativi della settimana (da oggi per la settimana in
  corso); un giorno e' libero per la persona se e' non lavorativo in tutti
  gli increment su cui ha item.
"""

from __future__ import annotations

import datetime as dt
from collections import defaultdict
from dataclasses import dataclass, field

from app import models
from app.services.earned_value import in_earned_value_scope, item_budget, item_completion

UNASSIGNED = "Non assegnato"


@dataclass
class WorkloadItem:
    project_id: int
    project_name: str
    project_code: str
    jira_key: str
    summary: str | None
    status: str
    start: dt.date | None
    finish: dt.date | None
    remaining_hours: float | None
    budget_source: str | None
    overdue: bool
    weeks: list[float]
    beyond_hours: float


@dataclass
class WorkloadAssignee:
    name: str
    weeks: list[float]
    capacity_days: list[int]
    beyond_hours: float
    remaining_hours: float
    overdue_hours: float
    overdue_items: int
    undated_items: int
    unbudgeted_items: int
    items: list[WorkloadItem] = field(default_factory=list)


@dataclass
class Workload:
    today: dt.date
    week_starts: list[dt.date]
    projects: list[tuple[int, str]]
    assignees: list[WorkloadAssignee]


def _is_off(day: dt.date, off: list[tuple[dt.date, dt.date]]) -> bool:
    return any(a <= day <= b for a, b in off)


def _working(day: dt.date, off: list[tuple[dt.date, dt.date]]) -> bool:
    return day.weekday() < 5 and not _is_off(day, off)


def compute_workload(projects: list[models.Project], weeks: int = 12, today: dt.date | None = None) -> Workload:
    today = today or dt.date.today()
    first_monday = today - dt.timedelta(days=today.weekday())
    week_starts = [first_monday + dt.timedelta(weeks=i) for i in range(weeks)]
    horizon_end = week_starts[-1] + dt.timedelta(days=6)

    def week_index(day: dt.date) -> int | None:
        index = (day - first_monday).days // 7
        return index if index < weeks else None

    calendars = {
        p.id: [(r.start_date, r.end_date) for r in p.non_working_days] for p in projects
    }
    by_assignee: dict[str, list[WorkloadItem]] = defaultdict(list)
    projects_of: dict[str, set[int]] = defaultdict(set)

    for project in projects:
        off = calendars[project.id]
        for item in project.backlog_items:
            if not in_earned_value_scope(item) or item.status == "Done":
                continue
            name = (item.assignee or "").strip() or UNASSIGNED
            projects_of[name].add(project.id)
            budget, source = item_budget(item)
            completion = item_completion(item, budget)
            remaining = budget * (1 - (completion or 0)) if budget else None
            start, finish = item.planned_start, item.expected_finish
            overdue = finish is not None and finish < today
            hours = [0.0] * weeks
            beyond = 0.0
            if remaining and finish is not None and not overdue:
                first = max(start or today, today)
                if first > finish:
                    first = finish
                days = []
                day = first
                while day <= finish:
                    if _working(day, off):
                        days.append(day)
                    day += dt.timedelta(days=1)
                days = days or [finish]
                per_day = remaining / len(days)
                for day in days:
                    index = week_index(day)
                    if index is None:
                        beyond += per_day
                    else:
                        hours[index] += per_day
            by_assignee[name].append(
                WorkloadItem(
                    project_id=project.id,
                    project_name=project.name,
                    project_code=project.code,
                    jira_key=item.jira_key,
                    summary=item.summary,
                    status=item.status,
                    start=start,
                    finish=finish,
                    remaining_hours=remaining,
                    budget_source=source,
                    overdue=overdue,
                    weeks=hours,
                    beyond_hours=beyond,
                )
            )

    assignees = []
    for name, items in by_assignee.items():
        own_off = [calendars[pid] for pid in projects_of[name]]
        capacity = []
        for start in week_starts:
            count = 0
            for offset in range(5):
                day = start + dt.timedelta(days=offset)
                if day < today or day > horizon_end:
                    continue
                if own_off and all(_is_off(day, off) for off in own_off):
                    continue
                count += 1
            capacity.append(count)
        items.sort(key=lambda i: (not i.overdue, i.finish or dt.date.max, i.jira_key))
        assignees.append(
            WorkloadAssignee(
                name=name,
                weeks=[sum(i.weeks[w] for i in items) for w in range(weeks)],
                capacity_days=capacity,
                beyond_hours=sum(i.beyond_hours for i in items),
                remaining_hours=sum(i.remaining_hours or 0 for i in items),
                overdue_hours=sum(i.remaining_hours or 0 for i in items if i.overdue),
                overdue_items=sum(1 for i in items if i.overdue),
                undated_items=sum(1 for i in items if i.finish is None),
                unbudgeted_items=sum(1 for i in items if i.remaining_hours is None),
                items=items,
            )
        )
    assignees.sort(key=lambda a: (a.name == UNASSIGNED, -a.remaining_hours, a.name.lower()))
    return Workload(
        today=today,
        week_starts=week_starts,
        projects=[(p.id, p.name) for p in projects],
        assignees=assignees,
    )
