import json
import os
import urllib.error
import urllib.request
from collections.abc import Iterator

import pytest
from fastapi.testclient import TestClient

# No background scheduler in tests: it would fire schedules from whatever Firestore the settings
# point at (the dev emulator by default). Tests call `Scheduler.tick` themselves.
os.environ["SCHEDULER_ENABLED"] = "false"

# Emulator tests run only against emulators named explicitly in the environment, as
# `firebase emulators:exec` does (`npm run test:backend`, CI). Never against the `npm run dev` ones
# by default: the API tests wipe Firestore between tests, which would delete the developer's flows.
_AUTH_HOST = os.environ.get("FIREBASE_AUTH_EMULATOR_HOST", "")
_FIRESTORE_HOST = os.environ.get("FIRESTORE_EMULATOR_HOST", "")
_STORAGE_HOST = os.environ.get("FIREBASE_STORAGE_EMULATOR_HOST", "")
AUTH_EMULATOR = f"http://{_AUTH_HOST}"
FIRESTORE_EMULATOR = f"http://{_FIRESTORE_HOST}"
STORAGE_EMULATOR = f"http://{_STORAGE_HOST}"


def _reachable(url: str) -> bool:
    if url == "http://":
        return False  # not configured
    try:
        urllib.request.urlopen(url, timeout=0.5)
    except urllib.error.HTTPError:
        return True  # it answered
    except OSError:
        return False
    return True


def requires_emulator(url: str, name: str) -> pytest.MarkDecorator:
    """Skips tests when the emulator isn't running — locally. With REQUIRE_EMULATORS=1 (CI) the
    tests run anyway and fail loudly, so a broken CI setup can't pass by skipping everything."""
    skip = not _reachable(url) and not os.environ.get("REQUIRE_EMULATORS")
    return pytest.mark.skipif(
        skip, reason=f"needs the {name} emulator: run `npm run test:backend` at the repo root"
    )


requires_auth_emulator = requires_emulator(AUTH_EMULATOR, "Firebase Auth")
requires_firestore_emulator = requires_emulator(FIRESTORE_EMULATOR, "Firestore")
requires_storage_emulator = requires_emulator(STORAGE_EMULATOR, "Storage")


def emulator_sign_up(email: str, password: str = "secret123") -> str:
    """Creates a user in the Auth emulator and returns a fresh ID token for it."""
    req = urllib.request.Request(
        f"{AUTH_EMULATOR}/identitytoolkit.googleapis.com/v1/accounts:signUp?key=demo-api-key",
        data=json.dumps({"email": email, "password": password, "returnSecureToken": True}).encode(),
        headers={"Content-Type": "application/json"},
    )
    with urllib.request.urlopen(req, timeout=5) as resp:
        return json.load(resp)["idToken"]


@pytest.fixture
def kb_client(monkeypatch: pytest.MonkeyPatch) -> Iterator[TestClient]:
    """API client signed in as "alice" against an emptied Firestore emulator, with no server-side
    LLM keys (so model defaults are predictable). For the knowledge-base API tests."""
    import app.llm.models as models
    from app.core.auth import AuthUser, get_current_user
    from app.core.firebase import get_db
    from app.main import app

    clear = f"{FIRESTORE_EMULATOR}/emulator/v1/projects/demo-mesh/databases/(default)/documents"
    urllib.request.urlopen(urllib.request.Request(clear, method="DELETE"), timeout=5)
    monkeypatch.setattr(models, "server_has_key", lambda provider: False)
    get_db.cache_clear()
    with TestClient(app) as test_client:
        app.dependency_overrides[get_current_user] = lambda: AuthUser(uid="alice")
        yield test_client
    app.dependency_overrides.clear()
    get_db.cache_clear()
