import asyncio
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app import llm
from app.api import flows, health, me, runs
from app.core.config import get_settings
from app.core.errors import register_error_handlers
from app.core.firebase import init_firebase
from app.services.runs import RunManager


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncIterator[None]:
    init_firebase()
    app.state.runs = RunManager(get_settings())
    # LiteLLM takes seconds to import; do it now, off the event loop, not on the first run.
    asyncio.get_running_loop().run_in_executor(None, llm.warm_up)
    yield
    await app.state.runs.shutdown()


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
    app.include_router(runs.router)
    register_error_handlers(app)
    return app


app = create_app()
