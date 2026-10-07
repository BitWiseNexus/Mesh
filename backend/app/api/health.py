import asyncio

from fastapi import APIRouter

from app.core.config import get_settings
from app.core.firebase import get_db

router = APIRouter(tags=["health"])


@router.get("/health")
async def health() -> dict[str, str]:
    settings = get_settings()
    return {"status": "ok", "app": settings.app_name, "environment": settings.environment}


@router.get("/health/deps")
async def health_deps() -> dict[str, str]:
    """Checks connectivity to backing services."""
    try:
        await asyncio.wait_for(get_db().collection("_meta").document("ping").get(), timeout=3)
        firestore_status = "ok"
    except Exception:
        firestore_status = "unavailable"
    return {"firestore": firestore_status}
