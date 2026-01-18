# IPython REPL Prelude

## Purpose
Define the Python-side helpers injected into the IPython kernel so the agent can perform common shell/file tasks without needing the bash tool. The goal is to cover the frequent bash use cases (file ops, grep/find, git status, basic exec), while keeping outputs visible in the tool stream.

## Design Principles
- **Visibility**: helpers must print concise, useful output by default.
- **Predictability**: return structured values *and* print summaries.
- **Safety**: no sandboxing; focus on correctness and clarity.
- **Parity**: cover the common bash operations seen in sessions.
- **Minimal state**: no persistence beyond kernel lifetime.

## Prelude Injection
The prelude is executed once per kernel at startup. It should:
- import common modules
- define helper functions
- set a small display utility for consistent output

### Core Imports
```python
from pathlib import Path
import os, sys, re, json, shutil, subprocess, glob, textwrap
from datetime import datetime
```

## Helpers to Expose

### 1) Working directory
```python
def pwd() -> Path:
    """Print and return current working directory."""
    p = Path.cwd()
    print(str(p))
    return p


def cd(path: str | Path) -> Path:
    """Change directory and print the new cwd."""
    p = Path(path).expanduser().resolve()
    os.chdir(p)
    print(str(p))
    return p
```

### 2) Environment
```python
def env(key: str | None = None, value: str | None = None):
    """Get/set environment variables.

    - env() -> prints all env vars (sorted) and returns dict
    - env("PATH") -> prints and returns value
    - env("FOO", "bar") -> sets and prints assignment
    """
    if key is None:
        items = dict(sorted(os.environ.items()))
        for k, v in items.items():
            print(f"{k}={v}")
        print(f"[env] {len(items)} variables")
        return items
    if value is not None:
        os.environ[key] = value
        print(f"{key}={value}")
        return value
    val = os.environ.get(key)
    print(f"{key}={val}")
    return val
```

### 3) File read/write
```python
def read(path: str | Path, *, limit: int | None = None) -> str:
    """Read file contents. Prints a short preview + length."""
    p = Path(path)
    data = p.read_text(encoding="utf-8")
    if limit is not None:
        preview = data[:limit]
        print(preview)
        print(f"[read {len(data)} chars from {p}]")
    else:
        print(data)
        print(f"[read {len(data)} chars from {p}]")
    return data


def write(path: str | Path, content: str) -> Path:
    """Write file contents (create parents). Prints bytes written."""
    p = Path(path)
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(content, encoding="utf-8")
    print(f"[wrote {len(content)} chars to {p}]")
    return p


def append(path: str | Path, content: str) -> Path:
    """Append to file. Prints bytes appended."""
    p = Path(path)
    p.parent.mkdir(parents=True, exist_ok=True)
    with p.open("a", encoding="utf-8") as f:
        f.write(content)
    print(f"[appended {len(content)} chars to {p}]")
    return p
```

### 4) File ops (mkdir/rm/mv/cp)
```python
def mkdir(path: str | Path) -> Path:
    p = Path(path)
    p.mkdir(parents=True, exist_ok=True)
    print(f"[mkdir] {p}")
    return p


def rm(path: str | Path, *, recursive: bool = False) -> None:
    p = Path(path)
    if p.is_dir() and recursive:
        shutil.rmtree(p)
        print(f"[rm -r] {p}")
    elif p.exists():
        p.unlink()
        print(f"[rm] {p}")
    else:
        print(f"[rm] {p} (missing)")


def mv(src: str | Path, dst: str | Path) -> Path:
    src_p = Path(src)
    dst_p = Path(dst)
    dst_p.parent.mkdir(parents=True, exist_ok=True)
    shutil.move(str(src_p), str(dst_p))
    print(f"[mv] {src_p} -> {dst_p}")
    return dst_p


def cp(src: str | Path, dst: str | Path) -> Path:
    src_p = Path(src)
    dst_p = Path(dst)
    dst_p.parent.mkdir(parents=True, exist_ok=True)
    if src_p.is_dir():
        shutil.copytree(src_p, dst_p, dirs_exist_ok=True)
    else:
        shutil.copy2(src_p, dst_p)
    print(f"[cp] {src_p} -> {dst_p}")
    return dst_p
```

### 5) Listing / find / glob
```python
def ls(path: str | Path = ".") -> list[Path]:
    p = Path(path)
    items = sorted(p.iterdir())
    for item in items:
        suffix = "/" if item.is_dir() else ""
        print(f"{item.name}{suffix}")
    print(f"[ls] {len(items)} entries in {p}")
    return items


def find(pattern: str, path: str | Path = ".", *, files_only: bool = True) -> list[Path]:
    """Recursive glob find. Defaults to files only."""
    p = Path(path)
    matches = []
    for m in p.rglob(pattern):
        if files_only and m.is_dir():
            continue
        matches.append(m)
    matches = sorted(matches)
    for m in matches:
        print(str(m))
    print(f"[find] {len(matches)} matches for '{pattern}' in {p}")
    return matches
```

