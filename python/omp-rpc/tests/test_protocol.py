from __future__ import annotations

import unittest

from omp_rpc import (
    AgentEndEvent,
    AutoCompactionEndEvent,
    AutoCompactionStartEvent,
    ExtensionUiRequest,
    MessageUpdateEvent,
    SessionState,
    TodoReminderEvent,
    assistant_text,
    assistant_text_with_thinking,
    parse_notification,
    parse_session_state,
)


class ProtocolParsingTests(unittest.TestCase):
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
                "steeringMode": "one-at-a-time",
                "followUpMode": "all",
                "interruptMode": "immediate",
                "sessionFile": "/tmp/test.jsonl",
                "sessionId": "session-123",
                "sessionName": "Scratchpad",
                "fastModeEnabled": False,
                "fastModeActive": True,
                "tokensPerSecond": 12.5,
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

        legacy = AgentEndEvent(notification.messages, "agent_end")
        self.assertEqual(legacy.type, "agent_end")
        self.assertIsNone(legacy.message_count)
        self.assertIsNone(legacy.is_terminal)

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

    def test_extension_ui_request_preserves_positional_constructor(self) -> None:
        request = ExtensionUiRequest(
            "ui-legacy", "confirm", "Confirm", None, "Continue?"
        )

        self.assertEqual(request.message, "Continue?")
        self.assertIsNone(request.option_details)

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

    def test_parse_message_update_rejects_invalid_assistant_done_reason(self) -> None:
        with self.assertRaises(ValueError):
            parse_notification(
                {
                    "type": "message_update",
                    "message": {
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
                    },
                    "assistantMessageEvent": {
                        "type": "done",
                        "reason": "error",
                        "message": {
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
                        },
                    },
                }
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
