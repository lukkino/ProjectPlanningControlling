import datetime as dt

from sqlalchemy import Boolean, Date, DateTime, Float, ForeignKey, Integer, String, Text
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.database import Base


def _utcnow() -> dt.datetime:
    return dt.datetime.utcnow()


class Increment(Base):
    """Un progetto (es. "PTIH-PT13"), con budget (ore per ruolo + materiali)
    e durata: modello UI "Progetto". Appartiene al massimo a un Project (il
    rilascio/"Increment" in UI): piu' Increment (Progetto) possono
    condividere lo stesso Project (rilascio) quando le ore di quel rilascio
    vanno rendicontate su piu' progetti diversi (es. un progetto
    "principale" + uno di maintenance)."""

    __tablename__ = "increments"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    code: Mapped[str] = mapped_column(String(64), index=True)
    notes: Mapped[str | None] = mapped_column(Text, nullable=True)
    start_date: Mapped[dt.date | None] = mapped_column(Date, nullable=True)
    end_date: Mapped[dt.date | None] = mapped_column(Date, nullable=True)
    estimated_budget_hours: Mapped[float] = mapped_column(Float, default=0)
    estimated_budget_material: Mapped[float] = mapped_column(Float, default=0)
    # Project (rilascio/"Increment" in UI) su cui questo progetto rendiconta
    # le ore, se assegnato: un progetto appartiene al massimo a un Project.
    project_id: Mapped[int | None] = mapped_column(ForeignKey("projects.id", ondelete="SET NULL"), nullable=True)
    created_at: Mapped[dt.datetime] = mapped_column(DateTime, default=_utcnow)
    updated_at: Mapped[dt.datetime] = mapped_column(DateTime, default=_utcnow, onupdate=_utcnow)

    project: Mapped["Project | None"] = relationship(back_populates="progetti")
    budget_lines: Mapped[list["IncrementBudgetLine"]] = relationship(
        back_populates="increment", cascade="all, delete-orphan", order_by="IncrementBudgetLine.order"
    )
    snapshots: Mapped[list["IncrementSnapshot"]] = relationship(
        back_populates="increment", cascade="all, delete-orphan", order_by="IncrementSnapshot.snapshot_date"
    )


class Project(Base):
    """Un rilascio (es. "PTBSYS-03-004"), sincronizzato da Jira via una fix
    version: modello UI "Increment". Puo' avere piu' Increment (Progetto)
    collegati (vedi Increment.project_id) quando le sue ore vanno
    rendicontate su progetti diversi."""

    __tablename__ = "projects"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    code: Mapped[str] = mapped_column(String(64), index=True)
    name: Mapped[str] = mapped_column(String(255))
    status: Mapped[str] = mapped_column(String(64), default="Kick-off")
    scope: Mapped[str | None] = mapped_column(Text, nullable=True)
    start_date: Mapped[dt.date | None] = mapped_column(Date, nullable=True)
    code_freeze_date: Mapped[dt.date | None] = mapped_column(Date, nullable=True)
    # Data di fine pianificata del progetto (rilascio finale/Release to
    # Market), distinta dal code freeze: usata anche nella Dashboard
    # progetti per il Gantt.
    planned_finish_date: Mapped[dt.date | None] = mapped_column(Date, nullable=True)
    # Inizio reale degli sviluppi (puo' differire da start_date, che spesso e'
    # solo l'avvio formale del progetto): usato in Forecasting per contare
    # solo i PBI Done da quella data in poi quando si crea una nuova
    # simulazione.
    dev_start_date: Mapped[dt.date | None] = mapped_column(Date, nullable=True)
    jira_jql: Mapped[str | None] = mapped_column(Text, nullable=True)
    # Link al Change Order (sezione Documents), globale per il progetto, con
    # testo alternativo opzionale da mostrare al posto dell'URL.
    change_order_url: Mapped[str | None] = mapped_column(Text, nullable=True)
    change_order_label: Mapped[str | None] = mapped_column(Text, nullable=True)
    # Ultima versione e ultimo testo di revisione usati per generare il
    # Release Report da questa app: propongono i valori di default (versione
    # incrementata, testo da modificare) alla generazione successiva. None
    # finche' il progetto non ha mai generato un Release Report da qui.
    rr_last_version: Mapped[int | None] = mapped_column(Integer, nullable=True)
    rr_last_revision_note: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_at: Mapped[dt.datetime] = mapped_column(DateTime, default=_utcnow)
    updated_at: Mapped[dt.datetime] = mapped_column(DateTime, default=_utcnow, onupdate=_utcnow)

    phases: Mapped[list["Phase"]] = relationship(back_populates="project", cascade="all, delete-orphan", order_by="Phase.order")
    backlog_items: Mapped[list["BacklogItem"]] = relationship(back_populates="project", cascade="all, delete-orphan", order_by="BacklogItem.priority_order")
    snapshots: Mapped[list["Snapshot"]] = relationship(back_populates="project", cascade="all, delete-orphan", order_by="Snapshot.snapshot_date")
    forecast_simulations: Mapped[list["ForecastSimulation"]] = relationship(
        back_populates="project", cascade="all, delete-orphan", order_by="ForecastSimulation.id"
    )
    progetti: Mapped[list["Increment"]] = relationship(back_populates="project", order_by="Increment.code")


