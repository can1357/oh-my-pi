from __future__ import annotations

import base64
import json
import os
import shutil
import signal
import sys
import tempfile
import textwrap
import threading
import time
import unittest

from omp_rpc import (
    AgentEndEvent,
    RpcClient,
    RpcCommandError,
    RpcConcurrencyError,
    RpcError,
    host_tool,
)
from omp_rpc.client import _RpcFrameDecoder


FAKE_SERVER = textwrap.dedent(
    """
    import json
    import sys
    import time

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

    def current_state():
        return {
            "model": model_info(model_id, model_provider),
            "thinkingLevel": thinking_level,
            "isStreaming": False,
            "isCompacting": False,
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
            "queuedMessageCount": 0,
            "todoPhases": todo_phases,
            "dumpTools": [{"name": "read", "description": "Read files", "parameters": {"type": "object"}}] + registered_host_tools,
        }

    def emit_prompt_turn(
        text: str,
        delay: float = 0.0,
        include_extra_events: bool = False,
        compact_terminal: bool = False,
    ):
        global last_assistant_text, messages
        print(json.dumps({"type": "agent_start"}), flush=True)
        print(json.dumps({"type": "turn_start"}), flush=True)
        partial = assistant_message("")
        print(json.dumps({"type": "message_start", "message": partial}), flush=True)
        print(
            json.dumps(
                {
                    "type": "message_update",
                    "message": partial,
                    "assistantMessageEvent": {
                        "type": "text_delta",
                        "contentIndex": 0,
                        "delta": text,
                        "partial": partial,
                    },
                }
            ),
            flush=True,
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
        print(json.dumps({"type": "message_end", "message": assistant}), flush=True)
        print(json.dumps({"type": "turn_end", "message": assistant, "toolResults": []}), flush=True)
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
            print(json.dumps({"type": "agent_end", "messages": [assistant]}), flush=True)
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

    for raw_line in sys.stdin:
        raw_line = raw_line.strip()
        if not raw_line:
            continue

        command = json.loads(raw_line)
        command_type = command["type"]
        request_id = command.get("id")

        if command_type == "extension_ui_response":
            emit_prompt_turn("ui acknowledged")
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
        elif command_type == "switch_session":
            respond(request_id, "switch_session", {"cancelled": False})
        elif command_type == "branch":
            branch_messages = [{"entryId": command["entryId"], "text": "branch message"}]
            respond(request_id, "branch", {"text": "branch created", "cancelled": False})
        elif command_type == "get_branch_messages":
            respond(request_id, "get_branch_messages", {"messages": branch_messages})
        elif command_type == "get_last_assistant_text":
            respond(request_id, "get_last_assistant_text", {"text": last_assistant_text})
        elif command_type == "set_session_name":
            session_name = command["name"]
            respond(request_id, "set_session_name", {})
        elif command_type in {"steer", "follow_up", "abort"}:
            respond(request_id, command_type, {})
        elif command_type in {"prompt", "abort_and_prompt"}:
            respond(request_id, command_type, {})
            message = command["message"]
            if message == "needs ui":
                print(json.dumps({"type": "extension_ui_request", "id": "ui-1", "method": "input", "title": "Need input", "placeholder": "value"}), flush=True)
                continue
            if message == "needs confirm":
                print(json.dumps({"type": "extension_ui_request", "id": "ui-2", "method": "confirm", "title": "Confirm", "message": "Continue?"}), flush=True)
                continue
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
            if message == "notifications":
                print(json.dumps({"type": "extension_error", "extensionPath": "/tmp/ext.py", "event": "run", "error": "boom"}), flush=True)
                print(json.dumps({"type": "unknown_future_event", "value": 1}), flush=True)
            emit_prompt_turn(
                "pong",
                delay=0.3 if message == "slow" else 0.0,
                include_extra_events=message == "all events",
                compact_terminal=message == "compacted turn",
            )
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
    """
)


class RpcClientTests(unittest.TestCase):
    def make_client(self, server: str = FAKE_SERVER, **kwargs: object) -> RpcClient:
        return RpcClient(
            command=[sys.executable, "-u", "-c", server],
            startup_timeout=2.0,
            request_timeout=2.0,
            **kwargs,
        )

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
    # Read one line (the prompt) and acknowledge it, then never emit agent_end.
    # The client's prompt_and_wait should sit in _wait_for_agent_end forever
    # unless stop() unblocks it.
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
    """Regression: stop() must wake `_wait_for_agent_end` immediately.

    Previously, the stdout reader's "if not self._stopping:" guard caused
    `_mark_closed` to be skipped after stop(), so `_closed_error` stayed
    `None` and `_wait_for_agent_end` blocked on its condition variable until
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
                    with open({pid_file!r}, "w") as f:
                        f.write(str(os.getpid()))
                    while True:
                        with open({beat_file!r}, "w") as f:
                            f.write(str(time.time()))
                        time.sleep(0.02)
                    """
                )
            )

        def _reap_leaked_grandchild() -> None:
            try:
                with open(pid_file, encoding="utf-8") as f:
                    os.kill(int(f.read()), signal.SIGKILL)
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


if __name__ == "__main__":
    unittest.main()
