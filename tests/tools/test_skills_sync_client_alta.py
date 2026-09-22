"""Tests for tools.skills_sync_client_alta — one-way mirror of the ALTA-curated skill catalog.

Unlike tools/skills_sync_client.py (personal sync, CAS objects/commits) and
tools/skills_sync_client_org.py (org mirror with fingerprint/merge/propose-back), this
client has no merge machinery to test: the server curates, the client only reflects. Tests
focus on the inert gates, the materialize/remove/no-op cycle, and path-safety against a
network-sourced catalog.
"""

from __future__ import annotations

import json
import time
from pathlib import Path
from unittest.mock import patch

import pytest


# ---------------------------------------------------------------------------
# Fixtures / helpers
# ---------------------------------------------------------------------------

def _set_base_url(monkeypatch, url: str) -> None:
    from hermes_cli.providers import HERMES_OVERLAYS, HermesOverlay
    monkeypatch.setitem(HERMES_OVERLAYS, "alta", HermesOverlay(base_url_override=url))


def _install_token(tmp_path, monkeypatch, token: str = "tok-abc") -> None:
    token_file = tmp_path / "entra-access-token.json"
    token_file.write_text(json.dumps({"accessToken": token, "expiresAt": time.time() + 3600}))
    monkeypatch.setenv("HERMES_ENTRA_ACCESS_TOKEN_FILE", str(token_file))


def _fake_response(payload: dict):
    class _Resp:
        def __enter__(self_inner):
            return self_inner

        def __exit__(self_inner, *exc):
            return False

        def read(self_inner):
            return json.dumps(payload).encode()

    return _Resp()


def _catalog(skills, version=1, updated_at="2026-09-21T12:00:00Z") -> dict:
    return {"version": version, "updated_at": updated_at, "skills": skills}


def _skill(slug: str, files: dict) -> dict:
    return {
        "slug": slug,
        "name": slug.replace("-", " ").title(),
        "description": f"{slug} description",
        "content_hash": "deadbeef",
        "files": files,
    }


@pytest.fixture(autouse=True)
def _ready_target(tmp_path, monkeypatch):
    """Every test starts with a valid base URL + token; individual tests override to
    exercise the inert gates."""
    _set_base_url(monkeypatch, "https://alta.example/intranet/hermes-server/api/v1")
    _install_token(tmp_path, monkeypatch)


def _pull_dir():
    from tools.skills_sync_client_alta import _alta_skills_dir
    return _alta_skills_dir()


# ---------------------------------------------------------------------------
# Inert gates — no network call at all
# ---------------------------------------------------------------------------

class TestInertGating:
    def test_no_token_is_inert(self, monkeypatch):
        from tools import skills_sync_client_alta as ssca

        monkeypatch.delenv("HERMES_ENTRA_ACCESS_TOKEN_FILE", raising=False)
        with patch("urllib.request.urlopen", side_effect=AssertionError("must not hit the network")):
            assert ssca.fetch_catalog() is None
            assert ssca.pull_alta_skills() is None
            assert ssca.maybe_pull_alta_skills() is None

    def test_no_base_url_is_inert(self, monkeypatch):
        from tools import skills_sync_client_alta as ssca

        _set_base_url(monkeypatch, "")
        with patch("urllib.request.urlopen", side_effect=AssertionError("must not hit the network")):
            assert ssca.fetch_catalog() is None
            assert ssca.pull_alta_skills() is None
            assert ssca.maybe_pull_alta_skills() is None


# ---------------------------------------------------------------------------
# fetch_catalog
# ---------------------------------------------------------------------------

