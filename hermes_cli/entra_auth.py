"""Reads the Microsoft Entra ID access token the desktop Electron process maintains.

``apps/desktop/electron/main.ts`` owns the actual login (PKCE, silent refresh — see
hermes-agent-bau) and writes the current access token to
``HERMES_ENTRA_ACCESS_TOKEN_FILE`` (mode 0600) every time it is issued or renewed. This
module only reads that file. Outside the ALTA desktop build (CLI, TUI, tests, upstream)
the env var is unset, so :func:`entra_bearer_header` always returns ``{}`` and nothing
here changes behavior anywhere else.

The client never constructs ``X-Auth-Request-Email``/``X-Auth-Request-User`` itself —
those are injected by oauth2-proxy only after it validates this Bearer token.
"""

from __future__ import annotations

import json
import logging
import os
import time
from pathlib import Path

logger = logging.getLogger(__name__)


def _token_file_path() -> Path | None:
    raw = os.environ.get("HERMES_ENTRA_ACCESS_TOKEN_FILE")
    return Path(raw) if raw else None


def get_entra_access_token() -> str | None:
    """The current Entra access token, or None when unset, unreadable, or expired."""
    path = _token_file_path()
    if path is None:
        return None
    try:
        with open(path, encoding="utf-8") as fh:
            data = json.load(fh)
    except (OSError, json.JSONDecodeError) as exc:
        logger.debug("Entra access-token file unreadable (%s): %s", path, exc)
        return None
    token = data.get("accessToken")
    expires_at = data.get("expiresAt")
    if not isinstance(token, str) or not token.strip():
        return None
    if isinstance(expires_at, (int, float)) and expires_at <= time.time():
        logger.debug("Entra access token at %s is expired", path)
        return None
    return token


def entra_bearer_header() -> dict[str, str]:
    """``{"Authorization": "Bearer <token>"}`` when a valid token is available, else ``{}``."""
    token = get_entra_access_token()
    return {"Authorization": f"Bearer {token}"} if token else {}
