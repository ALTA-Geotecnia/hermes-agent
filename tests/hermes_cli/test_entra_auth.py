"""Tests for hermes_cli.entra_auth — reads the Entra access-token file Electron maintains."""

from __future__ import annotations

import json
import time

import pytest


@pytest.fixture
def token_file(tmp_path, monkeypatch):
    path = tmp_path / "entra-access-token.json"
    monkeypatch.setenv("HERMES_ENTRA_ACCESS_TOKEN_FILE", str(path))
    return path


class TestGetEntraAccessToken:
    def test_none_when_env_var_unset(self, monkeypatch):
        monkeypatch.delenv("HERMES_ENTRA_ACCESS_TOKEN_FILE", raising=False)
        from hermes_cli.entra_auth import get_entra_access_token
        assert get_entra_access_token() is None

    def test_none_when_file_missing(self, token_file):
        from hermes_cli.entra_auth import get_entra_access_token
        assert get_entra_access_token() is None

    def test_returns_token_when_valid_and_not_expired(self, token_file):
        token_file.write_text(json.dumps({"accessToken": "abc123", "expiresAt": time.time() + 3600}))
        from hermes_cli.entra_auth import get_entra_access_token
        assert get_entra_access_token() == "abc123"

    def test_none_when_expired(self, token_file):
        token_file.write_text(json.dumps({"accessToken": "abc123", "expiresAt": time.time() - 60}))
        from hermes_cli.entra_auth import get_entra_access_token
        assert get_entra_access_token() is None

    def test_none_when_file_malformed(self, token_file):
        token_file.write_text("not json")
        from hermes_cli.entra_auth import get_entra_access_token
        assert get_entra_access_token() is None

    def test_none_when_token_field_missing(self, token_file):
        token_file.write_text(json.dumps({"expiresAt": time.time() + 3600}))
        from hermes_cli.entra_auth import get_entra_access_token
        assert get_entra_access_token() is None


class TestEntraBearerHeader:
    def test_wraps_token_as_bearer_header(self, token_file):
        token_file.write_text(json.dumps({"accessToken": "abc123", "expiresAt": time.time() + 3600}))
        from hermes_cli.entra_auth import entra_bearer_header
        assert entra_bearer_header() == {"Authorization": "Bearer abc123"}

    def test_empty_dict_when_no_token(self, monkeypatch):
        monkeypatch.delenv("HERMES_ENTRA_ACCESS_TOKEN_FILE", raising=False)
        from hermes_cli.entra_auth import entra_bearer_header
        assert entra_bearer_header() == {}
