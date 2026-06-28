from __future__ import annotations

import hashlib
import hmac
import pytest

from robomp.github_events import (
    extract_mention,
    is_implementation_authorizer,
    is_maintainer,
    rate_limit_cap,
    route,
    verify_signature,
)

ALLOWLIST = frozenset({"octo/widget"})
BOT = "robomp-bot"


def test_verify_signature_positive() -> None:
    secret = "shh"
    body = b'{"x":1}'
    sig = hmac.new(secret.encode(), body, hashlib.sha256).hexdigest()
    assert verify_signature(secret, body, f"sha256={sig}")


def test_verify_signature_rejects_missing_header() -> None:
    assert not verify_signature("shh", b"{}", None)
    assert not verify_signature("shh", b"{}", "")
    assert not verify_signature("shh", b"{}", "md5=deadbeef")


def test_verify_signature_rejects_wrong_secret() -> None:
    body = b'{"x":1}'
    sig = hmac.new(b"right", body, hashlib.sha256).hexdigest()
    assert not verify_signature("wrong", body, f"sha256={sig}")


def test_route_issue_opened_queues_triage() -> None:
    decision = route(
        "issues",
        {
            "action": "opened",
            "issue": {"number": 4, "user": {"login": "alice"}},
            "repository": {"full_name": "octo/widget"},
        },
        allowlist=ALLOWLIST,
        bot_login=BOT,
    )
    assert decision.should_queue
    assert decision.task == "triage_issue"
    assert decision.issue_key == "octo/widget#4"


def test_route_skips_disallowed_repo() -> None:
    decision = route(
        "issues",
        {"action": "opened", "issue": {"number": 1}, "repository": {"full_name": "other/repo"}},
        allowlist=ALLOWLIST,
        bot_login=BOT,
    )
    assert not decision.should_queue
    assert "allowlist" in decision.reason


def test_route_skips_self_comment() -> None:
    decision = route(
        "issue_comment",
        {
            "action": "created",
            "comment": {"user": {"login": BOT}, "body": "hi"},
            "issue": {"number": 4},
            "repository": {"full_name": "octo/widget"},
        },
        allowlist=ALLOWLIST,
        bot_login=BOT,
    )
    assert not decision.should_queue


def test_route_skips_bot_suffix_comment() -> None:
    decision = route(
        "issue_comment",
        {
            "action": "created",
            "comment": {"user": {"login": "github-actions[bot]", "type": "Bot"}, "body": "ci ran"},
            "issue": {"number": 4},
            "repository": {"full_name": "octo/widget"},
        },
        allowlist=ALLOWLIST,
        bot_login=BOT,
    )
    assert not decision.should_queue
    assert "bot" in decision.reason


def test_route_skips_user_type_bot() -> None:
    decision = route(
        "issue_comment",
        {
            "action": "created",
            "comment": {"user": {"login": "renovate", "type": "Bot"}, "body": "deps"},
            "issue": {"number": 4},
            "repository": {"full_name": "octo/widget"},
        },
        allowlist=ALLOWLIST,
        bot_login=BOT,
    )
    assert not decision.should_queue


def test_route_comment_routes_handle_comment() -> None:
    decision = route(
        "issue_comment",
        {
            "action": "created",
            "comment": {"user": {"login": "alice"}, "body": "hi"},
            "issue": {"number": 4},
            "repository": {"full_name": "octo/widget"},
        },
        allowlist=ALLOWLIST,
        bot_login=BOT,
    )
    assert decision.should_queue
    assert decision.task == "handle_comment"
    assert decision.issue_key == "octo/widget#4"


def test_route_pr_conversation_uses_handle_pr_conversation() -> None:
    """A regular comment on a PR (not a review) must NOT route to handle_review."""
    decision = route(
        "issue_comment",
        {
            "action": "created",
            "comment": {"user": {"login": "alice"}, "body": "looks good"},
            "issue": {"number": 9, "user": {"login": BOT}, "pull_request": {"url": "x"}},
            "repository": {"full_name": "octo/widget"},
        },
        allowlist=ALLOWLIST,
        bot_login=BOT,
        resolve_issue_from_pr=lambda _r, _n: "octo/widget#42",
    )
    assert decision.should_queue
    assert decision.task == "handle_pr_conversation"


