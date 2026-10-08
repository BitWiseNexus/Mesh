import json
import os
import urllib.error
import urllib.request

import pytest

AUTH_EMULATOR = "http://127.0.0.1:9099"
FIRESTORE_EMULATOR = "http://127.0.0.1:8080"


def _reachable(url: str) -> bool:
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
        skip, reason=f"{name} emulator not running (firebase emulators:start)"
    )


requires_auth_emulator = requires_emulator(AUTH_EMULATOR, "Firebase Auth")
requires_firestore_emulator = requires_emulator(FIRESTORE_EMULATOR, "Firestore")


def emulator_sign_up(email: str, password: str = "secret123") -> str:
    """Creates a user in the Auth emulator and returns a fresh ID token for it."""
    req = urllib.request.Request(
        f"{AUTH_EMULATOR}/identitytoolkit.googleapis.com/v1/accounts:signUp?key=demo-api-key",
        data=json.dumps({"email": email, "password": password, "returnSecureToken": True}).encode(),
        headers={"Content-Type": "application/json"},
    )
    with urllib.request.urlopen(req, timeout=5) as resp:
        return json.load(resp)["idToken"]