class Phase(Base):
    __tablename__ = "phases"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    project_id: Mapped[int] = mapped_column(ForeignKey("projects.id", ondelete="CASCADE"))
    name: Mapped[str] = mapped_column(String(64))
    planned_date: Mapped[dt.date | None] = mapped_column(Date, nullable=True)
    actual_date: Mapped[dt.date | None] = mapped_column(Date, nullable=True)
    order: Mapped[int] = mapped_column(Integer, default=0)
    notes: Mapped[str | None] = mapped_column(Text, nullable=True)

    project: Mapped["Project"] = relationship(back_populates="phases")


class IncrementBudgetLine(Base):
    """Una voce di budget del progetto (es. "Hours", "Prototype",
    "Travels"): solo il target di budget, mai un valore inserito nel tempo -
    quello vive nell'Andamento (vedi IncrementSnapshotValue), una voce per
    ogni IncrementSnapshot di questo Increment."""

    __tablename__ = "increment_budget_lines"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    increment_id: Mapped[int] = mapped_column(ForeignKey("increments.id", ondelete="CASCADE"))
    category_name: Mapped[str] = mapped_column(String(128))
    budget_value: Mapped[float] = mapped_column(Float, default=0)
    # Distingue le voci in ore (sommate in "Budget ore"/"Ore usate" del
    # Totale progetto) da quelle in altra unita', tipicamente euro (sommate
    # in "Budget materiali"): puramente per i totali aggregati, l'utente
    # sceglie liberamente per ogni voce che aggiunge.
    is_hours: Mapped[bool] = mapped_column(Boolean, default=False)
    order: Mapped[int] = mapped_column(Integer, default=0)

    increment: Mapped["Increment"] = relationship(back_populates="budget_lines")


class IncrementSnapshot(Base):
    """Andamento del progetto: una fotografia periodica dei valori Actual
    (cumulativi ad oggi, non del solo periodo) per ogni voce di budget -
    stesso concetto dello Snapshot dell'Increment, applicato alle voci di
    budget invece che a PBI/ore Jira."""

    __tablename__ = "increment_snapshots"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    increment_id: Mapped[int] = mapped_column(ForeignKey("increments.id", ondelete="CASCADE"))
    snapshot_date: Mapped[dt.date] = mapped_column(Date)
    note: Mapped[str | None] = mapped_column(Text, nullable=True)

    increment: Mapped["Increment"] = relationship(back_populates="snapshots")
    values: Mapped[list["IncrementSnapshotValue"]] = relationship(
        back_populates="snapshot", cascade="all, delete-orphan"
    )


class IncrementSnapshotValue(Base):
    __tablename__ = "increment_snapshot_values"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    snapshot_id: Mapped[int] = mapped_column(ForeignKey("increment_snapshots.id", ondelete="CASCADE"))
    budget_line_id: Mapped[int] = mapped_column(ForeignKey("increment_budget_lines.id", ondelete="CASCADE"))
    actual_value: Mapped[float] = mapped_column(Float, default=0)

    snapshot: Mapped["IncrementSnapshot"] = relationship(back_populates="values")
    budget_line: Mapped["IncrementBudgetLine"] = relationship()


