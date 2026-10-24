"""jev_client: key resolution, request shape, error mapping, retry policy.

Fully offline: urllib.request.urlopen is replaced per test. helpers installs a
real-network guard, so an unmocked call fails loudly instead of dialing out.
"""
import email.message
import io
import json
import os
import unittest
import urllib.error
from unittest import mock

import helpers
import jev_client


def ok_response(payload):
    return io.BytesIO(json.dumps(payload).encode())


def http_error(payload, status, headers=None):
    head = email.message.Message()
    for key, value in (headers or {}).items():
        head[key] = value
    return urllib.error.HTTPError(
        jev_client.API_URL, status, "err", head, io.BytesIO(json.dumps(payload).encode())
    )


def raising(err):
    def fake_urlopen(req, timeout=None):
        raise err

    return fake_urlopen


class ResolveKeyTest(helpers.ResearchCase):
    def test_env_wins_over_config(self):
        with mock.patch.dict(os.environ, {"TYPESAFE_API_KEY": "envkey"}):
            with mock.patch("pathlib.Path.exists", return_value=True):
                self.assertEqual(jev_client.resolve_key("/tmp/nonexistent"), "envkey")

    def test_none_when_absent(self):
        env = {k: v for k, v in os.environ.items() if k != "TYPESAFE_API_KEY"}
        with mock.patch.dict(os.environ, env, clear=True):
            self.assertIsNone(jev_client.resolve_key("/tmp/definitely-not-here-config.env"))

    def test_falls_back_to_config_env_file(self):
        path = os.path.join(self.dir, "config.env")
        with open(path, "w", encoding="utf-8") as fh:
            fh.write("# comment\nOTHER=1\nTYPESAFE_API_KEY=\"filekey\"\n")
        env = {k: v for k, v in os.environ.items() if k != "TYPESAFE_API_KEY"}
        with mock.patch.dict(os.environ, env, clear=True):
            self.assertEqual(jev_client.resolve_key(path), "filekey")


class FanOutTest(unittest.TestCase):
    def test_sends_bearer_and_returns_answers(self):
        seen = {}

        def fake_urlopen(req, timeout=90):
            seen["auth"] = req.get_header("Authorization")
            seen["body"] = json.loads(req.data.decode())
            return ok_response({"model": "jev-1.13.0", "answers": {"a": {"type": "noul", "noul": 0.9}}})

        with mock.patch.object(jev_client.urllib.request, "urlopen", fake_urlopen):
            out = jev_client.fan_out("state text", {"a": {"type": "noul", "instructions": "ok?"}}, "k1")
        self.assertEqual(seen["auth"], "Bearer k1")
        self.assertEqual(seen["body"]["model"], "jev-latest")
        self.assertEqual(seen["body"]["state"], "state text")
        self.assertEqual(out["answers"]["a"]["noul"], 0.9)

    def test_usage_error_400_carries_api_message(self):
        err = http_error({"detail": {"error_type": "api_usage_error", "message": "Unknown model: x"}}, 400)
        with mock.patch.object(jev_client.urllib.request, "urlopen", raising(err)):
            with self.assertRaises(jev_client.JevUsageError) as ctx:
                jev_client.fan_out("s", {"a": {"type": "noul", "instructions": "ok?"}}, "k1")
        self.assertIn("Unknown model: x", str(ctx.exception))

    def test_usage_error_422_surfaces_validation_list(self):
        # FastAPI/pydantic shape: detail is a LIST, not the {message: ...} dict.
        err = http_error({"detail": [{"type": "too_short", "loc": ["body", "questions"],
                                      "msg": "Dictionary should have at least 1 item"}]}, 422)
        with mock.patch.object(jev_client.urllib.request, "urlopen", raising(err)):
            with self.assertRaises(jev_client.JevUsageError) as ctx:
                jev_client.fan_out("s", {}, "k1")
        self.assertIn("at least 1 item", str(ctx.exception))

    def test_auth_error_401_raises_jev_auth_error(self):
        err = http_error({"detail": "bad key"}, 401)
        with mock.patch.object(jev_client.urllib.request, "urlopen", raising(err)):
            with self.assertRaises(jev_client.JevAuthError):
                jev_client.fan_out("s", {"a": {"type": "noul", "instructions": "ok?"}}, "k1")

    def test_429_retries_then_succeeds(self):
        calls = {"n": 0}

        def flaky(req, timeout=90):
            calls["n"] += 1
            if calls["n"] < 3:
                raise http_error({"detail": "slow down"}, 429, {"Retry-After": "0"})
            return ok_response({"model": "m", "answers": {}})

        with mock.patch.object(jev_client.urllib.request, "urlopen", flaky), \
                mock.patch.object(jev_client.time, "sleep"):
            out = jev_client.fan_out("s", {"a": {"type": "noul", "instructions": "ok?"}}, "k1")
        self.assertEqual(calls["n"], 3)
        self.assertEqual(out["model"], "m")

    def test_exhausted_retries_raise_jev_error(self):
        with mock.patch.object(jev_client.urllib.request, "urlopen",
                               raising(urllib.error.URLError("down"))), \
                mock.patch.object(jev_client.time, "sleep"), helpers.captured() as (_, err):
            with self.assertRaises(jev_client.JevError):
                jev_client.fan_out("s", {"a": {"type": "noul", "instructions": "ok?"}}, "k1")
        self.assertIn("retry 3/3", err.getvalue())


class ListModelsTest(unittest.TestCase):
    def test_returns_model_names(self):
        payload = {"models": [{"name": "jev-latest"}, {"name": "jev-preview"}]}
        with mock.patch.object(jev_client.urllib.request, "urlopen",
                               lambda req, timeout=30: ok_response(payload)):
            self.assertEqual(jev_client.list_models("k1"), ["jev-latest", "jev-preview"])


if __name__ == "__main__":
    unittest.main()
