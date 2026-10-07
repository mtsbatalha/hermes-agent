"""TEMPORARY gated-mode validation harness (spike only, not product code).

Stands up the REAL gateway server with the dashboard auth gate ENGAGED on a
loopback bind (via HERMES_DASHBOARD_PUBLIC_URL), behind an in-process stub
password provider — the same registration seam a real deployment host uses.
Purpose: prove the served web client boots on HttpOnly cookie auth and dials
the WS with a single-use ticket minted at POST /api/auth/ws-ticket, with no
session token injected into the page.

Run from hermes-agent/ with the workspace venv:
  PYTHONPATH="$PWD" HERMES_DASHBOARD_PUBLIC_URL=http://gated.hermes-test.local \
  HERMES_WEB_DIST=apps/desktop/dist HERMES_SERVE_HEADLESS= \
  "$V/Scripts/python.exe" apps/desktop/spike/_gated_serve.py --port 9212

Login at http://127.0.0.1:9212/ with user "spike", password "gated-token-456".
"""

from __future__ import annotations

import argparse
import base64
import hashlib
import hmac
import json
import secrets
import sys
import time

sys.path.insert(0, ".")

from hermes_cli.dashboard_auth import (
    DashboardAuthProvider,
    InvalidCredentialsError,
    RefreshExpiredError,
    register_provider,
)
from hermes_cli.dashboard_auth.base import LoginStart, Session

_SECRET = b"spike-gated-harness-secret"
_SIG_LEN = 32
_USERNAME = "spike"
_PASSWORD = "gated-token-456"


def _sign(payload: dict) -> str:
    raw = json.dumps(payload, separators=(",", ":")).encode()
    sig = hmac.new(_SECRET, raw, hashlib.sha256).digest()
    return base64.urlsafe_b64encode(raw + sig).decode()


def _unsign(token: str) -> dict | None:
    try:
        blob = base64.urlsafe_b64decode(token.encode())
        if len(blob) <= _SIG_LEN:
            return None
        raw, sig = blob[:-_SIG_LEN], blob[-_SIG_LEN:]
        if not hmac.compare_digest(hmac.new(_SECRET, raw, hashlib.sha256).digest(), sig):
            return None
        payload = json.loads(raw.decode())
        return payload if isinstance(payload, dict) else None
    except Exception:
        return None


class SpikePasswordProvider(DashboardAuthProvider):
    name = "spike-password"
    display_name = "Spike password provider (test only)"
    supports_password = True

    def start_login(self, *, redirect_uri: str) -> LoginStart:
        state = secrets.token_urlsafe(16)
        verifier = secrets.token_urlsafe(32)
        return LoginStart(
            redirect_url=f"{redirect_uri}?code=spike_code&state={state}",
            cookie_payload={"hermes_session_pkce": f"state={state};verifier={verifier}"},
        )

    def complete_login(self, *, code: str, state: str, code_verifier: str, redirect_uri: str) -> Session:
        return self._session()

    def complete_password_login(self, *, username: str, password: str) -> Session:
        if username != _USERNAME or password != _PASSWORD:
            raise InvalidCredentialsError("no such user or bad password")
        return self._session()

    def verify_session(self, *, access_token: str):
        payload = _unsign(access_token)
        if payload is None or payload.get("exp", 0) <= int(time.time()):
            return None
        return Session(
            user_id=payload["sub"],
            email=payload["email"],
            display_name=payload["name"],
            org_id=payload["org_id"],
            provider=self.name,
            expires_at=payload["exp"],
            access_token=access_token,
            refresh_token="",
        )

    def refresh_session(self, *, refresh_token: str) -> Session:
        payload = _unsign(refresh_token)
        if payload is None or payload.get("kind") != "refresh" or payload.get("exp", 0) <= int(time.time()):
            raise RefreshExpiredError("spike refresh token expired/invalid")
        return self._session()

    def revoke_session(self, *, refresh_token: str) -> None:
        return None

    @staticmethod
    def _session() -> Session:
        now = int(time.time())
        exp = now + 3600
        return Session(
            user_id="spike-user-1",
            email="spike@example.test",
            display_name="Spike User",
            org_id="spike-org-1",
            provider="spike-password",
            expires_at=exp,
            access_token=_sign({"sub": "spike-user-1", "email": "spike@example.test",
                                "name": "Spike User", "org_id": "spike-org-1", "exp": exp}),
            refresh_token=_sign({"sub": "spike-user-1", "kind": "refresh", "exp": now + 86400}),
        )


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=9212)
    args = parser.parse_args()

    register_provider(SpikePasswordProvider())

    from hermes_cli.web_server import start_server

    start_server(
        host=args.host,
        port=args.port,
        open_browser=False,
        headless=False,
        isolated=True,
    )


if __name__ == "__main__":
    main()
