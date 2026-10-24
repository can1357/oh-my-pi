"""Shared test plumbing: import paths, offline guard, env/state isolation.

Importing this module makes the whole test process offline: every
urllib.request.urlopen call raises NetworkGuard (a RuntimeError subclass, so
the retry handlers in _http — which catch URLError/OSError — cannot swallow
it). Tests that need HTTP install fixtures over _http.fetch or urlopen.
"""
import contextlib
import glob as globmod
import io
import json
import os
import sys
import tempfile
import unittest
import urllib.request

TESTS_DIR = os.path.dirname(os.path.abspath(__file__))
LIT_SCRIPTS = os.path.abspath(
    os.path.join(TESTS_DIR, "..", "skills", "literature-search", "scripts")
)
GRAPH_SCRIPTS = os.path.abspath(
    os.path.join(TESTS_DIR, "..", "skills", "paper-graph", "scripts")
)
for _p in (LIT_SCRIPTS, GRAPH_SCRIPTS):
    if _p not in sys.path:
        sys.path.insert(0, _p)


class NetworkGuard(RuntimeError):
    """Raised when a test reaches the real network. RuntimeError on purpose:
    the retry code in _http catches URLError/OSError, never this."""


def _no_network(*args, **kwargs):
    raise NetworkGuard("test attempted real network I/O via urllib.request.urlopen")


REAL_URLOPEN = urllib.request.urlopen
urllib.request.urlopen = _no_network


# Env vars the scripts read; saved/restored around every test.
ENV_KEYS = (
    "RESEARCH_PROJECT_DIR",
    "RESEARCH_CORPUS_DIR",
    "PAPER_GRAPH_DB",
    "UNPAYWALL_EMAIL",
    "OPENALEX_MAILTO",
)

# Corpus presence is decided from the env the suite was LAUNCHED with, before
# any test mutates it (skipUnless decorators evaluate at import time anyway).
def corpus_pdfs():
    d = os.path.expanduser(os.environ.get("RESEARCH_CORPUS_DIR") or "")
    if not d or not os.path.isdir(d):
        return []
    return sorted(globmod.glob(os.path.join(d, "*.pdf")))


CORPUS_PDFS = corpus_pdfs()


class ResearchCase(unittest.TestCase):
    """Base: one temp dir per test, env snapshot/restore, no real state."""

    def setUp(self):
        self._env = {k: os.environ.get(k) for k in ENV_KEYS}
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.dir = tmp.name
        # Point everything env-resolved at the sandbox so a test that forgets
        # an explicit --project/db can never touch ~/.research-harness.
        os.environ["RESEARCH_PROJECT_DIR"] = self.dir
        os.environ["PAPER_GRAPH_DB"] = os.path.join(self.dir, "papers.db")
        for k in ("RESEARCH_CORPUS_DIR", "UNPAYWALL_EMAIL", "OPENALEX_MAILTO"):
            os.environ.pop(k, None)

    def tearDown(self):
        for k, v in self._env.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v


@contextlib.contextmanager
def captured():
    out, err = io.StringIO(), io.StringIO()
    with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
        yield out, err


def run_cli(module, argv):
    """Run a script's main() with argv; returns (exit_code, stdout, stderr)."""
    out, err = io.StringIO(), io.StringIO()
    code = 0
    old_argv = sys.argv
    sys.argv = [getattr(module, "__name__", "prog")] + list(argv)
    try:
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            module.main()
    except SystemExit as e:
        code = e.code if isinstance(e.code, int) else (0 if e.code is None else 1)
    finally:
        sys.argv = old_argv
    return code, out.getvalue(), err.getvalue()


def json_lines(text):
    return [json.loads(line) for line in text.splitlines() if line.strip()]


def seed_review(pdir, dist, con=None):
    """Insert records directly with the given {state: count} distribution."""
    import review

    con = con or review.connect(pdir)
    n = sum(
        1 for _ in con.execute("SELECT 1 FROM records")
    )
    for state, count in dist.items():
        for _ in range(count):
            n += 1
            ts = review.now()
            con.execute(
                "INSERT INTO records (id, import_key, source_db, title, state,"
                " created_at, updated_at) VALUES (?,?,?,?,?,?,?)",
                (f"rec-{n}", f"key-{n}", "seed", f"Seeded Title {n}", state, ts, ts),
            )
    con.commit()
    return con
