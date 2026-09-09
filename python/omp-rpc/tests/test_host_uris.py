from __future__ import annotations

import sys
import textwrap
import time
import unittest

from omp_rpc import RpcClient, host_uri
from omp_rpc.host_uris import normalize_read_result


URI_SERVER = textwrap.dedent(
    """
    import json
    import sys

    print(json.dumps({"type": "ready"}), flush=True)

    pending_uri_id = 1

    def respond(request_id, command, data=None, success=True, error=None):
        frame = {"id": request_id, "type": "response", "command": command, "success": success}
        if success:
            if data is not None:
                frame["data"] = data
        else:
            frame["error"] = error or "error"
        print(json.dumps(frame), flush=True)

    for raw_line in sys.stdin:
        raw_line = raw_line.strip()
        if not raw_line:
            continue
        command = json.loads(raw_line)
        command_type = command.get("type")
        request_id = command.get("id")

        if command_type == "set_host_uri_schemes":
            schemes = command.get("schemes", [])
            respond(
                request_id,
                "set_host_uri_schemes",
                {"schemes": [entry.get("scheme", "") for entry in schemes]},
            )
        elif command_type == "trigger_read":
            print(
                json.dumps(
                    {
                        "type": "host_uri_request",
                        "id": f"uri-req-{pending_uri_id}",
                        "operation": "read",
                        "url": command["url"],
                    }
                ),
                flush=True,
            )
            pending_uri_id += 1
            respond(request_id, "trigger_read", {})
        elif command_type == "trigger_write":
            print(
                json.dumps(
                    {
                        "type": "host_uri_request",
                        "id": f"uri-req-{pending_uri_id}",
                        "operation": "write",
                        "url": command["url"],
                        "content": command["content"],
                    }
                ),
                flush=True,
            )
            pending_uri_id += 1
            respond(request_id, "trigger_write", {})
        elif command_type == "host_uri_result":
            # Re-emit the host_uri_result frame as an unknown notification
            # so the test can capture it through on_unknown_notification.
            print(
                json.dumps(
                    {
                        "type": "uri_echo",
                        "frame": command,
                    }
                ),
                flush=True,
            )
        else:
            respond(request_id, command_type, success=False, error=f"unsupported: {command_type}")
    """
)


class HostUriHelperTests(unittest.TestCase):
    def test_normalize_read_result_accepts_string(self) -> None:
        self.assertEqual(normalize_read_result("hello"), {"content": "hello"})

    def test_normalize_read_result_accepts_full_mapping(self) -> None:
        result = normalize_read_result(
            {
                "content": "body",
                "content_type": "application/json",
                "notes": ["fresh"],
                "immutable": True,
            }
        )
        self.assertEqual(result["content"], "body")
        self.assertEqual(result["contentType"], "application/json")
        self.assertEqual(result["notes"], ["fresh"])
        self.assertTrue(result["immutable"])

    def test_normalize_read_result_requires_content(self) -> None:
        with self.assertRaises(ValueError):
            normalize_read_result({"content_type": "text/plain"})  # type: ignore[arg-type]

    def test_normalize_read_result_rejects_invalid_content_type(self) -> None:
        with self.assertRaises(ValueError):
            normalize_read_result(
                {"content": "x", "content_type": "application/octet-stream"}
            )  # type: ignore[arg-type]

    def test_host_uri_helper_normalizes_scheme(self) -> None:
        uri = host_uri(scheme="  DB  ", read=lambda url, ctx: "x")
        self.assertEqual(uri.scheme, "db")
        self.assertFalse(uri.writable)

        with self.assertRaises(ValueError):
            host_uri(scheme="", read=lambda url, ctx: "x")

    def test_host_uri_writable_when_write_supplied(self) -> None:
        uri = host_uri(
            scheme="db", read=lambda url, ctx: "x", write=lambda url, content, ctx: None
        )
        self.assertTrue(uri.writable)


