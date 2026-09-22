"""Skill-authoring coaching is gated on skill_manage actually being available.

Removing skill_manage from the tool list (ALTA fork: ``agent.disabled_tools``)
is only half the job — the system prompt kept telling the model to "offer to
save as a skill" and to "fix it with skill_manage(action='patch')". That is a
dangling reference: it spends tokens teaching a tool the model cannot call, and
invites it to announce an action it will then fail to perform.

The ``## Skills`` block already gates its wording on tool availability (it does
not name web_search in a session with no web tools); this extends the same rule
to the authoring lines.

Separately, the ``[SKILL_PRUNED]`` safety rule must NOT disappear along with
skill_manage. It tells the model to reload a compaction-pruned skill with
skill_view — advice that stays correct, and necessary, in a read-only catalog.
"""

from agent import prompt_builder as pb


_CATEGORIES = {"productivity": [("docx", "Editar documentos Word")]}


def _render(available_tools):
    return pb._render_skills_index(_CATEGORIES, {}, None, available_tools)


def test_authoring_lines_are_dropped_without_skill_manage():
    rendered = _render({"skill_view", "skills_list"})

    assert "offer to save as a skill" not in rendered
    assert "skill_manage" not in rendered
    # The index itself is unaffected — the catalog is still advertised and loadable.
    assert "docx" in rendered
    assert "skill_view(name)" in rendered


def test_authoring_lines_are_kept_when_skill_manage_is_available():
    rendered = _render({"skill_view", "skills_list", "skill_manage"})

    assert "offer to save as a skill" in rendered
    assert "skill_manage(action='patch')" in rendered


def test_unknown_tool_surface_keeps_upstream_wording():
    """``available_tools=None`` means "caller did not say"; same convention the
    neighbouring web_search line already uses."""
    assert "skill_manage(action='patch')" in _render(None)


def test_pruned_safety_rule_survives_without_skill_manage():
    """The rule is about reloading via skill_view, so it is gated on skill_view."""
    assert "[SKILL_PRUNED]" in pb.SKILL_PRUNED_SAFETY_RULE
    assert "skill_manage" not in pb.SKILL_PRUNED_SAFETY_RULE
    # Upstream's combined constant still embeds it, so nothing that reads
    # SKILLS_GUIDANCE loses the contract.
    assert pb.SKILL_PRUNED_SAFETY_RULE in pb.SKILLS_GUIDANCE
