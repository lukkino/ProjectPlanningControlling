"""Login e permessi.

- Password: scrypt (libreria standard), salvata come
  "scrypt$n$r$p$<salt base64>$<hash base64>".
- Sessione: token casuale nel cookie HttpOnly SESSION_COOKIE; nel database
  (UserSession) solo il suo SHA-256. Scade dopo settings.session_days giorni
  senza attivita'.
- Permessi: authorize() e' una dipendenza globale dell'app (vedi main.py):
  ogni chiamata /api richiede un utente con il ruolo minimo dato da
  required_role(metodo, percorso), tranne le poche pubbliche (PUBLIC_PATHS).
"""

import base64
import datetime as dt
import hashlib
import hmac
import re
import secrets

from fastapi import Depends, HTTPException, Request, Response
from sqlalchemy.orm import Session

from app import models, ownership
from app.config import get_settings
from app.database import get_db

SESSION_COOKIE = "ppc_session"
ROLES = ("viewer", "editor", "admin")
ROLE_LABELS = {"viewer": "Viewer", "editor": "Editor", "admin": "Admin"}
MIN_PASSWORD_LENGTH = 8

# Chiamate senza login: stato (serve alla pagina di login), login e
# creazione del primo amministratore.
PUBLIC_PATHS = {"/api/health", "/api/auth/status", "/api/auth/login", "/api/auth/setup", "/api/auth/logout"}

# Chiamate POST che non modificano dati (generano o controllano documenti):
# permesse anche ai Viewer.
VIEWER_POST_PATTERNS = [
    re.compile(p)
    for p in (
        r"^/api/projects/\d+/documents/release-notice(/html)?$",
        r"^/api/projects/\d+/documents/ppr/[^/]+/inspect$",
        r"^/api/projects/\d+/documents/[^/]+/inspect$",
        r"^/api/projects/\d+/documents/(design-input|user-needs)/check$",
        r"^/api/auth/password$",
    )
]

# Solo Admin, per qualsiasi metodo.
ADMIN_ONLY_PATTERNS = [re.compile(r"^/api/users(/|$)")]
# Solo Admin per le modifiche (la lettura e' di tutti). /api/settings no:
# le JQL personali le modifica ogni Editor, il token solo l'Admin (controllo
# nel router settings).
ADMIN_WRITE_PATTERNS = [
    re.compile(r"^/api/documents/release-notice/template$"),
]
READ_METHODS = {"GET", "HEAD", "OPTIONS"}


def required_role(method: str, path: str) -> str:
    if any(p.match(path) for p in ADMIN_ONLY_PATTERNS):
        return "admin"
    if method in READ_METHODS:
        return "viewer"
    if any(p.match(path) for p in ADMIN_WRITE_PATTERNS):
        return "admin"
    if method == "POST" and any(p.match(path) for p in VIEWER_POST_PATTERNS):
        return "viewer"
    return "editor"


def has_role(user: models.User, role: str) -> bool:
    return ROLES.index(user.role) >= ROLES.index(role) if user.role in ROLES else False


# --- Password -----------------------------------------------------------------

_SCRYPT = {"n": 2**14, "r": 8, "p": 1}


def hash_password(password: str) -> str:
    salt = secrets.token_bytes(16)
    digest = hashlib.scrypt(password.encode(), salt=salt, dklen=32, **_SCRYPT)
    b64 = lambda b: base64.b64encode(b).decode()  # noqa: E731
    return f"scrypt${_SCRYPT['n']}${_SCRYPT['r']}${_SCRYPT['p']}${b64(salt)}${b64(digest)}"


def verify_password(password: str, stored: str | None) -> bool:
    if not stored:
        return False
    try:
        algo, n, r, p, salt, digest = stored.split("$")
        if algo != "scrypt":
            return False
        expected = base64.b64decode(digest)
        actual = hashlib.scrypt(
            password.encode(), salt=base64.b64decode(salt), n=int(n), r=int(r), p=int(p), dklen=len(expected)
        )
    except (ValueError, TypeError):
        return False
    return hmac.compare_digest(actual, expected)


