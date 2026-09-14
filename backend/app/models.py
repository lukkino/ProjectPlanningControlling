import datetime as dt

from sqlalchemy import Boolean, Date, DateTime, Float, ForeignKey, Integer, String, Text
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.database import Base


def _utcnow() -> dt.datetime:
    return dt.datetime.utcnow()


class Project(Base):
    __tablename__ = "projects"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    code: Mapped[str] = mapped_column(String(64), index=True)
    name: Mapped[str] = mapped_column(String(255))
    status: Mapped[str] = mapped_column(String(64), default="Kick-off")
    scope: Mapped[str | None] = mapped_column(Text, nullable=True)
    start_date: Mapped[dt.date | None] = mapped_column(Date, nullable=True)
    code_freeze_date: Mapped[dt.date | None] = mapped_column(Date, nullable=True)
    estimated_budget_hours: Mapped[float] = mapped_column(Float, default=0)
    estimated_budget_material: Mapped[float] = mapped_column(Float, default=0)
    jira_jql: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_at: Mapped[dt.datetime] = mapped_column(DateTime, default=_utcnow)
    updated_at: Mapped[dt.datetime] = mapped_column(DateTime, default=_utcnow, onupdate=_utcnow)

    phases: Mapped[list["Phase"]] = relationship(back_populates="project", cascade="all, delete-orphan", order_by="Phase.order")
    budget_lines: Mapped[list["BudgetLine"]] = relationship(back_populates="project", cascade="all, delete-orphan", order_by="BudgetLine.order")
    backlog_items: Mapped[list["BacklogItem"]] = relationship(back_populates="project", cascade="all, delete-orphan", order_by="BacklogItem.priority_order")
    snapshots: Mapped[list["Snapshot"]] = relationship(back_populates="project", cascade="all, delete-orphan", order_by="Snapshot.snapshot_date")
    forecast_simulations: Mapped[list["ForecastSimulation"]] = relationship(
        back_populates="project", cascade="all, delete-orphan", order_by="ForecastSimulation.id"
    )


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


class BudgetLine(Base):
    __tablename__ = "budget_lines"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    project_id: Mapped[int] = mapped_column(ForeignKey("projects.id", ondelete="CASCADE"))
    role_name: Mapped[str] = mapped_column(String(128))
    budget_hours: Mapped[float] = mapped_column(Float, default=0)
    order: Mapped[int] = mapped_column(Integer, default=0)

    project: Mapped["Project"] = relationship(back_populates="budget_lines")


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
    issue_type: Mapped[str | None] = mapped_column(String(64), nullable=True)
    jira_status: Mapped[str | None] = mapped_column(String(64), nullable=True)
    labels: Mapped[str | None] = mapped_column(String(255), nullable=True)
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

    project: Mapped["Project"] = relationship(back_populates="backlog_items")

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
