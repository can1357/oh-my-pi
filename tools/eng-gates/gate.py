#!/usr/bin/env python3
"""eng-gates: deterministic quality gates for Rust, Python and JS/TS projects.

Usage:
  gate.py fast   [--all] [--json] [--base REF]   # seconds: format, lint, types, tests, boundaries, guards
  gate.py full   [--all] [--json] [--base REF]   # fast + deps, CRAP, duplication, mutation, benchmarks
  gate.py doctor                                 # what is detected, what each check would run, what is missing
  gate.py init   [--force]                       # copy config templates and vendor the runner into the repo
  gate.py approve                                # HUMAN ONLY: accept the current state of protected config

Exit codes: 0 = no failures, 1 = at least one check failed, 2 = usage or configuration error.
Only the Python standard library is used (3.11+).
"""
from __future__ import annotations

import argparse
import fnmatch
import hashlib
import json
import os
import re
import shlex
import signal
import shutil
import subprocess
import sys
import time
import tomllib
from dataclasses import dataclass, field
from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parent
SKILL_DIR = SCRIPT_DIR.parent if SCRIPT_DIR.name == "scripts" else SCRIPT_DIR
CONFIG_NAME = "gates.toml"
STATE_DIR = ".gates"
VENDOR_DIR = "tools/eng-gates"
TAIL_LINES = 40

LANG_EXT = {
    "rust": {".rs"},
    "python": {".py", ".pyi"},
    "ts": {".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"},
}
LANG_MARKERS = {
    "rust": ["Cargo.toml"],
    "python": ["pyproject.toml", "setup.cfg", "setup.py", "requirements.txt"],
    "ts": ["package.json"],
}
# Files whose change re-triggers a language even if no source file changed.
LANG_CONFIG_FILES = {
    "rust": {"Cargo.toml", "Cargo.lock", "clippy.toml", ".clippy.toml", "deny.toml", "rustfmt.toml", "rust-toolchain.toml"},
    "python": {"pyproject.toml", "uv.lock", "requirements.txt", "ruff.toml", ".importlinter", "pyrightconfig.json", "mypy.ini", "tach.toml"},
    "ts": {"package.json", "package-lock.json", "pnpm-lock.yaml", "yarn.lock", "tsconfig.json", "eslint.config.mjs", ".dependency-cruiser.cjs", "knip.json"},
}

# Protected whole files: the agent must not weaken the gates by editing them.
PROTECTED_FILES = [
    "gates.toml", f"{VENDOR_DIR}/**",
    "clippy.toml", ".clippy.toml", "deny.toml", "rustfmt.toml", ".rustfmt.toml", "rust-toolchain.toml",
    "ruff.toml", ".ruff.toml", ".importlinter", "tach.toml", "pyrightconfig.json", "mypy.ini", ".coveragerc",
    "eslint.config.*", ".eslintrc*", ".dependency-cruiser.*", "knip.json", "knip.jsonc", ".size-limit.*",
    "tsconfig*.json", "vitest.config.*", "jest.config.*",
    "benches/baselines/**", ".gates/baselines/**", ".metrics/baselines/**",
    ".github/workflows/**", ".gitlab-ci.yml", ".pre-commit-config.yaml",
]
# Protected sections inside files that also hold ordinary content.
PROTECTED_TOML_SECTIONS = {
    "Cargo.toml": [("lints",), ("workspace", "lints"), ("profile",)],
    "pyproject.toml": [("tool", k) for k in (
        "ruff", "mypy", "pyright", "importlinter", "pytest", "coverage", "deptry", "tach")],
}
PROTECTED_JSON_KEYS = {"package.json": [("eslintConfig",), ("size-limit",), ("knip",),
                                        ("scripts", "test"), ("scripts", "lint"), ("scripts", "typecheck")]}

# New suppressions in the diff. A reason after "gate-allow:" downgrades the hit to a warning.
SUPPRESSIONS = {
    "rust": [r"#!?\[\s*allow\s*\(", r"#!?\[\s*expect\s*\(", r"#\[\s*ignore\s*\]", r"#\[\s*cfg_attr\s*\([^)]*allow"],
    "python": [r"#\s*noqa", r"#\s*type:\s*ignore", r"#\s*pyright:\s*ignore", r"#\s*pragma:\s*no\s*cover",
               r"@pytest\.mark\.(skip|xfail)", r"\bpytest\.skip\(", r"#\s*ruff:\s*noqa"],
    "ts": [r"eslint-disable", r"@ts-ignore", r"@ts-expect-error", r"@ts-nocheck", r"\b(it|test|describe)\.skip\(",
           r"(istanbul|c8|v8)\s+ignore", r"\bas\s+any\b"],
}
NEVER_ALLOWED = [r"\b(it|test|describe)\.only\(", r"\bfdescribe\(", r"\bfit\("]
ALLOW_RE = re.compile(r"gate-allow:\s*\S")


@dataclass
class Check:
    id: str
    lang: str            # rust | python | ts | any
    tier: str            # fast | full
    desc: str
    variants: list       # [(tool, argv-template)], first one whose tool resolves wins
    requires: list = field(default_factory=list)   # files that must exist (globs, any match)
    enabled: bool = True
    parse: str | None = None    # name of an output parser that can turn exit 0 into a failure
    internal: str | None = None # name of a built-in check instead of a command