class TestFetchCatalog:
    def test_fetch_success_returns_parsed_dict(self):
        from tools import skills_sync_client_alta as ssca

        catalog = _catalog([_skill("demo", {"SKILL.md": "# Demo"})])
        captured = {}

        def fake_urlopen(req, timeout=None):
            captured["url"] = req.full_url
            captured["headers"] = dict(req.header_items())
            return _fake_response(catalog)

        with patch("urllib.request.urlopen", side_effect=fake_urlopen):
            result = ssca.fetch_catalog()

        assert result == catalog
        assert captured["url"].endswith("/alta-skills/catalog")
        assert captured["headers"].get("Authorization") == "Bearer tok-abc"

    def test_network_error_returns_none(self):
        import urllib.error

        from tools import skills_sync_client_alta as ssca

        with patch("urllib.request.urlopen", side_effect=urllib.error.URLError("boom")):
            assert ssca.fetch_catalog() is None

    def test_malformed_schema_returns_none(self):
        from tools import skills_sync_client_alta as ssca

        with patch("urllib.request.urlopen", side_effect=lambda req, timeout=None: _fake_response({"oops": True})):
            assert ssca.fetch_catalog() is None


# ---------------------------------------------------------------------------
# pull_alta_skills — materialize / remove / no-op
# ---------------------------------------------------------------------------

class TestPullAltaSkills:
    def test_materializes_catalog_files(self):
        from tools import skills_sync_client_alta as ssca

        catalog = _catalog([
            _skill("demo-skill", {
                "SKILL.md": "# Demo Skill\n",
                "references/extra.md": "extra content",
            })
        ])
        with patch("urllib.request.urlopen", side_effect=lambda req, timeout=None: _fake_response(catalog)):
            result = ssca.pull_alta_skills()

        assert result == {"updated": ["demo-skill"], "removed": []}
        skill_dir = _pull_dir() / "demo-skill"
        assert (skill_dir / "SKILL.md").read_text(encoding="utf-8") == "# Demo Skill\n"
        assert (skill_dir / "references" / "extra.md").read_text(encoding="utf-8") == "extra content"

    def test_slug_removed_from_catalog_is_deleted_locally(self):
        from tools import skills_sync_client_alta as ssca

        first = _catalog([
            _skill("keep-me", {"SKILL.md": "keep"}),
            _skill("drop-me", {"SKILL.md": "drop"}),
        ])
        with patch("urllib.request.urlopen", side_effect=lambda req, timeout=None: _fake_response(first)):
            ssca.pull_alta_skills()
        assert (_pull_dir() / "drop-me").is_dir()

        second = _catalog([_skill("keep-me", {"SKILL.md": "keep"})], version=2)
        with patch("urllib.request.urlopen", side_effect=lambda req, timeout=None: _fake_response(second)):
            result = ssca.pull_alta_skills()

        assert result == {"updated": ["keep-me"], "removed": ["drop-me"]}
        assert not (_pull_dir() / "drop-me").exists()
        assert (_pull_dir() / "keep-me").is_dir()

    def test_unchanged_catalog_does_not_rewrite_disk(self):
        from tools import skills_sync_client_alta as ssca

        catalog = _catalog([_skill("stable", {"SKILL.md": "stable content"})])
        with patch("urllib.request.urlopen", side_effect=lambda req, timeout=None: _fake_response(catalog)):
            first_result = ssca.pull_alta_skills()
        assert first_result is not None

        # Same version/updated_at/slug set, on disk unchanged -> must be a pure no-op:
        # _materialize_skill must not even be called.
        with patch("urllib.request.urlopen", side_effect=lambda req, timeout=None: _fake_response(catalog)), \
             patch("tools.skills_sync_client_alta._materialize_skill") as materialize:
            second_result = ssca.pull_alta_skills()

        assert second_result is None
        materialize.assert_not_called()

    def test_registers_mirror_dir_in_external_dirs(self):
        from hermes_cli.config import load_config
        from tools import skills_sync_client_alta as ssca

        catalog = _catalog([_skill("demo", {"SKILL.md": "x"})])
        with patch("urllib.request.urlopen", side_effect=lambda req, timeout=None: _fake_response(catalog)):
            ssca.pull_alta_skills()

        config = load_config()
        external_dirs = config.get("skills", {}).get("external_dirs") or []
        assert str(ssca._alta_skills_dir()) in [str(Path(d)) for d in external_dirs]


