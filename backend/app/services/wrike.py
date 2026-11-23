"""Ore registrate (Time spent) di un progetto su Wrike, per gli snapshot del
Consumo risorse progetto.

Sola lettura con l'API v4 di Wrike e il token permanente dell'utente
(WRIKE_TOKEN nel backend/.env, mai nel DB ne' nel codice).

Le ore si ripartiscono nelle voci del progetto (models.DEFAULT_RESOURCE_TYPES)
in base al titolo dell'attivita' Wrike o della sua attivita' madre:
- "Project Management" -> Project Management
- "System Test..."     -> System Testing
- "SW Test..."         -> Testing (con le sotto-attivita')
- tutto il resto       -> Develop

Le ore si contano per data di inserimento (createdDate), non per giorno del
lavoro (trackedDate): quasi tutte vengono rendicontate giorni o settimane
dopo. Cosi' uno snapshot vale quello che Wrike mostrava quel giorno e le
ore per persona di un periodo sono quelle rendicontate tra due snapshot
(la loro somma e' la differenza dallo snapshot precedente).
"""

import datetime as dt
import re
import urllib.parse
from collections import defaultdict

import httpx

from app.config import get_settings

DEFAULT_HOST = "app-eu.wrike.com"

PROJECT_MANAGEMENT = "Project Management"
DEVELOP = "Develop"
TESTING = "Testing"
SYSTEM_TESTING = "System Testing"
CATEGORIES = [PROJECT_MANAGEMENT, DEVELOP, TESTING, SYSTEM_TESTING]

_RULES = [
    (re.compile(r"project\s+management", re.I), PROJECT_MANAGEMENT),
    (re.compile(r"\bsystem\s+test", re.I), SYSTEM_TESTING),
    (re.compile(r"\bsw\s+test", re.I), TESTING),
]


class WrikeError(Exception):
    pass


def parse_folder_url(url: str) -> tuple[str, str]:
    """(host, id cartella "v2") dal link della cartella/progetto copiato dal
    browser, es. https://app-eu.wrike.com/workspace.htm?acc=...#/folder/4561663327/..."""
    text = (url or "").strip()
    match = re.search(r"/folder/(\d+)", text) or re.search(r"[?&#]id=(\d+)", text)
    if not match:
        raise WrikeError("Nel link non trovo la cartella Wrike (…#/folder/<numero>/…): copia il link dal browser")
    host = urllib.parse.urlsplit(text).netloc or DEFAULT_HOST
    return host, match.group(1)


def _created(log: dict) -> str:
    """Giorno di inserimento della registrazione (YYYY-MM-DD)."""
    return (log.get("createdDate") or log.get("trackedDate") or "")[:10]


def _category(title: str) -> str | None:
    for pattern, category in _RULES:
        if pattern.search(title or ""):
            return category
    return None


class _Client:
    def __init__(self, host: str):
        token = get_settings().wrike_token.strip()
        if not token:
            raise WrikeError("Token Wrike mancante: aggiungi WRIKE_TOKEN nel file backend/.env e riavvia il backend")
        self.base = f"https://{host}/api/v4"
        self.http = httpx.Client(headers={"Authorization": f"bearer {token}"}, timeout=60)

    def get(self, path: str, **params) -> list[dict]:
        response = self.http.get(self.base + path, params=params)
        if response.status_code == 401:
            raise WrikeError("Wrike ha rifiutato il token (scaduto o revocato): rigeneralo e aggiorna WRIKE_TOKEN")
        if response.status_code == 403:
            raise WrikeError("Il token Wrike non ha accesso a questa cartella")
        if response.status_code == 404:
            raise WrikeError("Cartella Wrike non trovata: controlla il link")
        if response.status_code != 200:
            raise WrikeError(f"Wrike ha risposto {response.status_code}: {response.text[:200]}")
        return response.json().get("data", [])

    def close(self) -> None:
        self.http.close()