def builtin_checks() -> list[Check]:
    c = []
    # ---------- Rust ----------
    c.append(Check("rust.fmt", "rust", "fast", "rustfmt", [("cargo", "cargo fmt --all --check")]))
    c.append(Check("rust.clippy", "rust", "fast", "clippy, warnings are errors",
                   [("cargo", "cargo clippy --workspace --all-targets --all-features -- -D warnings")]))
    c.append(Check("rust.test", "rust", "fast", "tests",
                   [("cargo-nextest", "cargo nextest run --workspace --no-tests=pass"), ("cargo", "cargo test --workspace")]))
    c.append(Check("rust.deny", "rust", "full", "advisories, licenses, banned crates, sources",
                   [("cargo-deny", "cargo deny check")], requires=["deny.toml"]))
    c.append(Check("rust.machete", "rust", "full", "unused dependencies", [("cargo-machete", "cargo machete")]))
    c.append(Check("rust.semver", "rust", "full", "public API semver breakage (published libraries)",
                   [("cargo-semver-checks", "cargo semver-checks")], enabled=False))
    c.append(Check("rust.bench", "rust", "full", "benchmarks with regression limits (gungraun / codspeed)",
                   [("cargo", "cargo bench")], enabled=False))
    # ---------- Python ----------
    c.append(Check("py.format", "python", "fast", "ruff format", [("ruff", "ruff format --check {files:python}")]))
    c.append(Check("py.lint", "python", "fast", "ruff lint", [("ruff", "ruff check {files:python}")]))
    c.append(Check("py.types", "python", "fast", "static types",
                   [("pyright", "pyright"), ("mypy", "mypy .")],
                   requires=["pyrightconfig.json", "mypy.ini", "pyproject.toml"]))
    c.append(Check("py.test", "python", "fast", "pytest", [("pytest", "pytest -q -x")]))
    c.append(Check("py.imports", "python", "fast", "module boundaries",
                   [("lint-imports", "lint-imports"), ("tach", "tach check")],
                   requires=[".importlinter", "tach.toml"]))
    c.append(Check("py.deps", "python", "full", "missing / unused / transitive dependencies", [("deptry", "deptry .")]))
    c.append(Check("py.bench", "python", "full", "benchmarks against saved baseline",
                   [("pytest", "pytest benches --benchmark-only --benchmark-compare --benchmark-compare-fail=mean:5%")],
                   enabled=False))
    # ---------- JS / TS ----------
    c.append(Check("ts.types", "ts", "fast", "tsc --noEmit", [("tsc", "tsc --noEmit -p .")], requires=["tsconfig.json"]))
    c.append(Check("ts.lint", "ts", "fast", "eslint, warnings are errors",
                   [("eslint", "eslint --max-warnings 0 {files:ts}")],
                   requires=["eslint.config.*", ".eslintrc*"]))
    c.append(Check("ts.test", "ts", "fast", "tests", [("vitest", "vitest run"), ("jest", "jest --ci")]))
    c.append(Check("ts.deps", "ts", "fast", "module boundaries and cycles",
                   [("depcruise", "depcruise {src} --config .dependency-cruiser.cjs")],
                   requires=[".dependency-cruiser.cjs"]))
    c.append(Check("ts.knip", "ts", "full", "dead files, exports and dependencies", [("knip", "knip")]))
    c.append(Check("ts.size", "ts", "full", "bundle size budget", [("size-limit", "size-limit")],
                   requires=[".size-limit.json", ".size-limit.js", ".size-limit.cjs"]))
    c.append(Check("ts.bench", "ts", "full", "benchmarks against saved baseline", [("node", "node benches/run.mjs")],
                   enabled=False))
    # ---------- Uncle Bob's gates (ub-mode) ----------
    c.append(Check("ub.crap", "any", "full", "CRAP per function under threshold",
                   [("crapper", "crapper {changed_flag} --threshold {crap}")]))
    c.append(Check("ub.dry", "any", "full", "structural duplication",
                   [("dryer", "dryer {changed_flag} --threshold {dry}")], parse="dryer"))
    c.append(Check("ub.mutate", "any", "full", "mutation testing: no surviving mutants",
                   [("mutator", "mutator {changed_flag}")]))
    # ---------- guards ----------
    c.append(Check("guard.config", "any", "fast", "protected gate config unchanged", [], internal="config"))
    c.append(Check("guard.suppress", "any", "fast", "no new unexplained suppressions", [], internal="suppress"))
    return c


# ---------------------------------------------------------------- helpers

