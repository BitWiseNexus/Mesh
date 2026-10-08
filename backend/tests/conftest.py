import json
import urllib.error
import urllib.request

import pytest

AUTH_EMULATOR = "http://127.0.0.1:9099"


def _emulator_up() -> bool:
    try:
        urllib.request.urlopen(AUTH_EMULATOR, timeout=0.5)
    except urllib.error.HTTPError:
        return True  # it answered
    except OSError:
        return False
    return True


requires_auth_emulator = pytest.mark.skipif(
    not _emulator_up(), reason="Firebase Auth emulator not running (firebase emulators:start)"
)


def emulator_sign_up(email: str, password: str = "secret123") -> str:
    """Creates a user in the Auth emulator and returns a fresh ID token for it."""
    req = urllib.request.Request(
        f"{AUTH_EMULATOR}/identitytoolkit.googleapis.com/v1/accounts:signUp?key=demo-api-key",
        data=json.dumps({"email": email, "password": password, "returnSecureToken": True}).encode(),
        headers={"Content-Type": "application/json"},
    )
    with urllib.request.urlopen(req, timeout=5) as resp:
        return json.load(resp)["idToken"]
