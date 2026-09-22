"""A catalog model whose ``role`` is not "chat" can never become the conversation model.

The ALTA server publishes a dedicated entry for the background memory review so
that spend is separable from conversation spend. If a user could switch to it,
the measurement would be meaningless and they would land on a model chosen for a
different job.

Two doors have to be shut, because closing only the first leaves the second open:
  - the pickers (CLI /model, `hermes model`, REST /api/model/options, the desktop
    model menu) all read ``_alta_provider_row``;
  - a hand-typed ``/model <id>`` bypasses every picker and goes to
    ``validate_requested_model``, which for ALTA would otherwise accept anything
    the relay's /v1/models happens to list.

The rule is data-driven: the client hides what the catalog marks, and carries no
hardcoded list of ids.
"""

import pytest

from hermes_cli import inventory, model_catalog, models_validate


CATALOG = {
    "providers": {
        "alta": {
            "metadata": {"display_name": "ALTA"},
            "models": [
                {"id": "glmmodel", "name": "GLM corporativo", "role": "chat", "default": True},
                {"id": "alta-memory", "name": "ALTA memória", "role": "memory"},
            ],
        }
    }
}


@pytest.fixture
def alta_catalog(monkeypatch):
    monkeypatch.setattr(model_catalog, "get_catalog", lambda: CATALOG)
    monkeypatch.setattr(model_catalog, "_fetch_provider_override", lambda provider: None)
    import hermes_cli.web_routers._common as common
    monkeypatch.setattr(common, "byok_disabled", lambda: True)
    return CATALOG


def test_memory_model_is_absent_from_the_picker_row(alta_catalog):
    row = inventory._alta_provider_row("alta")

    assert row is not None
    assert row["models"] == ["glmmodel"]
    assert "alta-memory" not in row["model_labels"]
    assert row["total_models"] == 1


def test_entries_without_a_role_stay_selectable(monkeypatch):
    """Rollout order: the field reaches the catalog before every client reads it,
    and an older server does not publish it at all. Absent means chat."""
    monkeypatch.setattr(model_catalog, "get_catalog", lambda: {
        "providers": {"alta": {"models": [{"id": "glmmodel", "name": "GLM"}]}}
    })
    monkeypatch.setattr(model_catalog, "_fetch_provider_override", lambda provider: None)
    import hermes_cli.web_routers._common as common
    monkeypatch.setattr(common, "byok_disabled", lambda: True)

    assert inventory._alta_provider_row("alta")["models"] == ["glmmodel"]


def test_switching_to_the_memory_model_by_hand_is_rejected(alta_catalog):
    verdict = models_validate.validate_requested_model("alta-memory", "alta")

    assert verdict["accepted"] is False
    assert verdict["persist"] is False
    assert "alta-memory" in verdict["message"]


def test_a_chat_model_still_validates_normally(alta_catalog, monkeypatch):
    """The guard must reject only what the catalog marks — everything else keeps
    falling through the existing ladder."""
    monkeypatch.setattr(models_validate, "_validate_live_listing", lambda req: None)

    verdict = models_validate.validate_requested_model("glmmodel", "alta")

    assert verdict["accepted"] is True


def test_the_guard_only_applies_to_alta(alta_catalog, monkeypatch):
    """An id that collides with an ALTA memory model on another provider is that
    provider's business."""
    monkeypatch.setattr(models_validate, "_validate_live_listing", lambda req: None)

    verdict = models_validate.validate_requested_model("alta-memory", "openai")

    assert verdict["accepted"] is True
