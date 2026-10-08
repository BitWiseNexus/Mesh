"""Request authentication: verifies Firebase ID tokens sent as `Authorization: Bearer <token>`."""

from typing import Annotated

from fastapi import Depends, HTTPException, status
from fastapi.concurrency import run_in_threadpool
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from firebase_admin import auth
from pydantic import BaseModel

from app.core.config import get_settings
from app.core.firebase import init_firebase


class AuthUser(BaseModel):
    """The caller, as asserted by a verified Firebase ID token."""

    uid: str
    email: str | None = None
    email_verified: bool = False
    name: str | None = None
    picture: str | None = None
    sign_in_provider: str | None = None


# auto_error=False: we raise our own 401 with a consistent body instead of FastAPI's 403.
_bearer = HTTPBearer(auto_error=False, description="Firebase ID token")


def _unauthorized(code: str, message: str) -> HTTPException:
    return HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED,
        detail={"code": code, "message": message},
        headers={"WWW-Authenticate": "Bearer"},
    )


async def get_current_user(
    credentials: Annotated[HTTPAuthorizationCredentials | None, Depends(_bearer)],
) -> AuthUser:
    if credentials is None or not credentials.credentials:
        raise _unauthorized("missing_token", "Sign in to continue.")

    settings = get_settings()
    init_firebase()
    try:
        # Sync SDK call that may fetch Google's public keys — keep it off the event loop.
        claims = await run_in_threadpool(
            auth.verify_id_token,
            credentials.credentials,
            check_revoked=settings.auth_check_revoked,
            clock_skew_seconds=settings.auth_clock_skew_seconds,
        )
    # Order matters: expired/revoked are subclasses of InvalidIdTokenError.
    except auth.ExpiredIdTokenError as exc:
        raise _unauthorized("token_expired", "Your session expired. Sign in again.") from exc
    except auth.RevokedIdTokenError as exc:
        raise _unauthorized("token_revoked", "Your session was revoked. Sign in again.") from exc
    except auth.UserDisabledError as exc:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail={"code": "user_disabled", "message": "This account has been disabled."},
        ) from exc
    except (auth.InvalidIdTokenError, ValueError) as exc:
        raise _unauthorized("invalid_token", "Invalid session. Sign in again.") from exc
    except auth.CertificateFetchError as exc:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail={"code": "auth_unavailable", "message": "Can't verify sign-in right now."},
        ) from exc

    return AuthUser(
        uid=claims["uid"],
        email=claims.get("email"),
        email_verified=bool(claims.get("email_verified", False)),
        name=claims.get("name"),
        picture=claims.get("picture"),
        sign_in_provider=claims.get("firebase", {}).get("sign_in_provider"),
    )


CurrentUser = Annotated[AuthUser, Depends(get_current_user)]
"""Use as a route parameter type to require a signed-in caller: `def route(user: CurrentUser)`."""
