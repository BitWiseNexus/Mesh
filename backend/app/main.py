from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.api import flows, health, me
from app.core.config import get_settings
from app.core.errors import register_error_handlers
from app.core.firebase import init_firebase


@asynccontextmanager
async def lifespan(_: FastAPI) -> AsyncIterator[None]:
    init_firebase()
    yield


def create_app() -> FastAPI:
    settings = get_settings()
    app = FastAPI(title=f"{settings.app_name} API", version="0.1.0", lifespan=lifespan)

    app.add_middleware(
        CORSMiddleware,
        allow_origins=settings.cors_origins,
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )

    app.include_router(health.router)
    app.include_router(me.router)
    app.include_router(flows.router)
    register_error_handlers(app)
    return app


app = create_app()
