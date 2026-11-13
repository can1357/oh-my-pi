from __future__ import annotations

import base64
import contextlib
import errno
import functools
import json
import os
import shutil
import signal
import subprocess
import sys
import tempfile
import textwrap
import threading
import time
import unittest
from pathlib import Path
from typing import Any, Callable, Iterator, Mapping
from unittest import mock

from omp_rpc import (
    AgentEndEvent,
    AskAnswer,
    HostTool,
    HostToolCompletedEvent,
    AvailableCommandsUpdateEvent,
    GoalResult,
    HandoffResult,
    LivePhaseEvent,
    OpenSessionResult,
    PromptResultEvent,
    QueueUpdateEvent,
    RpcClient,
    RpcCommandError,
    RpcConcurrencyError,
    RpcError,
    RpcProcessExitError,
    RpcTimeoutError,
    SubagentLifecycleEvent,
    host_tool,
    host_uri,
)

from omp_rpc import client as client_module
from omp_rpc.client import (
    _PROC_DEAD_STATES,
    _ProcUnproven,
    _RpcFrameDecoder,
    _proc_group_dead,
    _proc_stat,
    _proc_threads_dead,
    _process_group_id,
    _read_file,
    _terminate_process_group,
)


FAKE_SERVER = textwrap.dedent(
    """
    import builtins
    import json
    import sys
    import threading
    import time

    # Background-job completions print from a timer thread; keep frames whole.
    print_lock = threading.Lock()

    def print(*args, **kwargs):
        with print_lock:
            builtins.print(*args, **kwargs)

    def usage():
        return {
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
        }

    def model_info(model_id: str, provider: str = "anthropic"):
        return {
            "id": model_id,
            "name": f"Model {model_id}",
            "api": "anthropic-messages",
            "provider": provider,
            "baseUrl": "https://api.anthropic.com",
            "reasoning": True,
            "input": ["text"],
            "cost": {
                "input": 1.0,
                "output": 2.0,
                "cacheRead": 0.0,
                "cacheWrite": 0.0,
            },
            "contextWindow": 200000,
            "maxTokens": 8192,
        }

    def assistant_message(text: str):
        return {
            "role": "assistant",
            "content": [{"type": "text", "text": text}],
            "api": "anthropic-messages",
            "provider": model_provider,
            "model": model_id,
            "usage": usage(),
            "stopReason": "stop",
            "timestamp": 1,
        }

    registered_host_tools = []
    host_event_tool_call_id = "toolu_host_1"
    host_event_tool_name = "echo_host"
    pending_prompt_id = None
    event_filter = None
    message_counter = 0
    pending_async_work = False

    def emit_event(payload):
        if event_filter is None or payload["type"] in event_filter:
            print(json.dumps(payload), flush=True)

    def emit_prompt_result(request_id, status="completed", agent_invoked=True, session_settled=True):
        print(
            json.dumps(
                {
                    "type": "prompt_result",
                    "id": request_id,
                    "agentInvoked": agent_invoked,
                    "status": status,
                    "sessionSettled": session_settled,
                }
            ),
            flush=True,
        )

    def finish_background_job():
        # The async job result wakes the session for a follow-up run, then it settles.
        global pending_async_work
        print(json.dumps({"type": "agent_start"}), flush=True)
        print(json.dumps({"type": "agent_end", "messages": []}), flush=True)
        pending_async_work = False
        print(json.dumps({"type": "session_settled"}), flush=True)

    def settle_pending_prompt(background_job=False):
        global pending_prompt_id, pending_async_work
        if pending_prompt_id is None:
            return
        if background_job:
            pending_async_work = True
            emit_prompt_result(pending_prompt_id, session_settled=False)
            threading.Timer(0.4, finish_background_job).start()
        else:
            emit_prompt_result(pending_prompt_id)
            print(json.dumps({"type": "session_settled"}), flush=True)
        pending_prompt_id = None

    def current_state():
        return {
            "model": model_info(model_id, model_provider),
            "thinkingLevel": thinking_level,
            "isStreaming": False,
            "isCompacting": False,
            "hasPendingAsyncWork": pending_async_work,
            "isSettled": not pending_async_work,
            "steeringMode": steering_mode,
            "followUpMode": follow_up_mode,
            "interruptMode": interrupt_mode,
            "sessionId": "fake-session",
            "sessionName": session_name,
            "fastModeEnabled": False,
            "fastModeActive": True,
            "tokensPerSecond": 7.25,
            "autoCompactionEnabled": auto_compaction_enabled,
            "messageCount": len(messages),
            "queuedMessageCount": sum(len(items) for items in queued_messages.values()),
            "queuedMessages": {"steering": queued_messages["steering"], "followUp": queued_messages["followUp"]},
            "todoPhases": todo_phases,
            "goal": goal_state,
            "dumpTools": [{"name": "read", "description": "Read files", "parameters": {"type": "object"}}] + registered_host_tools,
        }

    def emit_prompt_turn(
        text: str,
        delay: float = 0.0,
        include_extra_events: bool = False,
        compact_terminal: bool = False,
    ):
        global last_assistant_text, messages, message_counter
        message_counter += 1
        message_id = f"msg-{message_counter}"
        emit_event({"type": "agent_start"})
        emit_event({"type": "turn_start"})
        partial = assistant_message("")
        emit_event({"type": "message_start", "message": partial, "messageId": message_id})
        emit_event(
            {
                "type": "message_update",
                "message": partial,
                "messageId": message_id,
                "assistantMessageEvent": {
                    "type": "text_delta",
                    "contentIndex": 0,
                    "delta": text,
                    "partial": partial,
                },
            }
        )

        if delay:
            time.sleep(delay)

        if include_extra_events:
            print(
                json.dumps(
                    {
                        "type": "tool_execution_start",
                        "toolCallId": "tool-1",
                        "toolName": "read",
                        "args": {"path": "README.md"},
                        "intent": "Inspect docs",
                    }
                ),
                flush=True,
            )
            print(
                json.dumps(
                    {
                        "type": "tool_execution_update",
                        "toolCallId": "tool-1",
                        "toolName": "read",
                        "args": {"path": "README.md"},
                        "partialResult": {"bytes": 12},
                    }
                ),
                flush=True,
            )
            print(
                json.dumps(
                    {
                        "type": "tool_execution_end",
                        "toolCallId": "tool-1",
                        "toolName": "read",
                        "result": {"text": "docs"},
                        "isError": False,
                    }
                ),
                flush=True,
            )
            print(json.dumps({"type": "auto_compaction_start", "reason": "threshold", "action": "context-full"}), flush=True)
            print(
                json.dumps(
                    {
                        "type": "auto_compaction_end",
                        "action": "context-full",
                        "result": {
                            "summary": "trimmed",
                            "shortSummary": "trimmed",
                            "firstKeptEntryId": "entry-1",
                            "tokensBefore": 123,
                        },
                        "aborted": False,
                        "willRetry": False,
                    }
                ),
                flush=True,
            )
            print(
                json.dumps(
                    {
                        "type": "auto_retry_start",
                        "attempt": 1,
                        "maxAttempts": 3,
                        "delayMs": 25,
                        "errorMessage": "retrying",
                    }
                ),
                flush=True,
            )
            print(json.dumps({"type": "auto_retry_end", "success": True, "attempt": 1}), flush=True)
            print(json.dumps({"type": "retry_fallback_applied", "from": "a", "to": "b", "role": "primary"}), flush=True)
            print(json.dumps({"type": "retry_fallback_succeeded", "model": "b", "role": "primary"}), flush=True)
            print(json.dumps({"type": "ttsr_triggered", "rules": [{"id": "rule-1"}]}), flush=True)
            print(
                json.dumps(
                    {
                        "type": "todo_reminder",
                        "attempt": 1,
                        "maxAttempts": 2,
                        "todos": [{"id": "task-1", "content": "Map tools", "status": "pending"}],
                    }
                ),
                flush=True,
            )
            print(json.dumps({"type": "todo_auto_clear"}), flush=True)

        assistant = assistant_message(text)
        emit_event({"type": "message_end", "message": assistant, "messageId": message_id})
        emit_event({"type": "turn_end", "message": assistant, "toolResults": []})
        if compact_terminal:
            terminal = assistant_message("terminal")
            print(
                json.dumps(
                    {
                        "type": "agent_end",
                        "messages": [terminal],
                        "messageCount": 2,
                    }
                ),
                flush=True,
            )
            last_assistant_text = "terminal"
            messages = [assistant, terminal]
        else:
            emit_event({"type": "agent_end", "messages": [assistant]})
            last_assistant_text = text
            messages = [assistant]

    def respond(request_id, command, data=None, success=True, error=None):
        payload = {"id": request_id, "type": "response", "command": command, "success": success}
        if success and data is not None:
            payload["data"] = data
        if not success:
            payload["error"] = error
        print(json.dumps(payload), flush=True)

    print(json.dumps({"type": "ready"}), flush=True)
    todo_phases = []
    messages = []
    queued_messages = {"steering": [], "followUp": []}
    branch_messages = [{"entryId": "entry-1", "text": "branch message"}]
    model_provider = "anthropic"
    model_id = "claude-sonnet-4-5"
    thinking_level = "medium"
    steering_mode = "one-at-a-time"
    follow_up_mode = "one-at-a-time"
    interrupt_mode = "immediate"
    auto_compaction_enabled = True
    auto_retry_enabled = True
    session_name = "Scratchpad"
    last_assistant_text = None
    last_ui_response = None
    goal_state = None

    for raw_line in sys.stdin:
        raw_line = raw_line.strip()
        if not raw_line:
            continue

        command = json.loads(raw_line)
        command_type = command["type"]
        request_id = command.get("id")

        if command_type == "extension_ui_response":
            last_ui_response = command
            emit_prompt_turn("ui acknowledged")
            settle_pending_prompt()
            continue

        if command_type == "get_state":
            respond(request_id, "get_state", current_state())
        elif command_type == "set_host_tools":
            registered_host_tools = command.get("tools", [])
            respond(
                request_id,
                "set_host_tools",
                {"toolNames": [tool.get("name", "") for tool in registered_host_tools]},
            )
        elif command_type == "set_todos":
            todo_phases = command.get("phases", [])
            respond(request_id, "set_todos", {"todoPhases": todo_phases})
        elif command_type == "get_messages":
            respond(request_id, "get_messages", {"messages": messages})
        elif command_type == "set_host_tools":
            tool_names = [tool.get("name", "") for tool in command.get("tools", [])]
            respond(request_id, "set_host_tools", {"toolNames": tool_names})
        elif command_type == "set_model":
            model_provider = command["provider"]
            model_id = command["modelId"]
            respond(request_id, "set_model", model_info(model_id, model_provider))
        elif command_type == "cycle_model" and model_id == "solo":
            print(json.dumps({"id": request_id, "type": "response", "command": "cycle_model", "success": True, "data": None}), flush=True)
        elif command_type == "cycle_model":
            model_id = "claude-sonnet-4-6" if model_id == "claude-sonnet-4-5" else "claude-sonnet-4-5"
            respond(request_id, "cycle_model", {"model": model_info(model_id, model_provider), "thinkingLevel": thinking_level, "isScoped": False})
        elif command_type == "get_available_models":
            respond(
                request_id,
                "get_available_models",
                {
                    "models": [
                        model_info("claude-sonnet-4-5", "anthropic"),
                        model_info("claude-sonnet-4-6", "anthropic"),
                    ]
                },
            )
        elif command_type == "set_thinking_level":
            thinking_level = command["level"]
            respond(request_id, "set_thinking_level", {})
        elif command_type == "cycle_thinking_level":
            thinking_level = "high" if thinking_level != "high" else "low"
            respond(request_id, "cycle_thinking_level", {"level": thinking_level})
        elif command_type == "set_steering_mode":
            steering_mode = command["mode"]
            respond(request_id, "set_steering_mode", {})
        elif command_type == "set_follow_up_mode":
            follow_up_mode = command["mode"]
            respond(request_id, "set_follow_up_mode", {})
        elif command_type == "set_interrupt_mode":
            interrupt_mode = command["mode"]
            respond(request_id, "set_interrupt_mode", {})
        elif command_type == "compact":
            respond(
                request_id,
                "compact",
                {"summary": "trimmed", "shortSummary": "trimmed", "firstKeptEntryId": "entry-1", "tokensBefore": 123},
            )
        elif command_type == "set_fast_mode":
            enabled = command.get("enabled")
            if not isinstance(enabled, bool):
                respond(
                    request_id,
                    "set_fast_mode",
                    success=False,
                    error="set_fast_mode requires boolean enabled",
                )
            else:
                respond(
                    request_id,
                    "set_fast_mode",
                    {"enabled": False, "active": True},
                )
        elif command_type == "set_auto_compaction":
            auto_compaction_enabled = command["enabled"]
            respond(request_id, "set_auto_compaction", {})
        elif command_type == "set_auto_retry":
            auto_retry_enabled = command["enabled"]
            respond(request_id, "set_auto_retry", {})
        elif command_type == "set_cache_warming":
            # "streaming" answers with a mode outside the protocol to exercise response validation.
            effective = "always" if command["mode"] == "streaming" else command["mode"]
            respond(request_id, "set_cache_warming", {"mode": effective})
        elif command_type == "abort_retry":
            respond(request_id, "abort_retry", {})
        elif command_type == "bash":
            respond(
                request_id,
                "bash",
                {
                    "output": "hello\\n",
                    "exitCode": 0,
                    "cancelled": False,
                    "truncated": False,
                    "totalLines": 1,
                    "totalBytes": 6,
                    "outputLines": 1,
                    "outputBytes": 6,
                },
            )
        elif command_type == "abort_bash":
            respond(request_id, "abort_bash", {})
        elif command_type == "get_session_stats":
            respond(
                request_id,
                "get_session_stats",
                {
                    "sessionFile": "/tmp/fake-session.jsonl",
                    "sessionId": "fake-session",
                    "userMessages": 1,
                    "assistantMessages": len(messages),
                    "toolCalls": 1,
                    "toolResults": 1,
                    "totalMessages": len(messages) + 1,
                    "tokens": {"input": 10, "output": 5, "cacheRead": 0, "cacheWrite": 0, "total": 15},
                    "premiumRequests": 0,
                    "cost": 0.0,
                },
            )
        elif command_type == "export_html":
            respond(request_id, "export_html", {"path": command.get("outputPath") or "/tmp/session.html"})
        elif command_type == "new_session":
            respond(request_id, "new_session", {"cancelled": False})
        elif command_type in {"open_session", "switch_session"}:
            session_path = command["sessionDir" if command_type == "open_session" else "sessionPath"]
            if session_path.startswith("/tmp/unavailable") and "provider" not in command:
                respond(
                    request_id, command_type, success=False,
                    error="Could not restore model local/missing-model",
                )
                continue
            if "provider" in command:
                model_provider = command["provider"]
                model_id = command["modelId"]
            if command_type == "switch_session":
                respond(request_id, command_type, {"cancelled": False})
            else:
                respond(
                    request_id, command_type,
                    {
                        "cancelled": False,
                        "resumed": True,
                        "sessionId": "resumed-session",
                        "sessionFile": f"{session_path}/resumed.jsonl",
                    },
                )
        elif command_type == "set_event_filter":
            event_filter = command["events"]
            respond(request_id, "set_event_filter", {"events": event_filter})
        elif command_type == "branch":
            branch_messages = [{"entryId": command["entryId"], "text": "branch message"}]
            respond(request_id, "branch", {"text": "branch created", "cancelled": False})
        elif command_type == "fork":
            # Report whether entryId reached the wire; a whole-session fork must omit it.
            respond(request_id, "fork", {"cancelled": "entryId" not in command})
        elif command_type == "get_branch_messages":
            respond(request_id, "get_branch_messages", {"messages": branch_messages})
        elif command_type == "get_last_assistant_text":
            respond(request_id, "get_last_assistant_text", {"text": last_assistant_text})
        elif command_type == "set_session_name":
            session_name = command["name"]
            respond(request_id, "set_session_name", {})
        elif command_type in {"steer", "follow_up"}:
            queue_name = "steering" if command_type == "steer" else "followUp"
            queued_messages[queue_name].append(command["message"])
            respond(request_id, command_type, {})
            print(json.dumps({"type": "queue_update", "steering": queued_messages["steering"], "followUp": queued_messages["followUp"]}), flush=True)
        elif command_type == "remove_queued_message":
            items = queued_messages.get(command.get("queue"))
            if items is None:
                respond(request_id, command_type, success=False, error="invalid queue")
                continue
            removed = command["message"] in items
            if removed:
                items.remove(command["message"])
            respond(request_id, command_type, {"removed": removed})
            if removed:
                print(json.dumps({"type": "queue_update", "steering": queued_messages["steering"], "followUp": queued_messages["followUp"]}), flush=True)
        elif command_type == "promote_queued_message":
            promoted = command["message"] in queued_messages["followUp"]
            if promoted:
                queued_messages["followUp"].remove(command["message"])
                queued_messages["steering"].append(command["message"])
            respond(request_id, command_type, {"promoted": promoted})
            if promoted:
                print(json.dumps({"type": "queue_update", "steering": queued_messages["steering"], "followUp": queued_messages["followUp"]}), flush=True)
        elif command_type == "abort":
            respond(request_id, command_type, {})
        elif command_type == "debug_last_ui_response":
            respond(request_id, command_type, last_ui_response)
        elif command_type == "goal":
            if command["op"] == "create":
                goal_state = {
                    "enabled": True,
                    "mode": "active",
                    "goal": {
                        "id": "goal-1",
                        "objective": command["objective"],
                        "status": "active",
                        "tokenBudget": command.get("token_budget"),
                        "tokensUsed": 0,
                        "timeUsedSeconds": 0,
                        "createdAt": 1,
                        "updatedAt": 1,
                    },
                }
            respond(request_id, "goal", {"goal": goal_state["goal"] if goal_state else None, "state": goal_state})
        elif command_type == "handoff":
            data = None if command.get("customInstructions") == "decline" else {}
            print(json.dumps({"id": request_id, "type": "response", "command": "handoff", "success": True, "data": data}), flush=True)
        elif command_type in {"predict_word", "slow_command"}:
            time.sleep(0.6)
            respond(request_id, command_type, {"suffix": "ld"})
        elif command_type in {"prompt", "abort_and_prompt"}:
            message = command["message"]
            if message == "/local":
                respond(request_id, command_type, {"agentInvoked": False})
                continue
            respond(request_id, command_type, {})
            pending_prompt_id = request_id
            if message == "after stale run":
                # A terminal agent_end and prompt_result left over from an
                # earlier prompt arrive after this prompt was accepted.
                stale = assistant_message("stale")
                print(json.dumps({"type": "agent_end", "messages": [stale]}), flush=True)
                emit_prompt_result("req_earlier")
                time.sleep(0.1)
            if message == "needs ui":
                print(json.dumps({"type": "extension_ui_request", "id": "ui-1", "method": "input", "title": "Need input", "placeholder": "value"}), flush=True)
                continue
            if message == "needs confirm":
                print(json.dumps({"type": "extension_ui_request", "id": "ui-2", "method": "confirm", "title": "Confirm", "message": "Continue?"}), flush=True)
                continue
            if message == "needs ask":
                print(
                    json.dumps(
                        {
                            "type": "extension_ui_request",
                            "id": "ui-ask",
                            "method": "ask",
                            "questions": [
                                {"id": "db", "question": "Which database?", "options": [{"label": "Postgres"}, {"label": "SQLite"}], "recommended": 1},
                                {"id": "features", "question": "Which features?", "options": [{"label": "Auth"}, {"label": "Search"}], "multi": True},
                            ],
                        }
                    ),
                    flush=True,
                )
                continue
            if message == "side frames":
                print(json.dumps({"type": "available_commands_update", "commands": [{"name": "plan", "source": "builtin"}]}), flush=True)
                print(json.dumps({"type": "subagent_lifecycle", "payload": {"id": "Worker", "agent": "task", "agentSource": "bundled", "status": "started", "index": 0}}), flush=True)
                print(json.dumps({"type": "live_phase", "phase": "listening"}), flush=True)
            if message == "needs cancel":
                print(json.dumps({"type": "extension_ui_request", "id": "ui-3", "method": "editor", "title": "Edit", "placeholder": "value"}), flush=True)
                continue
            if message == "needs host tool":
                print(json.dumps({"type": "agent_start"}), flush=True)
                host_event_tool_call_id = "toolu_host_1"
                host_event_tool_name = "echo_host"
                print(
                    json.dumps(
                        {
                            "type": "host_tool_call",
                            "id": "host-call-1",
                            "toolCallId": "toolu_host_1",
                            "toolName": "echo_host",
                            "arguments": {"message": "hello"},
                        }
                    ),
                    flush=True,
                )
                continue
            if message == "needs xd host tool":
                print(json.dumps({"type": "agent_start"}), flush=True)
                host_event_tool_call_id = "toolu_write_1"
                host_event_tool_name = "write"
                print(
                    json.dumps(
                        {
                            "type": "tool_execution_start",
                            "toolCallId": "toolu_write_1",
                            "toolName": "write",
                            "args": {"path": "xd://echo_host", "content": '{"message": "hello"}'},
                        }
                    ),
                    flush=True,
                )
                print(
                    json.dumps(
                        {
                            "type": "host_tool_call",
                            "id": "host-call-2",
                            "toolCallId": "toolu_write_1",
                            "toolName": "echo_host",
                            "arguments": {"message": "hello"},
                        }
                    ),
                    flush=True,
                )
                continue
            if message == "needs eval host tool":
                # The eval bridge runs session tools in-process under a
                # synthetic call id; the only transport tool event on the wire
                # is the enclosing `eval` call.
                print(json.dumps({"type": "agent_start"}), flush=True)
                host_event_tool_call_id = "toolu_eval_1"
                host_event_tool_name = "eval"
                print(
                    json.dumps(
                        {
                            "type": "tool_execution_start",
                            "toolCallId": "toolu_eval_1",
                            "toolName": "eval",
                            "args": {"language": "js", "code": "await tool.echo_host({message: 'hello'})"},
                        }
                    ),
                    flush=True,
                )
                print(
                    json.dumps(
                        {
                            "type": "host_tool_call",
                            "id": "host-call-3",
                            "toolCallId": "js-echo_host-1",
                            "toolName": "echo_host",
                            "arguments": {"message": "hello"},
                        }
                    ),
                    flush=True,
                )
                continue
            if message == "notifications":
                print(json.dumps({"type": "extension_error", "extensionPath": "/tmp/ext.py", "event": "run", "error": "boom"}), flush=True)
                print(json.dumps({"type": "unknown_future_event", "value": 1}), flush=True)
            emit_prompt_turn(
                "pong",
                delay=0.3 if message == "slow" else 0.0,
                include_extra_events=message == "all events",
                compact_terminal=message == "compacted turn",
            )
            settle_pending_prompt(background_job=message == "background job")
        elif command_type == "host_tool_update":
            print(
                json.dumps(
                    {
                        "type": "tool_execution_update",
                        "toolCallId": host_event_tool_call_id,
                        "toolName": host_event_tool_name,
                        "args": {"message": "hello"},
                        "partialResult": command["partialResult"],
                    }
                ),
                flush=True,
            )
        elif command_type == "host_tool_result":
            print(
                json.dumps(
                    {
                        "type": "tool_execution_end",
                        "toolCallId": host_event_tool_call_id,
                        "toolName": host_event_tool_name,
                        "result": command["result"],
                        "isError": command.get("isError", False),
                    }
                ),
                flush=True,
            )
            print(json.dumps({"type": "agent_end", "messages": []}), flush=True)
            settle_pending_prompt()
        else:
            respond(request_id, command_type, success=False, error=f"unsupported: {command_type}")
    """
)