def test_route_pr_conversation_normalizes_bot_author_suffix() -> None:
    decision = route(
        "issue_comment",
        {
            "action": "created",
            "comment": {"user": {"login": "alice"}, "body": "looks good"},
            "issue": {"number": 9, "user": {"login": f"{BOT}[bot]"}, "pull_request": {"url": "x"}},
            "repository": {"full_name": "octo/widget"},
        },
        allowlist=ALLOWLIST,
        bot_login=f"@{BOT}[bot]",
        resolve_issue_from_pr=lambda _r, _n: "octo/widget#42",
    )
    assert decision.should_queue
    assert decision.task == "handle_pr_conversation"


def test_route_pr_conversation_uses_resolver_for_inflight_key() -> None:
    """PR-derived events MUST serialize on the originating issue's key."""

    def resolver(repo: str, pr_number: int) -> str | None:
        assert repo == "octo/widget"
        assert pr_number == 9
        return "octo/widget#42"

    decision = route(
        "issue_comment",
        {
            "action": "created",
            "comment": {"user": {"login": "alice"}, "body": "looks good"},
            "issue": {"number": 9, "user": {"login": BOT}, "pull_request": {"url": "x"}},
            "repository": {"full_name": "octo/widget"},
        },
        allowlist=ALLOWLIST,
        bot_login=BOT,
        resolve_issue_from_pr=resolver,
    )
    assert decision.should_queue
    # Same key as if the user had commented on issue #42 directly.
    assert decision.issue_key == "octo/widget#42"


def test_route_pr_conversation_falls_back_to_pr_key_when_resolver_misses() -> None:
    """Unmapped PR comments still queue so the worker can recover from the PR branch."""

    decision = route(
        "issue_comment",
        {
            "action": "created",
            "comment": {"user": {"login": "alice"}, "body": "hi"},
            "issue": {"number": 9, "user": {"login": BOT}, "pull_request": {"url": "x"}},
            "repository": {"full_name": "octo/widget"},
        },
        allowlist=ALLOWLIST,
        bot_login=BOT,
        resolve_issue_from_pr=lambda _r, _n: None,
    )
    assert decision.should_queue
    assert decision.task == "handle_pr_conversation"
    assert decision.submitter == "alice"
    assert decision.issue_key == "octo/widget#9"


def test_route_incoming_pr_opened_queues_review_pr() -> None:
    decision = route(
        "pull_request",
        {
            "action": "opened",
            "pull_request": {
                "number": 9,
                "draft": False,
                "user": {"login": "alice", "type": "User"},
                "author_association": "CONTRIBUTOR",
            },
            "repository": {"full_name": "octo/widget"},
        },
        allowlist=ALLOWLIST,
        bot_login=BOT,
    )
    assert decision.should_queue
    assert decision.task == "review_pr"
    assert decision.issue_key == "octo/widget#9"
    assert decision.submitter == "alice"
    assert decision.association == "CONTRIBUTOR"


def test_route_incoming_pr_opened_skips_draft_bot_and_disabled() -> None:
    payload = {
        "action": "opened",
        "pull_request": {"number": 9, "draft": True, "user": {"login": "alice", "type": "User"}},
        "repository": {"full_name": "octo/widget"},
    }
    assert not route("pull_request", payload, allowlist=ALLOWLIST, bot_login=BOT).should_queue

    payload["pull_request"]["draft"] = False  # type: ignore[index]
    payload["pull_request"]["user"] = {"login": BOT, "type": "Bot"}  # type: ignore[index]
    assert not route("pull_request", payload, allowlist=ALLOWLIST, bot_login=BOT).should_queue

    payload["pull_request"]["user"] = {"login": "alice", "type": "User"}  # type: ignore[index]
    disabled = route("pull_request", payload, allowlist=ALLOWLIST, bot_login=BOT, pr_review_enabled=False)
    assert not disabled.should_queue
    assert "disabled" in disabled.reason


def test_route_pull_request_synchronize_stays_skipped() -> None:
    decision = route(
        "pull_request",
        {
            "action": "synchronize",
            "pull_request": {"number": 9, "user": {"login": "alice"}},
            "repository": {"full_name": "octo/widget"},
        },
        allowlist=ALLOWLIST,
        bot_login=BOT,
    )
    assert not decision.should_queue


def test_route_incoming_pr_comment_skips() -> None:
    decision = route(
        "issue_comment",
        {
            "action": "created",
            "comment": {"user": {"login": "alice"}, "body": "ping"},
            "issue": {"number": 9, "user": {"login": "contributor"}, "pull_request": {"url": "x"}},
            "repository": {"full_name": "octo/widget"},
        },
        allowlist=ALLOWLIST,
        bot_login=BOT,
    )
    assert not decision.should_queue
    assert "incoming PR comments ignored" == decision.reason