def read_hours(url: str, until: dt.date, since: dt.date | None) -> dict:
    """Ore inserite sulla cartella (e sottocartelle/attivita') fino a
    `until` compreso, per voce; e, per voce, le ore per persona inserite
    dopo `since` (escluso) fino a `until` - il periodo tra due snapshot.

    {"categories": {voce: ore cumulative}, "people": {voce: [{name, hours}]},
     "last_created": giorno dell'ultima registrazione, "title": cartella}"""
    host, v2_id = parse_folder_url(url)
    client = _Client(host)
    try:
        ids = client.get("/ids", ids=f"[{v2_id}]", type="ApiV2Folder")
        if not ids:
            raise WrikeError("Cartella Wrike non trovata: controlla il link")
        folder_id = ids[0]["id"]
        folder = client.get(f"/folders/{folder_id}")
        title = folder[0].get("title") if folder else None
        logs = [
            log
            for log in client.get(f"/folders/{folder_id}/timelogs", descendants="true", plainText="true")
            if _created(log) <= until.isoformat()
        ]

        # Voce di ogni attivita': la sua regola o quella della madre piu'
        # vicina (es. "Validation protocol" sotto "SW Test" -> Testing).
        tasks: dict[str, dict] = {}
        pending = {log["taskId"] for log in logs}
        while pending:
            batch = sorted(pending - set(tasks))[:100]
            if not batch:
                break
            for task in client.get("/tasks/" + ",".join(batch)):
                tasks[task["id"]] = task
            pending = {s for t in tasks.values() for s in t.get("superTaskIds", [])} - set(tasks)

        def category_of(task_id: str, seen: frozenset = frozenset()) -> str:
            task = tasks.get(task_id)
            if not task or task_id in seen:
                return DEVELOP
            direct = _category(task.get("title", ""))
            if direct:
                return direct
            for parent in task.get("superTaskIds", []):
                inherited = category_of(parent, seen | {task_id})
                if inherited != DEVELOP:
                    return inherited
            return DEVELOP

        totals = {c: 0.0 for c in CATEGORIES}
        period: dict[str, dict[str, float]] = defaultdict(lambda: defaultdict(float))
        task_hours: dict[str, float] = defaultdict(float)
        for log in logs:
            task_hours[log["taskId"]] += log["hours"]
            category = category_of(log["taskId"])
            totals[category] += log["hours"]
            if since is None or _created(log) > since.isoformat():
                period[category][log["userId"]] += log["hours"]

        user_ids = sorted({u for people in period.values() for u in people})
        names: dict[str, str] = {}
        for i in range(0, len(user_ids), 100):
            for user in client.get("/contacts/" + ",".join(user_ids[i:i + 100])):
                names[user["id"]] = f"{user.get('firstName', '')} {user.get('lastName', '')}".strip() or user["id"]
    finally:
        client.close()

    total = round(sum(totals.values()), 2)
    # Struttura riconosciuta = almeno un'attivita' (o sua madre) con titolo
    # Project Management / SW Test / System Test. Se no tutto finirebbe in
    # Develop: meglio chiedere se basta il totale.
    recognized = total == 0 or any(totals[c] > 0 for c in CATEGORIES if c != DEVELOP)
    top_tasks = [
        {"title": tasks.get(t, {}).get("title") or t, "hours": round(h, 2)}
        for t, h in sorted(task_hours.items(), key=lambda kv: -kv[1])[:8]
    ]
    return {
        "title": title,
        "total": total,
        "recognized": recognized,
        "top_tasks": top_tasks,
        "categories": {c: round(h, 2) for c, h in totals.items()},
        "people": {
            category: sorted(
                ({"name": names.get(u, u), "hours": round(h, 2)} for u, h in people.items()),
                key=lambda p: (-p["hours"], p["name"]),
            )
            for category, people in period.items()
        },
        "last_created": max((_created(log) for log in logs), default=None),
    }
