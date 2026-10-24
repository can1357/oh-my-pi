"""_http.fetch: retry policy, Retry-After, stderr-only notices."""
import email.message
import io
import unittest
import urllib.error
import urllib.request
from unittest import mock

import helpers
import _http


def http_error(code, retry_after=None):
    headers = email.message.Message()
    if retry_after is not None:
        headers["Retry-After"] = retry_after
    return urllib.error.HTTPError("http://x.test/", code, "boom", headers, io.BytesIO(b""))


class FakeResponse:
    def __init__(self, body):
        self._body = body

    def read(self):
        return self._body

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False


class ScriptedUrlopen:
    """urlopen stand-in that pops one scripted outcome per call."""

    def __init__(self, outcomes):
        self.outcomes = list(outcomes)
        self.calls = 0

    def __call__(self, req, timeout=None):
        self.calls += 1
        outcome = self.outcomes.pop(0)
        if isinstance(outcome, Exception):
            raise outcome
        return FakeResponse(outcome)


class HttpTest(unittest.TestCase):
    def setUp(self):
        self._prev = urllib.request.urlopen

    def tearDown(self):
        urllib.request.urlopen = self._prev

    def fetch(self, outcomes):
        fake = ScriptedUrlopen(outcomes)
        urllib.request.urlopen = fake
        with mock.patch("time.sleep") as sleep, helpers.captured() as (out, err):
            body = _http.fetch("http://x.test/", "ua-test")
        return body, fake, sleep, out.getvalue(), err.getvalue()

    def test_retries_each_retryable_status_then_succeeds(self):
        for code in (429, 500, 502, 503, 504):
            with self.subTest(code=code):
                body, fake, sleep, out, err = self.fetch([http_error(code), b"payload"])
                self.assertEqual(body, b"payload")
                self.assertEqual(fake.calls, 2)
                self.assertEqual(sleep.call_count, 1)

    def test_non_retryable_status_raises_immediately(self):
        fake = ScriptedUrlopen([http_error(403)])
        urllib.request.urlopen = fake
        with mock.patch("time.sleep") as sleep:
            with self.assertRaises(urllib.error.HTTPError) as ctx:
                _http.fetch("http://x.test/", "ua-test")
        self.assertEqual(ctx.exception.code, 403)
        self.assertEqual(fake.calls, 1)
        sleep.assert_not_called()

    def test_honors_numeric_retry_after(self):
        _, _, sleep, _, _ = self.fetch([http_error(429, retry_after="7"), b"ok"])
        self.assertEqual(sleep.call_args_list[0].args[0], 7.0)

    def test_retry_after_capped_at_backoff_cap(self):
        _, _, sleep, _, _ = self.fetch([http_error(429, retry_after="9999"), b"ok"])
        self.assertEqual(sleep.call_args_list[0].args[0], _http.BACKOFF_CAP)

    def test_garbage_retry_after_falls_back_to_backoff(self):
        _, _, sleep, _, _ = self.fetch([http_error(429, retry_after="soon"), b"ok"])
        self.assertEqual(sleep.call_args_list[0].args[0], 3.0)

    def test_gives_up_after_max_attempts(self):
        fake = ScriptedUrlopen([http_error(503)] * _http.MAX_ATTEMPTS)
        urllib.request.urlopen = fake
        with mock.patch("time.sleep"), helpers.captured():
            with self.assertRaises(urllib.error.HTTPError):
                _http.fetch("http://x.test/", "ua-test")
        self.assertEqual(fake.calls, _http.MAX_ATTEMPTS)

    def test_retry_notices_go_to_stderr_stdout_stays_clean(self):
        _, _, _, out, err = self.fetch([http_error(429), b"ok"])
        self.assertEqual(out, "")
        self.assertIn("_http:", err)
        self.assertIn("retry 1/", err)

    def test_url_error_is_retried(self):
        _, fake, sleep, _, _ = self.fetch(
            [urllib.error.URLError("timed out"), b"payload"]
        )
        self.assertEqual(fake.calls, 2)
        self.assertEqual(sleep.call_count, 1)


if __name__ == "__main__":
    unittest.main()
