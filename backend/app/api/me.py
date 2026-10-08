from fastapi import APIRouter

from app.core.auth import AuthUser, CurrentUser

router = APIRouter(tags=["auth"])


@router.get("/me")
async def me(user: CurrentUser) -> AuthUser:
    """The signed-in caller, as seen by the backend."""
    return user