V2_MESSAGES_SERVER = textwrap.dedent(
    """
    import base64
    import json
    import os
    import sys

    message = {
        "role": "user",
        "content": [{"type": "text", "text": "x" * (1024 * 1024)}],
        "timestamp": 1,
    }

    def emit(payload):
        encoded = json.dumps(payload, separators=(",", ":")).encode("utf-8")
        if len(encoded) <= 1024 * 1024:
            print(encoded.decode("utf-8"), flush=True)
            return
        chunk_size = 256 * 1024
        count = (len(encoded) + chunk_size - 1) // chunk_size
        for index in range(count):
            chunk = encoded[index * chunk_size : (index + 1) * chunk_size]
            print(
                json.dumps(
                    {
                        "type": "rpc_chunk",
                        "chunkId": "test-page",
                        "index": index,
                        "count": count,
                        "byteLength": len(encoded),
                        "data": base64.b64encode(chunk).decode("ascii"),
                    },
                    separators=(",", ":"),
                ),
                flush=True,
            )

    print(
        json.dumps(
            {
                "type": "ready",
                "protocolVersion": 1,
                "supportedProtocolVersions": [1, 2],
                "maxFrameBytes": 1024 * 1024,
                "maxReassembledFrameBytes": 64 * 1024 * 1024,
            }
        ),
        flush=True,
    )

    for raw_line in sys.stdin:
        command = json.loads(raw_line)
        request_id = command["id"]
        command_type = command["type"]
        if command_type == "negotiate_protocol":
            emit(
                {
                    "id": request_id,
                    "type": "response",
                    "command": command_type,
                    "success": True,
                    "data": {"protocolVersion": 2},
                }
            )
        elif command_type == "get_messages_page":
            if os.environ.get("V2_MESSAGES_BUSY") == "1":
                emit(
                    {
                        "id": request_id,
                        "type": "response",
                        "command": command_type,
                        "success": False,
                        "error": "Cannot page messages while the session is changing",
                        "code": "session_busy",
                    }
                )
                continue
            if os.environ.get("V2_MESSAGES_STALE") == "1":
                if command.get("cursor") is not None:
                    emit(
                        {
                            "id": request_id,
                            "type": "response",
                            "command": command_type,
                            "success": False,
                            "error": "RPC message cursor is stale",
                            "code": "stale_cursor",
                        }
                    )
                    continue
                emit(
                    {
                        "id": request_id,
                        "type": "response",
                        "command": command_type,
                        "success": True,
                        "data": {
                            "messages": [message],
                            "totalMessages": 2,
                            "nextCursor": "page-two",
                        },
                    }
                )
                continue
            emit(
                {
                    "id": request_id,
                    "type": "response",
                    "command": command_type,
                    "success": True,
                    "data": {
                        "messages": [message],
                        "totalMessages": 1,
                        "nextCursor": None,
                    },
                }
            )
        elif command_type == "get_messages":
            emit(
                {
                    "id": request_id,
                    "type": "response",
                    "command": command_type,
                    "success": True,
                    "data": {
                        "messages": [
                            {
                                "role": "assistant",
                                "content": [
                                    {"type": "text", "text": "streaming snapshot"}
                                ],
                                "timestamp": 3,
                            }
                        ]
                    },
                }
            )
        else:
            emit(
                {
                    "id": request_id,
                    "type": "response",
                    "command": command_type,
                    "success": False,
                    "error": f"unexpected command: {command_type}",
                }
            )
    """
)

IDLESS_ERROR_SERVER = textwrap.dedent(
    """
    import json
    import sys

    print(json.dumps({"type": "ready"}), flush=True)

    for raw_line in sys.stdin:
        raw_line = raw_line.strip()
        if not raw_line:
            continue

        command = json.loads(raw_line)
        if command["type"] == "set_host_tools":
            print(
                json.dumps(
                    {
                        "id": command.get("id"),
                        "type": "response",
                        "command": "set_host_tools",
                        "success": True,
                        "data": {"toolNames": []},
                    }
                ),
                flush=True,
            )
            continue
        print(
            json.dumps(
                {
                    "type": "response",
                    "command": command["type"],
                    "success": False,
                    "error": f"unsupported: {command['type']}",
                }
            ),
            flush=True,
        )
    """
)

LATE_PROMPT_FAILURE_SERVER = textwrap.dedent(
    """
    import json
    import sys

    print(json.dumps({"type": "ready"}), flush=True)

    for raw_line in sys.stdin:
        raw_line = raw_line.strip()
        if not raw_line:
            continue

        command = json.loads(raw_line)
        request_id = command.get("id")
        if command["type"] == "set_host_tools":
            print(
                json.dumps(
                    {
                        "id": request_id,
                        "type": "response",
                        "command": "set_host_tools",
                        "success": True,
                        "data": {"toolNames": []},
                    }
                ),
                flush=True,
            )
            continue
        if command["type"] == "prompt":
            print(
                json.dumps(
                    {
                        "id": request_id,
                        "type": "response",
                        "command": "prompt",
                        "success": True,
                    }
                ),
                flush=True,
            )
            print(
                json.dumps(
                    {
                        "id": request_id,
                        "type": "response",
                        "command": "prompt",
                        "success": False,
                        "error": "late failure",
                    }
                ),
                flush=True,
            )
            print(
                json.dumps(
                    {
                        "type": "prompt_result",
                        "id": request_id,
                        "agentInvoked": False,
                        "sessionSettled": True,
                        "status": "error",
                        "error": {"message": "late failure", "retryable": False},
                    }
                ),
                flush=True,
            )
        else:
            print(
                json.dumps(
                    {
                        "id": request_id,
                        "type": "response",
                        "command": command["type"],
                        "success": True,
                    }
                ),
                flush=True,
            )
    """
)

STDERR_SERVER = textwrap.dedent(
    """
    import json
    import sys

    sys.stderr.write("first\\n")
    sys.stderr.flush()
    sys.stderr.write("second\\n")
    sys.stderr.flush()
    print(json.dumps({"type": "ready"}), flush=True)

    for raw_line in sys.stdin:
        raw_line = raw_line.strip()
        if not raw_line:
            continue
        command = json.loads(raw_line)
        if command["type"] == "set_host_tools":
            print(
                json.dumps(
                    {
                        "id": command.get("id"),
                        "type": "response",
                        "command": "set_host_tools",
                        "success": True,
                        "data": {"toolNames": []},
                    }
                ),
                flush=True,
            )
    """
)

INVALID_JSON_SERVER = textwrap.dedent(
    """
    import sys

    sys.stdout.write('{"type":"ready"}\\n')
    sys.stdout.flush()
    sys.stdout.write('{"type":"broken"\\n')
    sys.stdout.flush()
    """
)

BROKEN_STARTUP_SERVER = textwrap.dedent(
    """
    import sys

    sys.stdout.write('not-json\\n')
    sys.stdout.flush()
    """
)

FORWARD_COMPAT_SERVER = textwrap.dedent(
    """
    import json
    import sys
    import time

    print(json.dumps({"type": "ready"}), flush=True)
    for raw_line in sys.stdin:
        command = json.loads(raw_line)
        print(
            json.dumps(
                {
                    "id": command.get("id"),
                    "type": "response",
                    "command": command["type"],
                    "success": True,
                }
            ),
            flush=True,
        )
        if command["type"] != "prompt":
            continue
        if command.get("message") == "malformed terminal":
            print(
                json.dumps(
                    {
                        "type": "agent_end",
                        "messages": [{"role": "future_role"}],
                        "isTerminal": True,
                    }
                ),
                flush=True,
            )
            time.sleep(2)
            print(
                json.dumps(
                    {
                        "type": "prompt_result",
                        "id": command.get("id"),
                        "agentInvoked": True,
                        "sessionSettled": True,
                        "status": "completed",
                    }
                ),
                flush=True,
            )
            continue
        print(
            json.dumps(
                {
                    "type": "auto_compaction_start",
                    "reason": "future_reason",
                    "action": "future_action",
                }
            ),
            flush=True,
        )
        print(
            json.dumps(
                {"type": "agent_end", "messages": [], "isTerminal": False}
            ),
            flush=True,
        )
        time.sleep(0.15)
        print(
            json.dumps(
                {"type": "agent_end", "messages": [], "isTerminal": True}
            ),
            flush=True,
        )
        print(
            json.dumps(
                {
                    "type": "prompt_result",
                    "id": command.get("id"),
                    "agentInvoked": True,
                    "sessionSettled": True,
                    "status": "completed",
                }
            ),
            flush=True,
        )
    """
)