def test_route_incoming_pr_comment_with_maintainer_mention_still_skips() -> None:
    decision = route(
        "issue_comment",
        {
            "action": "created",
            "comment": {
                "user": {"login": "can1357"},
                "author_association": "OWNER",
                "body": "@robomp-bot please re-review",
            },
            "issue": {"number": 9, "user": {"login": "contributor"}, "pull_request": {"url": "x"}},
            "repository": {"full_name": "octo/widget"},
        },
        allowlist=ALLOWLIST,
        bot_login=BOT,
    )
    assert not decision.should_queue
    assert decision.issue_key == "octo/widget#9"
    assert decision.reason == "incoming PR comments ignored"


def test_route_review_only_for_bot_authored_pr() -> None:
    decision = route(
        "pull_request_review_comment",
        {
            "action": "created",
            "comment": {"user": {"login": "alice"}, "body": "nit"},
            "pull_request": {"number": 9, "user": {"login": BOT}},
            "repository": {"full_name": "octo/widget"},
        },
        allowlist=ALLOWLIST,
        bot_login=BOT,
        resolve_issue_from_pr=lambda _r, _n: "octo/widget#42",
    )
    assert decision.should_queue
    assert decision.task == "handle_review"
    assert decision.issue_key == "octo/widget#42"

    not_ours = route(
        "pull_request_review_comment",
        {
            "action": "created",
            "comment": {"user": {"login": "alice"}, "body": "nit"},
            "pull_request": {"number": 9, "user": {"login": "someone-else"}},
            "repository": {"full_name": "octo/widget"},
        },
        allowlist=ALLOWLIST,
        bot_login=BOT,
    )
    assert not not_ours.should_queue


def test_route_review_comment_falls_back_to_pr_key_when_resolver_misses() -> None:
    decision = route(
        "pull_request_review_comment",
        {
            "action": "created",
            "comment": {"user": {"login": "alice"}, "body": "nit"},
            "pull_request": {"number": 9, "user": {"login": BOT}},
            "repository": {"full_name": "octo/widget"},
        },
        allowlist=ALLOWLIST,
        bot_login=BOT,
        resolve_issue_from_pr=lambda _r, _n: None,
    )
    assert decision.should_queue
    assert decision.task == "handle_review"
    assert decision.submitter == "alice"
    assert decision.issue_key == "octo/widget#9"


def test_route_pr_closed_cleans_up_any_tracked_pr() -> None:
    payload = {
        "action": "closed",
        "pull_request": {"number": 9, "user": {"login": "alice"}, "merged": False},
        "repository": {"full_name": "octo/widget"},
    }
    decision = route(
        "pull_request",
        payload,
        allowlist=ALLOWLIST,
        bot_login=BOT,
        resolve_issue_from_pr=lambda _r, _n: "octo/widget#42",
    )
    assert decision.should_queue
    assert decision.task == "cleanup_workspace"
    assert decision.issue_key == "octo/widget#42"
    assert decision.reason == "pull_request.closed"

    payload["pull_request"]["merged"] = True  # type: ignore[index]
    merged = route(
        "pull_request",
        payload,
        allowlist=ALLOWLIST,
        bot_login=BOT,
        resolve_issue_from_pr=lambda _r, _n: None,
    )
    assert merged.should_queue
    assert merged.task == "cleanup_workspace"
    assert merged.issue_key == "octo/widget#9"
    assert merged.reason == "pull_request.merged"
    assert merged.submitter is None


def test_route_skips_pull_request_issues_event() -> None:
    decision = route(
        "issues",
        {
            "action": "opened",
            "issue": {"number": 4, "pull_request": {"url": "x"}},
            "repository": {"full_name": "octo/widget"},
        },
        allowlist=ALLOWLIST,
        bot_login=BOT,
    )
    assert not decision.should_queue


def test_route_issue_opened_captures_submitter() -> None:
    decision = route(
        "issues",
        {
            "action": "opened",
            "issue": {
                "number": 4,
                "user": {"login": "alice"},
                "author_association": "FIRST_TIME_CONTRIBUTOR",
            },
            "repository": {"full_name": "octo/widget"},
        },
        allowlist=ALLOWLIST,
        bot_login=BOT,
    )
    assert decision.submitter == "alice"
    assert decision.association == "FIRST_TIME_CONTRIBUTOR"


def test_route_comment_captures_comment_author_association() -> None:
    decision = route(
        "issue_comment",
        {
            "action": "created",
            "comment": {
                "user": {"login": "bob"},
                "body": "hi",
                "author_association": "CONTRIBUTOR",
            },
            "issue": {"number": 4},
            "repository": {"full_name": "octo/widget"},
        },
        allowlist=ALLOWLIST,
        bot_login=BOT,
    )
    assert decision.submitter == "bob"
    assert decision.association == "CONTRIBUTOR"


