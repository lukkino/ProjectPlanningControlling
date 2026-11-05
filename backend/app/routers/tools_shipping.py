"""Tool Modulo Spedizioni (ex app desktop "Modulo Spedizioni"): rubrica
indirizzi, rubrica persone ed export Excel del modulo. Le rubriche stanno nel
database (gitignored), non nel repository."""

import datetime as dt
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, Response
from pydantic import BaseModel, ConfigDict
from sqlalchemy.orm import Session

from app import models
from app.database import get_db
from app.services.tools.shipping import export_excel

router = APIRouter(prefix="/api/tools/shipping", tags=["tools"])


class AddressWrite(BaseModel):
    label: str
    company: str = ""
    address: str = ""
    contact: str = ""
    email: str = ""
    phone: str = ""


class Address(AddressWrite):
    model_config = ConfigDict(from_attributes=True)
    id: int


class ContactWrite(BaseModel):
    name: str
    company: str = ""
    email: str = ""
    phone: str = ""


class Contact(ContactWrite):
    model_config = ConfigDict(from_attributes=True)
    id: int


class Line(BaseModel):
    text: str = ""
    style: Literal["header", "bold", "normal", "link"] = "normal"


class ExportRequest(BaseModel):
    blocks: list[list[Line]]


def _clean(data: dict) -> dict:
    return {k: v.strip() if isinstance(v, str) else v for k, v in data.items()}


def _required(value: str, label: str) -> None:
    if not value.strip():
        raise HTTPException(status_code=422, detail=f"Il campo {label} non può essere vuoto")


# ---------- Rubrica indirizzi ----------

@router.get("/addresses", response_model=list[Address])
def list_addresses(db: Session = Depends(get_db)):
    return db.query(models.ShippingAddress).order_by(models.ShippingAddress.label).all()


@router.post("/addresses", response_model=Address, status_code=201)
def create_address(payload: AddressWrite, db: Session = Depends(get_db)):
    _required(payload.label, "Nome in rubrica")
    entry = models.ShippingAddress(**_clean(payload.model_dump()))
    db.add(entry)
    db.commit()
    db.refresh(entry)
    return entry


@router.put("/addresses/{address_id}", response_model=Address)
def update_address(address_id: int, payload: AddressWrite, db: Session = Depends(get_db)):
    entry = db.get(models.ShippingAddress, address_id)
    if entry is None:
        raise HTTPException(status_code=404, detail="Indirizzo non trovato")
    _required(payload.label, "Nome in rubrica")
    for field, value in _clean(payload.model_dump()).items():
        setattr(entry, field, value)
    db.commit()
    db.refresh(entry)
    return entry


@router.delete("/addresses/{address_id}", status_code=204)
def delete_address(address_id: int, db: Session = Depends(get_db)):
    entry = db.get(models.ShippingAddress, address_id)
    if entry is None:
        raise HTTPException(status_code=404, detail="Indirizzo non trovato")
    db.delete(entry)
    db.commit()


# ---------- Rubrica persone ----------

@router.get("/contacts", response_model=list[Contact])
def list_contacts(db: Session = Depends(get_db)):
    return db.query(models.ShippingContact).order_by(models.ShippingContact.name).all()


@router.post("/contacts", response_model=Contact, status_code=201)
def create_contact(payload: ContactWrite, db: Session = Depends(get_db)):
    _required(payload.name, "Nome e cognome")
    entry = models.ShippingContact(**_clean(payload.model_dump()))
    db.add(entry)
    db.commit()
    db.refresh(entry)
    return entry


@router.put("/contacts/{contact_id}", response_model=Contact)
def update_contact(contact_id: int, payload: ContactWrite, db: Session = Depends(get_db)):
    entry = db.get(models.ShippingContact, contact_id)
    if entry is None:
        raise HTTPException(status_code=404, detail="Persona non trovata")
    _required(payload.name, "Nome e cognome")
    for field, value in _clean(payload.model_dump()).items():
        setattr(entry, field, value)
    db.commit()
    db.refresh(entry)
    return entry


@router.delete("/contacts/{contact_id}", status_code=204)
def delete_contact(contact_id: int, db: Session = Depends(get_db)):
    entry = db.get(models.ShippingContact, contact_id)
    if entry is None:
        raise HTTPException(status_code=404, detail="Persona non trovata")
    db.delete(entry)
    db.commit()


# ---------- Export ----------

@router.post("/export")
def export_form(payload: ExportRequest):
    """Il modulo (blocchi gia' composti dal frontend) come file Excel."""
    content = export_excel([[(line.text, line.style) for line in block] for block in payload.blocks])
    filename = f"Modulo spedizione {dt.date.today().isoformat()}.xlsx"
    return Response(
        content=content,
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )
