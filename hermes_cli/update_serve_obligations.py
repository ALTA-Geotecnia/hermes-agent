"""Durable manual-serve handoffs, independent of gateway restart receipts."""

import json
import logging
import math
import os
import sys
import tempfile
from pathlib import Path

from hermes_constants import get_hermes_home

logger = logging.getLogger(__name__)


def defer_manual_serve(runtime: dict, *, require_alive: bool = False) -> bool:
    """Transfer an identified manual runtime to its own durable restart reminder."""
    from hermes_cli.process_identity import _pid_alive_matches

    if runtime.get("kind") not in ("serve", "dashboard") or runtime.get("supervisor") != "manual-serve" or runtime.get("restart_via") != "respawn-argv":
        return False
    pid = runtime.get("pid")
    detail = runtime.get("detail")
    if not isinstance(detail, dict):
        return False
    created = detail.get("create_time")
    if type(pid) is not int or pid <= 0 or type(created) not in (int, float) or not math.isfinite(created) or created <= 0:
        return False
    try:
        alive = _pid_alive_matches(pid, created)
        if require_alive and alive is not True:
            return False
        if alive is False:
            return True
        directory = get_hermes_home() / "serve_restart_pending"
        directory.mkdir(parents=True, exist_ok=True)
        row = {"kind": runtime["kind"], "profile": runtime.get("profile", "unknown"), "pid": pid, "create_time": created}
        target = directory / f"{pid}-{float(created).hex()}.json"
        # One immutable file per incarnation avoids read/merge/write races between CLI startups.
        with tempfile.NamedTemporaryFile(mode="w", encoding="utf-8", dir=directory, delete=False) as handle:
            temporary = Path(handle.name)
            json.dump(row, handle)
            handle.flush()
            os.fsync(handle.fileno())
        try:
            os.replace(temporary, target)
        finally:
            temporary.unlink(missing_ok=True)
        return True
    except (OSError, ValueError, TypeError) as exc:
        logger.debug("Could not preserve manual serve obligation: %s", exc)
        return False


def warn_pending_manual_serves(*, startup: bool = False) -> None:
    """Keep reminders until the recorded incarnation is provably gone; never restart it."""
    from hermes_cli.process_identity import _pid_alive_matches

    stream = sys.stderr if startup else sys.stdout
    directory = get_hermes_home() / "serve_restart_pending"
    for path in sorted(directory.glob("*.json")):
        try:
            row = json.loads(path.read_text(encoding="utf-8"))
            if _pid_alive_matches(row["pid"], row["create_time"]) is False:
                path.unlink(missing_ok=True)
                continue
            print(f"  ⚠ {row['kind']} [{row['profile']}] pid {row['pid']}: manual restart still pending; this process may still serve pre-update code.", file=stream)
            print("    Ask its owner to relaunch `hermes serve` / `hermes dashboard` (reconnect Desktop for an SSH backend).", file=stream)
        except (OSError, ValueError, KeyError, TypeError) as exc:
            logger.debug("Could not reconcile manual serve obligation %s: %s", path, exc)
            print(f"  ⚠ Manual serve restart reminder could not be verified: {path.name}", file=stream)