def test_route_pr_merged_carries_no_submitter() -> None:
    """Lifecycle events (cleanup on merge) are not user submissions."""
    payload = {
        "action": "closed",
        "pull_request": {"number": 9, "user": {"login": BOT}, "merged": True},
        "repository": {"full_name": "octo/widget"},
    }
    decision = route(
        "pull_request",
        payload,
        allowlist=ALLOWLIST,
        bot_login=BOT,
        resolve_issue_from_pr=lambda _r, _n: "octo/widget#42",
    )
    assert decision.should_queue
    assert decision.submitter is None


def test_rate_limit_cap_unlimited_allowlist_beats_association() -> None:
    # Even a NONE association is unlimited when login is in the explicit list.
    assert (
        rate_limit_cap(
            "can1357",
            "NONE",
            unlimited=frozenset({"can1357"}),
            default=3,
            contributor=10,
        )
        is None
    )


def test_rate_limit_cap_unlimited_is_case_insensitive() -> None:
    assert (
        rate_limit_cap(
            "Can1357",
            None,
            unlimited=frozenset({"can1357"}),
            default=3,
            contributor=10,
        )
        is None
    )


def test_rate_limit_cap_trusted_associations_bypass() -> None:
    for assoc in ("OWNER", "MEMBER", "COLLABORATOR"):
        assert (
            rate_limit_cap(
                "stranger",
                assoc,
                unlimited=frozenset(),
                default=3,
                contributor=10,
            )
            is None
        ), assoc


def test_rate_limit_cap_contributor_tier() -> None:
    assert (
        rate_limit_cap(
            "alice",
            "CONTRIBUTOR",
            unlimited=frozenset(),
            default=3,
            contributor=10,
        )
        == 10
    )


def test_rate_limit_cap_default_tier_for_unknown_and_first_timer() -> None:
    for assoc in (None, "NONE", "FIRST_TIME_CONTRIBUTOR", "FIRST_TIMER"):
        assert (
            rate_limit_cap(
                "alice",
                assoc,
                unlimited=frozenset(),
                default=3,
                contributor=10,
            )
            == 3
        ), assoc


# ---------- mention + directive ----------


def test_extract_mention_returns_body_minus_mention() -> None:
    assert extract_mention("hey @robomp-bot please look", "robomp-bot") == "hey please look"
    assert extract_mention("@robomp-bot do X", "robomp-bot") == "do X"


@pytest.mark.parametrize("configured_login", ["@roboomp", "roboomp[bot]", "@roboomp[bot]"])
def test_extract_mention_accepts_prefixed_or_app_bot_login(configured_login: str) -> None:
    assert extract_mention("@roboomp go ahead", configured_login) == "go ahead"


def test_extract_mention_strips_literal_app_suffix_from_body() -> None:
    assert extract_mention("@roboomp[bot] go ahead", "roboomp[bot]") == "go ahead"


def test_extract_mention_rejects_extended_literal_app_suffix() -> None:
    assert extract_mention("@roboomp[bot]-helper go ahead", "roboomp[bot]") is None


def test_extract_mention_returns_none_without_mention() -> None:
    assert extract_mention("hello there", "robomp-bot") is None
    assert extract_mention(None, "robomp-bot") is None
    assert extract_mention("", "robomp-bot") is None


def test_extract_mention_is_case_insensitive() -> None:
    assert extract_mention("yo @ROBOMP-BOT", "robomp-bot") == "yo"


def test_extract_mention_respects_hyphen_word_boundary() -> None:
    # @robomp-bot-helper must NOT match @robomp-bot.
    assert extract_mention("@robomp-bot-helper hi", "robomp-bot") is None


def test_extract_mention_handles_multiple_occurrences() -> None:
    assert extract_mention("@robomp-bot one, then @robomp-bot two", "robomp-bot") == "one, then two"


def test_is_maintainer_recognizes_explicit_allowlist() -> None:
    assert is_maintainer("can1357", None, maintainers=frozenset({"can1357"}))
    assert is_maintainer("Can1357", "NONE", maintainers=frozenset({"can1357"}))


def test_is_maintainer_recognizes_trusted_associations() -> None:
    for assoc in ("OWNER", "MEMBER", "COLLABORATOR"):
        assert is_maintainer("anyone", assoc, maintainers=frozenset()), assoc


