from __future__ import annotations

import unittest

from omp_rpc import (
    AgentEndEvent,
    AskOption,
    AutoCompactionEndEvent,
    AutoCompactionStartEvent,
    CacheWarmingEndEvent,
    ExtensionUiRequest,
    GoalUpdatedEvent,
    IrcMessageEvent,
    LiveTranscriptEvent,
    MessageEndEvent,
    MessageStartEvent,
    MessageUpdateEvent,
    PromptError,
    PromptResultEvent,
    NoticeEvent,
    SessionSettledEvent,
    SessionState,
    SkillDiagnosticsUpdateEvent,
    SubagentEvent,
    ThinkingLevelChangedEvent,
    TodoReminderEvent,
    ToolStreamUpdateEvent,
    UnknownNotification,
    assistant_text,
    assistant_text_with_thinking,
    parse_notification,
    parse_session_state,
    parse_skill_diagnostic_analysis_record,
)


GOAL = {
    "id": "goal-1",
    "objective": "Ship the parser",
    "status": "paused",
    "tokenBudget": 5000,
    "tokensUsed": 1200,
    "timeUsedSeconds": 42.5,
    "createdAt": 1,
    "updatedAt": 2,
}


def valid_skill_snapshot() -> dict[str, object]:
    entry = {"name": "review", "filePath": "/a/SKILL.md", "source": "native:user"}
    return {
        "cwd": "/workspace",
        "showStartupDiagnostics": True,
        "diagnostics": [
            {
                "name": "review",
                "reason": "source-order",
                "skills": [entry],
                "duplicates": [
                    {
                        "skill": {**entry, "pluginName": "p", "repository": "github.com/a/b"},
                        "retained": entry,
                        "match": "origin",
                    }
                ],
            }
        ],
    }


def _diagnostic(snapshot: dict[str, object]) -> dict[str, object]:
    return snapshot["diagnostics"][0]  # type: ignore[index]


def _duplicate(snapshot: dict[str, object]) -> dict[str, object]:
    return _diagnostic(snapshot)["duplicates"][0]  # type: ignore[index]


def _duplicate_skill(snapshot: dict[str, object]) -> dict[str, object]:
    return _duplicate(snapshot)["skill"]  # type: ignore[return-value]


def _set(target: dict[str, object], key: str, value: object) -> None:
    target[key] = value


def _drop(target: dict[str, object], key: str) -> None:
    del target[key]


class SkillDiagnosticsProtocolTests(unittest.TestCase):
    def test_valid_snapshot_parses_through_state_and_update(self) -> None:
        snapshot = valid_skill_snapshot()

        state = parse_session_state({"sessionId": "s", "skillDiagnostics": snapshot})
        update = parse_notification(
            {"type": "skill_diagnostics_update", "data": snapshot}
        )

        assert state.skill_diagnostics is not None
        assert isinstance(update, SkillDiagnosticsUpdateEvent)
        self.assertEqual(state.skill_diagnostics, update.data)
        duplicate = state.skill_diagnostics.diagnostics[0].duplicates[0]
        self.assertEqual(duplicate.skill.plugin_name, "p")
        self.assertIsNone(duplicate.retained.plugin_name)
        self.assertEqual(duplicate.skill.repository, "github.com/a/b")
        self.assertEqual(duplicate.match, "origin")

    def test_older_duplicate_without_match_defaults_to_content(self) -> None:
        snapshot = valid_skill_snapshot()
        _drop(_duplicate(snapshot), "match")

        state = parse_session_state({"sessionId": "s", "skillDiagnostics": snapshot})

        assert state.skill_diagnostics is not None
        duplicate = state.skill_diagnostics.diagnostics[0].duplicates[0]
        self.assertEqual(duplicate.match, "content")

    def test_rejects_malformed_skill_diagnostics_with_value_error(self) -> None:
        # One row per distinct boundary: bool leaf, required arrays (missing and
        # null must not become empty), object items, literal, str leaf, and the
        # optional leaf. Every failure must be the module's ValueError.
        mutations = {
            "bool leaf": lambda s: _set(s, "showStartupDiagnostics", "false"),
            "diagnostics missing": lambda s: _drop(s, "diagnostics"),
            "diagnostics null": lambda s: _set(s, "diagnostics", None),
            "diagnostics not list": lambda s: _set(s, "diagnostics", {}),
            "diagnostic not object": lambda s: _set(s, "diagnostics", ["x"]),
            "reason unknown": lambda s: _set(_diagnostic(s), "reason", "newest"),
            "skills missing": lambda s: _drop(_diagnostic(s), "skills"),
            "skills null": lambda s: _set(_diagnostic(s), "skills", None),
            "skill not object": lambda s: _set(_diagnostic(s), "skills", [1]),
            "duplicates missing": lambda s: _drop(_diagnostic(s), "duplicates"),
            "duplicates null": lambda s: _set(_diagnostic(s), "duplicates", None),
            "duplicate not object": lambda s: _set(_diagnostic(s), "duplicates", [1]),
            "duplicate retained missing": lambda s: _drop(_duplicate(s), "retained"),
            "duplicate match unknown": lambda s: _set(_duplicate(s), "match", "newest"),
            "entry leaf not string": lambda s: _set(_duplicate_skill(s), "filePath", 7),
            "pluginName not string": lambda s: _set(
                _duplicate_skill(s), "pluginName", 7
            ),
        }

        for label, mutate in mutations.items():
            snapshot = valid_skill_snapshot()
            mutate(snapshot)
            with self.subTest(label=label, path="state"), self.assertRaises(ValueError):
                parse_session_state({"sessionId": "s", "skillDiagnostics": snapshot})
            with (
                self.subTest(label=label, path="update"),
                self.assertRaises(ValueError),
            ):
                parse_notification(
                    {"type": "skill_diagnostics_update", "data": snapshot}
                )