class _WindowsJob:
    """Own a check's process tree, including children whose parent exits first."""

    def __init__(self):
        import ctypes
        from ctypes import wintypes as w

        class BasicLimits(ctypes.Structure):
            _fields_ = [
                ("process_time", ctypes.c_longlong), ("job_time", ctypes.c_longlong),
                ("flags", w.DWORD), ("min_working_set", ctypes.c_size_t),
                ("max_working_set", ctypes.c_size_t), ("active_processes", w.DWORD),
                ("affinity", ctypes.c_size_t), ("priority", w.DWORD), ("scheduling", w.DWORD),
            ]

        class ExtendedLimits(ctypes.Structure):
            _fields_ = [
                ("basic", BasicLimits), ("io", ctypes.c_ulonglong * 6),
                ("process_memory", ctypes.c_size_t), ("job_memory", ctypes.c_size_t),
                ("peak_process_memory", ctypes.c_size_t), ("peak_job_memory", ctypes.c_size_t),
            ]

        self.api = ctypes.WinDLL("kernel32", use_last_error=True)
        signatures = {
            "CreateJobObjectW": (w.HANDLE, [w.LPVOID, w.LPCWSTR]),
            "SetInformationJobObject": (w.BOOL, [w.HANDLE, ctypes.c_int, w.LPVOID, w.DWORD]),
            "AssignProcessToJobObject": (w.BOOL, [w.HANDLE, w.HANDLE]),
            "CloseHandle": (w.BOOL, [w.HANDLE]),
            "CreateToolhelp32Snapshot": (w.HANDLE, [w.DWORD, w.DWORD]),
            "Thread32First": (w.BOOL, [w.HANDLE, w.LPVOID]),
            "Thread32Next": (w.BOOL, [w.HANDLE, w.LPVOID]),
            "OpenThread": (w.HANDLE, [w.DWORD, w.BOOL, w.DWORD]),
            "ResumeThread": (w.DWORD, [w.HANDLE]),
        }
        for name, (result, arguments) in signatures.items():
            function = getattr(self.api, name)
            function.restype = result
            function.argtypes = arguments
        self.handle = self.api.CreateJobObjectW(None, None)
        if not self.handle:
            raise ctypes.WinError(ctypes.get_last_error())
        limits = ExtendedLimits()
        limits.basic.flags = 0x2000  # JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
        if not self.api.SetInformationJobObject(self.handle, 9, ctypes.byref(limits), ctypes.sizeof(limits)):
            error = ctypes.WinError(ctypes.get_last_error())
            self.close()
            raise error

    def attach_and_resume(self, process):
        import ctypes
        from ctypes import wintypes as w

        class ThreadEntry(ctypes.Structure):
            _fields_ = [
                ("size", w.DWORD), ("usage", w.DWORD), ("thread_id", w.DWORD),
                ("process_id", w.DWORD), ("base_priority", w.LONG),
                ("delta_priority", w.LONG), ("flags", w.DWORD),
            ]

        if not self.api.AssignProcessToJobObject(self.handle, int(process._handle)):
            raise ctypes.WinError(ctypes.get_last_error())
        # Popen closes the primary thread handle. Locate it while still suspended:
        # no user code can run or create a child before the job owns the process.
        snapshot = self.api.CreateToolhelp32Snapshot(4, 0)  # TH32CS_SNAPTHREAD
        if snapshot == ctypes.c_void_p(-1).value:
            raise ctypes.WinError(ctypes.get_last_error())
        try:
            entry = ThreadEntry()
            entry.size = ctypes.sizeof(entry)
            found = self.api.Thread32First(snapshot, ctypes.byref(entry))
            while found:
                if entry.process_id == process.pid:
                    thread = self.api.OpenThread(2, False, entry.thread_id)  # THREAD_SUSPEND_RESUME
                    if not thread:
                        raise ctypes.WinError(ctypes.get_last_error())
                    try:
                        if self.api.ResumeThread(thread) == 0xFFFFFFFF:
                            raise ctypes.WinError(ctypes.get_last_error())
                    finally:
                        self.api.CloseHandle(thread)
                    return
                found = self.api.Thread32Next(snapshot, ctypes.byref(entry))
            raise OSError("cannot locate the suspended tool's primary thread")
        finally:
            self.api.CloseHandle(snapshot)

    def close(self):
        if self.handle:
            self.api.CloseHandle(self.handle)
            self.handle = None

