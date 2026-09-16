"""Historical receipts cannot lend ownership to an empty marker observation."""

import json

import pytest

from hermes_cli import process_identity, update_cmd_fleet as fleet, update_receipt
from hermes_constants import get_hermes_home

MANUAL = {"kind": "serve", "profile": "work", "pid": 900, "supervisor": "manual-serve", "restart_via": "respawn-argv", "code_sha": "old", "detail": {"create_time": 1000.0}}
CURRENT = {"profile": "alpha", "state": "current", "code_sha": "new"}
GATEWAY = {"kind": "gateway", "profile": "alpha", "code_sha": "old"}

CASES = [
    ("receipt-successor", {"outcome": "failed", "plan": {"runtimes": [GATEWAY]}}, None, [CURRENT], False),
    ("marker-external-restart", {}, "new", [CURRENT], False),
    ("missing-sibling", {"outcome": "failed", "plan": {"runtimes": [GATEWAY, dict(GATEWAY, profile="beta")]}}, "new", [CURRENT], True),
    ("stale-successor", {"outcome": "failed", "plan": {"runtimes": [GATEWAY]}}, None, [dict(CURRENT, state="stale", code_sha="old")], True),
    ("unknown-successor", {"outcome": "failed", "plan": {"runtimes": [GATEWAY]}}, None, [dict(CURRENT, state="unknown")], True),
    ("marker-no-sha", {}, "", [CURRENT], True),
    ("checkout-moved", {}, "old", [CURRENT], True),
    ("marker-empty-no-receipt", {}, "new", [], True),
    ("markerless-stamped-manual", {"outcome": "partial", "plan": {"runtimes": [MANUAL]}}, None, [], False),
    ("old-manual-new-marker", {"outcome": "success", "post_update": {"sha": "old"}, "plan": {"runtimes": [MANUAL]}, "fleet": []}, "new", [], True),
    ("same-sha-not-ownership", {"outcome": "success", "post_update": {"sha": "new"}, "plan": {"runtimes": [MANUAL]}, "fleet": []}, "new", [], True),
    ("mixed-receipt-successors", {"outcome": "partial", "plan": {"runtimes": [GATEWAY, MANUAL]}, "fleet": [dict(CURRENT, state="stale", code_sha="old")]}, None, [CURRENT], False),
]


def seed(monkeypatch, old, marker, live, alive=True):
    root = get_hermes_home() / "logs" / "update_receipts"
    root.mkdir(parents=True, exist_ok=True)
    target = root / "latest.json"
    target.write_text(json.dumps(old))
    monkeypatch.setattr(process_identity, "_pid_alive_matches", lambda *a: alive)
    monkeypatch.setattr(fleet, "_current_checkout_sha", lambda: "new")
    monkeypatch.setattr("hermes_cli.update_cmd._current_checkout_sha", lambda: "new")
    monkeypatch.setattr(update_receipt, "collect_fleet_versions", lambda **k: live)
    if marker is not None:
        fleet._write_fleet_restart_pending_marker(expected_sha=marker)
    return target


@pytest.mark.parametrize("name,old,marker,live,pending", CASES, ids=[case[0] for case in CASES])
def test_scoped_reconciliation_matrix(monkeypatch, capsys, name, old, marker, live, pending):
    target = seed(monkeypatch, old, marker, live)
    before = target.read_bytes()
    assert fleet._pending_fleet_restart_needed() is pending
    fleet._warn_pending_fleet_restart_on_startup()
    assert ("hermes gateway restart" in capsys.readouterr().err) is pending
    # Catch-up must share the warning decision without restarting from a cron caller.
    fleet._apply_pending_fleet_restart_catchup(defer=True)
    assert ("fleet restart deferred" in capsys.readouterr().out) is pending
    assert target.read_bytes() == before
    assert fleet._fleet_restart_pending_marker_path().exists() is (marker is not None and pending)


@pytest.mark.parametrize("alive", [True, False, None], ids=["alive", "dead", "unknown"])
@pytest.mark.parametrize("sha", ["old", "new", None], ids=["different-sha", "same-sha", "no-sha"])
def test_empty_marker_never_inherits_receipt_ownership(monkeypatch, capsys, alive, sha):
    old = {"outcome": "success", "plan": {"runtimes": [MANUAL]}, "post_update": {"sha": sha}}
    target = seed(monkeypatch, old, "new", [], alive)
    before = target.read_bytes()
    fleet._warn_pending_fleet_restart_on_startup()
    warning = capsys.readouterr().err
    assert "hermes gateway restart" in warning
    assert ("serve [work] pid 900" in warning) is (alive is not False)
    assert fleet._fleet_restart_pending_marker_path().exists()
    assert target.read_bytes() == before


@pytest.mark.parametrize("consumer", ["predicate", "startup"])
def test_reconciliation_uses_one_receipt_snapshot(monkeypatch, capsys, consumer):
    old = {"outcome": "partial", "plan": {"runtimes": [MANUAL]}, "fleet": []}
    seed(monkeypatch, old, None, [])
    reads = []

    def read_rotating_receipt():
        reads.append(True)
        return old if len(reads) == 1 else {"outcome": "failed", "plan": {"runtimes": [GATEWAY]}}

    monkeypatch.setattr(update_receipt, "read_latest_receipt", read_rotating_receipt)
    if consumer == "predicate":
        assert not fleet._pending_fleet_restart_needed()
    else:
        fleet._warn_pending_fleet_restart_on_startup()
        warning = capsys.readouterr().err
        assert "hermes gateway restart" not in warning
        assert "serve [work] pid 900" in warning
    assert len(reads) == 1
    assert list((get_hermes_home() / "serve_restart_pending").glob("*.json"))


@pytest.mark.parametrize("marker", [None, "new"])
@pytest.mark.parametrize("blocked_storage", [False, True])
def test_probe_exception_does_not_hide_manual_warning(monkeypatch, capsys, marker, blocked_storage):
    old = {"outcome": "partial", "plan": {"runtimes": [GATEWAY, MANUAL]}}
    target = seed(monkeypatch, old, marker, [])
    before = target.read_bytes()
    if blocked_storage:
        (get_hermes_home() / "serve_restart_pending").write_text("not a directory")

    def unavailable(**kwargs):
        raise OSError("gateway probe unavailable")

    monkeypatch.setattr(update_receipt, "collect_fleet_versions", unavailable)
    fleet._warn_pending_fleet_restart_on_startup()
    warning = capsys.readouterr().err
    assert "hermes gateway restart" in warning
    assert "serve [work] pid 900" in warning
    assert ("could not be saved" in warning) is blocked_storage
    assert target.read_bytes() == before


def test_marker_reconciliation_collects_one_live_snapshot(monkeypatch):
    seed(monkeypatch, {}, "new", [CURRENT])
    probes = []

    def collect(**kwargs):
        probes.append(True)
        return [CURRENT] if len(probes) == 1 else []

    monkeypatch.setattr(update_receipt, "collect_fleet_versions", collect)
    assert not fleet._pending_fleet_restart_needed()
    assert len(probes) == 1