### 6) Grep
```python
def grep(pattern: str, path: str | Path, *, ignore_case: bool = False, context: int = 0) -> list[tuple[int, str]]:
    """Grep a single file."""
    flags = re.IGNORECASE if ignore_case else 0
    rx = re.compile(pattern, flags)
    p = Path(path)
    lines = p.read_text(encoding="utf-8").splitlines()
    hits: list[tuple[int, str]] = []
    for i, line in enumerate(lines, 1):
        if rx.search(line):
            hits.append((i, line))
            print(f"{i}: {line}")
            if context:
                start = max(0, i - 1 - context)
                end = min(len(lines), i - 1 + context + 1)
                for j in range(start, end):
                    if j + 1 == i:
                        continue
                    print(f"{j+1}- {lines[j]}")
    print(f"[grep] {len(hits)} matches in {p}")
    return hits


def rgrep(pattern: str, path: str | Path = ".", *, glob_pattern: str = "*", ignore_case: bool = False) -> list[tuple[Path, int, str]]:
    """Recursive grep across files matching glob_pattern."""
    flags = re.IGNORECASE if ignore_case else 0
    rx = re.compile(pattern, flags)
    base = Path(path)
    hits: list[tuple[Path, int, str]] = []
    for file_path in base.rglob(glob_pattern):
        if file_path.is_dir():
            continue
        try:
            lines = file_path.read_text(encoding="utf-8").splitlines()
        except Exception:
            continue
        for i, line in enumerate(lines, 1):
            if rx.search(line):
                hits.append((file_path, i, line))
                print(f"{file_path}:{i}: {line}")
    print(f"[rgrep] {len(hits)} matches in {base}")
    return hits
```

### 7) Text utilities (head/tail/sed-like replace)
```python
def head(text: str, n: int = 10) -> str:
    lines = text.splitlines()[:n]
    out = "\n".join(lines)
    print(out)
    print(f"[head] {len(lines)} lines")
    return out


def tail(text: str, n: int = 10) -> str:
    lines = text.splitlines()[-n:]
    out = "\n".join(lines)
    print(out)
    print(f"[tail] {len(lines)} lines")
    return out


def replace(path: str | Path, pattern: str, repl: str, *, regex: bool = False) -> int:
    p = Path(path)
    data = p.read_text(encoding="utf-8")
    if regex:
        new, count = re.subn(pattern, repl, data)
    else:
        new = data.replace(pattern, repl)
        count = data.count(pattern)
    p.write_text(new, encoding="utf-8")
    print(f"[replace] {count} replacements in {p}")
    return count
```

### 7) Simple command runner
```python
def run(cmd: str, *, cwd: str | Path | None = None, timeout: int | None = None) -> subprocess.CompletedProcess[str]:
    """Run a shell command and print stdout/stderr."""
    result = subprocess.run(
        cmd,
        cwd=str(cwd) if cwd else None,
        shell=True,
        capture_output=True,
        text=True,
        timeout=timeout,
    )
    if result.stdout:
        print(result.stdout, end="" if result.stdout.endswith("\n") else "\n")
    if result.stderr:
        print(result.stderr, end="" if result.stderr.endswith("\n") else "\n")
    print(f"[run] exit={result.returncode}")
    return result
```

## Bash bridge (snapshot-aware)
Expose a `bash()` helper that uses the shell snapshot when available (generated on the TypeScript side by `shell-snapshot.ts`). The kernel should receive the snapshot path via env var, e.g. `OMP_SHELL_SNAPSHOT`.

```python
def bash(cmd: str, *, cwd: str | Path | None = None, timeout: int | None = None) -> subprocess.CompletedProcess[str]:
    """Run a shell command via bash when available; fallback on Windows or missing bash."""
    snapshot = os.environ.get("OMP_SHELL_SNAPSHOT")
    prefix = f"source '{snapshot}' 2>/dev/null && " if snapshot else ""
    final = f"{prefix}{cmd}"

    # Prefer bash when present (Unix), otherwise fall back to sh/cmd.
    bash_path = shutil.which("bash")
    if bash_path:
        return run(f"{bash_path} -lc {json.dumps(final)}", cwd=cwd, timeout=timeout)

    # Windows fallback
    if sys.platform.startswith("win"):
        return run(f"cmd /c {json.dumps(cmd)}", cwd=cwd, timeout=timeout)

    # Last-resort POSIX shell
    sh_path = shutil.which("sh")
    if sh_path:
        return run(f"{sh_path} -lc {json.dumps(cmd)}", cwd=cwd, timeout=timeout)

    raise RuntimeError("No suitable shell found for bash() bridge")
```

## Behavior Notes
- All helpers print useful summaries so outputs are visible in tool streaming.
- Functions return values for programmatic use while still printing.
- `run()` is intentionally verbose and not a replacement for the bash tool; it’s a bridge for cases where Python lacks a direct helper.
- **Grep context**: if two matches are close, context lines can overlap. Low priority improvement: merge overlapping ranges before printing.

## Follow-ups (Optional)
- Add a `git` helper wrapper for common git operations (status/diff/log).
- Add a `cat()` alias for `read()` and `touch()` helper.
- Add `walk()` helper to show directories with depth limit.