def test_is_maintainer_rejects_contributor_and_none() -> None:
    assert not is_maintainer("alice", "CONTRIBUTOR", maintainers=frozenset())
    assert not is_maintainer("alice", None, maintainers=frozenset())
    assert is_maintainer(None, "OWNER", maintainers=frozenset())  # association still wins


def test_is_implementation_authorizer_accepts_allowlist_and_owner() -> None:
    assert is_implementation_authorizer("can1357", None, maintainers=frozenset({"can1357"}))
    assert is_implementation_authorizer("Can1357", "NONE", maintainers=frozenset({"can1357"}))
    assert is_implementation_authorizer("stranger", "OWNER", maintainers=frozenset())


def test_is_implementation_authorizer_rejects_non_owner_associations() -> None:
    for assoc in ("MEMBER", "COLLABORATOR", "NONE", "CONTRIBUTOR", None):
        assert not is_implementation_authorizer("stranger", assoc, maintainers=frozenset()), assoc


def test_route_directive_set_on_issue_comment_when_owner_mentions_bot() -> None:
    decision = route(
        "issue_comment",
        {
            "action": "created",
            "comment": {
                "user": {"login": "can1357"},
                "author_association": "OWNER",
                "body": "@robomp-bot please refactor X",
            },
            "issue": {"number": 9},
            "repository": {"full_name": "octo/widget"},
        },
        allowlist=ALLOWLIST,
        bot_login=BOT,
    )
    assert decision.should_queue
    assert decision.directive is True
    assert decision.directive_body == "please refactor X"
    assert decision.directive_author == "can1357"
    assert decision.directive_authorizes_impl is True


def test_route_directive_set_when_login_in_maintainers_list() -> None:
    decision = route(
        "issue_comment",
        {
            "action": "created",
            "comment": {
                "user": {"login": "can1357"},
                # No author_association field.
                "body": "@robomp-bot do it",
            },
            "issue": {"number": 9},
            "repository": {"full_name": "octo/widget"},
        },
        allowlist=ALLOWLIST,
        bot_login=BOT,
        maintainers=frozenset({"can1357"}),
    )
    assert decision.directive is True
    assert decision.directive_body == "do it"
    assert decision.directive_author == "can1357"
    assert decision.directive_authorizes_impl is True


def test_route_directive_authorizes_personal_repo_owner_without_author_association() -> None:
    decision = route(
        "issue_comment",
        {
            "action": "created",
            "comment": {
                "user": {"login": "can1357"},
                # Some delivery paths omit author_association even for the personal-account repo owner.
                "body": "@robomp-bot go ahead and push",
            },
            "issue": {"number": 9},
            "repository": {"full_name": "can1357/widget", "owner": {"login": "can1357", "type": "User"}},
        },
        allowlist=frozenset({"can1357/widget"}),
        bot_login=BOT,
    )
    assert decision.directive is True
    assert decision.directive_body == "go ahead and push"
    assert decision.directive_author == "can1357"
    assert decision.directive_authorizes_impl is True
    assert decision.association == "OWNER"


def test_route_directive_does_not_authorize_org_owner_name_without_author_association() -> None:
    decision = route(
        "issue_comment",
        {
            "action": "created",
            "comment": {
                "user": {"login": "octo"},
                "body": "@robomp-bot go ahead and push",
            },
            "issue": {"number": 9},
            "repository": {"full_name": "octo/widget", "owner": {"login": "octo", "type": "Organization"}},
        },
        allowlist=ALLOWLIST,
        bot_login=BOT,
    )
    assert decision.directive is False
    assert decision.directive_authorizes_impl is False


def test_route_directive_from_collaborator_does_not_authorize_impl() -> None:
    decision = route(
        "issue_comment",
        {
            "action": "created",
            "comment": {
                "user": {"login": "oldschoola"},
                "author_association": "COLLABORATOR",
                "body": "@robomp-bot go ahead with the plan",
            },
            "issue": {"number": 9},
            "repository": {"full_name": "octo/widget"},
        },
        allowlist=ALLOWLIST,
        bot_login=BOT,
    )
    assert decision.directive is True
    assert decision.directive_body == "go ahead with the plan"
    assert decision.directive_authorizes_impl is False


def test_route_directive_unset_for_random_user_even_with_mention() -> None:
    decision = route(
        "issue_comment",
        {
            "action": "created",
            "comment": {
                "user": {"login": "stranger"},
                "author_association": "NONE",
                "body": "@robomp-bot please refactor X",
            },
            "issue": {"number": 9},
            "repository": {"full_name": "octo/widget"},
        },
        allowlist=ALLOWLIST,
        bot_login=BOT,
    )
    assert decision.should_queue  # comment still routed normally
    assert decision.directive is False
    assert decision.directive_body is None