def check_password_rules(password: str) -> None:
    if len(password) < MIN_PASSWORD_LENGTH:
        raise HTTPException(status_code=400, detail=f"La password deve avere almeno {MIN_PASSWORD_LENGTH} caratteri.")


# --- Sessioni -----------------------------------------------------------------


def _hash_token(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


def _now() -> dt.datetime:
    return dt.datetime.utcnow()


def start_session(db: Session, response: Response, user: models.User) -> None:
    token = secrets.token_urlsafe(32)
    settings = get_settings()
    db.add(
        models.UserSession(
            token_hash=_hash_token(token),
            user_id=user.id,
            expires_at=_now() + dt.timedelta(days=settings.session_days),
        )
    )
    user.last_login_at = _now()
    # Sessioni scadute: pulizia a ogni login.
    db.query(models.UserSession).filter(models.UserSession.expires_at < _now()).delete()
    db.commit()
    response.set_cookie(
        SESSION_COOKIE,
        token,
        max_age=settings.session_days * 86400,
        httponly=True,
        samesite="lax",
        secure=settings.cookie_secure,
        path="/",
    )


def end_session(db: Session, request: Request, response: Response) -> None:
    token = request.cookies.get(SESSION_COOKIE)
    if token:
        db.query(models.UserSession).filter(models.UserSession.token_hash == _hash_token(token)).delete()
        db.commit()
    response.delete_cookie(SESSION_COOKIE, path="/")


def end_user_sessions(db: Session, user_id: int, keep_token: str | None = None) -> None:
    query = db.query(models.UserSession).filter(models.UserSession.user_id == user_id)
    if keep_token:
        query = query.filter(models.UserSession.token_hash != _hash_token(keep_token))
    query.delete()


def session_user(db: Session, request: Request) -> models.User | None:
    token = request.cookies.get(SESSION_COOKIE)
    if not token:
        return None
    session = db.query(models.UserSession).filter(models.UserSession.token_hash == _hash_token(token)).first()
    if session is None or session.expires_at < _now():
        return None
    user = db.get(models.User, session.user_id)
    if user is None or not user.is_active:
        return None
    # Scadenza "scorrevole": si allunga con l'uso (al massimo una scrittura l'ora).
    if _now() - session.last_seen_at > dt.timedelta(hours=1):
        session.last_seen_at = _now()
        session.expires_at = _now() + dt.timedelta(days=get_settings().session_days)
        db.commit()
    return user


# --- Dipendenze -----------------------------------------------------------------


def authorize(request: Request, db: Session = Depends(get_db)) -> None:
    """Dipendenza globale: login e ruolo minimo per ogni chiamata /api."""
    path = request.url.path
    if not path.startswith("/api/") or path in PUBLIC_PATHS:
        return
    user = session_user(db, request)
    if user is None:
        raise HTTPException(status_code=401, detail="Accesso richiesto")
    request.state.user = user
    role = required_role(request.method, path)
    if not has_role(user, role):
        raise HTTPException(
            status_code=403,
            detail=f"Permesso negato: serve il ruolo {ROLE_LABELS[role]} (il tuo è {ROLE_LABELS.get(user.role, user.role)}).",
        )
    # Dati altrui: 404 (vedi ownership.py).
    ownership.check_path_owner(db, user, path)
    request.state.scope_user_id = ownership.resolve_scope(db, user, request.headers.get(ownership.SCOPE_HEADER))


async def apply_scope(request: Request) -> None:
    """Dopo authorize: rende lo scope (di quale utente sono i dati) leggibile
    ovunque con ownership.scope_user_id(). Asincrona apposta: il ContextVar
    impostato qui arriva all'endpoint (anche se sincrono, gira con una copia
    di questo contesto)."""
    ownership.set_scope_user(getattr(request.state, "scope_user_id", None))


def current_user(request: Request) -> models.User:
    user = getattr(request.state, "user", None)
    if user is None:
        raise HTTPException(status_code=401, detail="Accesso richiesto")
    return user