class RpcClientTests(unittest.TestCase):
    def make_client(self, server: str = FAKE_SERVER, **kwargs: object) -> RpcClient:
        options: dict[str, object] = {
            "startup_timeout": 2.0,
            "request_timeout": 2.0,
            **kwargs,
        }
        return RpcClient(command=[sys.executable, "-u", "-c", server], **options)

    def test_ui_waiter_gets_the_exit_error_when_its_child_stops_or_is_replaced(self) -> None:
        for restart in (False, True):
            with self.subTest(restart=restart):
                client = self.make_client()
                client.start()
                outcome: list[BaseException | object] = []

                def wait() -> None:
                    try:
                        outcome.append(client.next_ui_request())
                    except BaseException as exc:
                        outcome.append(exc)

                waiter = threading.Thread(target=wait, daemon=True)
                waiter.start()
                time.sleep(0.2)
                client.stop()
                if restart:
                    client.start()
                waiter.join(3.0)
                try:
                    self.assertFalse(waiter.is_alive(), "next_ui_request() stayed blocked")
                    self.assertIsInstance(outcome[0], RpcProcessExitError)
                    if restart:
                        # The new child's waits are not poisoned by the old child's close.
                        with self.assertRaises(RpcTimeoutError):
                            client.next_ui_request(timeout=0.2)
                finally:
                    client.stop()

    @unittest.skipUnless(os.name == "posix", "the holder is started with start_new_session")
    def test_child_exit_closes_the_client_while_an_outside_process_holds_stdout(self) -> None:
        # The child starts a process in a session of its own that inherits its
        # stdout, so the pipe stays open after the child exits and the stdout
        # reader sees no EOF. A request makes the child send one dialog and exit.
        temp_dir = Path(tempfile.mkdtemp(prefix="omp-rpc-exit-holder-"))
        self.addCleanup(shutil.rmtree, temp_dir, True)
        holder_file = temp_dir / "holder.pid"
        server = textwrap.dedent(
            f"""
            import json, os, subprocess, sys
            holder = subprocess.Popen(["sleep", "60"], stdin=subprocess.DEVNULL,
                                      stderr=subprocess.DEVNULL, start_new_session=True)
            with open({str(holder_file)!r} + ".tmp", "w") as f:
                f.write(str(holder.pid))
            os.rename({str(holder_file)!r} + ".tmp", {str(holder_file)!r})
            print(json.dumps({{"type": "ready"}}), flush=True)
            sys.stdin.readline()
            print(json.dumps({{"type": "extension_ui_request", "id": "ui-last", "method": "confirm",
                               "title": "Confirm", "message": "Continue?"}}), flush=True)
            os._exit(23)
            """
        )
        client = self.make_client(server, request_timeout=60.0)
        client.start()

        def kill_holder() -> None:
            with contextlib.suppress(FileNotFoundError, ValueError, ProcessLookupError):
                os.kill(int(holder_file.read_text()), signal.SIGKILL)

        self.addCleanup(kill_holder)
        self.addCleanup(client.stop)
        outcome: dict[str, list[BaseException | object]] = {"ui": [], "request": []}

        def wait_ui() -> None:
            for _ in range(2):
                try:
                    outcome["ui"].append(client.next_ui_request())
                except BaseException as exc:
                    outcome["ui"].append(exc)
                    return

        def request() -> None:
            try:
                outcome["request"].append(client.get_state())
            except BaseException as exc:
                outcome["request"].append(exc)

        ui_waiter = threading.Thread(target=wait_ui, daemon=True)
        ui_waiter.start()
        requester = threading.Thread(target=request, daemon=True)
        requester.start()
        ui_waiter.join(15.0)
        requester.join(15.0)
        self.assertTrue(holder_file.exists())
        self.assertFalse(ui_waiter.is_alive(), "next_ui_request() stayed blocked after the child exited")
        self.assertFalse(requester.is_alive(), "the pending request stayed blocked after the child exited")
        # The dialog the child sent before it exited comes first, then the exit error.
        first, second = outcome["ui"]
        self.assertNotIsInstance(first, BaseException)
        self.assertEqual(getattr(first, "id", None), "ui-last")
        self.assertIsInstance(second, RpcProcessExitError)
        self.assertIn("code 23", str(second))
        self.assertIsInstance(outcome["request"][0], RpcProcessExitError)

    @unittest.skipUnless(os.name == "posix", "the holder is started with start_new_session")
    def test_child_exit_ends_a_request_blocked_writing_to_stdin_an_outside_process_holds(
        self,
    ) -> None:
        # The child starts a process in a session of its own that inherits its
        # stdin and stdout, stops reading and exits. A request too large for
        # the pipe is blocked writing when the child exits: the request timeout
        # starts only after the write, so only the exit can end it.
        temp_dir = Path(tempfile.mkdtemp(prefix="omp-rpc-exit-writer-"))
        self.addCleanup(shutil.rmtree, temp_dir, True)
        holder_file = temp_dir / "holder.pid"
        server = textwrap.dedent(
            f"""
            import json, os, subprocess, time
            holder = subprocess.Popen(["sleep", "60"], stderr=subprocess.DEVNULL,
                                      start_new_session=True)
            with open({str(holder_file)!r} + ".tmp", "w") as f:
                f.write(str(holder.pid))
            os.rename({str(holder_file)!r} + ".tmp", {str(holder_file)!r})
            print(json.dumps({{"type": "ready"}}), flush=True)
            time.sleep(1.0)
            os._exit(23)
            """
        )
        client = self.make_client(server, startup_timeout=15.0, request_timeout=60.0)
        client.start()

        def kill_holder() -> None:
            with contextlib.suppress(FileNotFoundError, ValueError, ProcessLookupError):
                os.kill(int(holder_file.read_text()), signal.SIGKILL)

        self.addCleanup(kill_holder)
        self.addCleanup(client.stop)
        outcome: list[BaseException | object] = []

        def request() -> None:
            try:
                outcome.append(client.request_raw("large", data="x" * 4_000_000))
            except BaseException as exc:
                outcome.append(exc)

        requester = threading.Thread(target=request, daemon=True)
        requester.start()
        requester.join(15.0)
        self.assertTrue(holder_file.exists())
        self.assertFalse(requester.is_alive(), "the request stayed blocked writing after the child exited")
        self.assertIsInstance(outcome[0], RpcProcessExitError)
        self.assertIn("code 23", str(outcome[0]))

    @unittest.skipUnless(os.name == "posix", "stdin writes wait for room only on POSIX")
    def test_a_close_ends_a_request_blocked_writing_to_a_child_that_stopped_reading(
        self,
    ) -> None:
        # The child never reads its stdin and stays alive. While a request too
        # large for the pipe is blocked writing, the child sends a frame that is
        # not JSON, which closes the client: the request ends with that error.
        server = textwrap.dedent(
            """
            import json, time
            print(json.dumps({"type": "ready"}), flush=True)
            time.sleep(1.0)
            print("not json", flush=True)
            time.sleep(60)
            """
        )
        client = self.make_client(server, startup_timeout=15.0, request_timeout=60.0)
        client.start()
        self.addCleanup(client.stop)
        outcome: list[BaseException | object] = []

        def request() -> None:
            try:
                outcome.append(client.request_raw("large", data="x" * 4_000_000))
            except BaseException as exc:
                outcome.append(exc)

        requester = threading.Thread(target=request, daemon=True)
        requester.start()
        requester.join(15.0)
        self.assertFalse(requester.is_alive(), "the request stayed blocked writing after the client closed")
        self.assertIsInstance(outcome[0], RpcProcessExitError)
        self.assertIn("Failed to decode RPC output", str(outcome[0]))

    def test_frames_the_child_wrote_before_it_exited_reach_consumers_before_the_exit_error(
        self,
    ) -> None:
        # The child answers the request with a notification, a dialog and the
        # reply in one write, then exits; no other process holds its pipes. A
        # notification listener holds the stdout reader for 8 s (a cap on the
        # drain closed the client 6 s after the exit). The reply still answers
        # the request, and the UI queue gives the dialog before the exit error.
        server = textwrap.dedent(
            """
            import json, os, sys
            print(json.dumps({"type": "ready"}), flush=True)
            command = json.loads(sys.stdin.readline())
            frames = [
                {"type": "probe_gate"},
                {"type": "extension_ui_request", "id": "last-dialog", "method": "confirm",
                 "title": "Last", "message": "Must precede exit"},
                {"type": "response", "id": command["id"], "command": command["type"],
                 "success": True, "data": {"sentinel": "completed-before-exit"}},
            ]
            os.write(1, "".join(json.dumps(frame) + "\\n" for frame in frames).encode())
            os._exit(23)
            """
        )
        client = self.make_client(server, request_timeout=60.0)
        entered = threading.Event()
        release = threading.Event()
        self.addCleanup(release.set)

        def hold(notification: object) -> None:
            if getattr(notification, "payload", {}).get("type") == "probe_gate":
                entered.set()
                release.wait(8.0)

        client.on_notification(hold)
        client.start()
        self.addCleanup(client.stop)
        outcome: list[BaseException | object] = []

        def request() -> None:
            try:
                outcome.append(client.request_raw("probe"))
            except BaseException as exc:
                outcome.append(exc)
            finally:
                release.set()

        requester = threading.Thread(target=request, daemon=True)
        requester.start()
        self.assertTrue(entered.wait(15.0), "the child's first frame never reached the listener")
        requester.join(30.0)
        self.assertFalse(requester.is_alive(), "the request stayed blocked")
        self.assertEqual(outcome, [{"sentinel": "completed-before-exit"}])
        first = client.next_ui_request(timeout=5.0)
        self.assertEqual(getattr(first, "id", None), "last-dialog")
        with self.assertRaises(RpcProcessExitError) as raised:
            client.next_ui_request(timeout=5.0)
        self.assertIn("code 23", str(raised.exception))

    @unittest.skipUnless(hasattr(os, "waitid"), "waits for the child's exit without reaping it")
    def test_a_reply_the_exited_child_cannot_read_keeps_its_later_frames(self) -> None:
        # The child calls a host tool this client does not have, then sends a
        # dialog and the reply to the request, and exits. A listener holds the
        # stdout reader until the child has exited, so the client's error reply
        # to the tool call fails to reach it. The frames after the call still
        # reach their consumers, before the exit error.
        server = textwrap.dedent(
            """
            import json, os, sys
            print(json.dumps({"type": "ready"}), flush=True)
            command = json.loads(sys.stdin.readline())
            frames = [
                {"type": "probe_gate"},
                {"type": "host_tool_call", "id": "call-1", "toolName": "missing",
                 "toolCallId": "tool-call-1", "arguments": {}},
                {"type": "extension_ui_request", "id": "last-dialog", "method": "confirm",
                 "title": "Last", "message": "Must precede exit"},
                {"type": "response", "id": command["id"], "command": command["type"],
                 "success": True, "data": {"sentinel": "completed-before-exit"}},
            ]
            os.write(1, "".join(json.dumps(frame) + "\\n" for frame in frames).encode())
            os._exit(23)
            """
        )
        client = self.make_client(server, request_timeout=60.0)
        child_pid: list[int] = []
        exited = threading.Event()

        def hold(notification: object) -> None:
            if getattr(notification, "payload", {}).get("type") != "probe_gate":
                return
            deadline = time.monotonic() + 15.0
            while time.monotonic() < deadline:
                if os.waitid(os.P_PID, child_pid[0], os.WEXITED | os.WNOHANG | os.WNOWAIT):
                    exited.set()
                    return
                time.sleep(0.01)

        client.on_notification(hold)
        client.start()
        self.addCleanup(client.stop)
        assert client._process is not None
        child_pid.append(client._process.pid)
        outcome: list[BaseException | object] = []

        def request() -> None:
            try:
                outcome.append(client.request_raw("probe"))
            except BaseException as exc:
                outcome.append(exc)

        requester = threading.Thread(target=request, daemon=True)
        requester.start()
        requester.join(30.0)
        self.assertTrue(exited.is_set(), "the child did not exit while the listener held the reader")
        self.assertFalse(requester.is_alive(), "the request stayed blocked")
        self.assertEqual(outcome, [{"sentinel": "completed-before-exit"}])
        first = client.next_ui_request(timeout=5.0)
        self.assertEqual(getattr(first, "id", None), "last-dialog")
        with self.assertRaises(RpcProcessExitError) as raised:
            client.next_ui_request(timeout=5.0)
        self.assertIn("code 23", str(raised.exception))

    def test_ask_answers_reach_the_wire_in_question_order(self) -> None:
        with self.make_client() as client:
            client.prompt("needs ask")
            request = client.next_ui_request(timeout=2.0)
            self.assertTrue(request.requires_response())
            questions = request.questions or ()
            client.send_ui_answers(
                request.id,
                [
                    AskAnswer(id=questions[0].id, selected_options=(), custom_input="DuckDB"),
                    AskAnswer(id=questions[1].id, selected_options=("Auth", "Search")),
                ],
            )
            client.wait_for_idle(timeout=2.0)
            self.assertEqual(
                client.request_raw("debug_last_ui_response"),
                {
                    "type": "extension_ui_response",
                    "id": "ui-ask",
                    "answers": [
                        {"id": "db", "selectedOptions": [], "customInput": "DuckDB"},
                        {"id": "features", "selectedOptions": ["Auth", "Search"]},
                    ],
                },
            )

    def test_headless_ui_cancels_ask_so_the_prompt_completes(self) -> None:
        with self.make_client() as client:
            client.install_headless_ui()
            turn = client.prompt_and_wait("needs ask", timeout=2.0)
            self.assertEqual(turn.assistant_text, "ui acknowledged")
            self.assertEqual(
                client.request_raw("debug_last_ui_response"),
                {"type": "extension_ui_response", "id": "ui-ask", "cancelled": True},
            )

    def test_null_command_data_is_distinct_from_an_empty_result(self) -> None:
        with self.make_client() as client:
            self.assertIsNone(client.handoff("decline"))
            self.assertEqual(client.handoff(), HandoffResult(saved_path=None))
            self.assertIsNotNone(client.cycle_model())
            client.set_model("anthropic", "solo")
            # Regression: a null cycle_model result used to raise instead of returning None.
            self.assertIsNone(client.cycle_model())

    def test_non_session_frames_reach_their_listeners_but_not_the_event_history(
        self,
    ) -> None:
        commands: list[AvailableCommandsUpdateEvent] = []
        lifecycle: list[SubagentLifecycleEvent] = []
        live: list[LivePhaseEvent] = []
        with self.make_client() as client:
            client.on_available_commands_update(commands.append)
            client.on_subagent_lifecycle(lifecycle.append)
            client.on_live_phase(live.append)
            turn = client.prompt_and_wait("side frames", timeout=2.0)

        self.assertEqual([command.name for command in commands[0].commands], ["plan"])
        self.assertEqual(
            [(event.payload.id, event.payload.status) for event in lifecycle],
            [("Worker", "started")],
        )
        self.assertEqual(live, [LivePhaseEvent(phase="listening")])
        self.assertEqual(turn.assistant_text, "pong")
        self.assertFalse(
            {"available_commands_update", "subagent_lifecycle", "live_phase"}
            & {event.type for event in turn.events}
        )

    def test_set_todos_rejects_unknown_status(self) -> None:
        with self.make_client() as client:
            with self.assertRaises(RpcError):
                client.set_todos([{"content": "Ship", "status": "blocked"}])

    def test_predict_word_outlasts_request_timeout(self) -> None:
        with self.make_client(request_timeout=0.3) as client:
            self.assertEqual(client.predict_word("hello wor", 9), "ld")
            with self.assertRaises(RpcTimeoutError):
                client.request_raw("slow_command")

    def test_goal_create_sends_snake_case_budget_and_updates_state(self) -> None:
        with self.make_client() as client:
            self.assertEqual(client.goal("get"), GoalResult(goal=None, state=None))
            result = client.goal("create", objective="Ship the parser", token_budget=5000)
            state = client.get_state()

        assert result.goal is not None
        self.assertEqual(
            (result.goal.objective, result.goal.status, result.goal.token_budget),
            ("Ship the parser", "active", 5000),
        )
        self.assertEqual(state.goal, result.state)

    def test_remove_queued_message_preserves_queue_and_duplicate_identity(self) -> None:
        with self.make_client() as client:
            client.steer("same")
            client.steer("same")
            client.follow_up("same")
            client.follow_up("keep")
            self.assertIs(client.remove_queued_message("same", "steering").removed, True)
            self.assertEqual(client.get_state().queued_message_count, 3)
            self.assertIs(client.remove_queued_message("same", "steering").removed, True)
            self.assertIs(client.remove_queued_message("same", "steering").removed, False)
            self.assertEqual(client.get_state().queued_message_count, 2)
            self.assertIs(client.remove_queued_message("same", "followUp").removed, True)
            self.assertIs(client.remove_queued_message("missing", "followUp").removed, False)
            self.assertEqual(client.get_state().queued_message_count, 1)
            self.assertIs(client.remove_queued_message("keep", "followUp").removed, True)

    def test_queue_update_event_matches_get_state_and_removal_invariant(self) -> None:
        updates: list[QueueUpdateEvent] = []
        with self.make_client() as client:
            client.on_queue_update(lambda event: updates.append(event))

            client.follow_up("first")
            client.follow_up("second")
            # The server writes each queue_update after the command's response, and
            # the reader thread dispatches frames in order: the get_state round trip
            # guarantees both updates have reached the listener before asserting.
            state = client.get_state()
            self.assertEqual([event.follow_up for event in updates], [("first",), ("first", "second")])
            self.assertEqual(updates[-1].steering, ())
            self.assertEqual(state.queued_messages.follow_up, updates[-1].follow_up)
            self.assertEqual(state.queued_messages.steering, updates[-1].steering)

            # Snapshot-string-removal invariant: every chip string in a snapshot,
            # passed back verbatim to remove_queued_message with its queue,
            # removes that message.
            for text in state.queued_messages.follow_up:
                self.assertIs(client.remove_queued_message(text, "followUp").removed, True)

            self.assertEqual(client.get_state().queued_messages.follow_up, ())
            self.assertEqual(updates[-1].follow_up, ())

    def test_remove_queued_message_propagates_unsupported_command(self) -> None:
        server = FAKE_SERVER.replace(
            'elif command_type == "remove_queued_message":',
            'elif command_type == "unavailable_remove_queued_message":',
        )
        with self.make_client(server) as client:
            client.steer("keep")
            with self.assertRaises(RpcCommandError) as ctx:
                client.remove_queued_message("keep", "steering")
            self.assertEqual(ctx.exception.command, "remove_queued_message")
            self.assertEqual(client.get_state().queued_message_count, 1)

    def test_remove_queued_message_rejects_missing_result(self) -> None:
        server = FAKE_SERVER.replace('{"removed": removed}', '{}')
        with self.make_client(server) as client:
            with self.assertRaises(ValueError):
                client.remove_queued_message("missing", "steering")

    def test_remove_queued_message_rejects_nonboolean_result(self) -> None:
        server = FAKE_SERVER.replace('{"removed": removed}', '{"removed": "false"}')
        with self.make_client(server) as client:
            with self.assertRaises(ValueError):
                client.remove_queued_message("missing", "steering")

    def test_promote_queued_message_moves_one_follow_up_into_steering(self) -> None:
        with self.make_client() as client:
            client.follow_up("same")
            client.follow_up("same")
            self.assertIs(client.promote_queued_message("same").promoted, True)
            self.assertIs(client.remove_queued_message("same", "steering").removed, True)
            self.assertIs(client.promote_queued_message("same").promoted, True)
            self.assertIs(client.promote_queued_message("same").promoted, False)
            self.assertIs(client.promote_queued_message("missing").promoted, False)
            self.assertEqual(client.get_state().queued_message_count, 1)

    def test_promote_queued_message_propagates_unsupported_command(self) -> None:
        server = FAKE_SERVER.replace(
            'elif command_type == "promote_queued_message":',
            'elif command_type == "unavailable_promote_queued_message":',
        )
        with self.make_client(server) as client:
            client.follow_up("keep")
            with self.assertRaises(RpcCommandError) as ctx:
                client.promote_queued_message("keep")
            self.assertEqual(ctx.exception.command, "promote_queued_message")
            self.assertEqual(client.get_state().queued_message_count, 1)

    def test_promote_queued_message_rejects_missing_or_nonboolean_result(self) -> None:
        for payload in ("{}", '{"promoted": "false"}'):
            with self.subTest(payload=payload):
                server = FAKE_SERVER.replace('{"promoted": promoted}', payload)
                with self.make_client(server) as client:
                    with self.assertRaises(ValueError):
                        client.promote_queued_message("missing")

    def test_protocol_v2_decoder_accepts_exact_logical_boundary(self) -> None:
        frame = {
            "id": "request-boundary",
            "type": "response",
            "command": "get_state",
            "success": True,
            "data": {"payload": ""},
        }
        encoded_empty = json.dumps(frame, separators=(",", ":")).encode("utf-8")
        frame["data"]["payload"] = "x" * (1024 * 1024 - len(encoded_empty))
        encoded = json.dumps(frame, separators=(",", ":")).encode("utf-8")
        self.assertEqual(len(encoded), 1024 * 1024)

        decoder = _RpcFrameDecoder()
        chunk_size = 256 * 1024
        count = (len(encoded) + chunk_size - 1) // chunk_size
        decoded = None
        for index in range(count):
            chunk = encoded[index * chunk_size : (index + 1) * chunk_size]
            decoded = decoder.push(
                {
                    "type": "rpc_chunk",
                    "chunkId": "exact-boundary",
                    "index": index,
                    "count": count,
                    "byteLength": len(encoded),
                    "data": base64.b64encode(chunk).decode("ascii"),
                }
            )

        self.assertEqual(decoded, frame)

    def test_command_builder_supports_common_rpc_options(self) -> None:
        client = RpcClient(
            executable="omp",
            model="openrouter/anthropic/claude-sonnet-4.6",
            cwd="/tmp/workspace",
            thinking="high",
            append_system_prompt="extra instructions",
            provider_session_id="provider-session-1",
            tools=("read", "edit", "write"),
            no_session=True,
            no_skills=True,
            no_rules=True,
            no_ui=True,
            extra_args=("--foo", "bar"),
        )

        self.assertEqual(
            client.command,
            (
                "omp",
                "--mode",
                "rpc",
                "--model",
                "openrouter/anthropic/claude-sonnet-4.6",
                "--thinking",
                "high",
                "--append-system-prompt",
                "extra instructions",
                "--provider-session-id",
                "provider-session-1",
                "--tools",
                "read,edit,write",
                "--no-session",
                "--no-skills",
                "--no-rules",
                "--no-title",
                "--no-ui",
                "--foo",
                "bar",
            ),
        )

    def test_get_state_and_bash(self) -> None:
        with self.make_client() as client:
            state = client.get_state()
            self.assertEqual(state.session_id, "fake-session")
            self.assertEqual(
                state.model.id if state.model else None, "claude-sonnet-4-5"
            )
            self.assertFalse(state.fast_mode_enabled)
            self.assertTrue(state.fast_mode_active)
            self.assertEqual(state.tokens_per_second, 7.25)

            result = client.bash("echo hello")
            self.assertEqual(result.output, "hello\n")
            self.assertEqual(result.exit_code, 0)

    def test_set_fast_mode_preserves_provider_tier_state(self) -> None:
        with self.make_client() as client:
            result = client.set_fast_mode(False)

            self.assertFalse(result.enabled)
            self.assertTrue(result.active)

    def test_prompt_and_wait_returns_assistant_text(self) -> None:
        with self.make_client() as client:
            turn = client.prompt_and_wait("say hello", timeout=2.0)
            self.assertEqual(turn.require_assistant_text(), "pong")
            self.assertGreaterEqual(len(turn.events), 3)

    def test_prompt_and_wait_ignores_stale_run_until_own_prompt_result(self) -> None:
        results: list[PromptResultEvent] = []

        with self.make_client() as client:
            client.on_prompt_result(results.append)
            turn = client.prompt_and_wait("after stale run", timeout=2.0)

        self.assertEqual(turn.require_assistant_text(), "pong")
        assert turn.result is not None
        self.assertEqual(turn.result.status, "completed")
        self.assertTrue(turn.result.agent_invoked)
        self.assertNotEqual(turn.result.id, "req_earlier")
        self.assertEqual([result.id for result in results], ["req_earlier", turn.result.id])

    def test_prompt_and_wait_returns_immediately_for_local_prompt(self) -> None:
        with self.make_client() as client:
            turn = client.prompt_and_wait("/local", timeout=2.0)
            client.wait_for_idle(timeout=0.5)

        self.assertIsNone(turn.result)
        self.assertEqual(turn.events, ())

    def test_wait_for_idle_returns_after_prompt_result_with_prompt_id(self) -> None:
        results: list[PromptResultEvent] = []

        with self.make_client() as client:
            client.on_prompt_result(results.append)
            request_id = client.prompt("slow")
            client.wait_for_idle(timeout=2.0)

            self.assertEqual([result.id for result in results], [request_id])

    def test_event_filter_does_not_block_prompt_completion(self) -> None:
        with self.make_client() as client:
            self.assertEqual(client.set_event_filter(["message_end"]), ("message_end",))
            turn = client.prompt_and_wait("say hello", timeout=2.0)
            self.assertIsNone(client.set_event_filter(None))

        self.assertEqual([event.type for event in turn.events], ["message_end"])
        self.assertEqual(turn.require_assistant_text(), "pong")

    def test_open_session_returns_typed_result(self) -> None:
        with self.make_client() as client:
            result = client.open_session(Path("/tmp/host-key"))

        self.assertEqual(
            result,
            OpenSessionResult(
                cancelled=False,
                resumed=True,
                session_id="resumed-session",
                session_file="/tmp/host-key/resumed.jsonl",
            ),
        )

    def test_session_commands_preserve_restore_failure_and_bind_replacement_model(self) -> None:
        for command in ("open_session", "switch_session"):
            for code in (None, "model_unavailable"):
                with self.subTest(command=command, code=code):
                    server = FAKE_SERVER
                    if code is not None:
                        server = server.replace(
                            'payload["error"] = error',
                            f'payload["error"] = error; payload["code"] = {code!r}',
                        )
                    with self.make_client(server) as client:
                        target = Path("/tmp/unavailable-session")
                        before = client.get_state()
                        change = client.open_session if command == "open_session" else client.switch_session
                        with self.assertRaises(RpcCommandError) as ctx:
                            change(target)
                        self.assertEqual(ctx.exception.command, command)
                        self.assertEqual(ctx.exception.error, "Could not restore model local/missing-model")
                        self.assertEqual(ctx.exception.code, code)
                        self.assertEqual(client.get_state(), before)

                        result = change(target, provider="local", model_id="renamed-model")
                        self.assertFalse(result.cancelled)
                        state = client.get_state()
                        self.assertIsNotNone(state.model)
                        assert state.model is not None
                        self.assertEqual((state.model.provider, state.model.id), ("local", "renamed-model"))

    def test_wait_for_settled_outlasts_prompt_yield_until_background_work_drains(
        self,
    ) -> None:
        settled = threading.Event()

        with self.make_client() as client:
            client.on_session_settled(lambda _event: settled.set())
            turn = client.prompt_and_wait("background job", timeout=2.0)

            assert turn.result is not None
            self.assertFalse(turn.result.session_settled)
            state = client.get_state()
            self.assertTrue(state.has_pending_async_work)
            self.assertFalse(state.is_settled)

            client.wait_for_settled(timeout=2.0)

            self.assertTrue(client.get_state().is_settled)
            self.assertTrue(settled.wait(1.0))

    def test_wait_for_settled_returns_at_once_when_state_is_settled(self) -> None:
        with self.make_client() as client:
            started = time.monotonic()
            client.wait_for_settled(timeout=1.0)

        self.assertLess(time.monotonic() - started, 0.5)

    def test_prompt_and_wait_reconstructs_compacted_terminal_messages(self) -> None:
        with self.make_client() as client:
            turn = client.prompt_and_wait("compacted turn", timeout=2.0)

        self.assertEqual(
            [message["content"][0]["text"] for message in turn.messages],
            ["pong", "terminal"],
        )
        self.assertEqual(turn.require_assistant_text(), "terminal")

    def test_custom_tools_are_registered_and_executed_via_rpc(self) -> None:
        def echo_host(args: dict[str, str], context) -> str:
            context.send_update(f"working:{args['message']}")
            return f"host:{args['message']}"

        with self.make_client(
            custom_tools=(
                host_tool(
                    name="echo_host",
                    description="Echo from the Python host process",
                    parameters={
                        "type": "object",
                        "properties": {"message": {"type": "string"}},
                        "required": ["message"],
                        "additionalProperties": False,
                    },
                    execute=echo_host,
                ),
            )
        ) as client:
            state = client.get_state()
            self.assertEqual(state.dump_tools[-1].name, "echo_host")

            turn = client.prompt_and_wait("needs host tool", timeout=2.0)
            update_events = [
                event
                for event in turn.events
                if getattr(event, "type", None) == "tool_execution_update"
            ]
            end_events = [
                event
                for event in turn.events
                if getattr(event, "type", None) == "tool_execution_end"
            ]

            self.assertEqual(len(update_events), 1)
            self.assertEqual(
                update_events[0].partial_result["content"][0]["text"], "working:hello"
            )
            self.assertEqual(len(end_events), 1)
            self.assertEqual(end_events[0].result["content"][0]["text"], "host:hello")

    def test_xd_dispatched_custom_tool_events_carry_host_tool_name(self) -> None:
        """Events for an xd:// device dispatch are renamed to the executed host tool.

        With `tools.xdev` on, omp invokes a custom tool through `write
        xd://<name>` and the wire events carry the transport tool (`write`).
        Consumers must observe the host-tool name on update/end events
        regardless of transport — roboomp's terminal-action detection
        triple-posted PR reviews when end events only said `write`
        (oh-my-pi#6696). `tool_execution_start` precedes the `host_tool_call`
        frame on the wire and keeps the transport name.
        """

        def echo_host(args: dict[str, str], context) -> str:
            context.send_update(f"working:{args['message']}")
            return f"host:{args['message']}"

        with self.make_client(
            custom_tools=(
                host_tool(
                    name="echo_host",
                    description="Echo from the Python host process",
                    parameters={
                        "type": "object",
                        "properties": {"message": {"type": "string"}},
                        "required": ["message"],
                        "additionalProperties": False,
                    },
                    execute=echo_host,
                ),
            )
        ) as client:
            turn = client.prompt_and_wait("needs xd host tool", timeout=2.0)
            start_names = [
                event.tool_name
                for event in turn.events
                if getattr(event, "type", None) == "tool_execution_start"
            ]
            update_events = [
                event
                for event in turn.events
                if getattr(event, "type", None) == "tool_execution_update"
            ]
            end_events = [
                event
                for event in turn.events
                if getattr(event, "type", None) == "tool_execution_end"
            ]

            self.assertEqual(start_names, ["write"])
            self.assertEqual(
                [event.tool_name for event in update_events], ["echo_host"]
            )
            self.assertEqual([event.tool_name for event in end_events], ["echo_host"])
            self.assertEqual(end_events[0].tool_call_id, "toolu_write_1")
            self.assertEqual(end_events[0].result["content"][0]["text"], "host:hello")

    def _echo_host_tool(self, execute) -> HostTool:
        return host_tool(
            name="echo_host",
            description="Echo from the Python host process",
            parameters={
                "type": "object",
                "properties": {"message": {"type": "string"}},
                "required": ["message"],
                "additionalProperties": False,
            },
            execute=execute,
        )

    def test_eval_bridged_host_tool_reports_completion(self) -> None:
        """An eval-bridged host tool is observable although no event names it.

        The eval bridge dispatches with a synthetic call id, so the only
        `tool_execution_end` on the wire is the enclosing `eval`. roboomp's
        terminal-action gate missed `submit_pr_review` and its reminders
        re-posted the review (oh-my-pi#13583).
        """
        completed: list[HostToolCompletedEvent] = []
        with self.make_client(
            custom_tools=(self._echo_host_tool(lambda args, _ctx: f"host:{args['message']}"),)
        ) as client:
            client.on_host_tool_completed(completed.append)
            turn = client.prompt_and_wait("needs eval host tool", timeout=2.0)

        end_names = [
            event.tool_name
            for event in turn.events
            if getattr(event, "type", None) == "tool_execution_end"
        ]
        self.assertEqual(end_names, ["eval"])
        self.assertEqual(
            completed,
            [HostToolCompletedEvent(tool_name="echo_host", tool_call_id="js-echo_host-1")],
        )

    def test_raising_host_tool_does_not_report_completion(self) -> None:
        def reject(_args, _ctx) -> str:
            raise RuntimeError("rejected: 422")

        completed: list[HostToolCompletedEvent] = []
        with self.make_client(custom_tools=(self._echo_host_tool(reject),)) as client:
            client.on_host_tool_completed(completed.append)
            turn = client.prompt_and_wait("needs eval host tool", timeout=2.0)

        end_events = [
            event
            for event in turn.events
            if getattr(event, "type", None) == "tool_execution_end"
        ]
        self.assertTrue(end_events[0].is_error)
        self.assertEqual(completed, [])

    def test_extension_ui_round_trip(self) -> None:
        with self.make_client() as client:
            client.prompt("needs ui")
            request = client.next_ui_request(timeout=2.0)
            self.assertEqual(request.method, "input")

            client.send_ui_value(request.id, "approved")
            client.wait_for_idle(timeout=2.0)

    def test_install_headless_ui_cancels_interactive_requests(self) -> None:
        seen_methods: list[str] = []

        with self.make_client() as client:
            client.install_headless_ui(
                on_request=lambda request: seen_methods.append(request.method)
            )
            client.prompt_and_wait("needs ui", timeout=2.0)

        self.assertEqual(seen_methods, ["input"])

    def test_ready_and_typed_event_listeners(self) -> None:
        ready_types: list[str] = []
        event_types: list[str] = []
        notification_types: list[str] = []
        client = self.make_client()
        client.on_ready(lambda event: ready_types.append(event.type))
        client.on_notification(
            lambda notification: notification_types.append(notification.type)
        )
        client.on_turn_start(lambda event: event_types.append(event.type))
        client.on_message_update(lambda event: event_types.append(event.type))
        client.on_agent_end(lambda event: event_types.append(event.type))

        try:
            client.start()
            client.prompt_and_wait("say hello", timeout=2.0)
        finally:
            client.stop()

        self.assertEqual(ready_types, ["ready"])
        self.assertEqual(event_types, ["turn_start", "message_update", "agent_end"])
        self.assertIn("ready", notification_types)
        self.assertIn("turn_start", notification_types)
        self.assertIn("agent_end", notification_types)

    def test_set_todos_supports_flat_items(self) -> None:
        with self.make_client() as client:
            phases = client.set_todos(["Map tools", "Exercise edits"])

            self.assertEqual(len(phases), 1)
            self.assertEqual(phases[0].name, "Todos")
            self.assertEqual(phases[0].tasks[0].content, "Map tools")
            self.assertEqual(phases[0].tasks[1].status, "pending")

            state = client.get_state()
            self.assertEqual(state.todo_phases[0].tasks[1].content, "Exercise edits")

    def test_model_mode_and_session_commands(self) -> None:
        with self.make_client() as client:
            model = client.set_model("anthropic", "claude-sonnet-4-6")
            self.assertEqual(model.id, "claude-sonnet-4-6")

            cycled = client.cycle_model()
            self.assertIsNotNone(cycled)
            self.assertEqual(cycled.model.id, "claude-sonnet-4-5")

            available = client.get_available_models()
            self.assertEqual(
                [item.id for item in available],
                ["claude-sonnet-4-5", "claude-sonnet-4-6"],
            )

            client.set_thinking_level("high")
            self.assertEqual(client.get_state().thinking_level, "high")

            cycled_level = client.cycle_thinking_level()
            self.assertIsNotNone(cycled_level)
            self.assertEqual(cycled_level.level, "low")

            client.set_steering_mode("all")
            client.set_follow_up_mode("all")
            client.set_interrupt_mode("wait")
            client.set_auto_compaction(False)
            client.set_auto_retry(False)
            self.assertEqual(client.set_cache_warming("off"), "off")
            with self.assertRaisesRegex(ValueError, "set_cache_warming.mode"):
                client.set_cache_warming("streaming")
            client.set_session_name("Renamed")

            state = client.get_state()
            self.assertEqual(state.steering_mode, "all")
            self.assertEqual(state.follow_up_mode, "all")
            self.assertEqual(state.interrupt_mode, "wait")
            self.assertFalse(state.auto_compaction_enabled)
            self.assertEqual(state.session_name, "Renamed")

            compacted = client.compact()
            self.assertEqual(compacted.summary, "trimmed")

            stats = client.get_session_stats()
            self.assertEqual(stats.session_id, "fake-session")
            self.assertEqual(stats.tokens.total, 15)

            exported = client.export_html("/tmp/custom.html")
            self.assertEqual(str(exported), "/tmp/custom.html")

            new_session = client.new_session()
            switched = client.switch_session("/tmp/session.jsonl")
            self.assertFalse(new_session.cancelled)
            self.assertFalse(switched.cancelled)

            branch = client.branch("entry-9")
            self.assertEqual(branch.text, "branch created")
            branch_messages = client.get_branch_messages()
            self.assertEqual(branch_messages[0].entry_id, "entry-9")

            # The fake reports cancelled exactly when no entryId was sent.
            self.assertFalse(client.fork("entry-9").cancelled)
            self.assertTrue(client.fork().cancelled)

    def test_message_and_control_commands(self) -> None:
        with self.make_client() as client:
            turn = client.prompt_and_wait("say hello", timeout=2.0)
            self.assertEqual(turn.require_assistant_text(), "pong")
            self.assertEqual(client.get_last_assistant_text(), "pong")

            messages = client.get_messages()
            self.assertEqual(len(messages), 1)
            self.assertEqual(messages[0]["role"], "assistant")

            client.clear_todos()
            self.assertEqual(client.get_todos(), ())

            client.steer("nudge")
            client.follow_up("later")
            client.abort()
            client.abort_retry()
            client.abort_bash()

            client.abort_and_prompt("say hello")
            client.wait_for_idle(timeout=2.0)
            self.assertEqual(client.get_last_assistant_text(), "pong")

    def test_protocol_v2_reassembles_chunked_message_pages(self) -> None:
        with self.make_client(server=V2_MESSAGES_SERVER) as client:
            messages = client.get_messages()

        self.assertEqual(len(messages), 1)
        self.assertEqual(len(messages[0]["content"][0]["text"]), 1024 * 1024)

    def test_protocol_v2_get_messages_falls_back_to_streaming_snapshot(self) -> None:
        with self.make_client(
            server=V2_MESSAGES_SERVER, env={"V2_MESSAGES_BUSY": "1"}
        ) as client:
            with self.assertRaisesRegex(
                RpcCommandError, "Cannot page messages while the session is changing"
            ):
                client.get_messages_page()
            messages = client.get_messages()

        self.assertEqual(len(messages), 1)
        self.assertEqual(messages[0]["content"][0]["text"], "streaming snapshot")

    def test_protocol_v2_get_messages_discards_stale_page_walk(self) -> None:
        with self.make_client(
            server=V2_MESSAGES_SERVER, env={"V2_MESSAGES_STALE": "1"}
        ) as client:
            with self.assertRaisesRegex(RpcCommandError, "RPC message cursor is stale"):
                client.get_messages_page(cursor="page-two")
            messages = client.get_messages()

        self.assertEqual(len(messages), 1)
        self.assertEqual(messages[0]["content"][0]["text"], "streaming snapshot")

    def test_collect_events_returns_turn_events(self) -> None:
        with self.make_client() as client:
            client.prompt("slow")
            events = client.collect_events(timeout=2.0)

        self.assertGreaterEqual(len(events), 1)
        self.assertEqual(events[-1].type, "agent_end")

    def test_all_typed_event_listeners_receive_eventful_prompt(self) -> None:
        seen: list[str] = []

        with self.make_client() as client:
            client.on_event(lambda event: seen.append(f"event:{event.type}"))
            client.on_agent_start(lambda event: seen.append(event.type))
            client.on_turn_end(lambda event: seen.append(event.type))
            client.on_message_start(lambda event: seen.append(event.type))
            client.on_message_end(lambda event: seen.append(event.type))
            client.on_tool_execution_start(lambda event: seen.append(event.type))
            client.on_tool_execution_update(lambda event: seen.append(event.type))
            client.on_tool_execution_end(lambda event: seen.append(event.type))
            client.on_auto_compaction_start(lambda event: seen.append(event.type))
            client.on_auto_compaction_end(lambda event: seen.append(event.type))
            client.on_auto_retry_start(lambda event: seen.append(event.type))
            client.on_auto_retry_end(lambda event: seen.append(event.type))
            client.on_retry_fallback_applied(lambda event: seen.append(event.type))
            client.on_retry_fallback_succeeded(lambda event: seen.append(event.type))
            client.on_ttsr_triggered(lambda event: seen.append(event.type))
            client.on_todo_reminder(lambda event: seen.append(event.type))
            client.on_todo_auto_clear(lambda event: seen.append(event.type))

            turn = client.prompt_and_wait("all events", timeout=2.0)

        self.assertEqual(turn.require_assistant_text(), "pong")
        for expected in [
            "agent_start",
            "message_start",
            "message_end",
            "turn_end",
            "tool_execution_start",
            "tool_execution_update",
            "tool_execution_end",
            "auto_compaction_start",
            "auto_compaction_end",
            "auto_retry_start",
            "auto_retry_end",
            "retry_fallback_applied",
            "retry_fallback_succeeded",
            "ttsr_triggered",
            "todo_reminder",
            "todo_auto_clear",
        ]:
            self.assertIn(expected, seen)

    def test_extension_and_unknown_notification_listeners(self) -> None:
        seen_extension_errors: list[str] = []
        seen_unknown: list[str] = []

        with self.make_client() as client:
            client.on_extension_error(
                lambda event: seen_extension_errors.append(event.error)
            )
            client.on_unknown_notification(
                lambda event: seen_unknown.append(str(event.payload.get("type")))
            )
            client.prompt_and_wait("notifications", timeout=2.0)

        self.assertEqual(seen_extension_errors, ["boom"])
        self.assertEqual(seen_unknown, ["unknown_future_event"])

    def test_additive_notification_values_do_not_stop_the_reader(self) -> None:
        unknown_errors: list[str | None] = []

        with self.make_client(server=FORWARD_COMPAT_SERVER) as client:
            client.on_unknown_notification(
                lambda event: unknown_errors.append(event.parse_error)
            )
            turn = client.prompt_and_wait("forward compatible", timeout=2.0)

        terminal_events = [
            event for event in turn.events if isinstance(event, AgentEndEvent)
        ]
        self.assertEqual(
            [event.is_terminal for event in terminal_events], [False, True]
        )
        self.assertEqual(len(unknown_errors), 1)
        self.assertIn("auto_compaction_start.reason", unknown_errors[0] or "")

    def test_malformed_terminal_agent_end_wakes_waiter(self) -> None:
        unknown_errors: list[str | None] = []

        with self.make_client(server=FORWARD_COMPAT_SERVER) as client:
            client.on_unknown_notification(
                lambda event: unknown_errors.append(event.parse_error)
            )
            with self.assertRaisesRegex(
                RpcError, "Failed to parse terminal agent_end"
            ):
                client.prompt_and_wait("malformed terminal", timeout=1.0)

        self.assertEqual(len(unknown_errors), 1)
        self.assertIn("messages[0].role", unknown_errors[0] or "")

    def test_ui_confirmation_and_cancel_round_trip(self) -> None:
        with self.make_client() as client:
            client.prompt("needs confirm")
            confirm_request = client.next_ui_request(timeout=2.0)
            self.assertEqual(confirm_request.method, "confirm")
            client.send_ui_confirmation(confirm_request.id, True)
            client.wait_for_idle(timeout=2.0)

            client.prompt("needs cancel")
            editor_request = client.next_ui_request(timeout=2.0)
            self.assertEqual(editor_request.method, "editor")
            client.cancel_ui_request(editor_request.id)
            client.wait_for_idle(timeout=2.0)

    def test_prompt_lifecycle_collectors_are_single_flight(self) -> None:
        results: list[str] = []
        errors: list[BaseException] = []

        with self.make_client() as client:

            def run_prompt() -> None:
                try:
                    results.append(
                        client.prompt_and_wait(
                            "slow", timeout=2.0
                        ).require_assistant_text()
                    )
                except (
                    BaseException
                ) as exc:  # pragma: no cover - defensive thread capture
                    errors.append(exc)

            thread = threading.Thread(target=run_prompt)
            thread.start()

            deadline = time.time() + 1.0
            while (
                client._prompt_lifecycle.active_operation != "prompt_and_wait"
                and time.time() < deadline
            ):
                time.sleep(0.01)

            self.assertEqual(
                client._prompt_lifecycle.active_operation, "prompt_and_wait"
            )
            with self.assertRaises(RpcConcurrencyError):
                client.collect_events(timeout=1.0)

            thread.join(timeout=2.0)
            self.assertFalse(thread.is_alive())

        self.assertEqual(errors, [])
        self.assertEqual(results, ["pong"])

    def test_listener_mutation_does_not_change_retained_turn(self) -> None:
        with self.make_client() as client:
            client.on_message_end(
                lambda event: event.message["content"].__setitem__(
                    0, {"type": "text", "text": "mutated"}
                )
            )
            turn = client.prompt_and_wait("say hello", timeout=2.0)
            messages = client.get_messages()

        self.assertEqual(turn.require_assistant_text(), "pong")
        self.assertEqual(messages[0]["content"][0]["text"], "pong")

    def test_id_less_error_responses_are_correlated(self) -> None:
        with self.make_client(server=IDLESS_ERROR_SERVER) as client:
            with self.assertRaises(RpcCommandError) as ctx:
                client.request_raw("unknown")

        self.assertEqual(ctx.exception.command, "unknown")
        self.assertEqual(ctx.exception.error, "unsupported: unknown")

    def test_prompt_and_wait_raises_for_late_prompt_failure(self) -> None:
        protocol_errors: list[str] = []
        client = self.make_client(server=LATE_PROMPT_FAILURE_SERVER)
        client.on_protocol_error(lambda error: protocol_errors.append(str(error)))

        try:
            client.start()
            with self.assertRaises(RpcCommandError) as ctx:
                client.prompt_and_wait("say hello", timeout=2.0)
        finally:
            client.stop()

        self.assertEqual(ctx.exception.command, "prompt")
        self.assertEqual(ctx.exception.error, "late failure")
        self.assertEqual(len(protocol_errors), 1)
        self.assertIn("late failure", protocol_errors[0])
        self.assertEqual(len(client.protocol_errors), 1)

    def test_listener_exceptions_are_reported_without_stopping_client(self) -> None:
        listener_errors: list[tuple[str, str | None, str]] = []
        client = self.make_client()
        client.on_notification(
            lambda notification: (
                (_ for _ in ()).throw(RuntimeError("boom"))
                if notification.type == "turn_start"
                else None
            )
        )
        client.on_listener_error(
            lambda event: listener_errors.append(
                (event.listener_kind, event.source_type, str(event.error))
            )
        )

        try:
            client.start()
            turn = client.prompt_and_wait("say hello", timeout=2.0)
        finally:
            client.stop()

        self.assertEqual(turn.require_assistant_text(), "pong")
        self.assertEqual(listener_errors, [("notification", "turn_start", "boom")])
        self.assertEqual(len(client.listener_errors), 1)
        self.assertEqual(client.listener_errors[0].listener_kind, "notification")

    def test_stderr_history_is_bounded(self) -> None:
        client = self.make_client(server=STDERR_SERVER, max_stderr_chunks=1)

        try:
            client.start()
        finally:
            client.stop()

        self.assertEqual(client.stderr, "second\n")

    def test_broken_startup_frame_is_reported(self) -> None:
        client = self.make_client(server=BROKEN_STARTUP_SERVER)

        with self.assertRaises(RpcError) as ctx:
            client.start()

        self.assertIn("Frame: 'not-json'", str(ctx.exception))

    def test_event_history_limit_reports_overflow(self) -> None:
        with self.make_client(max_event_history=2) as client:
            with self.assertRaises(RpcError) as ctx:
                client.prompt_and_wait("say hello", timeout=2.0)

        self.assertIn("max_event_history", str(ctx.exception))


