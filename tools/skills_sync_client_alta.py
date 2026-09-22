"""Read-only mirror of the ALTA-curated skill catalog.

The ALTA server (``server/`` — implemented separately) curates a small library of skills
and exposes it at ``GET <alta base url>/alta-skills/catalog``. Every Hermes install should
reflect that catalog automatically, without the user installing anything by hand.

This is a ONE-WAY mirror: the server curates, this module only reflects. Unlike its siblings
``tools/skills_sync_client.py`` (personal sync) and ``tools/skills_sync_client_org.py`` (org
mirror with fingerprint/merge/propose-back), there is no local-edit tracking, no merge, and
no conflict — a changed catalog simply replaces what is on disk under ``_alta/``.

Reuses existing infrastructure rather than inventing new config surface:
  - base URL: ``HERMES_OVERLAYS["alta"].base_url_override`` (hermes_cli/providers.py), the
    same source ``hermes_cli.runtime_provider._resolve_alta_runtime`` uses for the chat relay.
  - auth: ``hermes_cli.entra_auth.get_entra_access_token()``, the same Entra token the relay
    already refreshes; no separate login.
  - visibility: ``skills.external_dirs`` (hermes_cli/config_defaults.py), the existing generic
    "extra read-only skill directories" mechanism — no new prompt-builder wiring needed.

Every public entry point follows the "never raises" contract already established by
``maybe_pull_skills``/``maybe_pull_org_skills``: any absence (no base URL, no token, network
error, malformed catalog) is silently inert.
"""

from __future__ import annotations

import json
import logging
import shutil
import urllib.error
import urllib.request
from pathlib import Path, PurePosixPath
from typing import Any, Optional

logger = logging.getLogger(__name__)

_CATALOG_PATH_SUFFIX = "/alta-skills/catalog"
_FETCH_TIMEOUT_SECONDS = 5.0
_STATE_FILENAME = ".alta_sync_state.json"
_MIRROR_DIR_NAME = "_alta"


def _alta_skills_dir() -> Path:
    """``<skills_dir>/_alta`` — local mirror root for ALTA-curated skills."""
    from hermes_constants import get_skills_dir
    return get_skills_dir() / _MIRROR_DIR_NAME


def _state_path() -> Path:
    return _alta_skills_dir() / _STATE_FILENAME


def _user_agent() -> str:
    from hermes_cli import __version__
    return f"hermes-cli/{__version__}"


def _resolve_alta_sync_target() -> Optional[tuple[str, str]]:
    """``(base_url, token)`` for the ALTA skills catalog, or None when either is unset.

    Reuses the exact base-URL and token sources the ALTA chat relay already uses
    (see module docstring) — no new config or login flow.
    """
    from hermes_cli.entra_auth import get_entra_access_token
    from hermes_cli.providers import HERMES_OVERLAYS

    base_url = (HERMES_OVERLAYS["alta"].base_url_override or "").rstrip("/")
    token = get_entra_access_token()
    if not base_url or not token:
        return None
    return base_url, token


def fetch_catalog() -> Optional[dict[str, Any]]:
    """GET the ALTA skills catalog. Returns the parsed dict, or None on any error (never raises)."""
    target = _resolve_alta_sync_target()
    if target is None:
        return None
    base_url, token = target
    url = base_url + _CATALOG_PATH_SUFFIX
    # The User-Agent is not cosmetic: the server sits behind Cloudflare, which answers a
    # default "Python-urllib/x.y" agent with a 1010 block before the request ever reaches it.
    headers = {
        "Accept": "application/json",
        "User-Agent": _user_agent(),
        "Authorization": f"Bearer {token}",
    }
    try:
        req = urllib.request.Request(url, headers=headers)
        with urllib.request.urlopen(req, timeout=_FETCH_TIMEOUT_SECONDS) as resp:
            data = json.loads(resp.read().decode())
    except (urllib.error.URLError, TimeoutError, json.JSONDecodeError, OSError) as exc:
        logger.debug("alta skills catalog fetch failed (%s): %s", url, exc)
        return None
    except Exception as exc:  # pragma: no cover — defensive
        logger.debug("alta skills catalog fetch errored (%s): %s", url, exc)
        return None
    if not isinstance(data, dict) or not isinstance(data.get("skills"), list):
        logger.debug("alta skills catalog at %s failed schema validation", url)
        return None
    return data


def _read_state() -> dict[str, Any]:
    try:
        raw = json.loads(_state_path().read_text(encoding="utf-8"))
        return raw if isinstance(raw, dict) else {}
    except (OSError, ValueError):
        return {}


def _write_state(version: Any, updated_at: Any, hashes: dict[str, Any]) -> None:
    from utils import atomic_json_write
    atomic_json_write(_state_path(), {
        "version": version,
        "updated_at": updated_at,
        "hashes": hashes,
    })