def test_route_directive_unset_for_maintainer_without_mention() -> None:
    decision = route(
        "issue_comment",
        {
            "action": "created",
            "comment": {
                "user": {"login": "can1357"},
                "author_association": "OWNER",
                "body": "looks good to me",
            },
            "issue": {"number": 9},
            "repository": {"full_name": "octo/widget"},
        },
        allowlist=ALLOWLIST,
        bot_login=BOT,
    )
    assert decision.directive is False


def test_route_directive_on_incoming_pr_conversation_is_ignored() -> None:
    decision = route(
        "issue_comment",
        {
            "action": "created",
            "comment": {
                "user": {"login": "can1357"},
                "author_association": "OWNER",
                "body": "@robomp-bot change the indentation in foo.py",
            },
            "issue": {"number": 50, "pull_request": {"url": "x"}},
            "repository": {"full_name": "octo/widget"},
        },
        allowlist=ALLOWLIST,
        bot_login=BOT,
        resolve_issue_from_pr=lambda _r, _n: "octo/widget#42",
    )
    assert not decision.should_queue
    assert decision.reason == "incoming PR comments ignored"


def test_route_directive_set_on_review_comment() -> None:
    decision = route(
        "pull_request_review_comment",
        {
            "action": "created",
            "comment": {
                "user": {"login": "can1357"},
                "author_association": "OWNER",
                "body": "@robomp-bot use a generator here",
            },
            "pull_request": {"number": 50, "user": {"login": BOT}},
            "repository": {"full_name": "octo/widget"},
        },
        allowlist=ALLOWLIST,
        bot_login=BOT,
        resolve_issue_from_pr=lambda _r, _n: "octo/widget#42",
    )
    assert decision.should_queue
    assert decision.task == "handle_review"
    assert decision.directive is True
    assert decision.directive_body == "use a generator here"


def test_route_review_comment_normalizes_bot_author_suffix() -> None:
    decision = route(
        "pull_request_review_comment",
        {
            "action": "created",
            "comment": {
                "user": {"login": "can1357"},
                "author_association": "OWNER",
                "body": "@robomp-bot use a generator here",
            },
            "pull_request": {"number": 50, "user": {"login": f"{BOT}[bot]"}},
            "repository": {"full_name": "octo/widget"},
        },
        allowlist=ALLOWLIST,
        bot_login=f"@{BOT}[bot]",
        resolve_issue_from_pr=lambda _r, _n: "octo/widget#42",
    )
    assert decision.should_queue
    assert decision.task == "handle_review"
    assert decision.directive is True
    assert decision.directive_body == "use a generator here"


# ---------- reviewer bots ----------


def test_route_reviewer_bot_comment_on_incoming_pr_is_ignored() -> None:
    decision = route(
        "issue_comment",
        {
            "action": "created",
            "comment": {
                "user": {"login": "chatgpt-codex-connector[bot]", "type": "Bot"},
                "body": "Found two issues in the diff: ...",
            },
            "issue": {"number": 9, "pull_request": {"url": "x"}},
            "repository": {"full_name": "octo/widget"},
        },
        allowlist=ALLOWLIST,
        bot_login=BOT,
        reviewer_bots=frozenset({"chatgpt-codex-connector"}),
        resolve_issue_from_pr=lambda _r, _n: "octo/widget#42",
    )
    assert not decision.should_queue
    assert decision.reason == "incoming PR comments ignored"


def test_route_reviewer_bot_review_comment_is_directive() -> None:
    decision = route(
        "pull_request_review_comment",
        {
            "action": "created",
            "comment": {
                "user": {"login": "chatgpt-codex-connector[bot]", "type": "Bot"},
                "body": "This branch leaks memory.",
            },
            "pull_request": {"number": 50, "user": {"login": BOT}},
            "repository": {"full_name": "octo/widget"},
        },
        allowlist=ALLOWLIST,
        bot_login=BOT,
        reviewer_bots=frozenset({"chatgpt-codex-connector"}),
        resolve_issue_from_pr=lambda _r, _n: "octo/widget#42",
    )
    assert decision.should_queue
    assert decision.task == "handle_review"
    assert decision.directive is True
    assert decision.directive_body == "This branch leaks memory."
    assert decision.directive_author == "chatgpt-codex-connector"
    assert decision.directive_authorizes_impl is False