HANGING_SERVER = textwrap.dedent(
    """
    import json
    import sys

    print(json.dumps({"type": "ready"}), flush=True)
    # Read one line (the prompt) and acknowledge it, then never emit its
    # prompt_result. The client's prompt_and_wait should wait forever unless
    # stop() unblocks it.
    line = sys.stdin.readline()
    if line:
        command = json.loads(line)
        if command.get("type") == "prompt":
            print(
                json.dumps(
                    {
                        "id": command["id"],
                        "type": "response",
                        "command": "prompt",
                        "success": True,
                    }
                ),
                flush=True,
            )
    # Block forever on stdin so the subprocess does not exit on its own.
    sys.stdin.read()
    """
)


class StopUnblocksPromptAndWaitTests(unittest.TestCase):
    """Regression: stop() must wake a blocked `prompt_and_wait` immediately.

    Previously, the stdout reader's "if not self._stopping:" guard caused
    `_mark_closed` to be skipped after stop(), so `_closed_error` stayed
    `None` and the waiter blocked on its condition variable until
    the prompt timeout. The fix sets `_closed_error` from `stop()` itself.
    """

    def test_stop_during_prompt_unblocks_waiter(self) -> None:
        from omp_rpc import RpcProcessExitError

        client = RpcClient(
            command=[sys.executable, "-u", "-c", HANGING_SERVER],
            startup_timeout=2.0,
            request_timeout=2.0,
        )
        client.start()
        try:
            errors: list[BaseException] = []

            def run_prompt() -> None:
                try:
                    # 30s is more than enough to let stop() race in; if the
                    # bug regresses, the worker hangs the full 30s.
                    client.prompt_and_wait("hang", timeout=30.0)
                except BaseException as exc:
                    errors.append(exc)

            thread = threading.Thread(target=run_prompt)
            thread.start()

            # Wait until the prompt is in flight.
            deadline = time.time() + 2.0
            while (
                client._prompt_lifecycle.active_operation != "prompt_and_wait"
                and time.time() < deadline
            ):
                time.sleep(0.01)
            self.assertEqual(
                client._prompt_lifecycle.active_operation, "prompt_and_wait"
            )

            t0 = time.time()
            client.stop()
            thread.join(timeout=2.0)
            elapsed = time.time() - t0

            self.assertFalse(
                thread.is_alive(), "prompt_and_wait did not return after stop()"
            )
            self.assertLess(
                elapsed, 2.0, f"stop() took {elapsed:.2f}s to unblock prompt_and_wait"
            )
            self.assertEqual(len(errors), 1)
            self.assertIsInstance(errors[0], RpcProcessExitError)
        finally:
            # stop() is idempotent; safe to call again on cleanup paths.
            client.stop()


# A process whose main thread exits while a second thread keeps running:
# /proc/<pid>/stat then reads Z although the process is alive. pthread_exit
# ends the main thread alone (os._exit would end every thread). SIGTERM is
# ignored, so only SIGKILL ends it.
MAIN_THREAD_EXITS = textwrap.dedent(
    """
    import ctypes, signal, sys, threading
    signal.signal(signal.SIGTERM, signal.SIG_IGN)
    threading.Thread(target=threading.Event().wait).start()
    sys.stdout.write("ready\\n")
    sys.stdout.flush()
    ctypes.CDLL(None).pthread_exit(None)
    """
)

# A process that joins process group argv[1] when told on stdin, then idles.
JOIN_GROUP = textwrap.dedent(
    """
    import os, sys, time
    sys.stdin.readline()
    os.setpgid(0, int(sys.argv[1]))
    sys.stdout.write("joined\\n")
    sys.stdout.flush()
    time.sleep(60)
    """
)


def _proven_dead(pid: int) -> bool:
    """Whether /proc proves `pid` dead: its entry is gone, or it and every one
    of its threads are in a dead state. An unreadable entry proves nothing."""
    try:
        stat = _proc_stat(str(pid), _read_file)
        if stat is None:
            return True
        return stat[0] in _PROC_DEAD_STATES and _proc_threads_dead(
            str(pid), os.listdir, _read_file
        )
    except _ProcUnproven:
        return False


def _wait_for_proc_state(test: unittest.TestCase, pid: int, want: bytes) -> None:
    deadline = time.monotonic() + 5.0
    state: bytes | None = None
    while time.monotonic() < deadline:
        try:
            stat = _proc_stat(str(pid), _read_file)
        except _ProcUnproven:
            stat = None
        state = None if stat is None else stat[0]
        if state == want:
            return
        time.sleep(0.01)
    test.fail(f"process {pid} never reached state {want!r} (last {state!r})")


class TerminatesProcessGroupTests(unittest.TestCase):
    """Regression: stop() must reap descendants the agent spawned, not only
    the omp leader.

    A `bun test` launched by the agent's `bash` tool runs as a grandchild of
    the omp process. Before the fix, stop() signalled only the leader pid, so
    such grandchildren reparented to the container init and kept running —
    once ballooning to tens of GB of RAM. omp is now spawned in its own
    session and stop() tears down the whole process group.
    """

    @unittest.skipUnless(hasattr(os, "killpg"), "POSIX process groups only")
    def test_stop_kills_grandchild_spawned_by_server(self) -> None:
        work = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, work, ignore_errors=True)
        pid_file = os.path.join(work, "gc.pid")
        beat_file = os.path.join(work, "gc.beat")
        gc_script = os.path.join(work, "gc.py")
        with open(gc_script, "w", encoding="utf-8") as handle:
            handle.write(
                textwrap.dedent(
                    f"""
                    import os, time
                    # Write the pid whole: the test reads it once the file exists.
                    with open({pid_file!r} + ".tmp", "w") as f:
                        f.write(str(os.getpid()))
                    os.replace({pid_file!r} + ".tmp", {pid_file!r})
                    while True:
                        with open({beat_file!r}, "w") as f:
                            f.write(str(time.time()))
                        time.sleep(0.02)
                    """
                )
            )

        group: list[int] = []

        def _reap_leaked_grandchild() -> None:
            # Kill only a grandchild still in the server's group: once teardown
            # reaped it, its pid can belong to an unrelated process.
            try:
                with open(pid_file, encoding="utf-8") as f:
                    pid = int(f.read())
                if group and os.getpgid(pid) == group[0]:
                    os.kill(pid, signal.SIGKILL)
            except (OSError, ValueError):
                pass

        self.addCleanup(_reap_leaked_grandchild)

        # Fake omp server: spawn the long-lived grandchild, signal ready, then
        # idle until torn down (sleep past stdin EOF so the group is still
        # alive when stop() fires).
        server = textwrap.dedent(
            f"""
            import json, subprocess, sys, time
            subprocess.Popen([sys.executable, {gc_script!r}])
            print(json.dumps({{"type": "ready"}}), flush=True)
            for _line in sys.stdin:
                pass
            time.sleep(30)
            """
        )

        client = RpcClient(
            command=[sys.executable, "-u", "-c", server],
            startup_timeout=2.0,
            request_timeout=2.0,
        )
        client.start()
        if client._pgid is not None:
            group.append(client._pgid)
        try:
            deadline = time.time() + 2.0
            while time.time() < deadline and not os.path.exists(pid_file):
                time.sleep(0.02)
            self.assertTrue(os.path.exists(pid_file), "grandchild never started")
            with open(pid_file, encoding="utf-8") as f:
                os.kill(int(f.read()), 0)  # alive before teardown
        finally:
            client.stop()

        # The grandchild writes `time.time()` every 20ms. Once the group is
        # killed it stops writing, so the file contents stay frozen. Compare
        # contents (not mtime) to stay independent of filesystem timestamp
        # resolution.
        time.sleep(0.2)
        with open(beat_file, encoding="utf-8") as f:
            first = f.read()
        time.sleep(0.3)
        with open(beat_file, encoding="utf-8") as f:
            second = f.read()
        self.assertEqual(
            second,
            first,
            "grandchild kept running after stop() — process group leaked",
        )

    @unittest.skipUnless(
        hasattr(os, "killpg") and sys.platform == "linux",
        "needs POSIX process groups and /proc",
    )
    def test_stop_tears_down_the_group_when_getpgid_fails(self) -> None:
        # The group id is known from the spawn (omp leads its own session). A
        # failing getpgid must not leave teardown with no group, confirming it
        # once the leader alone exited while its child runs.
        work = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, work, ignore_errors=True)
        pid_file = os.path.join(work, "child.pid")
        server = textwrap.dedent(
            f"""
            import json, os, subprocess, sys
            child = subprocess.Popen(
                ["sleep", "30"],
                stdin=subprocess.DEVNULL,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
            )
            with open({pid_file!r} + ".tmp", "w") as f:
                f.write(str(child.pid))
            os.replace({pid_file!r} + ".tmp", {pid_file!r})
            print(json.dumps({{"type": "ready"}}), flush=True)
            for _line in sys.stdin:
                pass
            """
        )
        client = RpcClient(
            command=[sys.executable, "-u", "-c", server],
            startup_timeout=10.0,
            request_timeout=2.0,
        )
        with mock.patch("os.getpgid", side_effect=PermissionError(errno.EPERM, "denied")):
            client.start()
        self.addCleanup(client.stop)
        with open(pid_file, encoding="utf-8") as f:
            child = int(f.read())
        # The child is the server's, not ours: kill it through a pidfd so a
        # reused pid is never signalled.
        child_fd = os.pidfd_open(child)
        self.addCleanup(os.close, child_fd)

        def _kill_child() -> None:
            try:
                signal.pidfd_send_signal(child_fd, signal.SIGKILL)
            except ProcessLookupError:
                pass  # already dead and reaped

        self.addCleanup(_kill_child)

        stopped = client.stop()
        self.assertFalse(
            stopped and not _proven_dead(child),
            f"stop() returned True while the server's child {child} runs",
        )
        self.assertIs(stopped, True)


class _Survivor:
    """A child that cannot be reaped until it is told to `exit()`.

    Models a process whose pending SIGKILL only lands after it leaves
    uninterruptible sleep: `poll()`/`wait()` report it alive until `exit()`
    flips the state, and `terminate()`/`kill()` never change it on their own.
    """

    def __init__(self, pid: int) -> None:
        self.pid = pid
        self.stdin = None
        self.stdout = None
        self.stderr = None
        self._code: int | None = None

    def exit(self) -> None:
        self._code = 0

    def poll(self) -> int | None:
        return self._code

    def wait(self, timeout: float | None = None) -> int:
        if self._code is None:
            raise subprocess.TimeoutExpired(cmd="omp", timeout=timeout)
        return self._code

    def terminate(self) -> None:  # survivor ignores signals
        pass

    def kill(self) -> None:  # survivor ignores signals
        pass