class RpcHostUriBridgeTests(unittest.TestCase):
    def _make_client(self, **kwargs: object) -> RpcClient:
        client = RpcClient(
            command=[sys.executable, "-u", "-c", URI_SERVER],
            startup_timeout=2.0,
            request_timeout=2.0,
            **kwargs,
        )
        self._attach_capture(client)
        return client

    def test_set_host_uris_registers_schemes_on_start(self) -> None:
        captured: list[tuple[str, str]] = []

        def read_db(url: str, _ctx) -> str:
            captured.append(("read", url))
            return "id=42"

        with self._make_client(
            host_uris=(host_uri(scheme="db", read=read_db, description="test rows"),),
        ) as client:
            # No public list — we exercise the on-start side effect by hitting the wire.
            payload = client._request("trigger_read", url="db://users/42")  # type: ignore[attr-defined]
            self.assertEqual(payload, {})

            frame = self._await_echo(client)
            self.assertEqual(frame["type"], "host_uri_result")
            self.assertEqual(frame["content"], "id=42")
            self.assertEqual(captured, [("read", "db://users/42")])

    def test_read_handler_can_return_structured_result(self) -> None:
        def read_db(_url: str, _ctx):
            return {
                "content": '{"name":"Alice"}',
                "content_type": "application/json",
                "notes": ["row fresh"],
                "immutable": True,
            }

        with self._make_client(
            host_uris=(host_uri(scheme="db", read=read_db),)
        ) as client:
            client._request("trigger_read", url="db://users/42")  # type: ignore[attr-defined]
            frame = self._await_echo(client)
            self.assertEqual(frame["content"], '{"name":"Alice"}')
            self.assertEqual(frame["contentType"], "application/json")
            self.assertEqual(frame["notes"], ["row fresh"])
            self.assertTrue(frame["immutable"])

    def test_write_handler_receives_content_and_succeeds(self) -> None:
        seen: dict[str, str] = {}

        def write_db(url: str, content: str, _ctx) -> None:
            seen[url] = content

        uri = host_uri(scheme="db", read=lambda url, ctx: "ignored", write=write_db)
        with self._make_client(host_uris=(uri,)) as client:
            client._request("trigger_write", url="db://users/42", content="name=Bob")  # type: ignore[attr-defined]
            frame = self._await_echo(client)
            self.assertEqual(frame["type"], "host_uri_result")
            self.assertNotIn("isError", frame)
            self.assertEqual(seen, {"db://users/42": "name=Bob"})

    def test_write_rejected_for_read_only_scheme(self) -> None:
        with self._make_client(
            host_uris=(host_uri(scheme="db", read=lambda url, ctx: "x"),),
        ) as client:
            client._request("trigger_write", url="db://users/42", content="ignored")  # type: ignore[attr-defined]
            frame = self._await_echo(client)
            self.assertTrue(frame.get("isError"))
            self.assertIn("write handler", frame["error"])

    def test_unknown_scheme_is_rejected_with_error(self) -> None:
        with self._make_client(
            host_uris=(host_uri(scheme="db", read=lambda url, ctx: "x"),),
        ) as client:
            client._request("trigger_read", url="other://stuff")  # type: ignore[attr-defined]
            frame = self._await_echo(client)
            self.assertTrue(frame.get("isError"))
            self.assertIn("not registered", frame["error"])

    def test_handler_exception_is_surfaced_as_error(self) -> None:
        def read_db(_url: str, _ctx) -> str:
            raise RuntimeError("boom")

        with self._make_client(
            host_uris=(host_uri(scheme="db", read=read_db),)
        ) as client:
            client._request("trigger_read", url="db://users/42")  # type: ignore[attr-defined]
            frame = self._await_echo(client)
            self.assertTrue(frame.get("isError"))
            self.assertEqual(frame["error"], "boom")

    def _await_echo(self, client: RpcClient) -> dict:
        captured = getattr(client, "_test_uri_echos", None)
        if captured is None:
            self.fail("_capture was not called for this client")
        deadline = time.time() + 2.0
        while time.time() < deadline:
            if captured:
                return captured.pop(0)
            time.sleep(0.02)
        self.fail("Timed out waiting for host_uri_result echo")

    def _attach_capture(self, client: RpcClient) -> None:
        captured: list[dict] = []
        client._test_uri_echos = captured  # type: ignore[attr-defined]

        def on_notification(notification) -> None:
            payload = notification.payload
            if payload.get("type") == "uri_echo":
                frame = payload.get("frame")
                if isinstance(frame, dict):
                    captured.append(frame)

        client.on_unknown_notification(on_notification)


if __name__ == "__main__":
    unittest.main()
