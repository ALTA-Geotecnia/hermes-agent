"""``agent.disabled_tools`` — subtract INDIVIDUAL tool names from every selection.

Toolsets are all-or-nothing bundles, so ``disabled_toolsets`` cannot express
"keep this toolset but drop one tool from it". The ALTA fork needs exactly that
for skill_manage: the ``skills`` toolset also carries skill_view and skills_list,
which are what make the server-curated ``_alta/`` mirror usable.

The subtraction lands in ``_select_tool_names`` rather than at a call site so it
holds for every consumer at once — the agent's schema list, ``valid_tool_names``
(derived from it in agent/agent_init.py), the tool_search bridge's uncollapsed
catalog, and the background-review fork that inherits the parent's surface.
"""

import model_tools


def _patch_config(monkeypatch, cfg):
    import hermes_cli.config
    monkeypatch.setattr(hermes_cli.config, "load_config_readonly", lambda: cfg)


def test_named_tool_is_removed_from_the_selection(monkeypatch):
    _patch_config(monkeypatch, {"agent": {"disabled_tools": ["skill_manage"]}})

    names = model_tools._select_tool_names(["skills"], None, quiet_mode=True)

    assert "skill_manage" not in names
    # The rest of the bundle survives: this is a tool-level cut, not a toolset one.
    assert {"skill_view", "skills_list"} <= names


def test_empty_config_changes_nothing(monkeypatch):
    _patch_config(monkeypatch, {})

    names = model_tools._select_tool_names(["skills"], None, quiet_mode=True)

    assert {"skill_manage", "skill_view", "skills_list"} <= names


def test_unreadable_config_does_not_empty_the_tool_list(monkeypatch):
    """Fail-open in the direction that keeps the agent working: a broken config
    costs tokens, an empty tool list costs the whole session."""
    import hermes_cli.config

    def _boom():
        raise RuntimeError("config is gone")

    monkeypatch.setattr(hermes_cli.config, "load_config_readonly", _boom)

    names = model_tools._select_tool_names(["skills"], None, quiet_mode=True)

    assert "skill_view" in names


def test_malformed_value_is_ignored(monkeypatch):
    """A scalar where a list belongs must not be iterated character by character."""
    _patch_config(monkeypatch, {"agent": {"disabled_tools": "skill_manage"}})

    names = model_tools._select_tool_names(["skills"], None, quiet_mode=True)

    assert {"skill_manage", "skill_view", "skills_list"} <= names
