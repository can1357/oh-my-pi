"""Consumer-visible boundary for `RpcClient.max_event_history`.

The reported failure is `RpcClient._check_event_history()` raising "Event
history limit was exceeded" once the ring buffer evicted events from the start
of a long `review_pr` prompt, aborting the review. These tests pin the
boundary through the real client (not the `_FakeRpcClient` recording stand-in):
a prompt that streams more events than the configured cap fails with the exact
overflow error, while the same prompt under a higher configured cap completes.
"""

from __future__ import annotations

import sys
import textwrap

import pytest

from omp_rpc import (
    AgentEndEvent,
    MessageUpdateEvent,
    PromptResultEvent,
    RpcClient,
    RpcError,
)

# Streamed `message_update` frames per prompt. Must sit between the two caps
# under test: more than the 1000 minimum (overflow) and fewer than 100_000
# (completes). 50k is deliberate — it is the event count the former hardcoded
# 50k limit failed at, so the completing branch proves the configurable cap
# is what changed, not the prompt size.
_FLOOD_COUNT = 50_000
# Smallest prompt that overflows a 2-slot ring buffer: agent_start,
# turn_start, message_start, then one message_update.
_MINIMUM_CAP_FLOOD_COUNT = 1


def _flood_server(flood_count: int) -> str:
    """Subprocess RPC server that floods `message_update` frames on "flood".

    The client under test is the real `RpcClient` against this real server, so
    the ring-buffer eviction happens inside the client exactly as in
    production — the `_FakeRpcClient` recording stand-in cannot observe it.
    """
    return textwrap.dedent(
        f"""
        import json
        import sys

        def usage():
            return {{"input": 1, "output": 1, "cacheRead": 0, "cacheWrite": 0, "totalTokens": 2}}

        def assistant_message():
            return {{
                "role": "assistant",
                "content": [{{"type": "text", "text": ""}}],
                "api": "anthropic-messages",
                "provider": "anthropic",
                "model": "claude-sonnet-4-5",
                "usage": usage(),
                "stopReason": "stop",
                "timestamp": 1,
            }}

        print(json.dumps({{"type": "ready"}}), flush=True)

        for raw_line in sys.stdin:
            raw_line = raw_line.strip()
            if not raw_line:
                continue
            command = json.loads(raw_line)
            command_type = command["type"]
            request_id = command.get("id")

            if command_type in {{"prompt", "abort_and_prompt"}}:
                message = command["message"]
                print(json.dumps({{"id": request_id, "type": "response", "command": command_type, "success": True, "data": None}}), flush=True)
                if message == "flood":
                    partial = assistant_message()
                    message_id = "msg-flood"
                    print(json.dumps({{"type": "agent_start"}}), flush=True)
                    print(json.dumps({{"type": "turn_start"}}), flush=True)
                    print(json.dumps({{"type": "message_start", "message": partial, "messageId": message_id}}), flush=True)
                    for i in range({flood_count}):
                        print(
                            json.dumps(
                                {{
                                    "type": "message_update",
                                    "message": partial,
                                    "messageId": message_id,
                                    "assistantMessageEvent": {{"type": "text_delta", "contentIndex": 0, "delta": "x", "partial": partial}},
                                }}
                            ),
                            flush=True,
                        )
                    finished = assistant_message()
                    finished["content"] = [{{"type": "text", "text": "done"}}]
                    print(json.dumps({{"type": "message_end", "message": finished, "messageId": message_id}}), flush=True)
                    print(json.dumps({{"type": "turn_end", "message": finished, "toolResults": []}}), flush=True)
                    print(json.dumps({{"type": "agent_end", "messages": [finished]}}), flush=True)
                    print(
                        json.dumps(
                            {{
                                "type": "prompt_result",
                                "id": request_id,
                                "agentInvoked": True,
                                "status": "completed",
                                "sessionSettled": True,
                            }}
                        ),
                        flush=True,
                    )
            else:
                print(json.dumps({{"id": request_id, "type": "response", "command": command_type, "success": True, "data": None}}), flush=True)
        """
    )


def _make_client(max_event_history: int, flood_count: int) -> RpcClient:
    return RpcClient(
        command=[sys.executable, "-u", "-c", _flood_server(flood_count)],
        startup_timeout=30.0,
        request_timeout=120.0,
        max_event_history=max_event_history,
    )


def test_long_prompt_overflows_small_event_history() -> None:
    """A prompt streaming more events than the configured cap fails with the exact
    overflow `RpcError` — the failure mode that aborted `review_pr` on large PRs."""
    client = _make_client(max_event_history=1000, flood_count=_FLOOD_COUNT)
    try:
        client.start()
        with pytest.raises(RpcError, match="Event history limit was exceeded") as excinfo:
            client.prompt_and_wait("flood", timeout=120.0)
        assert "max_event_history" in str(excinfo.value)
    finally:
        client.stop()


def test_long_prompt_completes_under_higher_event_history() -> None:
    """The same prompt under a higher configured cap completes: the prompt result
    lands and the terminal `agent_end` is observed among the retained events."""
    client = _make_client(max_event_history=100_000, flood_count=_FLOOD_COUNT)
    try:
        client.start()
        turn = client.prompt_and_wait("flood", timeout=120.0)
    finally:
        client.stop()

    assert isinstance(turn.result, PromptResultEvent)
    assert turn.result.status == "completed"
    assert turn.require_assistant_text() == "done"
    assert any(isinstance(event, AgentEndEvent) for event in turn.events)
    assert sum(isinstance(event, MessageUpdateEvent) for event in turn.events) == _FLOOD_COUNT


def test_robomp_minimum_cap_overflows_a_four_event_prompt() -> None:
    """The config floor (ge=1000) is the smallest cap robomp accepts; a prompt
    streaming just four events overflows a 2-slot ring buffer through the real
    client, which distinguishes the configurable limit from the former hardcoded 50k."""
    client = _make_client(max_event_history=2, flood_count=_MINIMUM_CAP_FLOOD_COUNT)
    try:
        client.start()
        with pytest.raises(RpcError, match="Event history limit was exceeded"):
            client.prompt_and_wait("flood", timeout=30.0)
    finally:
        client.stop()
