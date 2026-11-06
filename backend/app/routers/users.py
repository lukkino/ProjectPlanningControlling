"""Login (/api/auth) e gestione utenti (/api/users, solo Admin: vedi auth.required_role)."""

import time

from fastapi import APIRouter, Depends, HTTPException, Request, Response
from sqlalchemy import func
from sqlalchemy.orm import Session

from app import auth, models, ownership, schemas
from app.database import get_db

router = APIRouter(tags=["users"])


def _normalize_username(username: str) -> str:
    value = username.strip().lower()
    if not value:
        raise HTTPException(status_code=400, detail="Lo username è obbligatorio.")
    return value


def _read(user: models.User) -> schemas.UserRead:
    return schemas.UserRead.model_validate(user)


# --- Login ----------------------------------------------------------------------


@router.get("/api/auth/status", response_model=schemas.AuthStatus)
def auth_status(db: Session = Depends(get_db)):
    """setup_required: nessun utente ancora, la pagina di login propone di
    creare il primo amministratore."""
    return schemas.AuthStatus(setup_required=db.query(models.User).count() == 0)


@router.post("/api/auth/setup", response_model=schemas.UserRead)
def setup_first_admin(payload: schemas.SetupRequest, response: Response, db: Session = Depends(get_db)):
    if db.query(models.User).count() > 0:
        raise HTTPException(status_code=409, detail="L'amministratore esiste già: accedi con le tue credenziali.")
    auth.check_password_rules(payload.password)
    user = models.User(
        username=_normalize_username(payload.username),
        display_name=payload.display_name.strip() or payload.username.strip(),
        email=(payload.email or "").strip() or None,
        password_hash=auth.hash_password(payload.password),
        role="admin",
    )
    db.add(user)
    db.commit()
    # I dati gia' presenti (app usata prima del login) diventano suoi.
    ownership.claim_orphans(db, user.id)
    auth.start_session(db, response, user)
    return _read(user)


@router.post("/api/auth/login", response_model=schemas.UserRead)
def login(payload: schemas.LoginRequest, response: Response, db: Session = Depends(get_db)):
    user = (
        db.query(models.User)
        .filter(func.lower(models.User.username) == payload.username.strip().lower())
        .first()
    )
    if user is None or not user.is_active or not auth.verify_password(payload.password, user.password_hash):
        time.sleep(0.5)  # rallenta i tentativi a raffica
        raise HTTPException(status_code=401, detail="Username o password non corretti.")
    auth.start_session(db, response, user)
    return _read(user)


@router.post("/api/auth/logout", status_code=204)
def logout(request: Request, response: Response, db: Session = Depends(get_db)):
    auth.end_session(db, request, response)
    response.status_code = 204
    return response


@router.get("/api/auth/me", response_model=schemas.UserRead)
def me(user: models.User = Depends(auth.current_user)):
    return _read(user)


@router.post("/api/auth/password", status_code=204)
def change_own_password(
    payload: schemas.PasswordChange,
    request: Request,
    db: Session = Depends(get_db),
    user: models.User = Depends(auth.current_user),
):
    if not auth.verify_password(payload.current_password, user.password_hash):
        raise HTTPException(status_code=400, detail="La password attuale non è corretta.")
    auth.check_password_rules(payload.new_password)
    user.password_hash = auth.hash_password(payload.new_password)
    # Le altre sessioni dello stesso utente (altri PC/browser) vengono chiuse.
    auth.end_user_sessions(db, user.id, keep_token=request.cookies.get(auth.SESSION_COOKIE))
    db.commit()
    return Response(status_code=204)


# --- Utenti (Admin) ---------------------------------------------------------------


def _get_user_or_404(db: Session, user_id: int) -> models.User:
    user = db.get(models.User, user_id)
    if user is None:
        raise HTTPException(status_code=404, detail="Utente non trovato")
    return user


def _other_active_admins(db: Session, user_id: int) -> int:
    return (
        db.query(models.User)
        .filter(models.User.role == "admin", models.User.is_active.is_(True), models.User.id != user_id)
        .count()
    )


@router.get("/api/users", response_model=list[schemas.UserRead])
def list_users(db: Session = Depends(get_db)):
    return [_read(u) for u in db.query(models.User).order_by(func.lower(models.User.display_name))]


@router.post("/api/users", response_model=schemas.UserRead)
def create_user(payload: schemas.UserCreate, db: Session = Depends(get_db)):
    username = _normalize_username(payload.username)
    if db.query(models.User).filter(func.lower(models.User.username) == username).first():
        raise HTTPException(status_code=409, detail=f"Lo username {username} esiste già.")
    auth.check_password_rules(payload.password)
    user = models.User(
        username=username,
        display_name=payload.display_name.strip() or username,
        email=(payload.email or "").strip() or None,
        role=payload.role,
        password_hash=auth.hash_password(payload.password),
    )
    db.add(user)
    db.commit()
    return _read(user)


@router.put("/api/users/{user_id}", response_model=schemas.UserRead)
def update_user(
    user_id: int,
    payload: schemas.UserUpdate,
    db: Session = Depends(get_db),
    me: models.User = Depends(auth.current_user),
):
    user = _get_user_or_404(db, user_id)
    data = payload.model_dump(exclude_unset=True)
    losing_admin = (data.get("role", user.role) != "admin" or data.get("is_active", user.is_active) is False) and user.role == "admin"
    if losing_admin and _other_active_admins(db, user.id) == 0:
        raise HTTPException(status_code=400, detail="Deve restare almeno un Admin attivo.")
    if user.id == me.id and data.get("is_active") is False:
        raise HTTPException(status_code=400, detail="Non puoi disattivare il tuo utente.")
    if "display_name" in data:
        user.display_name = (data["display_name"] or "").strip() or user.username
    if "email" in data:
        user.email = (data["email"] or "").strip() or None
    if "role" in data:
        user.role = data["role"]
    if "is_active" in data:
        user.is_active = data["is_active"]
        if not user.is_active:
            auth.end_user_sessions(db, user.id)
    if data.get("password"):
        auth.check_password_rules(data["password"])
        user.password_hash = auth.hash_password(data["password"])
        if user.id != me.id:
            auth.end_user_sessions(db, user.id)
    db.commit()
    return _read(user)


@router.delete("/api/users/{user_id}", status_code=204)
def delete_user(user_id: int, db: Session = Depends(get_db), me: models.User = Depends(auth.current_user)):
    user = _get_user_or_404(db, user_id)
    if user.id == me.id:
        raise HTTPException(status_code=400, detail="Non puoi eliminare il tuo utente.")
    if user.role == "admin" and user.is_active and _other_active_admins(db, user.id) == 0:
        raise HTTPException(status_code=400, detail="Deve restare almeno un Admin attivo.")
    auth.end_user_sessions(db, user.id)
    db.delete(user)
    db.commit()
    return Response(status_code=204)