class BacklogItem(Base):
    __tablename__ = "backlog_items"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    project_id: Mapped[int] = mapped_column(ForeignKey("projects.id", ondelete="CASCADE"))

    jira_key: Mapped[str] = mapped_column(String(64), index=True)
    # Float (non int) per permettere di inserire una riga "a meta'" tra due
    # esistenti via drag&drop, senza dover rinumerare tutto il backlog.
    priority_order: Mapped[float] = mapped_column(Float, default=0)

    # Campi sincronizzati da Jira (sovrascritti a ogni /sync)
    summary: Mapped[str | None] = mapped_column(Text, nullable=True)
    # Description completa (convertita da ADF a testo semplice), usata per
    # esempio nella colonna "Change Description" dei documenti generati.
    description: Mapped[str | None] = mapped_column(Text, nullable=True)
    # Campo custom Jira "Change Description": per i Bug sostituisce la
    # description standard nella colonna D dei documenti generati.
    change_description: Mapped[str | None] = mapped_column(Text, nullable=True)
    # Campo custom Jira "Problem Cause": per i Bug in colonna D del Release
    # Report generato.
    problem_cause: Mapped[str | None] = mapped_column(Text, nullable=True)
    # Campo standard Jira "Components" (nomi separati da virgola): colonna F
    # del Release Report generato.
    components: Mapped[str | None] = mapped_column(String(255), nullable=True)
    # Campo custom Jira "Developer Effort" (solo sulle Story): colonna "Ore
    # stimate" del Backlog.
    dev_effort_hours: Mapped[float | None] = mapped_column(Float, nullable=True)
    issue_type: Mapped[str | None] = mapped_column(String(64), nullable=True)
    jira_status: Mapped[str | None] = mapped_column(String(64), nullable=True)
    labels: Mapped[str | None] = mapped_column(String(255), nullable=True)
    # Epic/parent dell'issue (se presente): sincronizzato come gli altri
    # campi qui sopra.
    parent_key: Mapped[str | None] = mapped_column(String(64), nullable=True)
    parent_summary: Mapped[str | None] = mapped_column(Text, nullable=True)
    # Task collegati via link Jira "is implemented by", come JSON:
    # [{"key","summary","fix_version"}, ...]. Usato dalla sezione Documents.
    implemented_by_json: Mapped[str | None] = mapped_column(Text, nullable=True)
    # Ore da Time Tracking Jira (timeSpentSeconds): sincronizzato come gli
    # altri campi qui sopra, Jira e' sempre la fonte di verita' e sovrascrive
    # qualunque valore inserito a mano nell'app.
    logged_hours: Mapped[float | None] = mapped_column(Float, nullable=True)
    # Ricavate dal changelog Jira (prima transizione a In Progress/On-Going,
    # ultima a Done): sincronizzate come i campi sopra, sovrascritte ad ogni
    # sync anche se modificate a mano nell'app.
    actual_start: Mapped[dt.date | None] = mapped_column(Date, nullable=True)
    actual_finish: Mapped[dt.date | None] = mapped_column(Date, nullable=True)
    last_synced_at: Mapped[dt.datetime | None] = mapped_column(DateTime, nullable=True)

    # Campi di pianificazione, gestiti dall'utente (mai toccati dal sync)
    ready_for_refinement: Mapped[bool] = mapped_column(Boolean, default=False)
    in_scope: Mapped[bool] = mapped_column(Boolean, default=True)
    # Un item puo' essere in scope ma senza impatto diretto sul team di
    # sviluppo (es. attivita' amministrative): questo flag permette di
    # escluderlo dai totali PBI (Backlog, Snapshot, Forecasting) senza
    # doverlo anche togliere dallo scope del progetto.
    included_in_codefreeze: Mapped[bool] = mapped_column(Boolean, default=True)
    planned: Mapped[bool] = mapped_column(Boolean, default=False)
    planned_duration_days: Mapped[float | None] = mapped_column(Float, nullable=True)
    dev_estimate_hours: Mapped[float | None] = mapped_column(Float, nullable=True)
    test_estimate_hours: Mapped[float | None] = mapped_column(Float, nullable=True)
    planned_hours: Mapped[float | None] = mapped_column(Float, nullable=True)
    planned_start: Mapped[dt.date | None] = mapped_column(Date, nullable=True)
    expected_finish: Mapped[dt.date | None] = mapped_column(Date, nullable=True)
    # Testo libero (non Date) per poter scrivere anche "n.a." oltre a una data.
    refinement_date: Mapped[str | None] = mapped_column(String(32), nullable=True)
    ta_date: Mapped[str | None] = mapped_column(String(32), nullable=True)
    notes: Mapped[str | None] = mapped_column(Text, nullable=True)
    # Progetto su cui rendicontare le ore di questo item, scelto a mano tra
    # quelli collegati al Project (Increment) di questo item: serve quando un
    # Increment ha piu' progetti collegati e le ore vanno divise tra loro.
    progetto_id: Mapped[int | None] = mapped_column(ForeignKey("increments.id", ondelete="SET NULL"), nullable=True)

    project: Mapped["Project"] = relationship(back_populates="backlog_items")
    progetto: Mapped["Increment | None"] = relationship()

    @property
    def status(self) -> str:
        # Se sincronizzato da Jira, jira_status e' la fonte di verita' (mappato
        # sui 3 stati locali). Solo per item creati a mano senza jira_status
        # si usa il fallback storico basato sulle date effettive.
        if self.jira_status:
            if self.jira_status == "Done":
                return "Done"
            if self.jira_status in ("In Progress", "In Review", "On-Going"):
                return "In Progress"
            return "To Do"
        if self.actual_finish is not None:
            return "Done"
        if self.actual_start is not None:
            return "In Progress"
        return "To Do"


class ForecastSimulation(Base):
    """Una riga della tabella Forecasting: una simulazione/snapshot manuale
    usata per proiettare la data di completamento del progetto (equivalente
    alla tabella "Throughput" del foglio Excel originale). Tutti i campi
    numerici/data sono per ora inseriti a mano; la logica di calcolo verra'
    aggiunta in seguito."""

    __tablename__ = "forecast_simulations"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    project_id: Mapped[int] = mapped_column(ForeignKey("projects.id", ondelete="CASCADE"))

    note: Mapped[str | None] = mapped_column(Text, nullable=True)
    simulation_date: Mapped[dt.date | None] = mapped_column(Date, nullable=True)
    pbi_remaining: Mapped[int | None] = mapped_column(Integer, nullable=True)
    pbi_done: Mapped[int | None] = mapped_column(Integer, nullable=True)
    planned_pbi_done: Mapped[int | None] = mapped_column(Integer, nullable=True)
    unplanned_pbi_done: Mapped[int | None] = mapped_column(Integer, nullable=True)
    # Jira key dei PBI contati in planned_pbi_done/unplanned_pbi_done al
    # momento della creazione (", " come separatore), per il tooltip "i" in
    # UI. Congelate come i conteggi: non si aggiornano da sole in seguito.
    planned_pbi_keys: Mapped[str | None] = mapped_column(Text, nullable=True)
    unplanned_pbi_keys: Mapped[str | None] = mapped_column(Text, nullable=True)
    # Testo libero (non Date) perche' nel foglio originale può restare vuoto
    # o contenere una nota invece di una data vera e propria.
    traditional_forecasting: Mapped[str | None] = mapped_column(String(32), nullable=True)
    code_freeze_deadline: Mapped[dt.date | None] = mapped_column(Date, nullable=True)
    completion_likelihood: Mapped[float | None] = mapped_column(Float, nullable=True)
    completion_date_85pct: Mapped[dt.date | None] = mapped_column(Date, nullable=True)
    pbi_completed_by_deadline_85pct: Mapped[int | None] = mapped_column(Integer, nullable=True)
    completion_date_85pct_with_holidays: Mapped[dt.date | None] = mapped_column(Date, nullable=True)

    project: Mapped["Project"] = relationship(back_populates="forecast_simulations")


class Snapshot(Base):
    __tablename__ = "snapshots"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    project_id: Mapped[int] = mapped_column(ForeignKey("projects.id", ondelete="CASCADE"))
    snapshot_date: Mapped[dt.date] = mapped_column(Date)
    actual_hours: Mapped[float | None] = mapped_column(Float, nullable=True)
    logged_hours: Mapped[float | None] = mapped_column(Float, nullable=True)
    pbi_total: Mapped[int | None] = mapped_column(Integer, nullable=True)
    pbi_done: Mapped[int | None] = mapped_column(Integer, nullable=True)
    note: Mapped[str | None] = mapped_column(Text, nullable=True)

    project: Mapped["Project"] = relationship(back_populates="snapshots")