def test_route_random_bot_still_skipped_when_not_in_reviewer_list() -> None:
    decision = route(
        "issue_comment",
        {
            "action": "created",
            "comment": {"user": {"login": "renovate", "type": "Bot"}, "body": "deps"},
            "issue": {"number": 9},
            "repository": {"full_name": "octo/widget"},
        },
        allowlist=ALLOWLIST,
        bot_login=BOT,
        reviewer_bots=frozenset({"chatgpt-codex-connector"}),
    )
    assert not decision.should_queue
    assert "bot" in decision.reason


def test_route_reviewer_bot_login_case_insensitive_for_review_comments() -> None:
    decision = route(
        "pull_request_review_comment",
        {
            "action": "created",
            "comment": {
                "user": {"login": "ChatGPT-Codex-Connector", "type": "Bot"},
                "body": "feedback",
            },
            "pull_request": {"number": 9, "user": {"login": BOT}},
            "repository": {"full_name": "octo/widget"},
        },
        allowlist=ALLOWLIST,
        bot_login=BOT,
        reviewer_bots=frozenset({"chatgpt-codex-connector"}),
        resolve_issue_from_pr=lambda _r, _n: "octo/widget#42",
    )
    assert decision.directive is True
    assert decision.directive_author == "chatgpt-codex-connector"


def test_route_directive_strips_pragmas_from_maintainer_comment() -> None:
    decision = route(
        "issue_comment",
        {
            "action": "created",
            "comment": {
                "user": {"login": "can1357"},
                "author_association": "OWNER",
                "body": "@robomp-bot /model gpt /thinking low\nrefactor X",
            },
            "issue": {"number": 9},
            "repository": {"full_name": "octo/widget"},
        },
        allowlist=ALLOWLIST,
        bot_login=BOT,
    )
    assert decision.directive is True
    assert decision.directive_body == "refactor X"
    assert decision.directive_pragmas == (("model", "gpt"), ("thinking", "low"))


def test_route_directive_strips_pragmas_from_reviewer_bot_review_comment() -> None:
    decision = route(
        "pull_request_review_comment",
        {
            "action": "created",
            "comment": {
                "user": {"login": "chatgpt-codex-connector", "type": "Bot"},
                "body": "/model claude\nLeak in foo()",
            },
            "pull_request": {"number": 9, "user": {"login": BOT}},
            "repository": {"full_name": "octo/widget"},
        },
        allowlist=ALLOWLIST,
        bot_login=BOT,
        reviewer_bots=frozenset({"chatgpt-codex-connector"}),
        resolve_issue_from_pr=lambda _r, _n: "octo/widget#42",
    )
    assert decision.directive is True
    assert decision.directive_body == "Leak in foo()"
    assert decision.directive_pragmas == (("model", "claude"),)


def test_route_non_directive_comment_carries_no_pragmas() -> None:
    # Random user pragmas must NOT propagate — only directive comments do.
    decision = route(
        "issue_comment",
        {
            "action": "created",
            "comment": {
                "user": {"login": "stranger"},
                "author_association": "NONE",
                "body": "/model gpt\nhello",
            },
            "issue": {"number": 9},
            "repository": {"full_name": "octo/widget"},
        },
        allowlist=ALLOWLIST,
        bot_login=BOT,
    )
    assert decision.directive is False
    assert decision.directive_pragmas == ()


# ---------- vouched-label deferred PR review ----------


def test_route_vouched_label_defers_pr_open() -> None:
    decision = route(
        "pull_request",
        {
            "action": "opened",
            "pull_request": {"number": 9, "draft": False, "user": {"login": "alice", "type": "User"}},
            "repository": {"full_name": "octo/widget"},
        },
        allowlist=ALLOWLIST,
        bot_login=BOT,
        pr_review_trigger="vouched_label",
    )
    assert not decision.should_queue
    assert decision.reason == "deferred to vouch label"


def test_route_vouched_label_reviews_on_label() -> None:
    decision = route(
        "pull_request",
        {
            "action": "labeled",
            "label": {"name": "vouched"},
            "pull_request": {
                "number": 9,
                "draft": False,
                "user": {"login": "alice", "type": "User"},
                "author_association": "CONTRIBUTOR",
            },
            "repository": {"full_name": "octo/widget"},
            "sender": {"login": "github-actions[bot]"},
        },
        allowlist=ALLOWLIST,
        bot_login=BOT,
        pr_review_trigger="vouched_label",
    )
    assert decision.should_queue
    assert decision.task == "review_pr"
    assert decision.issue_key == "octo/widget#9"
    assert decision.submitter == "alice"