class RetainsSurvivorTests(unittest.TestCase):
    """Regression (#12767): teardown that cannot confirm death must report it,
    retain the survivor, and stay re-reapable — never drop the only handle.

    Before the fix `_terminate_process_group` swallowed both `wait()` timeouts
    and returned nothing, and `stop()` nulled `_process`/`_pgid` unconditionally,
    so a child stuck in uninterruptible sleep became unobservable and the second
    `stop()` was a guaranteed no-op.
    """

    @unittest.skipUnless(hasattr(os, "killpg"), "POSIX process groups only")
    def test_survivor_is_reported_retained_and_reaped_later(self) -> None:
        survivor = _Survivor(pid=424242)
        signals: list[tuple[int, int]] = []

        def fake_killpg(pgid: int, sig: int) -> None:
            signals.append((pgid, sig))
            # Signal 0 probes group liveness; the group empties only once the
            # survivor has actually exited.
            if sig == 0 and survivor.poll() is not None:
                raise ProcessLookupError()

        client = RpcClient(command=[sys.executable, "-c", "pass"])
        client._process = survivor  # type: ignore[assignment]
        client._pgid = survivor.pid

        with mock.patch("os.killpg", side_effect=fake_killpg):
            # First stop(): survivor cannot be killed -> teardown reports failure,
            # drops the live handle but keeps it observable as a survivor.
            self.assertIs(client.stop(), False)
            self.assertIsNone(client._process)
            self.assertEqual(client.survivor_pids, (survivor.pid,))

            # The second stop() (the one the `with` exit / cancel hook fires) must
            # re-signal the group, not no-op.
            signals.clear()
            self.assertFalse(client.stop())
            self.assertIn((survivor.pid, signal.SIGKILL), signals)
            self.assertEqual(client.survivor_pids, (survivor.pid,))

            # Once the child leaves uninterruptible sleep, reap() confirms it and
            # clears the survivor — probing the group (signal 0) without sending
            # TERM/KILL to a pgid that may already have been reused.
            survivor.exit()
            signals.clear()
            self.assertTrue(client.reap())
            self.assertEqual(signals, [(survivor.pid, 0)])
            self.assertEqual(client.survivor_pids, ())

    def test_restart_and_stop_keep_every_unreaped_survivor(self) -> None:
        # `pgid=None` takes the leader-only teardown path, so the stuck fakes
        # need no `os.killpg` mock and the test runs on every platform.
        first = _Survivor(pid=424243)
        second = _Survivor(pid=424244)
        client = RpcClient(
            command=[sys.executable, "-u", "-c", FAKE_SERVER],
            startup_timeout=2.0,
            request_timeout=2.0,
        )
        client._process = first  # type: ignore[assignment]
        client._pgid = None
        self.assertIs(client.stop(), False)
        self.assertEqual(client.survivor_pids, (first.pid,))

        # Restart with a healthy child: its own teardown succeeds, but the
        # earlier child is still alive, so stop() must not report success or
        # forget it.
        client.start()
        healthy = client._process
        assert healthy is not None
        self.assertIs(client.stop(), False)
        self.assertIsNotNone(healthy.poll(), "healthy child survived stop()")
        self.assertEqual(client.survivor_pids, (first.pid,))

        # A second stuck child joins the first instead of overwriting it.
        client._process = second  # type: ignore[assignment]
        client._pgid = None
        self.assertIs(client.stop(), False)
        self.assertEqual(client.survivor_pids, (first.pid, second.pid))

        first.exit()
        self.assertIs(client.reap(), False)
        self.assertEqual(client.survivor_pids, (second.pid,))
        second.exit()
        self.assertIs(client.reap(), True)
        self.assertEqual(client.survivor_pids, ())

    @unittest.skipUnless(hasattr(os, "killpg"), "POSIX process groups only")
    def test_terminate_confirms_and_reaps_a_real_child(self) -> None:
        proc = subprocess.Popen(
            [sys.executable, "-c", "import time; time.sleep(30)"],
            start_new_session=True,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
        self.addCleanup(lambda: proc.poll() is None and proc.kill())
        pgid = _process_group_id(proc)
        self.assertIsNotNone(pgid)

        self.assertTrue(_terminate_process_group(proc, pgid))
        self.assertIsNotNone(proc.poll(), "child survived a confirmed teardown")

    @unittest.skipUnless(hasattr(os, "killpg"), "POSIX process groups only")
    def test_terminate_waits_for_killed_term_ignoring_grandchild(self) -> None:
        # A grandchild that ignores SIGTERM outlives the first escalation step
        # and dies only to SIGKILL, after the leader is already reaped. Killed
        # members stay visible to `killpg(pgid, 0)` until init reaps them, so
        # an immediate post-SIGKILL probe misreports a dying group as a
        # survivor.
        work = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, work, ignore_errors=True)
        pid_file = os.path.join(work, "gc.pid")
        grandchild = """trap '' TERM; echo $$ > "$1"; sleep 30 & wait"""
        leader = textwrap.dedent(
            f"""
            import subprocess, time
            subprocess.Popen(["sh", "-c", {grandchild!r}, "sh", {pid_file!r}])
            time.sleep(30)
            """
        )
        proc = subprocess.Popen(
            [sys.executable, "-c", leader],
            start_new_session=True,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
        pgid = _process_group_id(proc)
        self.assertIsNotNone(pgid)
        assert pgid is not None

        def _kill_leaked_group() -> None:
            try:
                os.killpg(pgid, signal.SIGKILL)
            except OSError:
                pass
            if proc.poll() is None:
                proc.kill()
                proc.wait()

        self.addCleanup(_kill_leaked_group)

        # The pid file is written after the trap is installed, so SIGTERM is
        # guaranteed to be ignored once it holds a pid.
        grandchild_pid: int | None = None
        deadline = time.monotonic() + 5.0
        while grandchild_pid is None and time.monotonic() < deadline:
            try:
                with open(pid_file, encoding="utf-8") as f:
                    grandchild_pid = int(f.read())
            except (OSError, ValueError):
                time.sleep(0.02)
        self.assertIsNotNone(grandchild_pid, "grandchild never installed its trap")
        assert grandchild_pid is not None

        self.assertIs(_terminate_process_group(proc, pgid), True)
        self.assertIsNotNone(proc.poll(), "leader survived a confirmed teardown")
        # Teardown confirms as soon as the grandchild is dead, which can be
        # before init has reaped it: a zombie is dead, not a survivor.
        if sys.platform == "linux":
            self.assertTrue(
                _proven_dead(grandchild_pid),
                "grandchild still live after a confirmed teardown",
            )
        else:
            with self.assertRaises(ProcessLookupError):
                os.kill(grandchild_pid, 0)

    @unittest.skipUnless(
        hasattr(os, "killpg") and sys.platform == "linux",
        "needs POSIX process groups and /proc",
    )
    def test_terminate_confirms_when_only_a_zombie_remains(self) -> None:
        # A group member that is already dead but not yet reaped (a zombie) must
        # not be read as a survivor. Build the zombie deliberately so the test
        # does not depend on init's reap latency: a leader in its own group, and
        # a second child that joins that group, exits at once, and is never
        # reaped here, so it lingers as a dead-but-unreaped member.
        leader = subprocess.Popen(
            ["sleep", "30"],
            process_group=0,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
        self.addCleanup(lambda: leader.poll() is None and leader.kill())
        pgid = _process_group_id(leader)
        self.assertIsNotNone(pgid)
        assert pgid is not None

        zombie = subprocess.Popen(
            ["sh", "-c", "exit 0"],
            process_group=pgid,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
        )
        self.addCleanup(zombie.wait)
        assert zombie.stdout is not None
        # EOF means the member has exited; we deliberately do not reap it, so it
        # is now a dead-but-unreaped member of the leader's group.
        zombie.stdout.read()
        zombie.stdout.close()

        self.assertIs(_terminate_process_group(leader, pgid), True)
        self.assertIsNotNone(leader.poll(), "leader survived a confirmed teardown")


def _raising(error: OSError) -> Callable[[], Any]:
    def fail() -> Any:
        raise error

    return fail


def _rigged(
    listing: list[int] | None = None,
    files: dict[str, Callable[[], bytes]] | None = None,
    dirs: dict[str, Callable[[], list[str]]] | None = None,
) -> dict[str, Callable[[str], object]]:
    """`_proc_group_dead` seams that answer the named paths themselves and
    pass every other read to the real /proc. With `listing`, /proc lists only
    those pids, so no unrelated process on the host can change the answer."""
    files = files or {}
    dirs = dirs or {}

    def read_file(path: str) -> bytes:
        return files[path]() if path in files else _read_file(path)

    def listdir(path: str) -> list[str]:
        if path in dirs:
            return dirs[path]()
        if path == "/proc" and listing is not None:
            return [str(pid) for pid in listing]
        return os.listdir(path)

    return {"read_file": read_file, "listdir": listdir}


@unittest.skipUnless(
    hasattr(os, "killpg") and sys.platform == "linux",
    "needs POSIX process groups and /proc",
)
class GroupDeadNeedsPositiveEvidenceTests(unittest.TestCase):
    """Teardown confirms a process group gone only on positive evidence that no
    member of the group, process or thread, is alive; anything it cannot read
    or prove counts as alive."""

    def _spawn(
        self,
        args: list[str],
        pgid: int = 0,
        stdout: int = subprocess.DEVNULL,
        stdin: int = subprocess.DEVNULL,
    ) -> subprocess.Popen[bytes]:
        proc = subprocess.Popen(
            args,
            process_group=pgid,
            stdin=stdin,
            stdout=stdout,
            stderr=subprocess.DEVNULL,
        )

        def _kill() -> None:
            if proc.poll() is None:
                proc.kill()
            proc.wait()
            for stream in (proc.stdin, proc.stdout):
                if stream is not None:
                    stream.close()

        self.addCleanup(_kill)
        return proc

    def _main_thread_exited(self, pgid: int = 0) -> subprocess.Popen[bytes]:
        proc = self._spawn([sys.executable, "-c", MAIN_THREAD_EXITS], pgid, subprocess.PIPE)
        assert proc.stdout is not None
        self.assertEqual(proc.stdout.readline(), b"ready\n")
        _wait_for_proc_state(self, proc.pid, b"Z")
        self.assertFalse(
            _proc_threads_dead(str(proc.pid), os.listdir, _read_file),
            "helper has no live thread left",
        )
        return proc

    def _unreaped_dead(self, pgid: int = 0) -> int:
        proc = self._spawn(["sh", "-c", "exit 0"], pgid, subprocess.PIPE)
        assert proc.stdout is not None
        proc.stdout.read()  # EOF: it exited; it stays unreaped until cleanup
        _wait_for_proc_state(self, proc.pid, b"Z")
        return proc.pid

    def _dies(self, pid: int, timeout: float = 2.0) -> bool:
        deadline = time.monotonic() + timeout
        while not _proven_dead(pid):
            if time.monotonic() >= deadline:
                return False
            time.sleep(0.02)
        return True

    def test_group_dead_needs_positive_evidence(self) -> None:
        dead = self._unreaped_dead()
        live = self._spawn(["sleep", "30"]).pid
        main_exited = self._main_thread_exited().pid

        def denied(path: str) -> Callable[[], Any]:
            return _raising(PermissionError(errno.EACCES, os.strerror(errno.EACCES), path))

        def probe_denying(target: int) -> Callable[[int], None]:
            def probe(pid: int) -> None:
                if pid == target:
                    raise PermissionError(errno.EPERM, os.strerror(errno.EPERM))
                os.kill(pid, 0)

            return probe

        mountinfo = b"29 34 0:26 / /proc rw,nosuid shared:13 - proc proc rw,hidepid=invisible\n"
        proc_line = b"29 34 0:26 / /proc rw,nosuid shared:13 - proc proc rw\n"
        # A mount over a process's /proc entry hides it: the entry reads as gone.
        over_entry = proc_line + f"40 29 0:50 / /proc/{dead} rw - tmpfs tmpfs rw\n".encode()
        # binfmt_misc and a container's masks mount beneath /proc, not over an entry.
        beneath = proc_line + b"41 29 0:51 / /proc/sys/fs/binfmt_misc rw - binfmt_misc b rw\n"
        # A pid no fixture uses, answered only by the rigged stat below.
        released = 4194301

        def released_stat(state: bytes) -> bytes:
            return b"4194301 (git) " + state + b" 0 -1 -1 0 -1 4227084 424 93 0 0\n"

        # /proc lists only the fixtures, so no unrelated process on the host
        # can turn the dead-member control false.
        only = [dead, live, main_exited]
        rows: list[tuple[str, int, dict[str, object], bool]] = [
            ("only a dead, unreaped member", dead, _rigged(only), True),
            (
                "a member whose main thread exited while another thread runs",
                main_exited,
                _rigged(only),
                False,
            ),
            (
                "a live member whose stat is unreadable",
                live,
                _rigged(only, files={f"/proc/{live}/stat": denied(f"/proc/{live}/stat")}),
                False,
            ),
            (
                "a live member whose stat is malformed",
                live,
                _rigged(only, files={f"/proc/{live}/stat": lambda: b"garbage"}),
                False,
            ),
            (
                "a dead member whose thread list is unreadable",
                dead,
                _rigged(only, dirs={f"/proc/{dead}/task": denied(f"/proc/{dead}/task")}),
                False,
            ),
            (
                "a dead member whose thread stat is unreadable",
                dead,
                _rigged(
                    only,
                    files={f"/proc/{dead}/task/{dead}/stat": denied(f"/proc/{dead}/task/{dead}/stat")},
                ),
                False,
            ),
            (
                "an unlistable /proc",
                dead,
                _rigged(only, dirs={"/proc": _raising(OSError(errno.EIO, os.strerror(errno.EIO)))}),
                False,
            ),
            (
                "a /proc mounted with hidepid",
                dead,
                _rigged(only, files={"/proc/self/mountinfo": lambda: mountinfo}),
                False,
            ),
            (
                "a /proc of another pid namespace",
                dead,
                _rigged(only, files={"/proc/self/stat": lambda: b"1 (init) S 0 1 1 0 -1\n"}),
                False,
            ),
            (
                "a /proc with a process entry mounted over",
                dead,
                _rigged(only, files={"/proc/self/mountinfo": lambda: over_entry}),
                False,
            ),
            (
                "a /proc with another mount beneath it",
                dead,
                _rigged(only, files={"/proc/self/mountinfo": lambda: beneath}),
                True,
            ),
            # A task the kernel is releasing, anywhere on the host, reads state
            # X and pgrp -1: it has left every group.
            (
                "an unrelated task being released",
                dead,
                _rigged(
                    [*only, released],
                    files={f"/proc/{released}/stat": lambda: released_stat(b"X")},
                ),
                True,
            ),
            (
                "a live task without a process group",
                dead,
                _rigged(
                    [*only, released],
                    files={f"/proc/{released}/stat": lambda: released_stat(b"S")},
                ),
                False,
            ),
            (
                "a dead member SIGKILL could not reach",
                dead,
                {**_rigged(only), "probe": probe_denying(dead)},
                False,
            ),
        ]
        for name, pgid, seams, want in rows:
            with self.subTest(name):
                self.assertIs(_proc_group_dead(pgid, **seams), want)  # type: ignore[arg-type]

    def test_terminate_kills_a_process_that_joined_the_group_during_the_scan(self) -> None:
        # While a dead-but-unreaped member keeps the group id in use, a process
        # in the same session can join the group at any time, also after the
        # scan has read it as an outsider. Teardown must not report success
        # while that process runs.
        leader = self._spawn(["sleep", "30"])
        pgid = leader.pid
        self._unreaped_dead(pgid)  # keeps the group joinable once the leader dies
        joiner = self._spawn(
            [sys.executable, "-c", JOIN_GROUP, str(pgid)], 0, subprocess.PIPE, subprocess.PIPE
        )
        assert joiner.stdin is not None and joiner.stdout is not None
        joined: list[bool] = []

        def read_file(path: str) -> bytes:
            data = _read_file(path)
            if path == f"/proc/{joiner.pid}/stat" and not joined:
                # Behind the read: the process, read as outside the group, joins it.
                joiner.stdin.write(b"join\n")
                joiner.stdin.flush()
                self.assertEqual(joiner.stdout.readline(), b"joined\n")
                joined.append(True)
            return data

        with mock.patch.object(
            client_module, "_proc_group_dead", functools.partial(_proc_group_dead, read_file=read_file)
        ):
            confirmed = _terminate_process_group(leader, pgid)
        self.assertTrue(joined, "teardown never read the joining process")
        self.assertFalse(
            confirmed and not self._dies(joiner.pid),
            f"teardown confirmed while process {joiner.pid}, which joined the group during the scan, runs",
        )

    def test_terminate_sees_a_process_that_joined_after_the_last_sigkill(self) -> None:
        # The last SIGKILL does not end the race: a process can join the group
        # right after it, or be one the signal cannot reach. Teardown must
        # check the group after its last signal and not report success while
        # such a process runs.
        leader = self._spawn(["sleep", "30"])
        pgid = leader.pid
        self._unreaped_dead(pgid)  # keeps the group joinable once the leader dies
        joiner = self._spawn(
            [sys.executable, "-c", JOIN_GROUP, str(pgid)], 0, subprocess.PIPE, subprocess.PIPE
        )
        assert joiner.stdin is not None and joiner.stdout is not None
        real_killpg = os.killpg
        kills: list[int] = []

        def killpg(target: int, sig: int) -> None:
            real_killpg(target, sig)
            if target == pgid and sig == signal.SIGKILL:
                kills.append(sig)
                # The first SIGKILL escalates; the second follows the first
                # /proc proof. Join right after it.
                if len(kills) == 2:
                    joiner.stdin.write(b"join\n")
                    joiner.stdin.flush()
                    self.assertEqual(joiner.stdout.readline(), b"joined\n")

        with mock.patch.object(os, "killpg", killpg):
            confirmed = _terminate_process_group(leader, pgid)
        self.assertGreaterEqual(len(kills), 2, "teardown never proved the group dead")
        self.assertFalse(
            confirmed and not _proven_dead(joiner.pid),
            f"teardown confirmed while process {joiner.pid}, which joined after the last SIGKILL, runs",
        )

    def test_terminate_sees_a_process_that_joined_during_the_final_proof(self) -> None:
        # The final proof reads a process as outside the group, and the process
        # joins before the proof ends. The proof must read it again and see a
        # live member: teardown must not report success while it runs.
        leader = self._spawn(["sleep", "30"])
        pgid = leader.pid
        self._unreaped_dead(pgid)  # keeps the group joinable once the leader dies
        joiner = self._spawn(
            [sys.executable, "-c", JOIN_GROUP, str(pgid)], 0, subprocess.PIPE, subprocess.PIPE
        )
        assert joiner.stdin is not None and joiner.stdout is not None
        real_killpg = os.killpg
        kills: list[int] = []
        joined: list[bool] = []

        def killpg(target: int, sig: int) -> None:
            real_killpg(target, sig)
            if target == pgid and sig == signal.SIGKILL:
                kills.append(sig)

        def read_file(path: str) -> bytes:
            data = _read_file(path)
            if path == f"/proc/{joiner.pid}/stat" and len(kills) >= 2 and not joined:
                # After the last SIGKILL, behind this read: the process, read
                # as outside the group, joins it.
                joiner.stdin.write(b"join\n")
                joiner.stdin.flush()
                self.assertEqual(joiner.stdout.readline(), b"joined\n")
                joined.append(True)
            return data

        with mock.patch.object(os, "killpg", killpg), mock.patch.object(
            client_module, "_proc_group_dead", functools.partial(_proc_group_dead, read_file=read_file)
        ):
            confirmed = _terminate_process_group(leader, pgid)
        self.assertTrue(joined, "the final proof never read the joining process")
        self.assertFalse(
            confirmed and not _proven_dead(joiner.pid),
            f"teardown confirmed while process {joiner.pid}, which joined during the final proof, runs",
        )

    def test_stop_kills_a_member_whose_main_thread_exited(self) -> None:
        # The member reads Z in /proc although a thread of it runs, and it
        # ignores SIGTERM: stop() must not confirm teardown while that thread
        # is alive.
        work = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, work, ignore_errors=True)
        pid_file = os.path.join(work, "member.pid")
        server = textwrap.dedent(
            f"""
            import json, os, subprocess, sys
            # The member holds none of the client's pipes, so a member that
            # outlives stop() cannot block the client's own pipe teardown.
            member = subprocess.Popen(
                [sys.executable, "-c", {MAIN_THREAD_EXITS!r}],
                stdin=subprocess.DEVNULL,
                stdout=subprocess.PIPE,
                stderr=subprocess.DEVNULL,
            )
            member.stdout.readline()
            with open({pid_file!r} + ".tmp", "w") as f:
                f.write(str(member.pid))
            os.replace({pid_file!r} + ".tmp", {pid_file!r})
            print(json.dumps({{"type": "ready"}}), flush=True)
            for _line in sys.stdin:
                pass
            """
        )
        client = RpcClient(
            command=[sys.executable, "-u", "-c", server],
            startup_timeout=10.0,
            request_timeout=2.0,
        )
        client.start()
        self.addCleanup(client.stop)
        with open(pid_file, encoding="utf-8") as f:
            member = int(f.read())
        # The member is the server's child, not ours: kill it through a pidfd
        # so a reused pid is never signalled.
        member_fd = os.pidfd_open(member)
        self.addCleanup(os.close, member_fd)

        def _kill_member() -> None:
            try:
                signal.pidfd_send_signal(member_fd, signal.SIGKILL)
            except ProcessLookupError:
                pass  # already dead and reaped

        self.addCleanup(_kill_member)
        _wait_for_proc_state(self, member, b"Z")
        self.assertFalse(
            _proc_threads_dead(str(member), os.listdir, _read_file),
            "member has no live thread left",
        )

        stopped = client.stop()
        self.assertTrue(
            _proven_dead(member) or not stopped,
            f"stop() returned True while member {member} still has a live thread",
        )
        self.assertIs(stopped, True)
        self.assertEqual(client.survivor_pids, ())

    def test_terminate_rejects_a_member_that_joined_during_the_scan(self) -> None:
        # A /proc scan is not a snapshot: a member can join the group after the
        # listing, and the member the listing holds can then die. Teardown must
        # not confirm a group whose new member it never saw while it runs.
        leader = self._spawn(["sleep", "30"])
        pgid = leader.pid
        member = self._spawn(
            ["sh", "-c", "trap '' TERM; echo ready; exec sleep 30"], pgid, subprocess.PIPE
        )
        assert member.stdout is not None
        self.assertEqual(member.stdout.readline(), b"ready\n")

        late: list[subprocess.Popen[bytes]] = []

        def listdir(path: str) -> list[str]:
            entries = os.listdir(path)
            if path == "/proc" and not late:
                # Behind the listing: a new member joins, then the member the
                # listing holds dies (it is our child, so its pid stays ours).
                late.append(self._spawn(["sleep", "30"], pgid))
                os.kill(member.pid, signal.SIGKILL)
                _wait_for_proc_state(self, member.pid, b"Z")
            return entries

        with mock.patch.object(
            client_module, "_proc_group_dead", functools.partial(_proc_group_dead, listdir=listdir)
        ):
            confirmed = _terminate_process_group(leader, pgid)
        self.assertTrue(late, "teardown never listed /proc")
        self.assertFalse(
            confirmed and not _proven_dead(late[0].pid),
            f"teardown confirmed while member {late[0].pid}, which joined during the scan, runs",
        )


@unittest.skipUnless(
    hasattr(os, "killpg") and hasattr(os, "pidfd_open"),
    "needs POSIX process groups and pidfds",
)
class StopIsBoundedTests(unittest.TestCase):
    """stop() returns in bounded time whatever holds the client's pipes, so it
    can report what it found. A stop() that never returns reports nothing."""

    STOP_LIMIT = 10.0

    def _stop_in_background(self, client: RpcClient) -> tuple[threading.Thread, list[bool]]:
        result: list[bool] = []
        stopper = threading.Thread(target=lambda: result.append(client.stop()), daemon=True)
        stopper.start()
        return stopper, result

    def test_stop_returns_while_a_process_outside_the_group_holds_a_client_pipe(self) -> None:
        for pipe in ("stdout", "stderr"):
            with self.subTest(pipe):
                self._check_outside_holder(pipe)

    def _check_outside_holder(self, pipe: str) -> None:
        work = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, work, ignore_errors=True)
        pid_file = os.path.join(work, "holder.pid")
        streams = (
            "stdout=None, stderr=subprocess.DEVNULL"
            if pipe == "stdout"
            else "stdout=subprocess.DEVNULL, stderr=None"
        )
        # The holder runs in a session of its own, so it is outside the
        # server's group and teardown does not reach it, but it inherited the
        # client's pipe.
        server = textwrap.dedent(
            f"""
            import json, os, subprocess, sys
            holder = subprocess.Popen(
                ["sleep", "30"], stdin=subprocess.DEVNULL, {streams}, start_new_session=True
            )
            with open({pid_file!r} + ".tmp", "w") as f:
                f.write(str(holder.pid))
            os.replace({pid_file!r} + ".tmp", {pid_file!r})
            print(json.dumps({{"type": "ready"}}), flush=True)
            for _line in sys.stdin:
                pass
            """
        )
        client = RpcClient(
            command=[sys.executable, "-u", "-c", server],
            startup_timeout=10.0,
            request_timeout=2.0,
        )
        client.start()
        process = client._process
        assert process is not None
        with open(pid_file, encoding="utf-8") as f:
            holder_fd = os.pidfd_open(int(f.read()))
        self.addCleanup(os.close, holder_fd)

        stopper, result = self._stop_in_background(client)
        try:
            stopper.join(self.STOP_LIMIT)
            returned = not stopper.is_alive()
        finally:
            # The holder is not ours: kill it through its pidfd. This also
            # releases a stop() that is still blocked.
            try:
                signal.pidfd_send_signal(holder_fd, signal.SIGKILL)
            except ProcessLookupError:
                pass
            stopper.join(30.0)
        self.assertTrue(
            returned,
            f"stop() still blocked after {self.STOP_LIMIT} s on a {pipe} pipe held outside the group",
        )
        self.assertEqual(result, [True], "the server's own group is gone")
        # Once the holder is gone the reader reaches EOF and closes its stream.
        stream = getattr(process, pipe)
        deadline = time.monotonic() + 5.0
        while not stream.closed and time.monotonic() < deadline:
            time.sleep(0.02)
        self.assertTrue(stream.closed, f"the client's {pipe} stayed open after its holder exited")

    def test_stop_returns_while_a_write_is_blocked_on_a_server_that_stopped_reading(self) -> None:
        server = textwrap.dedent(
            """
            import json, sys, time
            print(json.dumps({"type": "ready"}), flush=True)
            time.sleep(60)  # never reads stdin
            """
        )
        client = RpcClient(
            command=[sys.executable, "-u", "-c", server],
            startup_timeout=10.0,
            request_timeout=60.0,
        )
        client.start()
        process = client._process
        assert process is not None

        errors: list[BaseException] = []

        def write() -> None:
            try:
                client.prompt("x" * (1 << 20))  # far more than the pipe holds
            except BaseException as exc:  # noqa: BLE001
                errors.append(exc)

        writer = threading.Thread(target=write, daemon=True)
        writer.start()
        writer.join(1.0)
        self.assertTrue(writer.is_alive(), "the write did not block")

        stopper, result = self._stop_in_background(client)
        try:
            stopper.join(self.STOP_LIMIT)
            returned = not stopper.is_alive()
        finally:
            # The server is our child's group: killing it ends the blocked write
            # and releases a stop() that is still blocked.
            try:
                os.killpg(process.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            stopper.join(30.0)
            writer.join(30.0)
        self.assertTrue(
            returned,
            f"stop() still blocked after {self.STOP_LIMIT} s behind a write the server never read",
        )
        self.assertEqual(result, [True])
        self.assertFalse(writer.is_alive(), "the blocked write never ended")
        self.assertEqual(len(errors), 1, "the blocked write must fail, not succeed")

    def test_stop_ends_a_write_that_a_process_outside_the_group_keeps_blocked(self) -> None:
        # The holder runs in a session of its own and inherited the server's
        # stdin, which it never reads: killing the server does not end a write
        # blocked on that pipe. stop() must still end the write and close stdin.
        work = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, work, ignore_errors=True)
        pid_file = os.path.join(work, "holder.pid")
        server = textwrap.dedent(
            f"""
            import json, os, subprocess, sys, time
            holder = subprocess.Popen(
                ["sleep", "30"],
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                start_new_session=True,
            )
            with open({pid_file!r} + ".tmp", "w") as f:
                f.write(str(holder.pid))
            os.replace({pid_file!r} + ".tmp", {pid_file!r})
            print(json.dumps({{"type": "ready"}}), flush=True)
            time.sleep(60)  # never reads stdin
            """
        )
        client = RpcClient(
            command=[sys.executable, "-u", "-c", server],
            startup_timeout=10.0,
            request_timeout=60.0,
        )
        client.start()
        process = client._process
        assert process is not None and process.stdin is not None
        with open(pid_file, encoding="utf-8") as f:
            holder_fd = os.pidfd_open(int(f.read()))
        self.addCleanup(os.close, holder_fd)

        errors: list[BaseException] = []

        def write() -> None:
            try:
                client.prompt("x" * (1 << 20))
            except BaseException as exc:  # noqa: BLE001
                errors.append(exc)

        writer = threading.Thread(target=write, daemon=True)
        writer.start()
        writer.join(1.0)
        self.assertTrue(writer.is_alive(), "the write did not block")

        stopper, result = self._stop_in_background(client)
        try:
            stopper.join(self.STOP_LIMIT)
            returned = not stopper.is_alive()
            writer.join(5.0)
            writer_ended = not writer.is_alive()
            stdin_closed = process.stdin.closed
        finally:
            try:
                signal.pidfd_send_signal(holder_fd, signal.SIGKILL)
            except ProcessLookupError:
                pass
            stopper.join(30.0)
            writer.join(30.0)
        self.assertTrue(returned, f"stop() still blocked after {self.STOP_LIMIT} s")
        self.assertEqual(result, [True])
        self.assertTrue(writer_ended, "the write stayed blocked after stop()")
        self.assertEqual(len(errors), 1, "the blocked write must fail, not succeed")
        self.assertTrue(stdin_closed, "the stopped child's stdin stayed open")