def analysis_candidate(candidate_id: str) -> dict[str, object]:
    return {
        "id": candidate_id,
        "name": "review",
        "filePath": f"/{candidate_id}/review/SKILL.md",
        "root": f"/{candidate_id}/review",
        "fingerprint": "f" * 64,
        "complete": True,
        "files": 1,
        "omissions": [],
    }


def analysis_result() -> dict[str, object]:
    evidence = {
        "file": "SKILL.md",
        "quote": "Review changes carefully.",
        "explanation": "Both carry it.",
    }
    return {
        "relationship": "adaptation",
        "evidence": [
            {**evidence, "candidateId": "skill-1"},
            {**evidence, "candidateId": "skill-2"},
        ],
        "differences": ["One skips the linter."],
        "recommendation": {
            "action": "prefer",
            "preferredId": "skill-1",
            "reason": "The first loses nothing.",
        },
        "limitations": [],
    }


def analysis_record(**overrides: object) -> dict[str, object]:
    return {
        "id": "analysis-1",
        "name": "review",
        "status": "complete",
        "model": "fake/fake-model",
        "bytes": 120,
        "candidates": [analysis_candidate("skill-1"), analysis_candidate("skill-2")],
        "disclosure": "Files are treated as data.",
        "createdAt": 1_700_000_000_000,
        "applied": False,
        "result": analysis_result(),
        **overrides,
    }


def skill_snapshot_with_items() -> dict[str, object]:
    snapshot = valid_skill_snapshot()
    entry = {"name": "review", "filePath": "/a/SKILL.md", "source": "native:user"}
    snapshot["items"] = [
        {
            "name": "review",
            "issues": ["conflict", "redundancy"],
            "skills": [entry],
            "duplicates": [{"skill": entry, "retained": entry, "match": "content"}],
            "reason": "source-order",
            "canAnalyze": True,
            "analysis": analysis_record(),
            "lastAnalysis": analysis_record(
                id="analysis-0", status="failed", error="The model failed.", result=None
            ),
        },
        {
            "name": "solo",
            "issues": [],
            "skills": [entry],
            "duplicates": [],
            "canAnalyze": False,
            "unavailableReason": "Only one copy is loaded.",
        },
    ]
    return snapshot


def _item(snapshot: dict[str, object]) -> dict[str, object]:
    return snapshot["items"][0]  # type: ignore[index]


def _record(snapshot: dict[str, object]) -> dict[str, object]:
    return _item(snapshot)["analysis"]  # type: ignore[return-value]


def _result(snapshot: dict[str, object]) -> dict[str, object]:
    return _record(snapshot)["result"]  # type: ignore[return-value]