def test_route_vouched_label_ignores_other_labels() -> None:
    decision = route(
        "pull_request",
        {
            "action": "labeled",
            "label": {"name": "bug"},
            "pull_request": {"number": 9, "user": {"login": "alice"}},
            "repository": {"full_name": "octo/widget"},
        },
        allowlist=ALLOWLIST,
        bot_login=BOT,
        pr_review_trigger="vouched_label",
    )
    assert not decision.should_queue


def test_route_vouched_label_ready_for_review_defers_even_with_label() -> None:
    # Persisted labels are NOT trusted; the workflow re-applies the label (a
    # fresh `labeled` event) after re-validating, so ready_for_review defers.
    decision = route(
        "pull_request",
        {
            "action": "ready_for_review",
            "pull_request": {
                "number": 9,
                "draft": False,
                "user": {"login": "alice", "type": "User"},
                "labels": [{"name": "vouched"}],
            },
            "repository": {"full_name": "octo/widget"},
        },
        allowlist=ALLOWLIST,
        bot_login=BOT,
        pr_review_trigger="vouched_label",
    )
    assert not decision.should_queue
    assert decision.reason == "deferred to vouch label"


def test_route_vouched_label_labeled_skips_draft() -> None:
    decision = route(
        "pull_request",
        {
            "action": "labeled",
            "label": {"name": "vouched"},
            "pull_request": {"number": 9, "draft": True, "user": {"login": "alice", "type": "User"}},
            "repository": {"full_name": "octo/widget"},
            "sender": {"login": "github-actions[bot]"},
        },
        allowlist=ALLOWLIST,
        bot_login=BOT,
        pr_review_trigger="vouched_label",
    )
    assert not decision.should_queue
    assert decision.reason == "draft PR"


def test_route_default_trigger_ignores_labeled() -> None:
    # Backward-compat: the default "open" trigger does not route `labeled`.
    decision = route(
        "pull_request",
        {
            "action": "labeled",
            "label": {"name": "vouched"},
            "pull_request": {"number": 9, "user": {"login": "alice"}},
            "repository": {"full_name": "octo/widget"},
        },
        allowlist=ALLOWLIST,
        bot_login=BOT,
    )
    assert not decision.should_queue


def test_route_vouched_label_reopened_defers_even_with_label() -> None:
    # A since-denounced author must not slip through on reopen via a stale
    # label; reopened always defers to a fresh gate check + re-label.
    decision = route(
        "pull_request",
        {
            "action": "reopened",
            "pull_request": {
                "number": 9,
                "draft": False,
                "user": {"login": "alice", "type": "User"},
                "labels": [{"name": "vouched"}],
            },
            "repository": {"full_name": "octo/widget"},
        },
        allowlist=ALLOWLIST,
        bot_login=BOT,
        pr_review_trigger="vouched_label",
    )
    assert not decision.should_queue
    assert decision.reason == "deferred to vouch label"


def test_route_vouched_label_reopened_without_label_defers() -> None:
    decision = route(
        "pull_request",
        {
            "action": "reopened",
            "pull_request": {"number": 9, "draft": False, "user": {"login": "alice", "type": "User"}},
            "repository": {"full_name": "octo/widget"},
        },
        allowlist=ALLOWLIST,
        bot_login=BOT,
        pr_review_trigger="vouched_label",
    )
    assert not decision.should_queue
    assert decision.reason == "deferred to vouch label"


def test_route_vouched_label_rejects_manual_labeler() -> None:
    # A triage/maintainer hand-adding the label must NOT trigger review.
    decision = route(
        "pull_request",
        {
            "action": "labeled",
            "label": {"name": "vouched"},
            "pull_request": {"number": 9, "draft": False, "user": {"login": "alice", "type": "User"}},
            "repository": {"full_name": "octo/widget"},
            "sender": {"login": "evilmaintainer"},
        },
        allowlist=ALLOWLIST,
        bot_login=BOT,
        pr_review_trigger="vouched_label",
    )
    assert not decision.should_queue
    assert "trusted labeler" in decision.reason


def test_route_vouched_label_skips_closed_pr() -> None:
    # `labeled` can fire on a closed PR; never review one.
    decision = route(
        "pull_request",
        {
            "action": "labeled",
            "label": {"name": "vouched"},
            "pull_request": {"number": 9, "state": "closed", "user": {"login": "alice", "type": "User"}},
            "repository": {"full_name": "octo/widget"},
            "sender": {"login": "github-actions[bot]"},
        },
        allowlist=ALLOWLIST,
        bot_login=BOT,
        pr_review_trigger="vouched_label",
    )
    assert not decision.should_queue
    assert decision.reason == "PR not open"
