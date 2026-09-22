"""ALTA fork: the self-learning machinery is off by default.

Hermes ships three independent mechanisms that write skills without a human in
the loop — the in-prompt creation nudge, the post-turn background review fork,
and the curator's inactivity pruning. ALTA keeps per-user MEMORY but not
automatic skill authoring: the skill catalog is curated on the server and
mirrored read-only into ``_alta/``, so a client-side writer has nothing
legitimate to add and the curator has nothing legitimate to prune.

These assertions are the contract. Upstream defaults differ on every one of
them, so a merge that silently reverts one has to fail here rather than in
production token spend.
"""

from hermes_cli.config import DEFAULT_CONFIG


def test_skill_creation_nudge_is_disabled():
    """``creation_nudge_interval: 0`` is the single switch that stops both the
    in-prompt nudge and the SKILL half of the background review fork
    (agent/turn_finalizer.py builds ``_should_review_skills`` from it).

    Upstream leaves the key absent and falls back to a hardcoded 10 in
    agent/agent_init.py, so it must be present here, not merely falsy.
    """
    assert "creation_nudge_interval" in DEFAULT_CONFIG["skills"]
    assert DEFAULT_CONFIG["skills"]["creation_nudge_interval"] == 0


def test_curator_is_disabled():
    """No bundled skill may be archived behind the user's back.

    ``PROTECTED_BUILTIN_SKILLS`` is an empty set and ``prune_builtins`` defaults
    to true, so with the curator on, a built-in nobody touched for 30 days
    (docx, pdf, ...) is moved out of the index AND added to
    ``.curator_suppressed`` so ``hermes update`` will not restore it. Recovery
    is a CLI-only ``hermes curator restore``, which an ALTA end user has no way
    to discover.
    """
    assert DEFAULT_CONFIG["curator"]["enabled"] is False


def test_skill_manage_is_not_offered_to_the_model():
    """Config alone cannot remove one tool: ``disabled_toolsets`` takes toolset
    names, and the ``skills`` toolset bundles skill_view and skills_list —
    which ALTA needs — together with skill_manage. Hence ``agent.disabled_tools``.
    """
    assert "skill_manage" in DEFAULT_CONFIG["agent"]["disabled_tools"]


def test_background_review_is_routed_to_a_dedicated_model():
    """Memory review stays on, but not on the main model.

    Unrouted, the fork replays the FULL conversation on the conversation model
    (agent/background_review.py ``_resolve_review_runtime``); routed to a
    different concrete model it replays a bounded digest instead. A dedicated
    catalog id also makes the spend separable on the server, which is the point:
    measure it, then decide whether it earns its keep.

    ``provider`` must be concrete — ``_resolve_review_runtime`` treats "auto"
    as "not routed" and silently falls back to the parent runtime.
    """
    review = DEFAULT_CONFIG["auxiliary"]["background_review"]
    assert review["enabled"] is True
    assert review["provider"] == "alta"
    assert review["model"] == "alta-memory"