class SkillAnalysisProtocolTests(unittest.TestCase):
    def test_items_records_and_structured_results_reach_consumers(self) -> None:
        snapshot = skill_snapshot_with_items()

        state = parse_session_state({"sessionId": "s", "skillDiagnostics": snapshot})
        update = parse_notification(
            {"type": "skill_diagnostics_update", "data": snapshot}
        )

        assert state.skill_diagnostics is not None
        assert isinstance(update, SkillDiagnosticsUpdateEvent)
        self.assertEqual(state.skill_diagnostics, update.data)
        assert state.skill_diagnostics.items is not None
        review, solo = state.skill_diagnostics.items
        self.assertEqual(review.issues, ("conflict", "redundancy"))
        self.assertTrue(review.can_analyze)
        assert review.analysis is not None and review.last_analysis is not None
        self.assertEqual(
            (review.analysis.id, review.analysis.status, review.analysis.applied),
            ("analysis-1", "complete", False),
        )
        self.assertEqual(review.analysis.created_at, 1_700_000_000_000)
        self.assertEqual(review.analysis.candidates[1].root, "/skill-2/review")
        assert review.analysis.result is not None
        self.assertEqual(review.analysis.result.relationship, "adaptation")
        self.assertEqual(review.analysis.result.evidence[1].candidate_id, "skill-2")
        self.assertEqual(review.analysis.result.recommendation.preferred_id, "skill-1")
        self.assertEqual(review.last_analysis.error, "The model failed.")
        self.assertIsNone(review.last_analysis.result)
        self.assertFalse(solo.can_analyze)
        self.assertEqual(solo.unavailable_reason, "Only one copy is loaded.")
        self.assertIsNone(solo.analysis)

        record = parse_skill_diagnostic_analysis_record(analysis_record())
        self.assertEqual(record, review.analysis)

    def test_older_snapshot_without_items_still_decodes(self) -> None:
        state = parse_session_state(
            {"sessionId": "s", "skillDiagnostics": valid_skill_snapshot()}
        )

        assert state.skill_diagnostics is not None
        self.assertIsNone(state.skill_diagnostics.items)
        self.assertEqual(len(state.skill_diagnostics.diagnostics), 1)

    def test_rejects_malformed_analysis_state_with_value_error(self) -> None:
        mutations = {
            "items not list": lambda s: _set(s, "items", {}),
            "item issue unknown": lambda s: _set(_item(s), "issues", ["bogus"]),
            "item canAnalyze not bool": lambda s: _set(_item(s), "canAnalyze", 1),
            "item canAnalyze missing": lambda s: _drop(_item(s), "canAnalyze"),
            "record status unknown": lambda s: _set(_record(s), "status", "paused"),
            "record applied not bool": lambda s: _set(_record(s), "applied", "no"),
            "record id missing": lambda s: _drop(_record(s), "id"),
            "record bytes not int": lambda s: _set(_record(s), "bytes", 1.5),
            "record candidates null": lambda s: _set(_record(s), "candidates", None),
            "candidate complete not bool": lambda s: _set(
                _record(s)["candidates"][0], "complete", "yes"  # type: ignore[index]
            ),
            "result relationship unknown": lambda s: _set(
                _result(s), "relationship", "twins"
            ),
            "result recommendation missing": lambda s: _drop(
                _result(s), "recommendation"
            ),
            "recommendation action unknown": lambda s: _set(
                _result(s)["recommendation"], "action", "hide"  # type: ignore[index]
            ),
            "evidence candidateId missing": lambda s: _drop(
                _result(s)["evidence"][0], "candidateId"  # type: ignore[index]
            ),
            "differences not list": lambda s: _set(_result(s), "differences", "none"),
        }

        for label, mutate in mutations.items():
            snapshot = skill_snapshot_with_items()
            mutate(snapshot)
            with self.subTest(label=label, path="state"), self.assertRaises(ValueError):
                parse_session_state({"sessionId": "s", "skillDiagnostics": snapshot})
            with (
                self.subTest(label=label, path="update"),
                self.assertRaises(ValueError),
            ):
                parse_notification(
                    {"type": "skill_diagnostics_update", "data": snapshot}
                )