def _is_safe_relative_path(rel_path: str) -> bool:
    """Reject absolute paths and any ``..`` component — this is network-sourced content and
    must never be allowed to write outside the mirror directory."""
    if not isinstance(rel_path, str) or not rel_path.strip():
        return False
    if rel_path.startswith(("/", "\\")):
        return False
    if len(rel_path) >= 2 and rel_path[1] == ":":  # Windows drive letter, e.g. "C:\\..."
        return False
    posix = PurePosixPath(rel_path.replace("\\", "/"))
    if posix.is_absolute():
        return False
    parts = posix.parts
    return bool(parts) and ".." not in parts


def _materialize_skill(slug: str, files: dict[str, str]) -> None:
    """Replace ``_alta/<slug>/`` on disk with exactly the files given (invalid paths skipped)."""
    skill_dir = _alta_skills_dir() / slug
    shutil.rmtree(skill_dir, ignore_errors=True)
    for rel_path, content in files.items():
        if not _is_safe_relative_path(rel_path) or not isinstance(content, str):
            logger.debug("alta skills sync: rejecting unsafe entry %r in skill %r", rel_path, slug)
            continue
        dest = skill_dir / rel_path
        dest.parent.mkdir(parents=True, exist_ok=True)
        dest.write_text(content, encoding="utf-8")


def _existing_slug_dirs() -> set[str]:
    root = _alta_skills_dir()
    if not root.is_dir():
        return set()
    return {p.name for p in root.iterdir() if p.is_dir()}


def _ensure_external_dir_registered() -> None:
    """Best-effort, idempotent: add ``_alta_skills_dir()`` to ``skills.external_dirs`` so the
    mirror is picked up by the existing external-skills-dir mechanism (no prompt-builder
    changes needed). Never raises."""
    from hermes_cli.config import load_config, save_config

    alta_dir = str(_alta_skills_dir())
    try:
        config = load_config()
        skills_cfg = config.setdefault("skills", {})
        external_dirs = skills_cfg.get("external_dirs") or []
        if not isinstance(external_dirs, list):
            external_dirs = [external_dirs]
        external_dirs = [str(d) for d in external_dirs]
        already_present = any(str(Path(d).expanduser()) == alta_dir for d in external_dirs)
        if already_present:
            return
        external_dirs.append(alta_dir)
        skills_cfg["external_dirs"] = external_dirs
        save_config(config)
    except Exception as exc:
        logger.debug("alta skills sync: could not register external dir: %s", exc)


def pull_alta_skills() -> Optional[dict[str, Any]]:
    """Fetch the ALTA catalog and materialize it into ``_alta/``.

    A skill is rewritten only when its ``content_hash`` differs from the mirrored one or
    its directory is missing — the server publishes that hash precisely so the client can
    tell a changed skill from an unchanged one without comparing bytes. Relying on the
    catalog's ``updated_at`` instead would miss a change in what the server renders from
    unchanged records. Returns None when nothing had to be written or removed.

    Returns ``{"updated": [...slugs...], "removed": [...slugs...]}`` on a real sync.
    """
    catalog = fetch_catalog()
    if catalog is None:
        return None

    skills = [s for s in (catalog.get("skills") or []) if isinstance(s, dict) and s.get("slug")]
    incoming_hashes = {s["slug"]: s.get("content_hash") for s in skills}

    state = _read_state()
    mirrored_hashes = state.get("hashes") or {}
    on_disk_slugs = _existing_slug_dirs()

    stale = {
        slug for slug, digest in incoming_hashes.items()
        if mirrored_hashes.get(slug) != digest or slug not in on_disk_slugs
    }
    removed = sorted(on_disk_slugs - set(incoming_hashes))
    if not stale and not removed:
        return None

    root = _alta_skills_dir()
    root.mkdir(parents=True, exist_ok=True)

    for skill in skills:
        files = skill.get("files")
        if skill["slug"] in stale and isinstance(files, dict):
            _materialize_skill(skill["slug"], files)

    for slug in removed:
        shutil.rmtree(root / slug, ignore_errors=True)

    _write_state(catalog.get("version"), catalog.get("updated_at"), incoming_hashes)
    _ensure_external_dir_registered()
    return {"updated": sorted(stale), "removed": removed}


def maybe_pull_alta_skills() -> Optional[dict[str, Any]]:
    """Best-effort ALTA skills pull (curator tick sites: gateway housekeeping + CLI/session
    startup). Never raises; None when inert, unchanged, or failed."""
    try:
        return pull_alta_skills()
    except Exception as exc:
        logger.debug("skills_sync_client_alta: maybe_pull_alta_skills inert/failed: %s", exc)
        return None
