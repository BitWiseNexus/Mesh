import asyncio
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app import llm
from app.api import (
    credentials,
    flows,
    health,
    knowledge,
    me,
    models,
    runs,
    schedules,
    tables,
    webhooks,
)
from app.core.config import get_settings
from app.core.crypto import get_cipher
from app.core.errors import register_error_handlers
from app.core.firebase import init_firebase
from app.core.middleware import ErrorGuardMiddleware
from app.services.ingestion import IngestionManager
from app.services.runs import RunManager
from app.services.schedules import Scheduler
from app.services.webhooks import RateLimiter


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncIterator[None]:
    init_firebase()
    get_cipher()  # refuse to start without an encryption key where one is required
    app.state.runs = RunManager(get_settings())
    app.state.ingestion = IngestionManager()
    app.state.webhook_limiter = RateLimiter(get_settings().webhook_requests_per_minute)
    app.state.scheduler = Scheduler(get_settings(), app.state.runs, app.state.ingestion)
    if get_settings().scheduler_enabled:
        app.state.scheduler.start()
    # LiteLLM takes seconds to import; do it now, off the event loop, not on the first run.
    asyncio.get_running_loop().run_in_executor(None, llm.warm_up)
    yield
    await app.state.scheduler.shutdown()
    await app.state.runs.shutdown()
    await app.state.ingestion.shutdown()


def create_app() -> FastAPI:
    settings = get_settings()
    app = FastAPI(title=f"{settings.app_name} API", version="0.1.0", lifespan=lifespan)

    # Inside CORS (middleware added later wraps earlier), so its error responses get CORS headers.
    app.add_middleware(
        ErrorGuardMiddleware,
        timeout=settings.request_timeout_seconds,
        # Waiting for the flow's answer, plus the usual time for everything else.
        webhook_timeout=(
            settings.webhook_response_timeout_seconds + settings.request_timeout_seconds
        ),
    )
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
    app.include_router(runs.router)
    app.include_router(credentials.router)
    app.include_router(models.router)
    app.include_router(knowledge.router)
    app.include_router(webhooks.router)
    app.include_router(schedules.router)
    app.include_router(tables.router)
    register_error_handlers(app)
    return app


app = create_app()