class ProtocolParsingTests(unittest.TestCase):
    def test_parse_session_state_goal(self) -> None:
        base = {"sessionId": "s", "goal": None}
        self.assertIsNone(parse_session_state(base).goal)

        state = parse_session_state(
            {**base, "goal": {"enabled": False, "mode": "active", "goal": GOAL}}
        )
        assert state.goal is not None
        self.assertEqual(
            (state.goal.enabled, state.goal.goal.status, state.goal.goal.token_budget),
            (False, "paused", 5000),
        )
        self.assertEqual(state.goal.goal.time_used_seconds, 42.5)

    def test_parse_ask_request_questions(self) -> None:
        request = parse_notification(
            {
                "type": "extension_ui_request",
                "id": "ui-9",
                "method": "ask",
                "timeout": 30000,
                "questions": [
                    {
                        "id": "db",
                        "question": "Which database?",
                        "header": "Storage",
                        "options": [
                            {"label": "Postgres", "description": "server"},
                            {"label": "SQLite"},
                        ],
                        "recommended": 1,
                    },
                    {
                        "id": "features",
                        "question": "Which features?",
                        "options": [{"label": "Auth"}],
                        "multi": True,
                    },
                ],
            }
        )

        assert isinstance(request, ExtensionUiRequest)
        self.assertTrue(request.requires_response())
        self.assertFalse(request.accepts_text())
        questions = request.questions or ()
        self.assertEqual(
            questions[0].options,
            (AskOption(label="Postgres", description="server"), AskOption(label="SQLite")),
        )
        self.assertEqual(
            [(q.id, q.multi, q.recommended) for q in questions],
            [("db", False, 1), ("features", True, None)],
        )

    def test_parse_session_events_added_to_the_protocol(self) -> None:
        # Each of these used to degrade to UnknownNotification (or, for the
        # `remote` compaction action, fail to parse).
        cases = [
            (
                {"type": "auto_compaction_start", "reason": "overflow", "action": "remote"},
                AutoCompactionStartEvent,
                lambda e: e.action,
                "remote",
            ),
            (
                {"type": "goal_updated", "goal": GOAL},
                GoalUpdatedEvent,
                lambda e: (e.goal.status, e.state),
                ("paused", None),
            ),
            (
                {"type": "notice", "level": "warning", "message": "disk full", "source": "session"},
                NoticeEvent,
                lambda e: (e.level, e.source),
                ("warning", "session"),
            ),
            (
                {
                    "type": "cache_warming_end",
                    "phase": "idle",
                    "provider": "anthropic",
                    "model": "claude-sonnet-4-5",
                    "outcome": "miss",
                    "usage": {"input": 3, "output": 1},
                    "warmingStopReason": "refresh missed the cache",
                },
                CacheWarmingEndEvent,
                lambda e: (e.outcome, e.usage["input"], e.warming_stop_reason),
                ("miss", 3, "refresh missed the cache"),
            ),
            (
                {"type": "thinking_level_changed", "thinkingLevel": "high", "configured": "auto", "resolved": "high"},
                ThinkingLevelChangedEvent,
                lambda e: (e.thinking_level, e.configured, e.resolved),
                ("high", "auto", "high"),
            ),
            (
                {"type": "tool_stream_update", "toolCallId": "t1", "toolName": "bash", "update": {"chunk": "ok"}},
                ToolStreamUpdateEvent,
                lambda e: (e.tool_call_id, e.update),
                ("t1", {"chunk": "ok"}),
            ),
            (
                {
                    "type": "irc_message",
                    "message": {"role": "custom", "customType": "irc", "content": "hi", "display": True, "timestamp": 1},
                },
                IrcMessageEvent,
                lambda e: e.message["customType"],
                "irc",
            ),
        ]
        for payload, event_class, project, expected in cases:
            with self.subTest(event_type=payload["type"]):
                event = parse_notification(payload)
                self.assertIsInstance(event, event_class)
                self.assertEqual(project(event), expected)

    def test_parse_subagent_event_degrades_malformed_nested_event(self) -> None:
        malformed = parse_notification(
            {
                "type": "subagent_event",
                "payload": {
                    "id": "Worker",
                    "event": {"type": "message_end", "message": {"role": "martian"}},
                },
            }
        )
        assert isinstance(malformed, SubagentEvent)
        self.assertIsInstance(malformed.payload.event, UnknownNotification)
        assert isinstance(malformed.payload.event, UnknownNotification)
        self.assertIsNotNone(malformed.payload.event.parse_error)

        valid = parse_notification(
            {
                "type": "subagent_event",
                "payload": {
                    "id": "Worker",
                    "event": {"type": "message_end", "message": {"role": "assistant"}},
                },
            }
        )
        assert isinstance(valid, SubagentEvent)
        self.assertIsInstance(valid.payload.event, MessageEndEvent)

    def test_parse_live_frames(self) -> None:
        self.assertEqual(
            parse_notification(
                {"type": "live_transcript", "role": "user", "turn": 3, "text": "hello", "final": False}
            ),
            LiveTranscriptEvent(role="user", turn=3, text="hello", final=False),
        )
        with self.assertRaises(ValueError):
            parse_notification({"type": "live_phase", "phase": "dozing"})

    def test_parse_message_update_preserves_assistant_event_type(self) -> None:
        assistant = {"role": "assistant"}
        common = {"contentIndex": 0, "partial": assistant}
        cases = {
            "start": {"partial": assistant},
            "text_start": common,
            "thinking_start": common,
            "toolcall_start": common,
            "text_delta": {**common, "delta": "text"},
            "thinking_delta": {**common, "delta": "thought"},
            "toolcall_delta": {**common, "delta": "arguments"},
            "text_end": {**common, "content": "text"},
            "thinking_end": {**common, "content": "thought"},
            "toolcall_end": {**common, "toolCall": {}},
            "done": {"reason": "stop", "message": assistant},
            "error": {"reason": "error", "error": assistant},
        }

        for event_type, event in cases.items():
            with self.subTest(event_type=event_type):
                parsed = parse_notification(
                    {
                        "type": "message_update",
                        "message": assistant,
                        "assistantMessageEvent": {"type": event_type, **event},
                    }
                )

                self.assertIsInstance(parsed, MessageUpdateEvent)
                assert isinstance(parsed, MessageUpdateEvent)
                self.assertEqual(parsed.assistant_message_event["type"], event_type)

    def test_parse_message_lifecycle_events_carry_message_id(self) -> None:
        assistant = {"role": "assistant"}
        update = {
            "type": "message_update",
            "message": assistant,
            "messageId": "m-7",
            "assistantMessageEvent": {"type": "start", "partial": assistant},
        }
        events = [
            parse_notification(
                {"type": "message_start", "message": assistant, "messageId": "m-7"}
            ),
            parse_notification(update),
            parse_notification(
                {"type": "message_end", "message": assistant, "messageId": "m-7"}
            ),
        ]

        self.assertIsInstance(events[0], MessageStartEvent)
        self.assertIsInstance(events[2], MessageEndEvent)
        self.assertEqual(
            [getattr(event, "message_id") for event in events], ["m-7"] * 3
        )
        legacy = parse_notification({"type": "message_end", "message": assistant})
        assert isinstance(legacy, MessageEndEvent)
        self.assertIsNone(legacy.message_id)

    def test_parse_prompt_result_with_error(self) -> None:
        parsed = parse_notification(
            {
                "type": "prompt_result",
                "id": "req_3",
                "agentInvoked": True,
                "sessionSettled": False,
                "status": "error",
                "error": {
                    "message": "overloaded",
                    "provider": "anthropic",
                    "model": "claude-sonnet-4-5",
                    "httpStatus": 529,
                    "retryable": True,
                },
            }
        )

        self.assertEqual(
            parsed,
            PromptResultEvent(
                id="req_3",
                agent_invoked=True,
                status="error",
                error=PromptError(
                    message="overloaded",
                    retryable=True,
                    provider="anthropic",
                    model="claude-sonnet-4-5",
                    http_status=529,
                ),
                session_settled=False,
            ),
        )

    def test_parse_session_settled_notification(self) -> None:
        self.assertEqual(
            parse_notification({"type": "session_settled"}), SessionSettledEvent()
        )

    def test_parse_prompt_result_rejects_unknown_status(self) -> None:
        with self.assertRaises(ValueError):
            parse_notification(
                {
                    "type": "prompt_result",
                    "agentInvoked": True,
                    "sessionSettled": True,
                    "status": "later",
                }
            )

    def test_parse_session_state(self) -> None:
        state = parse_session_state(
            {
                "model": {
                    "id": "claude-sonnet-4-5",
                    "name": "Claude Sonnet 4.5",
                    "api": "anthropic-messages",
                    "provider": "anthropic",
                    "baseUrl": "https://api.anthropic.com",
                    "reasoning": True,
                    "input": ["text", "image"],
                    "cost": {
                        "input": 1.0,
                        "output": 2.0,
                        "cacheRead": 0.1,
                        "cacheWrite": 0.2,
                    },
                    "contextWindow": 200000,
                    "maxTokens": 8192,
                    "thinking": {
                        "mode": "effort",
                        "efforts": ["minimal", "low", "medium", "high"],
                        "defaultLevel": "medium",
                        "effortMap": {"high": "xhigh"},
                        "supportsDisplay": True,
                    },
                },
                "thinkingLevel": "medium",
                "isStreaming": False,
                "isCompacting": False,
                "hasPendingAsyncWork": True,
                "isSettled": False,
                "steeringMode": "one-at-a-time",
                "followUpMode": "all",
                "interruptMode": "immediate",
                "sessionFile": "/tmp/test.jsonl",
                "sessionId": "session-123",
                "sessionName": "Scratchpad",
                "fastModeEnabled": False,
                "fastModeActive": True,
                "tokensPerSecond": 12.5,
                "slowModeSupported": True,
                "slowModeEnabled": True,
                "slowModeScope": "global",
                "usageLimit": {
                    "stage": "low_priority",
                    "resetsAtSec": 1770000000,
                    "allowanceLeftPercent": 62,
                },
                "autoCompactionEnabled": True,
                "messageCount": 4,
                "queuedMessageCount": 1,
                "todoPhases": [
                    {
                        "id": "phase-1",
                        "name": "Todos",
                        "tasks": [
                            {
                                "id": "task-1",
                                "content": "Map tools",
                                "status": "in_progress",
                                "details": "Inspect read and edit first.",
                            }
                        ],
                    }
                ],
                "systemPrompt": "You are useful.",
                "dumpTools": [
                    {
                        "name": "read",
                        "description": "Read files",
                        "parameters": {"type": "object"},
                    }
                ],
                "contextUsage": {
                    "tokens": 12345,
                    "contextWindow": 200000,
                    "percent": 6.1725,
                },
            }
        )

        self.assertIsInstance(state, SessionState)
        self.assertEqual(state.session_id, "session-123")
        self.assertEqual(state.follow_up_mode, "all")
        self.assertEqual(state.model.id if state.model else None, "claude-sonnet-4-5")
        self.assertEqual(state.todo_phases[0].tasks[0].status, "in_progress")
        # Legacy bare-string systemPrompt is accepted and wrapped to a tuple.
        self.assertEqual(state.system_prompt, ("You are useful.",))
        self.assertEqual(state.dump_tools[0].name, "read")
        assert state.context_usage is not None
        self.assertEqual(state.context_usage.tokens, 12345)
        self.assertEqual(state.context_usage.context_window, 200000)
        self.assertEqual(state.context_usage.percent, 6.1725)
        assert state.model is not None and state.model.thinking is not None
        self.assertEqual(
            state.model.thinking.efforts, ("minimal", "low", "medium", "high")
        )
        self.assertEqual(state.model.thinking.mode, "effort")
        self.assertEqual(state.model.thinking.default_level, "medium")
        self.assertEqual(state.model.thinking.effort_map, {"high": "xhigh"})
        self.assertTrue(state.model.thinking.supports_display)
        self.assertFalse(state.fast_mode_enabled)
        self.assertTrue(state.fast_mode_active)
        self.assertEqual(state.tokens_per_second, 12.5)
        self.assertTrue(state.slow_mode_supported)
        self.assertTrue(state.slow_mode_enabled)
        self.assertEqual(state.slow_mode_scope, "global")
        assert state.usage_limit is not None
        self.assertEqual(state.usage_limit.stage, "low_priority")
        self.assertEqual(state.usage_limit.resets_at_sec, 1770000000)
        self.assertEqual(state.usage_limit.allowance_left_percent, 62)
        self.assertTrue(state.has_pending_async_work)
        self.assertFalse(state.is_settled)

    def test_parse_session_state_validates_usage_limit_variants(self) -> None:
        base = {
            "sessionId": "session-123",
            "steeringMode": "one-at-a-time",
            "followUpMode": "all",
            "interruptMode": "immediate",
        }
        wrap_up = parse_session_state(
            {
                **base,
                "usageLimit": {
                    "stage": "wrap_up",
                    "extraUsage": True,
                },
            }
        ).usage_limit
        assert wrap_up is not None
        self.assertEqual(wrap_up.stage, "wrap_up")
        self.assertTrue(wrap_up.extra_usage)
        self.assertIsNone(wrap_up.resets_at_sec)
        self.assertIsNone(parse_session_state(base).usage_limit)
        self.assertFalse(parse_session_state(base).slow_mode_supported)

        invalid = (
            ({"stage": "low_priority"}, "resetsAtSec"),
            ({"stage": "wrap_up"}, "extraUsage"),
            ({"stage": "wrap_up", "extraUsage": "false"}, "extraUsage"),
            ({"stage": "unknown"}, "stage"),
        )
        for slow_mode, field in invalid:
            with self.subTest(slow_mode=slow_mode):
                with self.assertRaisesRegex(ValueError, field):
                    parse_session_state({**base, "usageLimit": slow_mode})

    def test_parse_session_state_defaults_missing_fast_mode_and_throughput(
        self,
    ) -> None:
        missing = object()
        for tokens_per_second, expected in (
            (None, None),
            (missing, None),
        ):
            with self.subTest(tokens_per_second=tokens_per_second):
                payload = {
                    "sessionId": "session-123",
                    "steeringMode": "one-at-a-time",
                    "followUpMode": "all",
                    "interruptMode": "immediate",
                }
                if tokens_per_second is not missing:
                    payload["tokensPerSecond"] = tokens_per_second

                state = parse_session_state(payload)

                self.assertEqual(
                    (
                        state.fast_mode_enabled,
                        state.fast_mode_active,
                        state.tokens_per_second,
                    ),
                    (False, False, expected),
                )

    def test_parse_agent_end_notification(self) -> None:
        notification = parse_notification(
            {
                "type": "agent_end",
                "messages": [
                    {
                        "role": "assistant",
                        "content": [{"type": "text", "text": "hello"}],
                        "api": "anthropic-messages",
                        "provider": "anthropic",
                        "model": "claude-sonnet-4-5",
                        "usage": {
                            "input": 1,
                            "output": 1,
                            "cacheRead": 0,
                            "cacheWrite": 0,
                            "totalTokens": 2,
                            "cost": {
                                "input": 0.0,
                                "output": 0.0,
                                "cacheRead": 0.0,
                                "cacheWrite": 0.0,
                                "total": 0.0,
                            },
                        },
                        "stopReason": "stop",
                        "timestamp": 1,
                    }
                ],
                "messageCount": 1,
                "isTerminal": False,
            }
        )

        self.assertIsInstance(notification, AgentEndEvent)
        self.assertEqual(assistant_text(notification.messages[0]), "hello")
        self.assertEqual(notification.message_count, 1)
        self.assertFalse(notification.is_terminal)

    def test_parse_agent_end_yielded(self) -> None:
        for raw, expected in ((True, True), (False, False), (None, None)):
            with self.subTest(yielded=raw):
                payload = {"type": "agent_end", "messages": [], "isTerminal": False}
                if raw is not None:
                    payload["yielded"] = raw
                notification = parse_notification(payload)
                assert isinstance(notification, AgentEndEvent)
                self.assertEqual(notification.yielded, expected)

    def test_parse_current_compaction_variants(self) -> None:
        start = parse_notification(
            {
                "type": "auto_compaction_start",
                "reason": "incomplete",
                "action": "snapcompact",
            }
        )
        end = parse_notification(
            {
                "type": "auto_compaction_end",
                "action": "shake",
                "result": None,
                "aborted": False,
                "willRetry": False,
            }
        )

        self.assertIsInstance(start, AutoCompactionStartEvent)
        self.assertEqual(start.reason, "incomplete")
        self.assertEqual(start.action, "snapcompact")
        self.assertIsInstance(end, AutoCompactionEndEvent)
        self.assertEqual(end.action, "shake")

    def test_parse_extension_ui_request(self) -> None:
        notification = parse_notification(
            {
                "type": "extension_ui_request",
                "id": "ui-1",
                "method": "confirm",
                "title": "Confirm",
                "message": "Continue?",
                "timeout": 1000,
            }
        )

        self.assertIsInstance(notification, ExtensionUiRequest)
        self.assertEqual(notification.method, "confirm")
        self.assertEqual(notification.message, "Continue?")
        self.assertTrue(notification.is_interactive())
        self.assertTrue(notification.requires_response())
        self.assertFalse(notification.is_passive())

    def test_parse_select_option_details(self) -> None:
        notification = parse_notification(
            {
                "type": "extension_ui_request",
                "id": "ui-2",
                "method": "select",
                "title": "Deploy",
                "options": ["Keep", "Deploy"],
                "optionDetails": [{}, {"description": "Push to production"}],
            }
        )

        self.assertIsInstance(notification, ExtensionUiRequest)
        self.assertEqual(notification.options, ("Keep", "Deploy"))
        self.assertEqual(
            notification.option_details,
            ({}, {"description": "Push to production"}),
        )

    def test_parse_open_url_request(self) -> None:
        notification = parse_notification(
            {
                "type": "extension_ui_request",
                "id": "ui-oauth",
                "method": "open_url",
                "url": "https://example.com/oauth",
                "launchUrl": "http://127.0.0.1:8123/redirect",
                "instructions": "Open this URL to continue.",
            }
        )

        self.assertIsInstance(notification, ExtensionUiRequest)
        self.assertEqual(notification.method, "open_url")
        self.assertEqual(notification.url, "https://example.com/oauth")
        self.assertEqual(notification.launch_url, "http://127.0.0.1:8123/redirect")
        self.assertTrue(notification.is_passive())

    def test_parse_todo_reminder_notification(self) -> None:
        notification = parse_notification(
            {
                "type": "todo_reminder",
                "attempt": 1,
                "maxAttempts": 3,
                "todos": [
                    {
                        "id": "task-1",
                        "content": "Map tools",
                        "status": "pending",
                    }
                ],
            }
        )

        self.assertIsInstance(notification, TodoReminderEvent)
        self.assertEqual(notification.todos[0].content, "Map tools")
        self.assertEqual(notification.todos[0].status, "pending")

    def test_parse_session_state_accepts_blocked_todo(self) -> None:
        # Regression: the TS agent added a `blocked` todo status (with a
        # `blocker` note); resuming a session whose todos were blocked must
        # not fail state parsing.
        state = parse_session_state(
            {
                "sessionId": "session-123",
                "steeringMode": "one-at-a-time",
                "followUpMode": "one-at-a-time",
                "interruptMode": "immediate",
                "todoPhases": [
                    {
                        "id": "phase-1",
                        "name": "Fix",
                        "tasks": [
                            {
                                "id": "task-1",
                                "content": "Open PR",
                                "status": "blocked",
                                "blocker": "waiting on maintainer go-ahead",
                            }
                        ],
                    }
                ],
            }
        )

        task = state.todo_phases[0].tasks[0]
        self.assertEqual(task.status, "blocked")
        self.assertEqual(task.blocker, "waiting on maintainer go-ahead")

    def test_assistant_text_excludes_thinking_by_default(self) -> None:
        message = {
            "role": "assistant",
            "content": [
                {"type": "thinking", "thinking": "internal"},
                {"type": "text", "text": "visible"},
            ],
        }

        self.assertEqual(assistant_text(message), "visible")
        self.assertEqual(assistant_text_with_thinking(message), "internalvisible")

    def test_parse_session_state_rejects_invalid_thinking_level(self) -> None:
        with self.assertRaises(ValueError):
            parse_session_state(
                {
                    "sessionId": "session-123",
                    "thinkingLevel": "extreme",
                    "steeringMode": "one-at-a-time",
                    "followUpMode": "one-at-a-time",
                    "interruptMode": "immediate",
                }
            )

    def test_parse_model_info_rejects_unknown_effort(self) -> None:
        with self.assertRaises(ValueError):
            parse_session_state(
                {
                    "sessionId": "session-123",
                    "steeringMode": "one-at-a-time",
                    "followUpMode": "one-at-a-time",
                    "interruptMode": "immediate",
                    "model": {
                        "id": "m",
                        "name": "M",
                        "api": "anthropic-messages",
                        "provider": "anthropic",
                        "baseUrl": "https://api.anthropic.com",
                        "reasoning": True,
                        "thinking": {"mode": "effort", "efforts": ["extreme"]},
                    },
                }
            )

    def test_parse_session_state_accepts_system_prompt_array(self) -> None:
        state = parse_session_state(
            {
                "sessionId": "session-abc",
                "steeringMode": "one-at-a-time",
                "followUpMode": "one-at-a-time",
                "interruptMode": "immediate",
                "systemPrompt": ["base instructions", "extra policy"],
            }
        )
        self.assertEqual(state.system_prompt, ("base instructions", "extra policy"))

    def test_parse_session_state_defaults_system_prompt_to_empty_tuple(self) -> None:
        state = parse_session_state(
            {
                "sessionId": "session-abc",
                "steeringMode": "one-at-a-time",
                "followUpMode": "one-at-a-time",
                "interruptMode": "immediate",
            }
        )
        self.assertEqual(state.system_prompt, ())

    def test_parse_session_state_rejects_non_string_in_system_prompt_array(
        self,
    ) -> None:
        with self.assertRaises(ValueError):
            parse_session_state(
                {
                    "sessionId": "session-abc",
                    "steeringMode": "one-at-a-time",
                    "followUpMode": "one-at-a-time",
                    "interruptMode": "immediate",
                    "systemPrompt": ["ok", 42],
                }
            )

    def test_parse_session_state_rejects_invalid_system_prompt_shape(self) -> None:
        with self.assertRaises(ValueError):
            parse_session_state(
                {
                    "sessionId": "session-abc",
                    "steeringMode": "one-at-a-time",
                    "followUpMode": "one-at-a-time",
                    "interruptMode": "immediate",
                    "systemPrompt": {"unexpected": "object"},
                }
            )

    def test_parse_extension_ui_request_rejects_invalid_method(self) -> None:
        with self.assertRaises(ValueError):
            parse_notification(
                {"type": "extension_ui_request", "id": "ui-1", "method": "launch"}
            )

    def test_parse_notification_deep_clones_nested_messages(self) -> None:
        payload = {
            "type": "agent_end",
            "messages": [
                {
                    "role": "assistant",
                    "content": [{"type": "text", "text": "hello"}],
                    "api": "anthropic-messages",
                    "provider": "anthropic",
                    "model": "claude-sonnet-4-5",
                    "usage": {
                        "input": 1,
                        "output": 1,
                        "cacheRead": 0,
                        "cacheWrite": 0,
                        "totalTokens": 2,
                        "cost": {
                            "input": 0.0,
                            "output": 0.0,
                            "cacheRead": 0.0,
                            "cacheWrite": 0.0,
                            "total": 0.0,
                        },
                    },
                    "stopReason": "stop",
                    "timestamp": 1,
                }
            ],
        }

        notification = parse_notification(payload)
        payload["messages"][0]["content"][0]["text"] = "mutated"

        self.assertIsInstance(notification, AgentEndEvent)
        self.assertEqual(notification.messages[0]["content"][0]["text"], "hello")


if __name__ == "__main__":
    unittest.main()