# ---------------------------------------------------------------------------
# Path safety — the catalog is network-sourced, untrusted content
# ---------------------------------------------------------------------------

class TestMaliciousPaths:
    def test_parent_traversal_path_is_rejected(self, tmp_path):
        from tools import skills_sync_client_alta as ssca

        catalog = _catalog([
            _skill("evil", {
                "../../etc/passwd": "pwned",
                "SKILL.md": "legit content",
            })
        ])
        with patch("urllib.request.urlopen", side_effect=lambda req, timeout=None: _fake_response(catalog)):
            ssca.pull_alta_skills()

        mirror_root = _pull_dir()
        assert (mirror_root / "evil" / "SKILL.md").read_text(encoding="utf-8") == "legit content"
        # Nothing was written outside the mirror root.
        for path in mirror_root.rglob("*"):
            assert mirror_root in path.resolve().parents or path.resolve() == mirror_root.resolve()
        assert not (mirror_root.parent.parent / "etc" / "passwd").exists()

    def test_absolute_path_is_rejected(self):
        from tools import skills_sync_client_alta as ssca

        catalog = _catalog([
            _skill("evil2", {
                "/etc/passwd": "pwned",
                "SKILL.md": "legit content",
            })
        ])
        with patch("urllib.request.urlopen", side_effect=lambda req, timeout=None: _fake_response(catalog)):
            ssca.pull_alta_skills()

        assert (_pull_dir() / "evil2" / "SKILL.md").read_text(encoding="utf-8") == "legit content"
        assert not Path("/etc/passwd").exists() or "pwned" not in Path("/etc/passwd").read_text(errors="ignore")


# ---------------------------------------------------------------------------
# maybe_pull_alta_skills — never raises
# ---------------------------------------------------------------------------

class TestMaybePullNeverRaises:
    def test_network_error_never_raises(self):
        import urllib.error

        from tools import skills_sync_client_alta as ssca

        with patch("urllib.request.urlopen", side_effect=urllib.error.URLError("boom")):
            assert ssca.maybe_pull_alta_skills() is None

    def test_unexpected_exception_never_raises(self):
        from tools import skills_sync_client_alta as ssca

        with patch("tools.skills_sync_client_alta.fetch_catalog", side_effect=RuntimeError("kaboom")):
            assert ssca.maybe_pull_alta_skills() is None


# ---------------------------------------------------------------------------
# Wiring — guards the integration gap (function exists but nothing calls it)
# ---------------------------------------------------------------------------

class TestAltaPullIsWiredIn:
    """Mirrors tests/agent/test_org_skill_namespace.py::TestOrgPullIsWiredIn: assert the
    CALL SITES exist so this can't silently become dead code."""

    def _read(self, *parts) -> str:
        root = Path(__file__).resolve().parents[2]
        return root.joinpath(*parts).read_text(encoding="utf-8")

    def test_cli_startup_calls_maybe_pull_alta_skills(self):
        src = self._read("cli.py")
        assert "maybe_pull_alta_skills" in src
        # Alongside the existing pulls, not replacing them.
        assert "maybe_pull_skills" in src
        assert "maybe_pull_org_skills" in src

    def test_gateway_housekeeping_calls_maybe_pull_alta_skills(self):
        src = self._read("gateway", "run.py")
        assert "maybe_pull_alta_skills" in src
        assert "_housekeeping_alta_skill_sync" in src

    def test_web_server_sessions_calls_maybe_pull_alta_skills(self):
        src = self._read("hermes_cli", "web_server_sessions.py")
        assert "maybe_pull_alta_skills" in src

    def test_main_platform_setup_calls_maybe_pull_alta_skills(self):
        src = self._read("hermes_cli", "main_platform_setup.py")
        assert "maybe_pull_alta_skills" in src
