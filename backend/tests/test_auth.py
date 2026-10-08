import uuid

import pytest
from fastapi.testclient import TestClient
from firebase_admin import auth
from pydantic import ValidationError

from app.core import auth as auth_module
from app.core.config import Settings
from app.main import app
from tests.conftest import emulator_sign_up, requires_auth_emulator

client = TestClient(app)

CLAIMS = {
    "uid": "user-123",
    "email": "ada@example.com",
    "email_verified": True,
    "name": "Ada Lovelace",
    "firebase": {"sign_in_provider": "password"},
}


@pytest.fixture
def verify(monkeypatch: pytest.MonkeyPatch):
    """Replaces Firebase token verification; set `.result` to claims or an exception."""

    class Fake:
        result: object = CLAIMS
        calls: list[tuple[str, dict]] = []

        def __call__(self, token: str, **kwargs):
            self.calls.append((token, kwargs))
            if isinstance(self.result, Exception):
                raise self.result
            return self.result

    fake = Fake()
    fake.calls = []
    monkeypatch.setattr(auth_module.auth, "verify_id_token", fake)
    return fake


def get_me(token: str | None = "good-token", scheme: str = "Bearer"):
    headers = {"Authorization": f"{scheme} {token}"} if token is not None else {}
    return client.get("/me", headers=headers)


def test_returns_the_verified_user(verify) -> None:
    response = get_me()
    assert response.status_code == 200
    assert response.json() == {
        "uid": "user-123",
        "email": "ada@example.com",
        "email_verified": True,
        "name": "Ada Lovelace",
        "picture": None,
        "sign_in_provider": "password",
    }
    token, kwargs = verify.calls[0]
    assert token == "good-token"
    assert kwargs == {"check_revoked": False, "clock_skew_seconds": 10}


@pytest.mark.parametrize(
    ("token", "scheme"),
    [(None, "Bearer"), ("", "Bearer"), ("abc", "Basic")],
    ids=["no-header", "empty-token", "wrong-scheme"],
)
def test_missing_token_is_401(verify, token, scheme) -> None:
    response = get_me(token, scheme)
    assert response.status_code == 401
    assert response.json()["detail"]["code"] == "missing_token"
    assert response.headers["www-authenticate"] == "Bearer"
    assert verify.calls == []


@pytest.mark.parametrize(
    ("error", "status", "code"),
    [
        (auth.ExpiredIdTokenError("expired", None), 401, "token_expired"),
        (auth.RevokedIdTokenError("revoked"), 401, "token_revoked"),
        (auth.InvalidIdTokenError("bad signature"), 401, "invalid_token"),
        (ValueError("malformed"), 401, "invalid_token"),
        (auth.UserDisabledError("disabled"), 403, "user_disabled"),
        (auth.CertificateFetchError("no keys", None), 503, "auth_unavailable"),
    ],
    ids=["expired", "revoked", "invalid", "malformed", "disabled", "certs-down"],
)
def test_verification_failures(verify, error, status, code) -> None:
    verify.result = error
    response = get_me()
    assert response.status_code == status
    assert response.json()["detail"]["code"] == code


def test_emulators_are_refused_in_production() -> None:
    with pytest.raises(ValidationError, match="USE_FIREBASE_EMULATORS must be false"):
        Settings(environment="production", use_firebase_emulators=True)
    Settings(environment="production", use_firebase_emulators=False)  # fine


@requires_auth_emulator
def test_real_token_from_the_auth_emulator() -> None:
    email = f"pytest-{uuid.uuid4().hex[:8]}@mesh.test"
    response = get_me(emulator_sign_up(email))
    assert response.status_code == 200
    body = response.json()
    assert body["email"] == email
    assert body["sign_in_provider"] == "password"
    assert body["uid"]


@requires_auth_emulator
def test_corrupted_emulator_token_is_rejected() -> None:
    # Emulator tokens are unsigned, so this checks malformed-token handling, not signatures
    # (signature verification against Google's keys is the Firebase SDK's job in production).
    token = emulator_sign_up(f"pytest-{uuid.uuid4().hex[:8]}@mesh.test")
    header, payload, signature = token.split(".")
    response = get_me(f"{header}.{payload[:-4]}AAAA.{signature}")
    assert response.status_code == 401