def sh(argv: list[str], cwd: Path, timeout: int | None = None):
    p = None
    job = None
    try:
        if os.name == "nt" and Path(argv[0]).suffix.lower() in (".cmd", ".bat"):
            # npm's batch shim is data, never a shell boundary for source filenames.
            shim = Path(argv[0])
            text = shim.read_text(encoding="utf-8")
            entry = re.search(r'"%dp0%[\\/](\.\.[\\/][^"\r\n]+)"', text)
            node = shutil.which("node")
            if not entry or not node:
                return 127, "cannot safely run batch tool; configure a native executable or an npm Node shim"
            script = (shim.parent / entry.group(1).replace("\\", "/")).resolve()
            if not script.is_file():
                return 127, f"npm entry point not found: {script}"
            if script.suffix.lower() not in (".js", ".mjs", ".cjs"):
                with script.open("rb") as source:
                    shebang = source.readline(256)
                if not re.match(rb"#![^\r\n]*\bnode(?:\.exe)?(?:\s|$)", shebang):
                    return 127, f"npm entry point is not a Node script: {script}"
            argv = [node, str(script), *argv[1:]]
        job = _WindowsJob() if os.name == "nt" else None
        p = subprocess.Popen(
            argv, cwd=cwd, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            text=True, encoding="utf-8", errors="replace",
            start_new_session=os.name != "nt",
            creationflags=(subprocess.CREATE_NEW_PROCESS_GROUP | 4) if job else 0,  # CREATE_SUSPENDED
        )
        if job:
            job.attach_and_resume(p)
        try:
            out, err = p.communicate(timeout=timeout)
            return p.returncode, out + err
        except subprocess.TimeoutExpired as error:
            if job:
                job.close()
            else:
                try:
                    os.killpg(p.pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass
            if p.poll() is None:
                p.kill()
            try:
                out, err = p.communicate(timeout=5)
            except subprocess.TimeoutExpired:
                # External launchers can escape a process group/job. Keep cleanup bounded;
                # Windows reader threads may hold the stream lock until the writer exits.
                if os.name != "nt":
                    p.stdout.close()
                    p.stderr.close()
                p.wait(timeout=5)
                out, err = error.output or b"", error.stderr or b""
            if isinstance(out, bytes):
                out = out.decode("utf-8", errors="replace")
            if isinstance(err, bytes):
                err = err.decode("utf-8", errors="replace")
            return 124, out + err + f"\n[eng-gates] timed out after {timeout}s"
    except OSError as error:
        if p is not None and p.poll() is None:
            p.kill()
            p.wait(timeout=5)
        return 127, str(error)
    finally:
        if job:
            job.close()


def git(root: Path, *args: str) -> tuple[int, str]:
    try:
        result = subprocess.run(["git", *args], cwd=root, capture_output=True)
        return result.returncode, os.fsdecode(result.stdout) + os.fsdecode(result.stderr)
    except OSError as error:
        return 127, str(error)


def find_root(start: Path) -> Path:
    cur = start.resolve()
    for d in [cur, *cur.parents]:
        if (d / CONFIG_NAME).exists() or (d / ".git").exists():
            return d
    return cur


def load_config(root: Path) -> dict:
    p = root / CONFIG_NAME
    if not p.exists():
        return {}
    try:
        return tomllib.loads(p.read_text(encoding="utf-8"))
    except tomllib.TOMLDecodeError as e:
        print(f"[eng-gates] {CONFIG_NAME}: {e}", file=sys.stderr)
        sys.exit(2)


def any_exists(root: Path, globs: list[str]) -> bool:
    return any(next(root.glob(g), None) is not None for g in globs)


def detect_languages(root: Path, cfg: dict) -> list[str]:
    forced = cfg.get("gate", {}).get("languages")
    if forced:
        return list(forced)
    return [lang for lang, markers in LANG_MARKERS.items() if any((root / m).exists() for m in markers)]


def is_git(root: Path) -> bool:
    return git(root, "rev-parse", "--is-inside-work-tree")[0] == 0


def resolve_base(root: Path, cfg: dict, override: str | None) -> str | None:
    if not is_git(root):
        return None
    requested = override or cfg.get("gate", {}).get("base")
    candidates = [requested] if requested else ["origin/main", "origin/master", "main", "master"]
    for ref in candidates:
        code, out = git(root, "merge-base", ref, "HEAD")
        if code == 0:
            return out.strip()
        if requested:
            print(f"[eng-gates] cannot resolve base {ref!r}: {out.strip()}", file=sys.stderr)
            sys.exit(2)
    code, head = git(root, "rev-parse", "--verify", "-q", "HEAD")
    return head.strip() if code == 0 else None  # repository without commits


def changed_files(root: Path, base: str | None) -> list[str] | None:
    """Files changed against base, including staged, unstaged and untracked. None = not a git repo."""
    if not is_git(root):
        return None
    args = ("diff", "--no-renames", "--name-only", "-z", "--diff-filter=ACDMRT", base) if base else (
        "diff", "--cached", "--name-only", "-z")
    files: set[str] = set()
    for query in (args, ("ls-files", "--others", "--exclude-standard", "-z")):
        code, out = git(root, *query)
        if code:
            print(f"[eng-gates] cannot determine changed files: {out.strip()}", file=sys.stderr)
            sys.exit(2)
        files.update(name for name in out.split("\0") if name)
    return sorted(files)


def langs_touched(files: list[str]) -> set[str]:
    out = set()
    for f in files:
        name, ext = Path(f).name, Path(f).suffix
        for lang, exts in LANG_EXT.items():
            if ext in exts or any(fnmatch.fnmatch(name, pattern) for pattern in LANG_CONFIG_FILES[lang]) or (
                lang == "ts" and fnmatch.fnmatch(name, "tsconfig*.json")
            ):
                out.add(lang)
    return out


def resolve_tool(root: Path, tool: str, cfg: dict) -> str | None:
    tools_cfg = cfg.get("tools", {})
    if tool in tools_cfg:
        p = Path(os.path.expanduser(tools_cfg[tool]))
        p = p if p.is_absolute() else root / p
        return str(p) if p.exists() else None
    nt = os.name == "nt"
    if tool in ("crapper", "dryer", "mutator"):
        if nt:  # the ub launchers are POSIX sh scripts with a hard-coded .venv/bin: unusable on Windows
            return None
        ub_dir = Path(os.path.expanduser(tools_cfg.get("ub_dir", os.environ.get(
            "ENG_GATES_UB_DIR", "~/.local/share/eng-gates/ub"))))
        p = ub_dir / tool / tool
        if p.exists():
            return str(p)
        return shutil.which(tool)
    if tool.startswith("cargo-"):
        return shutil.which(tool)
    # Windows: npm shims are tool.cmd (the extensionless file is a sh script), venvs use Scripts/.
    venv_bin = root / ".venv" / ("Scripts" if nt else "bin")
    for name in ((tool + ".cmd", tool + ".exe") if nt else (tool,)):
        for local in (root / "node_modules" / ".bin" / name, venv_bin / name):
            if local.exists():
                return str(local)
    return shutil.which(tool)


def render(template: str, ctx: dict) -> list[str] | None:
    """Fill placeholders. Returns None when a {files:lang} placeholder has nothing to check."""
    argv = []
    scalars = {k: str(v) for k, v in ctx.items() if isinstance(v, (str, int, float))}
    for tok in shlex.split(template):
        m = re.fullmatch(r"\{files:(\w+)\}", tok)
        if m:
            files = ctx["files"].get(m.group(1))
            if files is None:
                argv.append(".")
            elif not files:
                return None
            else:
                argv.extend(files)
            continue
        val = re.sub(r"\{(\w+)\}", lambda mm: scalars.get(mm.group(1), mm.group(0)), tok)
        if val or not tok.startswith("{"):  # an empty placeholder ({changed_flag} in --all) disappears
            argv.append(val)
    return argv


def tail(text: str, n: int = TAIL_LINES) -> str:
    return "\n".join(text.rstrip().splitlines()[-n:])


# ---------------------------------------------------------------- guards

def table_at(data: dict, path: tuple):
    cur = data
    for k in path:
        if not isinstance(cur, dict) or k not in cur:
            return None
        cur = cur[k]
    return cur


def file_at_base(root: Path, base: str | None, rel: str) -> str | None:
    if not base:
        return None
    code, out = git(root, "show", f"{base}:{rel}")
    return out if code == 0 else None


def protected_state(root: Path, cfg: dict, base: str | None) -> dict[str, str]:
    """Hash protected content, including explicit tombstones for approved deletions."""
    state = {}
    globs = PROTECTED_FILES + cfg.get("gate", {}).get("protected", [])
    candidates = set(changed_files(root, base) or [])
    for pattern in globs:
        pattern = pattern + "/*" if pattern.endswith("/**") else pattern
        candidates.update(
            path.relative_to(root).as_posix()
            for path in root.glob(pattern) if path.is_file() and ".git" not in path.parts
        )
    for rel in candidates:
        if any(fnmatch.fnmatch(rel, pattern) for pattern in globs):
            path = root / rel
            state[rel] = hashlib.sha256(path.read_bytes()).hexdigest() if path.is_file() else "<deleted>"
    for rel, sections, loads, error in (
        *[(r, s, tomllib.loads, tomllib.TOMLDecodeError) for r, s in PROTECTED_TOML_SECTIONS.items()],
        *[(r, k, json.loads, json.JSONDecodeError) for r, k in PROTECTED_JSON_KEYS.items()],
    ):
        path = root / rel
        try:
            data = loads(path.read_text(encoding="utf-8")) if path.exists() else {}
        except error:
            continue
        for section in sections:
            state[f"{rel}#{'.'.join(section)}"] = hashlib.sha256(
                json.dumps(table_at(data, section), sort_keys=True, default=str).encode()
            ).hexdigest()
    return state


def guard_config(root: Path, cfg: dict, base: str | None, changed: list[str] | None) -> tuple[str, str]:
    if changed is None:
        return "skip", "not a git repository: nothing to compare against"
    globs = PROTECTED_FILES + cfg.get("gate", {}).get("protected", [])
    hits: list[str] = [f for f in changed if any(fnmatch.fnmatch(f, g) for g in globs)]  # keys as in protected_state
    for rel, sections, loads, err in (
            *[(r, s, tomllib.loads, tomllib.TOMLDecodeError) for r, s in PROTECTED_TOML_SECTIONS.items()],
            *[(r, k, json.loads, json.JSONDecodeError) for r, k in PROTECTED_JSON_KEYS.items()]):
        if rel not in changed:
            continue
        try:
            current_file = root / rel
            new = loads(current_file.read_text(encoding="utf-8")) if current_file.exists() else {}
            old_text = file_at_base(root, base, rel)
            old = loads(old_text) if old_text else {}
        except err as e:
            hits.append(f"{rel}#(unparseable: {e})")
            continue
        hits += [f"{rel}#{'.'.join(s)}" for s in sections if table_at(new, s) != table_at(old, s)]
    if not hits:
        return "pass", ""
    listing = "\n  ".join(hits)
    approved = load_approval(root)
    if approved is not None and not os.environ.get("CI"):
        current = protected_state(root, cfg, base)
        if all(k in approved and current.get(k) == approved[k] for k in hits):
            return "pass", f"protected config changed, approved by a human (gate.py approve):\n  {listing}"
    return "fail", ("protected gate configuration changed. Agents must not edit these: revert the change, "
                    f"or stop and ask a human to review it (they run `gate.py approve`).\n  {listing}")


def approval_path(root: Path) -> Path:
    return root / STATE_DIR / "approved.json"


def load_approval(root: Path) -> dict | None:
    p = approval_path(root)
    try:
        return json.loads(p.read_text(encoding="utf-8")) if p.exists() else None
    except json.JSONDecodeError:
        return None


def added_lines(root: Path, base: str | None, changed: list[str]) -> list[tuple[str, int, str]]:
    out: list[tuple[str, int, str]] = []
    code, names = git(root, "ls-files", "--others", "--exclude-standard", "-z")
    if code:
        print(f"[eng-gates] cannot list untracked files: {names}", file=sys.stderr)
        sys.exit(2)
    untracked = set(names.split("\0"))
    renamed = {}
    if base:
        code, names = git(root, "diff", "--no-ext-diff", "--no-textconv", "--find-renames",
                          "--name-status", "-z", "--diff-filter=R", base)
        if code:
            print(f"[eng-gates] cannot determine renamed files: {names}", file=sys.stderr)
            sys.exit(2)
        records = names.split("\0")
        renamed = {records[i + 2]: records[i + 1] for i in range(0, len(records) - 1, 3)}
    for rel in changed:
        if rel in untracked or not base:
            path = root / rel
            if path.is_file():
                out.extend((rel, n, text) for n, text in enumerate(
                    path.read_text(encoding="utf-8", errors="replace").splitlines(), 1
                ))
            continue
        # Associate hunks with the known raw filename, not Git's quoted display path.
        paths = [renamed[rel], rel] if rel in renamed else [rel]
        code, diff = git(root, "--literal-pathspecs", "diff", "--no-ext-diff", "--no-textconv",
                         "--find-renames", "-U0", "--no-color", base, "--", *paths)
        if code:
            print(f"[eng-gates] cannot inspect diff for {rel}: {diff}", file=sys.stderr)
            sys.exit(2)
        line_no = None
        for line in diff.splitlines():
            if line.startswith("@@"):
                match = re.search(r"\+(\d+)", line)
                line_no = int(match.group(1)) if match else None
            elif line.startswith("+") and line_no is not None:
                out.append((rel, line_no, line[1:]))
                line_no += 1
    return out


def guard_suppress(root: Path, cfg: dict, base: str | None, changed: list[str] | None) -> tuple[str, str]:
    if changed is None:
        return "skip", "not a git repository"
    skip_globs = cfg.get("gate", {}).get("suppress_ignore", []) + [f"{VENDOR_DIR}/**"]
    fails, warns = [], []
    for rel, n, text in added_lines(root, base, changed):
        if any(fnmatch.fnmatch(rel, g) for g in skip_globs):
            continue
        ext = Path(rel).suffix
        lang = next((name for name, exts in LANG_EXT.items() if ext in exts), None)
        if lang is None:
            continue
        loc = f"{rel}:{n}: {text.strip()[:120]}"
        if any(re.search(p, text) for p in NEVER_ALLOWED):
            fails.append(loc + "   <- focused test, never allowed")
        elif any(re.search(p, text) for p in SUPPRESSIONS[lang]):
            (warns if ALLOW_RE.search(text) else fails).append(loc)
    msg = []
    if fails:
        msg.append("new suppressions without a reason. Fix the cause, or if the suppression is truly right, "
                   "add `gate-allow: <reason>` on the same line for the reviewer:\n  " + "\n  ".join(fails))
    if warns:
        msg.append("suppressions with a stated reason (reviewer must look):\n  " + "\n  ".join(warns))
    return ("fail" if fails else "warn" if warns else "pass"), "\n".join(msg)


# ---------------------------------------------------------------- output parsers

def parse_dryer(code: int, out: str) -> tuple[int, str]:
    dups = [line for line in out.splitlines() if line.startswith("DUPLICATE")]
    if code == 0 and dups:
        return 1, f"{len(dups)} duplicate candidate(s)"
    return code, ""


PARSERS = {"dryer": parse_dryer}


# ---------------------------------------------------------------- runner

def build_checks(cfg: dict) -> list[Check]:
    checks = {c.id: c for c in builtin_checks()}
    for cid, over in cfg.get("check", {}).items():
        if cid in checks:
            c = checks[cid]
            if "cmd" in over:
                c.variants = [(over.get("tool", c.variants[0][0] if c.variants else shlex.split(over["cmd"])[0]), over["cmd"])]
            for k in ("enabled", "tier", "requires"):
                if k in over:
                    setattr(c, k, over[k])
        else:  # custom check
            if "cmd" not in over:
                print(f"[eng-gates] custom check {cid} needs cmd", file=sys.stderr)
                sys.exit(2)
            checks[cid] = Check(cid, over.get("lang", "any"), over.get("tier", "full"), over.get("desc", "custom"),
                                [(over.get("tool", shlex.split(over["cmd"])[0]), over["cmd"])],
                                requires=over.get("requires", []), enabled=over.get("enabled", True))
    return list(checks.values())


def plan(root: Path, cfg: dict, tier: str, all_files: bool, base_override: str | None):
    langs = detect_languages(root, cfg)
    base = resolve_base(root, cfg, base_override)
    changed = changed_files(root, base)
    scope_changed = (not all_files) and changed is not None
    touched = langs_touched(changed) if scope_changed else set(langs)
    files = {}
    for lang in LANG_EXT:
        config_changed = scope_changed and any(
            any(fnmatch.fnmatch(Path(f).name, pattern) for pattern in LANG_CONFIG_FILES[lang]) or
            (lang == "ts" and fnmatch.fnmatch(Path(f).name, "tsconfig*.json"))
            for f in changed
        )
        if scope_changed and not config_changed:
            files[lang] = [f for f in changed if Path(f).suffix in LANG_EXT[lang] and (root / f).is_file()]
        else:
            files[lang] = None  # whole tree
    ub = cfg.get("ub", {})
    ctx = {"files": files, "changed_flag": "--changed" if scope_changed else "",
           "crap": ub.get("crap", 10), "dry": ub.get("dry", 0.8),
           "src": cfg.get("gate", {}).get("ts_src", "src")}
    tiers = {"fast"} if tier == "fast" else {"fast", "full"}
    selected = []
    for c in build_checks(cfg):
        if c.tier not in tiers:
            continue
        if c.lang != "any" and c.lang not in langs:
            continue
        selected.append(c)
    return dict(langs=langs, base=base, changed=changed, scope_changed=scope_changed,
                touched=touched, ctx=ctx, checks=selected)


def run_check(root: Path, cfg: dict, c: Check, p: dict, strict: bool, timeout: int) -> dict:
    res = {"id": c.id, "desc": c.desc, "status": "skip", "seconds": 0.0, "cmd": "", "detail": ""}
    if not c.enabled:
        res["detail"] = f"disabled (enable in {CONFIG_NAME}: [check.\"{c.id}\"] enabled = true)"
        return res
    if c.internal:
        t0 = time.monotonic()
        fn = guard_config if c.internal == "config" else guard_suppress
        res["status"], res["detail"] = fn(root, cfg, p["base"], p["changed"])
        res["seconds"] = round(time.monotonic() - t0, 2)
        return res
    if c.lang != "any" and p["scope_changed"] and c.lang not in p["touched"]:
        res["detail"] = "no changed files for this language"
        return res
    if c.lang == "any" and p["scope_changed"] and not p["changed"]:
        res["detail"] = "nothing changed"
        return res
    if c.requires and not any_exists(root, c.requires):
        res["detail"] = f"not configured (needs one of: {', '.join(c.requires)})"
        return res
    chosen = None
    for tool, template in c.variants:
        path = resolve_tool(root, tool, cfg)
        if path:
            chosen = (tool, path, template)
            break
    if not chosen:
        tools = " or ".join(t for t, _ in c.variants)
        res["status"] = "fail" if strict else "skip"
        res["detail"] = f"missing tool: {tools} (scripts/install-tools.sh, or [tools] in {CONFIG_NAME})"
        return res
    tool, path, template = chosen
    argv = render(template, p["ctx"])
    if argv is None:
        res["detail"] = "no matching changed files"
        return res
    if argv and argv[0] == tool:
        argv[0] = path
    elif tool.startswith("cargo-") and argv[:2] == ["cargo", tool.removeprefix("cargo-")]:
        argv[0] = path
    res["cmd"] = " ".join(argv)
    t0 = time.monotonic()
    code, out = sh(argv, root, timeout=timeout)
    res["seconds"] = round(time.monotonic() - t0, 1)
    note = ""
    if c.parse in PARSERS:
        code, note = PARSERS[c.parse](code, out)
    res["exit"] = code
    if code == 0:
        res["status"] = "pass"
    else:
        res["status"] = "fail"
        res["detail"] = ((note + "\n") if note else "") + tail(out)
    return res


def cmd_run(root: Path, args) -> int:
    cfg = load_config(root)
    gate_cfg = cfg.get("gate", {})
    p = plan(root, cfg, args.tier, args.all, args.base)
    if not p["langs"]:
        print("[eng-gates] no Rust, Python or JS/TS project found here", file=sys.stderr)
        return 2
    strict = args.strict or gate_cfg.get("strict", False) or bool(os.environ.get("CI"))
    timeout = int(gate_cfg.get("timeout", 900))
    only = set(args.only.split(",")) if args.only else None
    results = []
    for c in p["checks"]:
        if only and c.id not in only and c.id.split(".")[0] not in only:
            continue
        r = run_check(root, cfg, c, p, strict, timeout)
        results.append(r)
        if not args.json:
            mark = {"pass": "PASS", "fail": "FAIL", "skip": "skip", "warn": "WARN"}[r["status"]]
            extra = "" if r["status"] in ("fail", "warn") else (r["detail"] if r["status"] == "skip" else "")
            print(f"  {mark} {r['id']:<15} {r['seconds']:>6}s  {extra}".rstrip(), flush=True)
    failed = [r for r in results if r["status"] == "fail"]
    summary = {
        "tier": args.tier, "ok": not failed, "root": str(root), "languages": p["langs"],
        "base": p["base"], "scope": "changed" if p["scope_changed"] else "all",
        "changed_files": len(p["changed"]) if p["changed"] is not None else None,
        "counts": {s: sum(r["status"] == s for r in results) for s in ("pass", "fail", "warn", "skip")},
        "results": results,
    }
    state = root / STATE_DIR
    state.mkdir(exist_ok=True)
    (state / "last.json").write_text(json.dumps(summary, indent=2))
    if args.json:
        print(json.dumps(summary, indent=2))
    else:
        for r in results:
            if r["status"] in ("fail", "warn") and r["detail"]:
                print(f"\n--- {r['status'].upper()} {r['id']}" + (f"  ({r['cmd']})" if r["cmd"] else ""))
                print(r["detail"])
        k = summary["counts"]
        if p["scope_changed"] and p["base"] and git(root, "rev-parse", "HEAD")[1].strip() == p["base"]:
            print("\nnote: base equals HEAD, so only uncommitted changes were checked. Work on a branch, "
                  "or pass --base <ref> to cover committed work.")
        print(f"\neng-gates {args.tier}: {'OK' if not failed else 'FAILED'} - "
              f"{k['pass']} pass, {k['fail']} fail, {k['warn']} warn, {k['skip']} skip "
              f"[{summary['scope']}, base {str(p['base'])[:12]}]  details: {STATE_DIR}/last.json")
    return 1 if failed else 0


def cmd_doctor(root: Path) -> int:
    cfg = load_config(root)
    langs = detect_languages(root, cfg)
    base = resolve_base(root, cfg, None)
    print(f"root      {root}\nconfig    {CONFIG_NAME} {'found' if (root / CONFIG_NAME).exists() else 'MISSING (run init)'}")
    print(f"languages {', '.join(langs) or 'none detected'}\nbase      {base or 'none (not git or no commits)'}\n")
    missing = 0
    for c in build_checks(cfg):
        if c.lang != "any" and c.lang not in langs:
            continue
        if c.internal:
            print(f"  ok   {c.id:<15} built-in")
            continue
        if not c.enabled:
            print(f"  off  {c.id:<15} disabled")
            continue
        if c.requires and not any_exists(root, c.requires):
            print(f"  --   {c.id:<15} not configured: needs {' | '.join(c.requires)}")
            continue
        found = [(t, resolve_tool(root, t, cfg)) for t, _ in c.variants]
        hit = next(((t, pth) for t, pth in found if pth), None)
        if hit:
            print(f"  ok   {c.id:<15} {hit[1]}")
        else:
            missing += 1
            print(f"  MISS {c.id:<15} install: {' or '.join(t for t, _ in found)}")
    print(f"\n{missing} check(s) missing a tool. scripts/install-tools.sh installs them.")
    return 0


TEMPLATE_MAP = {
    "common": [("gates.toml", "gates.toml"), ("justfile", "justfile.gates"), ("AGENTS.gates.md", "AGENTS.gates.md")],
    "rust": [("clippy.toml", "clippy.toml"), ("deny.toml", "deny.toml"), ("cargo-lints.toml", ".gates/merge-into-Cargo.toml")],
    "python": [("ruff.toml", "ruff.toml"), (".importlinter", ".importlinter"), ("pyrightconfig.json", "pyrightconfig.json")],
    "ts": [("eslint.config.mjs", "eslint.config.mjs"), (".dependency-cruiser.cjs", ".dependency-cruiser.cjs"),
           ("knip.json", "knip.json"), ("tsconfig.strict.json", "tsconfig.strict.json")],
}


def guess_python_package(root: Path) -> str | None:
    for base in (root / "src", root):
        if base.is_dir():
            for d in sorted(base.iterdir()):
                if d.is_dir() and (d / "__init__.py").exists() and d.name not in ("tests", "test", "benches"):
                    return d.name
    return None


def cmd_init(root: Path, force: bool) -> int:
    cfg = load_config(root)
    langs = detect_languages(root, cfg)
    tdir = SKILL_DIR / "templates"
    created, kept = [], []
    pkg = guess_python_package(root) or "your_package"
    for group in ["common", *langs]:
        for src_name, dst_name in TEMPLATE_MAP.get(group, []):
            src, dst = tdir / group / src_name, root / dst_name
            if dst.exists() and not force:
                kept.append(dst_name)
                continue
            dst.parent.mkdir(parents=True, exist_ok=True)
            text = src.read_text(encoding="utf-8").replace("{{package}}", pkg)
            dst.write_text(text, encoding="utf-8")
            created.append(dst_name)
    vend = root / VENDOR_DIR
    vend.mkdir(parents=True, exist_ok=True)
    for name in ("gate.py", "bench_compare.py", "install-tools.sh"):
        src, dst = SCRIPT_DIR / name, vend / name
        if src.resolve() == dst.resolve() or (dst.exists() and not force):
            kept.append(f"{VENDOR_DIR}/{name}")
            continue
        shutil.copy2(src, dst)
        created.append(f"{VENDOR_DIR}/{name}")
    # Keep the original templates with the vendored runner for re-init/new languages.
    for src in tdir.rglob("*"):
        if not src.is_file():
            continue
        dst = vend / "templates" / src.relative_to(tdir)
        if src.resolve() == dst.resolve() or (dst.exists() and not force):
            continue
        dst.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(src, dst)
    gi = root / ".gitignore"
    lines = gi.read_text(encoding="utf-8").splitlines() if gi.exists() else []
    for entry in (f"{STATE_DIR}/last.json", f"{STATE_DIR}/approved.json", ".metrics/"):
        if entry not in lines:
            lines.append(entry)
    gi.write_text("\n".join(lines) + "\n", encoding="utf-8")
    print("created:\n  " + "\n  ".join(created))
    if kept:
        print("kept existing (compare with templates by hand):\n  " + "\n  ".join(kept))
    print("\nnext:")
    if "rust" in langs:
        print("  - merge .gates/merge-into-Cargo.toml into Cargo.toml, then delete it")
    if "python" in langs and pkg == "your_package":
        print("  - set root_package in .importlinter")
    if "ts" in langs:
        print("  - add `\"extends\": \"./tsconfig.strict.json\"` to tsconfig.json; set layer paths in .dependency-cruiser.cjs")
    print("  - append AGENTS.gates.md to AGENTS.md; merge justfile.gates into your justfile")
    print(f"  - CI: copy {SKILL_DIR / 'templates/common/ci-github.yml'} to .github/workflows/gates.yml")
    print("  - run: python3 tools/eng-gates/gate.py doctor   then commit everything (a human commit = approval)")
    return 0


def cmd_approve(root: Path, base_override: str | None) -> int:
    if os.environ.get("ENG_GATES_AGENT"):
        print("[eng-gates] approve is for humans; refusing inside an agent session (ENG_GATES_AGENT is set)", file=sys.stderr)
        return 2
    cfg = load_config(root)
    base = resolve_base(root, cfg, base_override)
    p = approval_path(root)
    p.parent.mkdir(exist_ok=True)
    p.write_text(json.dumps(protected_state(root, cfg, base), indent=2, sort_keys=True), encoding="utf-8")
    print(f"approved current protected config -> {p.relative_to(root)} (ignored when CI is set)")
    return 0


def main() -> int:
    ap = argparse.ArgumentParser(prog="gate.py", description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("command", choices=["fast", "full", "doctor", "init", "approve"])
    ap.add_argument("--all", action="store_true", help="check the whole tree, not only changed files")
    ap.add_argument("--json", action="store_true", help="print the JSON report instead of text")
    ap.add_argument("--base", help="git ref to compare against (default: gates.toml base, then origin/main)")
    ap.add_argument("--only", help="comma list of check ids or prefixes (rust, py, ts, ub, guard)")
    ap.add_argument("--strict", action="store_true", help="a missing tool fails instead of skipping")
    ap.add_argument("--force", action="store_true", help="init: overwrite existing files")
    ap.add_argument("-C", dest="cwd", default=".", help="project directory")
    args = ap.parse_args()
    root = find_root(Path(args.cwd))
    if args.command == "doctor":
        return cmd_doctor(root)
    if args.command == "init":
        return cmd_init(root, args.force)
    if args.command == "approve":
        return cmd_approve(root, args.base)
    args.tier = args.command
    return cmd_run(root, args)


if __name__ == "__main__":
    sys.exit(main())