@unittest.skipUnless(hasattr(os, "killpg"), "POSIX process groups only")
class StopAndRestartTests(unittest.TestCase):
    """A frame from a stopped child never changes a restarted client."""

    def _settle_once_server(self) -> str:
        # Sends one `session_settled` after `ready`, on its first start only.
        work = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, work, ignore_errors=True)
        marker = os.path.join(work, "settle-once")
        with open(marker, "w", encoding="utf-8"):
            pass
        return textwrap.dedent(
            f"""
            import json, os, sys
            print(json.dumps({{"type": "ready"}}), flush=True)
            try:
                os.unlink({marker!r})
            except FileNotFoundError:
                pass
            else:
                print(json.dumps({{"type": "session_settled"}}), flush=True)
            for _line in sys.stdin:
                pass
            """
        )

    def test_a_frame_from_the_stopped_child_does_not_reach_the_restarted_client(self) -> None:
        client = RpcClient(
            command=[sys.executable, "-u", "-c", self._settle_once_server()],
            startup_timeout=10.0,
            request_timeout=2.0,
        )
        entered = threading.Event()
        release = threading.Event()

        def hold(notification: object) -> None:
            if getattr(notification, "type", None) == "session_settled":
                entered.set()
                release.wait(30.0)

        client.on_notification(hold)
        self.addCleanup(client.stop)
        self.addCleanup(release.set)
        client.start()
        self.assertTrue(entered.wait(10.0), "the settled frame never arrived")
        # The reader is still delivering that frame when the client stops and
        # restarts.
        self.assertIs(client.stop(), True)
        restart = threading.Thread(target=client.start, daemon=True)
        restart.start()
        # Let the restart reset its state and spawn the new child before the
        # old frame goes on; a restart that waits for that frame never spawns.
        deadline = time.monotonic() + 2.0
        while client._process is None and time.monotonic() < deadline:
            time.sleep(0.01)
        release.set()
        restart.join(30.0)
        self.assertFalse(restart.is_alive(), "the restart never finished")
        self.assertIsNotNone(client._process)
        self.assertEqual(
            client._session_settled_count,
            0,
            "the stopped child's settled frame reached the restarted client",
        )

    def test_a_listener_can_stop_and_restart_the_client(self) -> None:
        # The rest of the frame the listener runs in belongs to the stopped
        # child: once the listener has restarted the client, it is dropped and
        # does not change the new child's state.
        client = RpcClient(
            command=[sys.executable, "-u", "-c", self._settle_once_server()],
            startup_timeout=10.0,
            request_timeout=2.0,
        )
        outcomes: dict[str, object] = {}
        done = threading.Event()

        def on_settled(notification: object) -> None:
            if getattr(notification, "type", None) != "session_settled":
                return
            try:
                outcomes["stop"] = client.stop()
                client.start()
                outcomes["start"] = "started"
            except BaseException as exc:  # noqa: BLE001
                outcomes["error"] = exc
            done.set()

        client.on_notification(on_settled)
        self.addCleanup(client.stop)
        client.start()
        self.assertTrue(done.wait(20.0), "the listener never ran")
        self.assertNotIn("error", outcomes)
        self.assertIs(outcomes["stop"], True)
        self.assertEqual(outcomes["start"], "started")
        self.assertIsNotNone(client._process)
        self.assertEqual(
            client._session_settled_count,
            0,
            "the stopped child's settled frame reached the restarted client",
        )

    def test_start_succeeds_when_a_listener_restarts_the_client_after_ready(self) -> None:
        # A start() succeeds once its own child has sent `ready`. A listener
        # that then stops the client and restarts it on another thread owns
        # the new child; the first start() must still return, in any order of
        # the two threads. Here the restart finishes before the first start()
        # looks at its child again.
        client = RpcClient(
            command=[sys.executable, "-u", "-c", self._settle_once_server()],
            startup_timeout=10.0,
            request_timeout=2.0,
        )
        self.addCleanup(client.stop)
        restarted = threading.Event()
        errors: list[BaseException] = []

        def on_settled(notification: object) -> None:
            if getattr(notification, "type", None) != "session_settled":
                return
            try:
                client.stop()
                restart = threading.Thread(target=client.start, daemon=True)
                restart.start()
                restart.join(20.0)
            except BaseException as exc:  # noqa: BLE001
                errors.append(exc)
            restarted.set()

        client.on_notification(on_settled)
        caller = threading.current_thread()
        real_wait = client._ready.wait

        def wait(timeout: float | None = None) -> bool:
            result = real_wait(timeout)
            if threading.current_thread() is caller:
                restarted.wait(20.0)  # the listener's restart finishes first
            return result

        with mock.patch.object(client._ready, "wait", wait):
            client.start()
        self.assertTrue(restarted.is_set(), "the listener never ran")
        self.assertEqual(errors, [])
        self.assertIsNotNone(client._process, "the listener's restart did not start the client")
        self.assertIsNone(client._process.poll(), "the restarted child is not running")

    def test_a_listener_can_hand_the_restart_to_another_thread(self) -> None:
        # A listener that stops the client, hands start() to an owner thread
        # and waits for it must not wait on the frame it runs in.
        client = RpcClient(
            command=[sys.executable, "-u", "-c", self._settle_once_server()],
            startup_timeout=10.0,
            request_timeout=2.0,
        )
        outcomes: dict[str, object] = {}
        done = threading.Event()

        def on_settled(notification: object) -> None:
            if getattr(notification, "type", None) != "session_settled":
                return
            outcomes["stop"] = client.stop()
            restart = threading.Thread(target=client.start, daemon=True)
            restart.start()
            restart.join(10.0)
            outcomes["restarted"] = not restart.is_alive()
            done.set()
            restart.join(30.0)

        client.on_notification(on_settled)
        self.addCleanup(client.stop)
        client.start()
        self.assertTrue(done.wait(30.0), "the listener never ran")
        self.assertIs(outcomes["stop"], True)
        self.assertIs(outcomes["restarted"], True, "the restart waited on the listener's frame")

    def test_a_wait_begun_for_the_stopped_child_ends_with_it(self) -> None:
        # A wait woken by stop() can run again only after a restart has reset
        # the client. It must still end with the stop error, not succeed on the
        # new child's state or keep waiting, and not hold the prompt slot.
        for kind in ("prompt", "idle", "settled", "agent_end"):
            with self.subTest(kind):
                self._check_wait_across_restart(kind)

    def _check_wait_across_restart(self, kind: str) -> None:
        # `settle` emits one session_settled; get_state reports unsettled.
        server = textwrap.dedent(
            """
            import json, sys
            print(json.dumps({"type": "ready"}), flush=True)
            for line in sys.stdin:
                command = json.loads(line)
                kind = command["type"]
                if kind == "settle":
                    print(json.dumps({"type": "session_settled"}), flush=True)
                data = {}
                if kind == "get_state":
                    data = {"isSettled": False, "isStreaming": False, "isCompacting": False,
                            "steeringMode": "all", "followUpMode": "all",
                            "sessionId": "probe", "autoCompactionEnabled": False,
                            "messageCount": 0, "queuedMessageCount": 0}
                print(json.dumps({"type": "response", "id": command["id"],
                                  "command": kind, "success": True, "data": data}),
                      flush=True)
            """
        )
        client = RpcClient(
            command=[sys.executable, "-u", "-c", server],
            startup_timeout=10.0,
            request_timeout=10.0,
        )
        self.addCleanup(client.stop)
        waiting = threading.Event()
        woken = threading.Event()
        release = threading.Event()
        self.addCleanup(release.set)
        condition = client._event_condition
        real_wait = condition.wait

        def wait(timeout: float | None = None) -> bool:
            # Hold the old wait's thread once stop() wakes it, before it looks
            # at the client again, and without the condition's lock, so the
            # restart can run meanwhile.
            mine = threading.current_thread().name == "old-wait"
            if mine:
                waiting.set()
            result = real_wait(timeout)
            if mine and not woken.is_set():
                condition.release()
                try:
                    woken.set()
                    release.wait(20.0)
                finally:
                    condition.acquire()
            return result

        outcome: list[BaseException | str] = []

        def old_wait() -> None:
            try:
                if kind == "prompt":
                    client.prompt_and_wait("old", timeout=8.0)
                elif kind == "idle":
                    client.wait_for_idle(timeout=8.0)
                elif kind == "settled":
                    client.wait_for_settled(timeout=8.0)
                else:
                    client.collect_events(timeout=8.0)
                outcome.append("returned")
            except BaseException as exc:  # noqa: BLE001
                outcome.append(exc)

        with mock.patch.object(condition, "wait", wait):
            client.start()
            client.request_raw("settle")  # the old child's settled count is 1
            if kind == "idle":
                client.prompt("pending")  # a prompt the old child never answers
            old = threading.Thread(target=old_wait, name="old-wait", daemon=True)
            old.start()
            self.assertTrue(waiting.wait(10.0), "the old wait never waited")
            self.assertIs(client.stop(), True)
            self.assertTrue(woken.wait(10.0), "stop() did not wake the old wait")
            client.start()
            release.set()
            old.join(2.0)
        self.assertFalse(old.is_alive(), "the old wait kept waiting after the restart")
        self.assertEqual(len(outcome), 1)
        self.assertIsInstance(outcome[0], RpcProcessExitError, f"the old wait ended with {outcome[0]!r}")
        if kind == "prompt":
            # The restarted client's prompt slot is free: a new prompt waits
            # for its own result (and times out) instead of being refused.
            with self.assertRaises(RpcTimeoutError):
                client.prompt_and_wait("new", timeout=0.5)

    def _host_server(self, kind: str, log: str) -> str:
        # On `trigger` asks for host work under id "same-id"; on `cancel`
        # cancels it. Logs every host_* frame it receives.
        request = (
            {"type": "host_tool_call", "id": "same-id", "toolName": "slow",
             "toolCallId": "call", "arguments": {}}
            if kind == "tool"
            else {"type": "host_uri_request", "id": "same-id", "operation": "read",
                  "url": "db://x"}
        )
        cancel = {"type": "host_tool_cancel" if kind == "tool" else "host_uri_cancel",
                  "targetId": "same-id"}
        return textwrap.dedent(
            f"""
            import json, sys
            print(json.dumps({{"type": "ready"}}), flush=True)
            for line in sys.stdin:
                command = json.loads(line)
                kind = command["type"]
                if kind.startswith("host_"):
                    with open({log!r}, "a") as f:
                        f.write(line)
                    continue
                if kind == "trigger":
                    print(json.dumps({request!r}), flush=True)
                if kind == "cancel":
                    print(json.dumps({cancel!r}), flush=True)
                data = ({{"toolNames": ["slow"]}} if kind == "set_host_tools"
                        else {{"schemes": ["db"]}} if kind == "set_host_uri_schemes"
                        else {{}})
                print(json.dumps({{"type": "response", "id": command["id"],
                                  "command": kind, "success": True, "data": data}}),
                      flush=True)
            """
        )

    _ECHO_SERVER = textwrap.dedent(
        """
        import json, sys
        print(json.dumps({"type": "ready"}), flush=True)
        for line in sys.stdin:
            command = json.loads(line)
            print(json.dumps({"type": "response", "id": command["id"],
                              "command": command["type"], "success": True,
                              "data": {}}), flush=True)
        """
    )

    def test_a_restart_on_another_thread_while_starting_leaves_one_reader_pair(self) -> None:
        # Each child has one stdout and one stderr reader, and a start() acts
        # only on the child it spawned: a stop() and a start() on another
        # thread while a first start() is still starting its readers must not
        # give the new child a second pair. The first start() fails if its
        # child was stopped before it sent `ready` and succeeds if it was
        # stopped after, but either way leaves the new child running and
        # current.
        client = RpcClient(
            command=[sys.executable, "-u", "-c", self._ECHO_SERVER],
            startup_timeout=20.0,
            request_timeout=10.0,
        )
        self.addCleanup(client.stop)
        readers: list[tuple[str, int | None]] = []
        lock = threading.Lock()

        def recording(kind: str, loop: Callable[..., None]) -> Callable[..., None]:
            def run(*args: Any) -> None:
                process = args[0] if args else client._process
                with lock:
                    readers.append((kind, process.pid if process is not None else None))
                loop(*args)

            return run

        client._read_stdout_loop = recording("stdout", client._read_stdout_loop)  # type: ignore[method-assign]
        client._read_stderr_loop = recording("stderr", client._read_stderr_loop)  # type: ignore[method-assign]
        held = threading.Event()
        release = threading.Event()
        self.addCleanup(release.set)
        first = [True]
        real_start = threading.Thread.start

        def start(thread: threading.Thread) -> None:
            # Pause the first start() just before its first reader starts
            # (bounded: a client that holds its restart lock here makes the
            # other thread's start() wait for this one).
            if thread.name == "omp-rpc-stderr" and first[0]:
                first[0] = False
                held.set()
                release.wait(3.0)
            real_start(thread)

        outcome: list[BaseException | str] = []

        def first_start() -> None:
            try:
                client.start()
                outcome.append("returned")
            except BaseException as exc:  # noqa: BLE001
                outcome.append(exc)

        with mock.patch.object(threading.Thread, "start", start):
            starter = threading.Thread(target=first_start, daemon=True)
            starter.start()
            self.assertTrue(held.wait(20.0), "the first start() never reached its readers")
            old = client._process
            assert old is not None
            self.assertIs(client.stop(), True)
            client.start()
            new = client._process
            assert new is not None
            release.set()
            starter.join(20.0)
        self.assertFalse(starter.is_alive(), "the first start() never returned")
        self.assertEqual(client.request_raw("barrier"), {}, "the new child does not answer")
        with lock:
            new_readers = sorted(kind for kind, pid in readers if pid == new.pid)
        self.assertEqual(new_readers, ["stderr", "stdout"], f"readers per child: {readers}")
        self.assertEqual(len(outcome), 1)
        self.assertTrue(
            outcome[0] == "returned" or isinstance(outcome[0], RpcProcessExitError),
            f"the first start() ended with {outcome[0]!r}",
        )
        self.assertIs(client._process, new, "the first start() replaced or detached the new child")
        self.assertIsNone(new.poll(), "the first start() stopped the new child")

    def test_a_completion_listener_that_restarts_the_client_ends_the_old_completion(self) -> None:
        # Once a host_tool_completed listener has restarted the client, the
        # rest of that completion belongs to the stopped child: no later
        # listener receives it.
        entered = threading.Event()
        release = threading.Event()
        self.addCleanup(release.set)

        def handler(_argument: object, _context: Any) -> str:
            entered.set()
            release.wait(20.0)
            return "OLD RESULT"

        work = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, work, ignore_errors=True)
        client = RpcClient(
            command=[sys.executable, "-u", "-c", self._host_server("tool", os.path.join(work, "log"))],
            startup_timeout=10.0,
            request_timeout=10.0,
            custom_tools=(
                host_tool(name="slow", description="probe",
                          parameters={"type": "object", "properties": {}}, execute=handler),
            ),
        )
        self.addCleanup(client.stop)
        received: list[str] = []
        restarted = threading.Event()

        def restart(_event: object) -> None:
            received.append("restart")
            client.stop()
            client.start()
            restarted.set()

        client.on_host_tool_completed(restart)
        client.on_host_tool_completed(lambda event: received.append(event.tool_call_id))
        client.start()
        client.request_raw("trigger")
        self.assertTrue(entered.wait(10.0), "the host tool never ran")
        release.set()
        self.assertTrue(restarted.wait(20.0), "the first listener never restarted the client")
        deadline = time.monotonic() + 5.0
        while time.monotonic() < deadline and any(
            thread.name == "omp-rpc-host-tool:slow" for thread in threading.enumerate()
        ):
            time.sleep(0.01)
        self.assertEqual(received, ["restart"], "a later listener received the old completion")
        self.assertEqual(client.request_raw("barrier"), {}, "the restarted child does not answer")

    def test_a_listener_can_stop_the_client_while_it_starts(self) -> None:
        # The first frames can reach a listener while start() is still starting
        # the client's reader threads; stop() there must not fail on them.
        server = textwrap.dedent(
            """
            import json, sys
            print(json.dumps({"type": "ready"}), flush=True)
            print(json.dumps({"type": "session_settled"}), flush=True)
            for _line in sys.stdin:
                pass
            """
        )
        client = RpcClient(
            command=[sys.executable, "-u", "-c", server],
            startup_timeout=10.0,
            request_timeout=2.0,
        )
        self.addCleanup(client.stop)
        outcomes: list[object] = []
        done = threading.Event()

        def on_settled(notification: object) -> None:
            if getattr(notification, "type", None) != "session_settled":
                return
            try:
                outcomes.append(client.stop())
            except BaseException as exc:  # noqa: BLE001
                outcomes.append(exc)
            done.set()

        client.on_notification(on_settled)
        real_start = threading.Thread.start

        def start(thread: threading.Thread) -> None:
            # Hold the stderr reader back until the listener has run (bounded,
            # since a client that starts it first never runs the listener
            # before it).
            if thread.name == "omp-rpc-stderr":
                done.wait(1.0)
            real_start(thread)

        with mock.patch.object(threading.Thread, "start", start):
            try:
                client.start()
            except RpcError:
                pass  # the listener stopped the client before start() returned
        self.assertTrue(done.wait(10.0), "the listener never ran")
        self.assertEqual(outcomes, [True])

    def test_a_host_tool_of_the_stopped_child_is_not_reported_completed(self) -> None:
        # A host_tool_completed listener acts on the client: once the child
        # that asked for the tool is replaced, the old tool's completion must
        # not reach it.
        work = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, work, ignore_errors=True)
        entered = threading.Event()
        release = threading.Event()
        self.addCleanup(release.set)
        finished = threading.Event()

        def handler(_argument: object, _context: Any) -> str:
            entered.set()
            release.wait(20.0)
            finished.set()
            return "OLD RESULT"

        client = RpcClient(
            command=[sys.executable, "-u", "-c", self._host_server("tool", os.path.join(work, "log"))],
            startup_timeout=10.0,
            request_timeout=10.0,
            custom_tools=(
                host_tool(name="slow", description="probe",
                          parameters={"type": "object", "properties": {}}, execute=handler),
            ),
        )
        self.addCleanup(client.stop)
        completed: list[str] = []
        client.on_host_tool_completed(lambda event: completed.append(event.tool_call_id))
        client.start()
        client.request_raw("trigger")
        self.assertTrue(entered.wait(10.0), "the host tool never ran")
        self.assertIs(client.stop(), True)
        client.start()
        release.set()
        self.assertTrue(finished.wait(10.0), "the host tool never finished")
        deadline = time.monotonic() + 5.0
        while time.monotonic() < deadline and any(
            thread.name == "omp-rpc-host-tool:slow" for thread in threading.enumerate()
        ):
            time.sleep(0.01)
        self.assertEqual(completed, [], "the stopped child's tool was reported to the restarted client")

    def test_host_work_of_the_stopped_child_does_not_reach_the_restarted_child(self) -> None:
        for kind in ("tool", "uri"):
            with self.subTest(kind):
                self._check_host_work_across_restart(kind)

    def _check_host_work_across_restart(self, kind: str) -> None:
        work = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, work, ignore_errors=True)
        log = os.path.join(work, "received")
        entered = [threading.Event(), threading.Event()]
        release = [threading.Event(), threading.Event()]
        for event in release:
            self.addCleanup(event.set)
        contexts: list[Any] = []

        def handler(_argument: object, context: Any) -> str:
            index = len(contexts)
            contexts.append(context)
            entered[index].set()
            release[index].wait(20.0)
            return "OLD RESULT" if index == 0 else "NEW RESULT"

        options: dict[str, Any] = (
            {"custom_tools": (host_tool(name="slow", description="probe",
                                        parameters={"type": "object", "properties": {}},
                                        execute=handler),)}
            if kind == "tool"
            else {"host_uris": (host_uri(scheme="db", read=handler),)}
        )
        client = RpcClient(
            command=[sys.executable, "-u", "-c", self._host_server(kind, log)],
            startup_timeout=10.0,
            request_timeout=10.0,
            **options,
        )
        self.addCleanup(client.stop)
        pending = (
            client._pending_host_tool_calls if kind == "tool" else client._pending_host_uri_requests
        )
        worker_name = "omp-rpc-host-tool:slow" if kind == "tool" else "omp-rpc-host-uri:db:read"

        def workers() -> int:
            return sum(1 for thread in threading.enumerate() if thread.name == worker_name)

        client.start()
        client.request_raw("trigger")
        self.assertTrue(entered[0].wait(10.0), "the first child's host work never ran")
        old_entry = pending["same-id"]
        restarted = threading.Event()
        real_is_set = old_entry.cancel_event.is_set

        hook_errors: list[BaseException] = []

        def is_set() -> bool:
            # The first child's work has just found itself not cancelled and
            # is about to reply. The client stops and restarts right then, and
            # the restarted child asks for work under the same id.
            cancelled = real_is_set()
            if not restarted.is_set():
                restarted.set()
                try:
                    if client.stop() is not True:
                        hook_errors.append(AssertionError("stop() did not confirm"))
                    client.start()
                    client.request_raw("trigger")
                    if not entered[1].wait(10.0):
                        hook_errors.append(AssertionError("the second child's work never ran"))
                except BaseException as exc:  # noqa: BLE001
                    hook_errors.append(exc)
                finally:
                    hook_done.set()
            return cancelled

        hook_done = threading.Event()
        old_entry.cancel_event.is_set = is_set  # type: ignore[method-assign]
        release[0].set()
        self.assertTrue(hook_done.wait(30.0), "the first child's host work never finished")
        self.assertEqual(hook_errors, [])
        deadline = time.monotonic() + 10.0
        while workers() > 1 and time.monotonic() < deadline:
            time.sleep(0.01)
        self.assertEqual(workers(), 1, "the first child's host work never finished")
        client.request_raw("barrier")
        try:
            with open(log, encoding="utf-8") as f:
                received = f.read()
        except FileNotFoundError:
            received = ""
        problems: list[str] = []
        if "OLD" in received:
            problems.append(f"the stopped child's reply reached the new child: {received!r}")
        new_entry = pending.get("same-id")
        if new_entry is None or new_entry is old_entry:
            problems.append("the old work removed the new child's pending entry")
        client.request_raw("cancel")
        if not contexts[1].cancelled:
            problems.append("the new child's cancel did not reach its work")
        release[1].set()
        self.assertEqual(problems, [])


# A fake server for the child-ownership tests. READY is its ready frame, LOG
# a file that receives every host_* and extension_ui_response frame it gets,
# NEGOTIATED the protocol version it answers negotiate_protocol with.
OWNERSHIP_SERVER = textwrap.dedent(
    """
    import json, os, sys
    print(json.dumps(READY), flush=True)
    for line in sys.stdin:
        command = json.loads(line)
        kind = command["type"]
        if kind == "extension_ui_response" or kind.startswith("host_"):
            with open(LOG, "a") as f:
                f.write(json.dumps({"pid": os.getpid(), "frame": command}) + "\\n")
            continue
        if kind == "settle":
            print(json.dumps({"type": "session_settled"}), flush=True)
        if kind == "ui":
            print(json.dumps({"type": "extension_ui_request", "method": "confirm",
                              "id": "old-ui", "title": "Continue?"}), flush=True)
        if kind == "tool":
            print(json.dumps({"type": "host_tool_call", "id": "old", "toolName": "slow",
                              "toolCallId": "old-call", "arguments": {}}), flush=True)
        if kind == "uri":
            print(json.dumps({"type": "host_uri_request", "id": "old", "operation": "read",
                              "url": "db://one"}), flush=True)
        if kind == "uis":
            # `count` confirm dialogs, each cancelled again when `cancel`.
            for index in range(command.get("count", 1)):
                dialog = f"{os.getpid()}-{index}"
                print(json.dumps({"type": "extension_ui_request", "method": "confirm",
                                  "id": dialog, "title": "Continue?"}), flush=True)
                if command.get("cancel"):
                    print(json.dumps({"type": "extension_ui_request", "method": "cancel",
                                      "id": "cancel-" + dialog, "targetId": dialog}),
                          flush=True)
        if kind == "event":
            print(json.dumps({"type": "agent_start"}), flush=True)
        data = ({"protocolVersion": NEGOTIATED} if kind == "negotiate_protocol"
                else {"toolNames": ["slow"]} if kind == "set_host_tools"
                else {"schemes": ["db"]} if kind == "set_host_uri_schemes"
                else {"agentInvoked": False} if kind == "prompt"
                else {})
        print(json.dumps({"type": "response", "id": command["id"], "command": kind,
                          "success": True, "data": data}), flush=True)
    """
)


class _OwnershipFixture(unittest.TestCase):
    """A client on OWNERSHIP_SERVER and the frames that server received."""

    def setUp(self) -> None:
        work = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, work, ignore_errors=True)
        self.log = os.path.join(work, "received")

    def _argv(self, *, v2: bool = False, negotiated: int = 2) -> tuple[str, ...]:
        ready: dict[str, Any] = {"type": "ready"}
        if v2:
            ready.update(
                supportedProtocolVersions=[1, 2],
                maxFrameBytes=client_module._MAX_RPC_FRAME_BYTES,
                maxReassembledFrameBytes=client_module._MAX_RPC_REASSEMBLED_BYTES,
            )
        prelude = f"READY = {ready!r}\nLOG = {self.log!r}\nNEGOTIATED = {negotiated!r}\n"
        return (sys.executable, "-u", "-c", prelude + OWNERSHIP_SERVER)

    def _client(self, **options: Any) -> RpcClient:
        client = RpcClient(
            command=self._argv(), startup_timeout=15.0, request_timeout=10.0, **options
        )
        self.addCleanup(client.stop)
        return client

    def _received(self) -> list[dict[str, Any]]:
        try:
            with open(self.log, encoding="utf-8") as f:
                return [json.loads(line) for line in f]
        except FileNotFoundError:
            return []

    def _pause_teardown_of(self, thread_name: str) -> tuple[threading.Event, threading.Event]:
        """Hold the named thread right after it has torn its child down."""
        held, release = threading.Event(), threading.Event()
        self.addCleanup(release.set)
        real = client_module._terminate_process_group

        def terminate(process: Any, pgid: Any) -> bool:
            result = real(process, pgid)
            if threading.current_thread().name == thread_name and not held.is_set():
                held.set()
                release.wait(20.0)
            return result

        patcher = mock.patch.object(client_module, "_terminate_process_group", terminate)
        patcher.start()
        self.addCleanup(patcher.stop)
        return held, release


@unittest.skipUnless(hasattr(os, "killpg"), "POSIX process groups only")
class ChildOwnershipTests(_OwnershipFixture):
    """Nothing of a stopped or replaced child acts on the client or reaches
    its listeners, and a stop() or start() acts only on its own child, also
    when another thread or a listener stops and restarts the client meanwhile."""

    def test_a_stop_that_ends_after_a_restart_keeps_the_new_child(self) -> None:
        client = self._client()
        client.start()
        held, release = self._pause_teardown_of("first-stop")
        outcome: list[bool] = []
        first = threading.Thread(target=lambda: outcome.append(client.stop()), name="first-stop")
        first.start()
        self.assertTrue(held.wait(20.0), "the first stop() never tore its child down")
        self.assertIs(client.stop(), True)
        client.start()
        replacement = client._process
        assert replacement is not None
        release.set()
        first.join(20.0)
        self.assertEqual(outcome, [True])
        self.assertIs(client._process, replacement, "the first stop() detached the new child")
        self.assertIsNone(replacement.poll(), "the first stop() stopped the new child")
        self.assertEqual(client.request_raw("barrier"), {})

    def test_a_failed_start_stops_only_its_own_child(self) -> None:
        client = self._client()
        # The first child offers protocol v2 and then refuses it, so its
        # start() fails and stops its child.
        client._argv = self._argv(v2=True, negotiated=1)
        held, release = self._pause_teardown_of("failing-start")
        outcome: list[BaseException | str] = []

        def failing_start() -> None:
            try:
                client.start()
                outcome.append("returned")
            except BaseException as exc:  # noqa: BLE001
                outcome.append(exc)

        starter = threading.Thread(target=failing_start, name="failing-start")
        starter.start()
        self.assertTrue(held.wait(20.0), "the failing start() never stopped its child")
        self.assertIs(client.stop(), True)
        client._argv = self._argv()
        client.start()
        replacement = client._process
        assert replacement is not None
        release.set()
        starter.join(20.0)
        self.assertEqual(len(outcome), 1)
        self.assertIsInstance(outcome[0], RpcError)
        self.assertIs(client._process, replacement, "the failed start() detached the new child")
        self.assertIsNone(replacement.poll(), "the failed start() stopped the new child")
        self.assertEqual(client.request_raw("barrier"), {})

    def test_a_replaced_start_leaves_the_new_childs_protocol(self) -> None:
        client = self._client()
        client._argv = self._argv(v2=True)
        held, release = threading.Event(), threading.Event()
        self.addCleanup(release.set)
        real_request = client._request_data

        def request(command: str, *args: Any, **kwargs: Any) -> Any:
            data = real_request(command, *args, **kwargs)
            if command == "negotiate_protocol" and threading.current_thread().name == "old-start":
                # Negotiated with the first child; it is replaced before
                # start() records the result.
                held.set()
                release.wait(20.0)
            return data

        client._request_data = request  # type: ignore[method-assign]
        starter = threading.Thread(target=client.start, name="old-start", daemon=True)
        starter.start()
        self.assertTrue(held.wait(20.0), "the first start() never negotiated")
        self.assertIs(client.stop(), True)
        client._argv = self._argv()  # protocol v1 only
        client.start()
        replacement = client._process
        release.set()
        starter.join(20.0)
        self.assertFalse(starter.is_alive(), "the first start() never returned")
        self.assertIs(client._process, replacement)
        self.assertEqual(
            client._protocol_version, 1, "the first start() set the new child's protocol"
        )
        self.assertEqual(client.request_raw("barrier"), {})

    def _settle_and_wait(self, client: RpcClient) -> None:
        reader = client._stdout_thread
        assert reader is not None
        try:
            client.request_raw("settle")
        except RpcProcessExitError:
            pass  # a listener stopped the client while the request waited
        reader.join(20.0)
        self.assertFalse(reader.is_alive(), "the first child's reader never ended")
        self.assertEqual(client.request_raw("barrier"), {})

    def test_a_listener_error_of_the_stopped_child_reaches_no_error_listener(self) -> None:
        client = self._client()
        reported: list[str] = []

        def restart_then_raise(notification: object) -> None:
            if getattr(notification, "type", None) != "session_settled":
                return
            client.stop()
            client.start()
            raise ValueError("error from the old listener")

        client.on_notification(restart_then_raise)
        client.on_listener_error(lambda event: reported.append(str(event.error)))
        client.start()
        self._settle_and_wait(client)
        self.assertEqual(reported, [], "the old listener's error reached the restarted client")
        self.assertEqual(client.listener_errors, ())

    def test_an_error_listener_that_restarts_the_client_ends_the_old_error(self) -> None:
        client = self._client()
        seen: list[str] = []

        def raise_on_settled(notification: object) -> None:
            if getattr(notification, "type", None) == "session_settled":
                raise ValueError("old frame")

        def restart(_event: object) -> None:
            client.stop()
            client.start()
            seen.append("restarted")

        client.on_notification(raise_on_settled)
        client.on_listener_error(restart)
        client.on_listener_error(lambda event: seen.append(f"second got {event.error}"))
        client.start()
        self._settle_and_wait(client)
        self.assertEqual(seen, ["restarted"], "a later error listener got the old error")

    def test_a_headless_ui_answer_reaches_only_the_child_that_asked(self) -> None:
        client = self._client()
        restarted: list[int] = []

        def restart(_request: object) -> None:
            client.stop()
            client.start()
            assert client._process is not None
            restarted.append(client._process.pid)

        client.install_headless_ui(on_request=restart)
        client.start()
        reader = client._stdout_thread
        assert reader is not None
        try:
            client.request_raw("ui")
        except RpcProcessExitError:
            pass
        reader.join(20.0)
        self.assertEqual(client.request_raw("barrier"), {})
        self.assertEqual(len(restarted), 1)
        self.assertEqual(self._received(), [], "the old UI answer reached the restarted child")

    def test_an_answer_to_a_request_of_the_stopped_child_is_dropped(self) -> None:
        client = self._client()
        requests: list[Any] = []
        client.on_ui_request(requests.append)
        client.start()
        client.request_raw("ui")
        deadline = time.monotonic() + 10.0
        while not requests and time.monotonic() < deadline:
            time.sleep(0.01)
        self.assertEqual(len(requests), 1, "the UI request never arrived")
        self.assertIs(client.stop(), True)
        client.start()
        client.send_ui_confirmation(requests[0].id, True)
        self.assertEqual(client.request_raw("barrier"), {})
        self.assertEqual(self._received(), [], "the answer reached a child that never asked")

    def test_a_host_handler_of_the_stopped_child_does_not_run(self) -> None:
        for kind in ("tool", "uri"):
            with self.subTest(kind):
                self._check_late_handler(kind)

    def _check_late_handler(self, kind: str) -> None:
        ran: list[str] = []

        def handler(_argument: object, _context: Any) -> str:
            ran.append(kind)
            return "OLD"

        options: dict[str, Any] = (
            {"custom_tools": (host_tool(name="slow", description="probe",
                                        parameters={"type": "object", "properties": {}},
                                        execute=handler),)}
            if kind == "tool"
            else {"host_uris": (host_uri(scheme="db", read=handler),)}
        )
        client = self._client(**options)
        entered, release = threading.Event(), threading.Event()
        self.addCleanup(release.set)
        prefix = f"omp-rpc-host-{kind}"
        real_run = threading.Thread.run

        def run(thread: threading.Thread) -> None:
            # Hold the worker before it calls the handler.
            if thread.name.startswith(prefix):
                entered.set()
                release.wait(20.0)
            real_run(thread)

        with mock.patch.object(threading.Thread, "run", run):
            client.start()
            client.request_raw(kind)
            self.assertTrue(entered.wait(10.0), "the host work never started")
            self.assertIs(client.stop(), True)
            client.start()
            release.set()
            deadline = time.monotonic() + 10.0
            while time.monotonic() < deadline and any(
                thread.name.startswith(prefix) for thread in threading.enumerate()
            ):
                time.sleep(0.01)
        self.assertEqual(client.request_raw("barrier"), {})
        self.assertEqual(ran, [], "the stopped child's host handler ran")
        client.stop()

    def test_a_host_tool_cancelled_by_stop_reports_no_completion(self) -> None:
        entered = threading.Event()

        def handler(_argument: object, context: Any) -> str:
            entered.set()
            context._cancel_event.wait(20.0)
            return "LATE"

        client = self._client(
            custom_tools=(
                host_tool(name="slow", description="probe",
                          parameters={"type": "object", "properties": {}}, execute=handler),
            )
        )
        completed: list[str] = []
        client.on_host_tool_completed(lambda event: completed.append(event.tool_call_id))
        client.start()
        client.request_raw("tool")
        self.assertTrue(entered.wait(10.0), "the host tool never ran")
        self.assertIs(client.stop(), True)
        deadline = time.monotonic() + 10.0
        while time.monotonic() < deadline and any(
            thread.name == "omp-rpc-host-tool:slow" for thread in threading.enumerate()
        ):
            time.sleep(0.01)
        self.assertEqual(completed, [], "a cancelled host tool was reported completed")


@unittest.skipUnless(hasattr(os, "killpg"), "POSIX process groups only")
class ChildOwnershipEdgeTests(_OwnershipFixture):
    """More paths of the same rule: a listener on the ready frame, user code
    inside a host tool's decoder, repeated and cancelled dialog answers, a
    local prompt, and a reply the child never reads."""

    def test_stop_returns_while_a_reply_to_the_child_is_stuck(self) -> None:
        # The server asks for something the client refuses at once, with a
        # reply larger than a pipe holds, and never reads it. stop() must
        # still end the child: the reader never holds the lock stop() needs
        # while it writes.
        for kind in ("tool", "uri"):
            with self.subTest(kind):
                self._check_stuck_reply(kind)

    def _check_stuck_reply(self, kind: str) -> None:
        # Built in the server: a 200 kB argument is too long for argv.
        frame = (
            '{"type": "host_tool_call", "id": "bad", "toolName": "x" * 200_000,'
            ' "toolCallId": "bad", "arguments": {}}'
            if kind == "tool"
            else '{"type": "host_uri_request", "id": "bad", "operation": "x" * 200_000,'
            ' "url": "db://one"}'
        )
        server = textwrap.dedent(
            """
            import json, sys, time
            print(json.dumps({"type": "ready"}), flush=True)
            sys.stdin.readline()
            print(json.dumps(FRAME), flush=True)
            time.sleep(60)  # never reads again
            """
        ).replace("FRAME", frame)
        client = RpcClient(
            command=[sys.executable, "-u", "-c", server], startup_timeout=15.0, request_timeout=5.0
        )
        self.addCleanup(client.stop)
        writing = threading.Event()
        real_write = client._write_polled

        def write(process: Any, data: bytes) -> None:
            if threading.current_thread().name == "omp-rpc-stdout":
                writing.set()
            real_write(process, data)

        client._write_polled = write  # type: ignore[method-assign]
        client.start()
        process = client._process
        assert process is not None
        client._write_json(process, {"type": "trigger"})
        self.assertTrue(writing.wait(15.0), "the reader never replied")
        stopper, result = StopIsBoundedTests._stop_in_background(self, client)  # type: ignore[arg-type]
        try:
            stopper.join(StopIsBoundedTests.STOP_LIMIT)
            returned = not stopper.is_alive()
        finally:
            try:
                os.killpg(process.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            stopper.join(30.0)
        self.assertTrue(returned, f"stop() still blocked after {StopIsBoundedTests.STOP_LIMIT} s")
        self.assertEqual(result, [True])

    def test_start_succeeds_when_a_ready_listener_stops_the_client(self) -> None:
        client = self._client()
        seen: list[str] = []

        def on_ready(notification: object) -> None:
            if getattr(notification, "type", None) == "ready":
                seen.append("ready")
                client.stop()

        client.on_notification(on_ready)
        client.start()  # must not raise: its own child sent `ready`
        self.assertEqual(seen, ["ready"])
        self.assertIsNone(client._process)

    def _decoding_tool(self, decode: Callable[[Any], Any], ran: list[bool]) -> RpcClient:
        def execute(_params: object, _context: Any) -> str:
            ran.append(True)
            return "ran"

        return self._client(
            custom_tools=(
                host_tool(name="slow", description="probe", decode=decode,
                          parameters={"type": "object", "properties": {}}, execute=execute),
            )
        )

    def _join_tool_workers(self) -> None:
        deadline = time.monotonic() + 10.0
        while time.monotonic() < deadline and any(
            thread.name == "omp-rpc-host-tool:slow" for thread in threading.enumerate()
        ):
            time.sleep(0.01)

    def test_a_host_tool_stopped_during_its_decoder_does_not_execute(self) -> None:
        decoding, release = threading.Event(), threading.Event()
        self.addCleanup(release.set)
        ran: list[bool] = []

        def decode(arguments: Any) -> Any:
            decoding.set()
            release.wait(20.0)
            return arguments

        client = self._decoding_tool(decode, ran)
        client.start()
        client.request_raw("tool")
        self.assertTrue(decoding.wait(10.0), "the decoder never ran")
        self.assertIs(client.stop(), True)
        release.set()
        self._join_tool_workers()
        self.assertEqual(ran, [], "the stopped child's tool executed")

    def test_a_host_tool_whose_decoder_restarts_the_client_does_not_execute(self) -> None:
        ran: list[bool] = []
        holder: list[RpcClient] = []

        def decode(arguments: Any) -> Any:
            holder[0].stop()
            holder[0].start()
            return arguments

        client = self._decoding_tool(decode, ran)
        holder.append(client)
        client.start()
        try:
            client.request_raw("tool")
        except RpcProcessExitError:
            pass  # the decoder stopped the client while the request waited
        self._join_tool_workers()
        self.assertEqual(client.request_raw("barrier"), {})
        self.assertEqual(ran, [], "the replaced child's tool executed")

    def test_every_late_answer_to_an_old_dialog_is_dropped(self) -> None:
        client = self._client()
        client.start()
        client.request_raw("uis")
        request = client.next_ui_request(timeout=5.0)
        self.assertIs(client.stop(), True)
        client.start()
        client.send_ui_confirmation(request.id, True)
        client.send_ui_confirmation(request.id, False)
        self.assertEqual(client.request_raw("barrier"), {})
        self.assertEqual(self._received(), [], "a late answer reached a child that never asked")

    def test_answered_cancelled_and_old_dialogs_hold_no_state(self) -> None:
        client = self._client()
        for _ in range(3):
            client.start()
            client.request_raw("uis", count=20, cancel=True)  # each dialog cancelled again
            client.request_raw("uis", count=5)
            self.assertEqual(len(client._pending_ui_ids), 5, "cancelled dialogs stayed open")
            self.assertIs(client.stop(), True)
            self.assertEqual(len(client._pending_ui_ids), 0, "a stopped child's dialogs stayed open")

    def test_a_local_prompt_does_not_return_the_restarted_childs_events(self) -> None:
        client = self._client()
        client.start()
        answered, release = threading.Event(), threading.Event()
        self.addCleanup(release.set)
        real_request = client._request_with_id

        def request(kind: str, *args: Any, **kwargs: Any) -> Any:
            data = real_request(kind, *args, **kwargs)
            if kind == "prompt":
                # The first child answered `agentInvoked: false`; the client
                # restarts before the prompt collects its events.
                answered.set()
                release.wait(20.0)
            return data

        client._request_with_id = request  # type: ignore[method-assign]
        outcome: list[BaseException | list[str]] = []

        def prompt() -> None:
            try:
                turn = client.prompt_and_wait("local command")
                outcome.append([event.type for event in turn.events])
            except BaseException as exc:  # noqa: BLE001
                outcome.append(exc)

        prompter = threading.Thread(target=prompt, daemon=True)
        prompter.start()
        self.assertTrue(answered.wait(10.0), "the prompt was never answered")
        self.assertIs(client.stop(), True)
        client.start()
        client.request_raw("event")  # the new child emits agent_start
        release.set()
        prompter.join(20.0)
        self.assertFalse(prompter.is_alive())
        self.assertEqual(len(outcome), 1)
        self.assertIsInstance(
            outcome[0], RpcProcessExitError, f"the old prompt returned {outcome[0]!r}"
        )


# A fake server for the call-binding tests. It logs every command it gets, with
# its pid, to LOG, and answers the commands the tests send. With V2 it offers
# protocol v2 and pages messages two at a time.
BINDING_SERVER = textwrap.dedent(
    """
    import json, os, sys
    ready = {"type": "ready"}
    if V2:
        ready.update(supportedProtocolVersions=[1, 2], maxFrameBytes=MAX_FRAME,
                     maxReassembledFrameBytes=MAX_REASSEMBLED)
    print(json.dumps(ready), flush=True)
    message = {"role": "user", "content": [{"type": "text", "text": "hi"}], "timestamp": 1}
    state = {"isSettled": False, "isStreaming": False, "isCompacting": False,
             "steeringMode": "all", "followUpMode": "all", "sessionId": "probe",
             "autoCompactionEnabled": False, "messageCount": 0, "queuedMessageCount": 0}
    for line in sys.stdin:
        command = json.loads(line)
        kind = command["type"]
        with open(LOG, "a") as f:
            f.write(json.dumps({"pid": os.getpid(), "frame": command}) + "\\n")
        if kind.startswith("host_"):
            continue
        if kind == "unknown_tool":
            # No response: the frame this sends ends the client's reader, and
            # a write after that would fail on the closed pipe.
            print(json.dumps({"type": "host_tool_call", "id": "unknown", "toolName": "nope",
                              "toolCallId": "unknown", "arguments": {}}), flush=True)
            continue
        if kind == "break_reader":
            # A line that is not JSON: the client's reader fails on it and
            # ends, while this server goes on reading.
            print("not json", flush=True)
            continue
        if kind == "slow":
            continue  # never answered
        if kind == "bad_slow":
            # An error for a `slow` request no request of this server awaits.
            print(json.dumps({"type": "response", "id": "absent", "command": "slow",
                              "success": False, "error": "new child failure"}), flush=True)
        if kind == "bad_async":
            # An error response no request awaits: the client records it as an
            # async error of its prompts.
            print(json.dumps({"type": "response", "id": "absent", "command": "prompt",
                              "success": False, "error": "new child async failure"}),
                  flush=True)
        data = {}
        if kind == "negotiate_protocol":
            data = {"protocolVersion": 2}
        elif kind in ("prompt", "abort_and_prompt"):
            # "live" starts a run (its prompt_result never comes); anything
            # else is handled locally.
            data = {"agentInvoked": command.get("message") == "live"}
        elif kind == "get_state":
            data = state
        elif kind == "get_messages_page":
            first = command.get("cursor") is None
            data = {"messages": [message], "totalMessages": 2,
                    "nextCursor": "two" if first else None}
        elif kind == "set_host_tools":
            data = {"toolNames": [tool["name"] for tool in command["tools"]]}
        elif kind == "set_host_uri_schemes":
            data = {"schemes": [uri["scheme"] for uri in command["schemes"]]}
        print(json.dumps({"type": "response", "id": command["id"], "command": kind,
                          "success": True, "data": data}), flush=True)
    """
)


@unittest.skipUnless(hasattr(os, "killpg"), "POSIX process groups only")
class CallBindingTests(unittest.TestCase):
    """A call acts only on the child it began for: once that child is stopped
    or replaced, the call neither sends to the new child nor changes the
    client's state for it."""

    def setUp(self) -> None:
        work = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, work, ignore_errors=True)
        self.log = os.path.join(work, "received")

    def _client(self, *, v2: bool = False, **options: Any) -> RpcClient:
        prelude = (
            f"LOG = {self.log!r}\nV2 = {v2!r}\n"
            f"MAX_FRAME = {client_module._MAX_RPC_FRAME_BYTES!r}\n"
            f"MAX_REASSEMBLED = {client_module._MAX_RPC_REASSEMBLED_BYTES!r}\n"
        )
        client = RpcClient(
            command=[sys.executable, "-u", "-c", prelude + BINDING_SERVER],
            startup_timeout=15.0,
            request_timeout=10.0,
            **options,
        )
        self.addCleanup(client.stop)
        return client

    def _received(self, pid: int, kind: str) -> list[dict[str, Any]]:
        try:
            with open(self.log, encoding="utf-8") as f:
                records = [json.loads(line) for line in f]
        except FileNotFoundError:
            return []
        return [r["frame"] for r in records if r["pid"] == pid and r["frame"]["type"] == kind]

    def _across_restart(
        self,
        client: RpcClient,
        call: Callable[[], object],
        pause_on: Callable[[str, Mapping[str, Any]], bool],
    ) -> tuple[int, BaseException | object]:
        """Run `call` on another thread, hold it just before it sends the
        request `pause_on` picks, stop and restart the client, then let the
        call go on. Returns the new child's pid and the call's outcome."""
        held, release = threading.Event(), threading.Event()
        self.addCleanup(release.set)
        real = client._request_data

        def request(kind: str, request_id: str, payload: Mapping[str, Any], **kwargs: Any) -> Any:
            if threading.current_thread().name == "old-call" and pause_on(kind, payload):
                held.set()
                release.wait(20.0)
            return real(kind, request_id, payload, **kwargs)

        client._request_data = request  # type: ignore[method-assign]
        outcome: list[BaseException | object] = []

        def run() -> None:
            try:
                outcome.append(call())
            except BaseException as exc:  # noqa: BLE001
                outcome.append(exc)

        caller = threading.Thread(target=run, name="old-call", daemon=True)
        caller.start()
        self.assertTrue(held.wait(20.0), "the call never reached its request")
        self.assertIs(client.stop(), True)
        client.start()
        assert client._process is not None
        new_pid = client._process.pid
        release.set()
        caller.join(20.0)
        self.assertFalse(caller.is_alive(), "the call never returned")
        client.request_raw("barrier")  # every frame sent so far has reached the server
        self.assertEqual(len(outcome), 1)
        return new_pid, outcome[0]

    def test_a_prompt_that_began_for_the_stopped_child_is_not_sent_to_the_new_one(self) -> None:
        client = self._client()
        client.start()
        new_pid, outcome = self._across_restart(
            client, lambda: client.prompt_and_wait("belongs to the old child"),
            lambda kind, _payload: kind == "prompt",
        )
        self.assertIsInstance(outcome, RpcProcessExitError, f"the old prompt ended with {outcome!r}")
        self.assertEqual(self._received(new_pid, "prompt"), [], "the old prompt reached the new child")

    def test_a_settled_wait_does_not_query_the_new_child(self) -> None:
        client = self._client()
        client.start()
        new_pid, outcome = self._across_restart(
            client, lambda: client.wait_for_settled(timeout=5.0),
            lambda kind, _payload: kind == "get_state",
        )
        self.assertIsInstance(outcome, RpcProcessExitError, f"the old wait ended with {outcome!r}")
        self.assertEqual(self._received(new_pid, "get_state"), [], "the old wait queried the new child")

    def test_message_pages_all_come_from_the_child_the_call_began_for(self) -> None:
        client = self._client(v2=True)
        client.start()
        new_pid, outcome = self._across_restart(
            client, client.get_messages,
            lambda kind, payload: kind == "get_messages_page" and payload.get("cursor") is not None,
        )
        self.assertIsInstance(outcome, RpcProcessExitError, f"get_messages() ended with {outcome!r}")
        self.assertEqual(
            self._received(new_pid, "get_messages_page"), [], "a page came from the new child"
        )

    def test_a_registration_that_began_for_the_stopped_child_is_not_sent_to_the_new_one(
        self,
    ) -> None:
        def handler(_argument: object, _context: Any) -> str:
            return "ran"

        tools = (host_tool(name="mine", description="probe",
                           parameters={"type": "object", "properties": {}}, execute=handler),)
        uris = (host_uri(scheme="mine", read=handler),)
        for kind, register, command in (
            ("tool", lambda client: client.set_custom_tools(tools), "set_host_tools"),
            ("uri", lambda client: client.set_host_uris(uris), "set_host_uri_schemes"),
        ):
            with self.subTest(kind):
                client = self._client()
                client.start()
                new_pid, outcome = self._across_restart(
                    client, lambda: register(client), lambda sent, _payload: sent == command
                )
                self.assertIsInstance(outcome, RpcProcessExitError, f"the call ended with {outcome!r}")
                # The new child's own start() registered the set once.
                self.assertEqual(
                    len(self._received(new_pid, command)), 1,
                    "the registration of the stopped child reached the new child",
                )
                client.stop()

    def test_an_old_start_does_not_replace_the_new_childs_host_handlers(self) -> None:
        # The red run of this race is the review's own probe against the head
        # before the fix, where the start path called the public setter.
        def handler(name: str) -> Callable[[object, Any], str]:
            return lambda _argument, _context: name

        old_tools = (host_tool(name="old_tool", description="old",
                               parameters={"type": "object", "properties": {}},
                               execute=handler("old")),)
        new_tools = (host_tool(name="new_tool", description="new",
                               parameters={"type": "object", "properties": {}},
                               execute=handler("new")),)
        old_uris = (host_uri(scheme="old", read=handler("old")),)
        new_uris = (host_uri(scheme="new", read=handler("new")),)
        for kind, step, setter, attribute, command, old, new in (
            ("tool", "_register_host_tools", "set_custom_tools", "_custom_tools",
             "set_host_tools", old_tools, new_tools),
            ("uri", "_register_host_uris", "set_host_uris", "_host_uris",
             "set_host_uri_schemes", old_uris, new_uris),
        ):
            with self.subTest(kind):
                client = self._client(**{"custom_tools" if kind == "tool" else "host_uris": old})
                held, release = threading.Event(), threading.Event()
                self.addCleanup(release.set)
                real_step = getattr(client, step)

                def paused(value: Any, real_step: Any = real_step,
                           held: threading.Event = held, release: threading.Event = release) -> Any:
                    if threading.current_thread().name == "old-start":
                        held.set()
                        release.wait(20.0)
                    return real_step(value)

                setattr(client, step, paused)
                outcome: list[BaseException | str] = []

                def start(client: RpcClient = client, outcome: list[Any] = outcome) -> None:
                    try:
                        client.start()
                        outcome.append("returned")
                    except BaseException as exc:  # noqa: BLE001
                        outcome.append(exc)

                starter = threading.Thread(target=start, name="old-start", daemon=True)
                starter.start()
                self.assertTrue(held.wait(20.0), "the first start() never registered")
                self.assertIs(client.stop(), True)
                getattr(client, setter)(new)  # while stopped: the registry only
                client.start()
                assert client._process is not None
                new_pid = client._process.pid
                release.set()
                starter.join(20.0)
                self.assertFalse(starter.is_alive(), "the first start() never returned")
                client.request_raw("barrier")
                self.assertEqual(outcome, ["returned"])
                self.assertEqual(getattr(client, attribute), new, "the old start replaced the registry")
                sent = self._received(new_pid, command)
                self.assertEqual(len(sent), 1, f"registrations the new child got: {sent}")
                self.assertNotIn("old", json.dumps(sent[0]), "the new child got the old handlers")
                client.stop()

    def test_a_prompt_tracked_for_the_stopped_child_is_not_sent_to_the_new_one(self) -> None:
        # The prompt is tracked for the first child, which is then replaced
        # (start() resets the tracking) before the prompt is sent. It must not
        # reach the new child, where nothing would track it.
        for method in ("prompt", "abort_and_prompt"):
            with self.subTest(method):
                client = self._client()
                client.start()
                new_pid, outcome = self._across_restart(
                    client, lambda: getattr(client, method)("live"),
                    lambda kind, _payload, method=method: kind == method,
                )
                self.assertIsInstance(outcome, RpcProcessExitError, f"{method}() ended with {outcome!r}")
                self.assertEqual(self._received(new_pid, method), [], "the prompt reached the new child")
                self.assertEqual(client._pending_prompt_ids, set())
                client.stop()

    def test_an_old_prompt_does_not_move_the_new_childs_error_checkpoint(self) -> None:
        # A prompt_and_wait() that began for the first child resumes after the
        # restart: it must leave the new child's prompt tracking alone, so an
        # async error of the new child still fails wait_for_idle().
        client = self._client()
        client.start()
        held, release = threading.Event(), threading.Event()
        self.addCleanup(release.set)
        real = client._submit_prompt

        def submit(*args: Any, **kwargs: Any) -> bool:
            if threading.current_thread().name == "old-call":
                held.set()
                release.wait(20.0)
            return real(*args, **kwargs)

        client._submit_prompt = submit  # type: ignore[method-assign]
        outcome: list[BaseException | str] = []

        def run() -> None:
            try:
                client.prompt_and_wait("old")
                outcome.append("returned")
            except BaseException as exc:  # noqa: BLE001
                outcome.append(exc)

        caller = threading.Thread(target=run, name="old-call", daemon=True)
        caller.start()
        self.assertTrue(held.wait(20.0), "the old prompt never reached its submission")
        self.assertIs(client.stop(), True)
        client.start()
        client.request_raw("bad_async")
        client.request_raw("barrier")  # the new child's async error is recorded
        before = client._last_schedule_async_error_index
        release.set()
        caller.join(20.0)
        self.assertFalse(caller.is_alive(), "the old prompt never returned")
        self.assertEqual(len(outcome), 1)
        self.assertIsInstance(outcome[0], RpcProcessExitError, f"the old prompt ended with {outcome[0]!r}")
        self.assertEqual(
            client._last_schedule_async_error_index, before,
            "the old prompt moved the new child's error checkpoint",
        )
        with self.assertRaises(RpcCommandError):
            client.wait_for_idle(timeout=0.5)

    def test_a_request_of_a_stopped_child_cannot_take_the_new_childs_error(self) -> None:
        # The reader has failed and marked the client closed, but the child
        # still reads: a request made then is written and never answered.
        # stop() must fail it, so it is not left among the new child's
        # requests, where the new child's error would resolve it.
        client = self._client()
        client.start()
        process = client._process
        reader = client._stdout_thread
        assert process is not None and reader is not None
        client._write_json(process, {"type": "break_reader", "id": "break"})
        reader.join(10.0)
        self.assertFalse(reader.is_alive(), "the bad frame did not end the reader")
        outcome: list[BaseException | object] = []
        sent = threading.Event()
        real_write = client._write_json

        def write(child: Any, payload: Any) -> None:
            real_write(child, payload)
            if payload.get("type") == "slow":
                sent.set()

        client._write_json = write  # type: ignore[method-assign]

        def call() -> None:
            try:
                outcome.append(client.request_raw("slow"))
            except BaseException as exc:  # noqa: BLE001
                outcome.append(exc)

        caller = threading.Thread(target=call, daemon=True)
        caller.start()
        self.assertTrue(sent.wait(10.0), "the request was never written")
        self.assertIs(client.stop(), True)
        caller.join(5.0)
        stopped_in_time = not caller.is_alive()
        client.start()
        client.request_raw("bad_slow")  # the new child's error for a `slow` request
        client.request_raw("barrier")
        caller.join(15.0)
        self.assertTrue(stopped_in_time, "stop() did not end the old child's request")
        self.assertEqual(len(outcome), 1)
        self.assertIsInstance(outcome[0], RpcProcessExitError, f"the old request ended with {outcome[0]!r}")
        self.assertEqual(
            [error.remote_error for error in client.protocol_errors], ["new child failure"],
            "the new child's error did not reach the new client",
        )

    def test_an_old_prompt_does_not_open_a_result_slot_for_the_new_child(self) -> None:
        client = self._client()
        client.start()
        bound, release_bound = threading.Event(), threading.Event()
        submitting, release_submit = threading.Event(), threading.Event()
        for event in (release_bound, release_submit):
            self.addCleanup(event.set)
        real_bound = client._bound_to_child
        real_submit = client._submit_prompt

        @contextlib.contextmanager
        def bound_to_child() -> Iterator[int]:
            with real_bound() as generation:
                if threading.current_thread().name == "old-call":
                    bound.set()
                    release_bound.wait(20.0)
                yield generation

        def submit(*args: Any, **kwargs: Any) -> bool:
            if threading.current_thread().name == "old-call":
                submitting.set()
                release_submit.wait(20.0)
            return real_submit(*args, **kwargs)

        client._bound_to_child = bound_to_child  # type: ignore[method-assign]
        client._submit_prompt = submit  # type: ignore[method-assign]
        outcome: list[BaseException | str] = []

        def run() -> None:
            try:
                client.prompt_and_wait("old")
                outcome.append("returned")
            except BaseException as exc:  # noqa: BLE001
                outcome.append(exc)

        caller = threading.Thread(target=run, name="old-call", daemon=True)
        caller.start()
        self.assertTrue(bound.wait(20.0), "the old prompt never bound to its child")
        self.assertIs(client.stop(), True)
        client.start()
        release_bound.set()
        self.assertTrue(submitting.wait(20.0), "the old prompt never reached its submission")
        with client._event_condition:
            slots = dict(client._prompt_results)
        release_submit.set()
        caller.join(20.0)
        self.assertFalse(caller.is_alive(), "the old prompt never returned")
        self.assertEqual(slots, {}, "the old prompt opened a result slot in the new client")
        self.assertEqual(len(outcome), 1)
        self.assertIsInstance(outcome[0], RpcProcessExitError, f"the old prompt ended with {outcome[0]!r}")

    def test_a_request_is_registered_only_together_with_its_child_check(self) -> None:
        # A request checks its child and records its pending entry in one
        # step under the lock a restart takes. Where the two steps are apart,
        # a restart between them puts the old request among the new child's,
        # where the new child's error for the same command resolves it.
        client = self._client()
        client.start()
        reached, release_checked = threading.Event(), threading.Event()
        writing, release_write = threading.Event(), threading.Event()
        for event in (release_checked, release_write):
            self.addCleanup(event.set)
        real_require = client._require_process
        real_write = client._write_json

        def require() -> Any:
            child = real_require()
            # Pause only where the lock is not held: there the child is checked
            # but the request not yet recorded. Under the lock a restart cannot
            # come in between, and a pause there would only hold up stop().
            if threading.current_thread().name == "old-call" and not client._dispatch_lock._is_owned():
                reached.set()
                release_checked.wait(20.0)
            return child

        def write(child: Any, payload: Any) -> None:
            if threading.current_thread().name == "old-call":
                # Recorded, not yet written: the request's child is retired now.
                writing.set()
                reached.set()
                release_write.wait(20.0)
            real_write(child, payload)

        client._require_process = require  # type: ignore[method-assign]
        client._write_json = write  # type: ignore[method-assign]
        outcome: list[BaseException | object] = []

        def call() -> None:
            try:
                outcome.append(client.request_raw("slow"))
            except BaseException as exc:  # noqa: BLE001
                outcome.append(exc)

        caller = threading.Thread(target=call, name="old-call", daemon=True)
        caller.start()
        self.assertTrue(reached.wait(20.0), "the request never reached its child check")
        self.assertIs(client.stop(), True)
        client.start()
        release_checked.set()
        self.assertTrue(writing.wait(20.0), "the request was never recorded")
        with client._state_lock:
            stale = {request_id: entry.command for request_id, entry in client._pending.items()}
        client.request_raw("bad_slow")  # the new child's error for a `slow` request
        client.request_raw("barrier")
        release_write.set()
        caller.join(20.0)
        self.assertFalse(caller.is_alive(), "the old request never ended")
        self.assertEqual(stale, {}, "the old request was recorded among the new child's")
        self.assertEqual(
            [error.remote_error for error in client.protocol_errors], ["new child failure"],
            "the new child's error did not reach the new client",
        )
        self.assertEqual(len(outcome), 1)
        self.assertIsInstance(outcome[0], RpcProcessExitError, f"the old request ended with {outcome[0]!r}")

    def test_a_reply_queued_by_a_frame_that_raises_is_sent(self) -> None:
        client = self._client()
        real = client._handle_host_tool_call

        def handle_then_raise(payload: Any, process: Any) -> None:
            real(payload, process)  # refuses the unknown tool: a reply is queued
            raise RuntimeError("the frame fails after queueing its reply")

        client._handle_host_tool_call = handle_then_raise  # type: ignore[method-assign]
        client.start()
        process = client._process
        assert process is not None
        reader = client._stdout_thread
        assert reader is not None
        client._write_json(process, {"type": "unknown_tool", "id": "trigger"})
        reader.join(10.0)
        self.assertFalse(reader.is_alive(), "the failing frame did not end the reader")
        deadline = time.monotonic() + 10.0
        while not self._received(process.pid, "host_tool_result") and time.monotonic() < deadline:
            time.sleep(0.02)
        self.assertEqual(
            [frame["id"] for frame in self._received(process.pid, "host_tool_result")],
            ["unknown"],
            "the refusal the frame queued was never sent",
        )


@unittest.skipUnless(os.name == "posix", "the polled stdin write is POSIX-only")
class PolledStdinWriteTests(unittest.TestCase):
    def test_a_large_write_works_on_a_descriptor_above_1023(self) -> None:
        # A busy host has more than 1024 descriptors open; the child's stdin
        # then gets a number select() cannot take.
        import resource

        soft, hard = resource.getrlimit(resource.RLIMIT_NOFILE)
        if soft < 1200:
            if hard != resource.RLIM_INFINITY and hard < 1200:
                self.skipTest("cannot open 1200 descriptors")
            resource.setrlimit(resource.RLIMIT_NOFILE, (1200, hard))
            self.addCleanup(resource.setrlimit, resource.RLIMIT_NOFILE, (soft, hard))
        null = os.open(os.devnull, os.O_RDONLY)
        fillers = [null]
        self.addCleanup(lambda: [os.close(fd) for fd in fillers])
        while fillers[-1] < 1100:
            fillers.append(os.dup(null))
        server = textwrap.dedent(
            """
            import json, sys
            print(json.dumps({"type": "ready"}), flush=True)
            for line in sys.stdin:
                command = json.loads(line)
                print(json.dumps({"type": "response", "id": command["id"],
                                  "command": command["type"], "success": True,
                                  "data": {"size": len(command.get("pad", ""))}}),
                      flush=True)
            """
        )
        client = RpcClient(
            command=[sys.executable, "-u", "-c", server],
            startup_timeout=10.0,
            request_timeout=20.0,
        )
        self.addCleanup(client.stop)
        client.start()
        assert client._process is not None and client._process.stdin is not None
        self.assertGreater(client._process.stdin.fileno(), 1023)
        # Far more than a pipe holds, so the write must wait for room.
        self.assertEqual(client.request_raw("echo", pad="x" * (1 << 20)), {"size": 1 << 20})


if __name__ == "__main__":
    unittest.main()
