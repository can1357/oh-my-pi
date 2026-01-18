# OMP IPython prelude helpers
if "__omp_prelude_loaded__" not in globals():
    __omp_prelude_loaded__ = True
    from pathlib import Path
    import os, sys, re, json, shutil, subprocess, glob, textwrap, inspect
    from datetime import datetime

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

    def env(key: str | None = None, value: str | None = None):
        """Get/set environment variables."""
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

    def mkdir(path: str | Path) -> Path:
        """Create directory (parents=True)."""
        p = Path(path)
        p.mkdir(parents=True, exist_ok=True)
        print(f"[mkdir] {p}")
        return p

    def rm(path: str | Path, *, recursive: bool = False) -> None:
        """Delete file or directory (recursive optional)."""
        p = Path(path)
        if p.is_dir():
            if recursive:
                shutil.rmtree(p)
                print(f"[rm -r] {p}")
                return
            print(f"[rm] {p} (directory, use recursive=True)")
            return
        if p.exists():
            p.unlink()
            print(f"[rm] {p}")
        else:
            print(f"[rm] {p} (missing)")

    def mv(src: str | Path, dst: str | Path) -> Path:
        """Move or rename a file/directory."""
        src_p = Path(src)
        dst_p = Path(dst)
        dst_p.parent.mkdir(parents=True, exist_ok=True)
        shutil.move(str(src_p), str(dst_p))
        print(f"[mv] {src_p} -> {dst_p}")
        return dst_p

    def cp(src: str | Path, dst: str | Path) -> Path:
        """Copy a file or directory."""
        src_p = Path(src)
        dst_p = Path(dst)
        dst_p.parent.mkdir(parents=True, exist_ok=True)
        if src_p.is_dir():
            shutil.copytree(src_p, dst_p, dirs_exist_ok=True)
        else:
            shutil.copy2(src_p, dst_p)
        print(f"[cp] {src_p} -> {dst_p}")
        return dst_p

    def ls(path: str | Path = ".") -> list[Path]:
        """List directory contents."""
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

    def head(text: str, n: int = 10) -> str:
        """Return the first n lines of text."""
        lines = text.splitlines()[:n]
        out = "\n".join(lines)
        print(out)
        print(f"[head] {len(lines)} lines")
        return out

    def tail(text: str, n: int = 10) -> str:
        """Return the last n lines of text."""
        lines = text.splitlines()[-n:]
        out = "\n".join(lines)
        print(out)
        print(f"[tail] {len(lines)} lines")
        return out

    def replace(path: str | Path, pattern: str, repl: str, *, regex: bool = False) -> int:
        """Replace text in a file (regex optional)."""
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

    def bash(cmd: str, *, cwd: str | Path | None = None, timeout: int | None = None) -> subprocess.CompletedProcess[str]:
        """Run a shell command via bash when available; fallback when missing."""
        snapshot = os.environ.get("OMP_SHELL_SNAPSHOT")
        prefix = f"source '{snapshot}' 2>/dev/null && " if snapshot else ""
        final = f"{prefix}{cmd}"

        bash_path = shutil.which("bash")
        if bash_path:
            return run(f"{bash_path} -lc {json.dumps(final)}", cwd=cwd, timeout=timeout)

        if sys.platform.startswith("win"):
            return run(f"cmd /c {json.dumps(cmd)}", cwd=cwd, timeout=timeout)

        sh_path = shutil.which("sh")
        if sh_path:
            return run(f"{sh_path} -lc {json.dumps(cmd)}", cwd=cwd, timeout=timeout)

        raise RuntimeError("No suitable shell found for bash() bridge")

    # --- Extended shell-like utilities ---

    def cat(*paths: str | Path, separator: str = "\n") -> str:
        """Concatenate multiple files and print. Like shell cat."""
        parts = []
        for p in paths:
            parts.append(Path(p).read_text(encoding="utf-8"))
        out = separator.join(parts)
        print(out)
        print(f"[cat] {len(paths)} files, {len(out)} chars")
        return out

    def touch(path: str | Path) -> Path:
        """Create empty file or update mtime."""
        p = Path(path)
        p.parent.mkdir(parents=True, exist_ok=True)
        p.touch()
        print(f"[touch] {p}")
        return p

    def wc(text: str) -> dict:
        """Word/line/char count."""
        lines = text.splitlines()
        words = text.split()
        result = {"lines": len(lines), "words": len(words), "chars": len(text)}
        print(f"{result['lines']} lines, {result['words']} words, {result['chars']} chars")
        return result

    def sort_lines(text: str, *, reverse: bool = False, unique: bool = False) -> str:
        """Sort lines of text."""
        lines = text.splitlines()
        if unique:
            lines = list(dict.fromkeys(lines))
        lines = sorted(lines, reverse=reverse)
        out = "\n".join(lines)
        print(out)
        return out

    def uniq(text: str, *, count: bool = False) -> str | list[tuple[int, str]]:
        """Remove duplicate adjacent lines (like uniq)."""
        lines = text.splitlines()
        if not lines:
            return [] if count else ""
        groups: list[tuple[int, str]] = []
        current = lines[0]
        current_count = 1
        for line in lines[1:]:
            if line == current:
                current_count += 1
                continue
            groups.append((current_count, current))
            current = line
            current_count = 1
        groups.append((current_count, current))
        if count:
            for c, l in groups:
                print(f"{c:>4} {l}")
            return groups
        out = "\n".join(line for _, line in groups)
        print(out)
        return out

    def cols(text: str, *indices: int, sep: str | None = None) -> str:
        """Extract columns from text (0-indexed). Like cut."""
        result_lines = []
        for line in text.splitlines():
            parts = line.split(sep) if sep else line.split()
            selected = [parts[i] for i in indices if i < len(parts)]
            result_lines.append(" ".join(selected))
        out = "\n".join(result_lines)
        print(out)
        return out

    def tree(path: str | Path = ".", *, max_depth: int = 3, show_hidden: bool = False) -> str:
        """Print directory tree."""
        base = Path(path)
        lines = []
        def walk(p: Path, prefix: str, depth: int):
            if depth > max_depth:
                return
            items = sorted(p.iterdir(), key=lambda x: (not x.is_dir(), x.name.lower()))
            items = [i for i in items if show_hidden or not i.name.startswith(".")]
            for i, item in enumerate(items):
                is_last = i == len(items) - 1
                connector = "└── " if is_last else "├── "
                suffix = "/" if item.is_dir() else ""
                lines.append(f"{prefix}{connector}{item.name}{suffix}")
                if item.is_dir():
                    ext = "    " if is_last else "│   "
                    walk(item, prefix + ext, depth + 1)
        lines.append(str(base) + "/")
        walk(base, "", 1)
        out = "\n".join(lines)
        print(out)
        return out

    def stat(path: str | Path) -> dict:
        """Get file/directory info."""
        p = Path(path)
        s = p.stat()
        info = {
            "path": str(p),
            "size": s.st_size,
            "is_file": p.is_file(),
            "is_dir": p.is_dir(),
            "mtime": datetime.fromtimestamp(s.st_mtime).isoformat(),
            "mode": oct(s.st_mode),
        }
        for k, v in info.items():
            print(f"{k}: {v}")
        return info

    def diff(a: str | Path, b: str | Path) -> str:
        """Compare two files, print unified diff."""
        import difflib
        path_a, path_b = Path(a), Path(b)
        lines_a = path_a.read_text(encoding="utf-8").splitlines(keepends=True)
        lines_b = path_b.read_text(encoding="utf-8").splitlines(keepends=True)
        result = difflib.unified_diff(lines_a, lines_b, fromfile=str(path_a), tofile=str(path_b))
        out = "".join(result)
        if out:
            print(out)
        else:
            print("[diff] files are identical")
        return out

    def glob_files(pattern: str, path: str | Path = ".") -> list[Path]:
        """Non-recursive glob (use find() for recursive)."""
        p = Path(path)
        matches = sorted(p.glob(pattern))
        for m in matches:
            print(str(m))
        print(f"[glob] {len(matches)} matches")
        return matches

    def batch(paths: list[str | Path], fn) -> list:
        """Apply function to multiple files. Returns list of results."""
        results = []
        for p in paths:
            result = fn(Path(p))
            results.append(result)
        print(f"[batch] processed {len(paths)} files")
        return results

    def sed(path: str | Path, pattern: str, repl: str, *, flags: int = 0) -> int:
        """Regex replace in file (like sed -i). Returns count."""
        p = Path(path)
        data = p.read_text(encoding="utf-8")
        new, count = re.subn(pattern, repl, data, flags=flags)
        p.write_text(new, encoding="utf-8")
        print(f"[sed] {count} replacements in {p}")
        return count

    def rsed(pattern: str, repl: str, path: str | Path = ".", *, glob_pattern: str = "*", flags: int = 0) -> int:
        """Recursive sed across files matching glob_pattern."""
        base = Path(path)
        total = 0
        for file_path in base.rglob(glob_pattern):
            if file_path.is_dir():
                continue
            try:
                data = file_path.read_text(encoding="utf-8")
                new, count = re.subn(pattern, repl, data, flags=flags)
                if count > 0:
                    file_path.write_text(new, encoding="utf-8")
                    print(f"{file_path}: {count} replacements")
                    total += count
            except Exception:
                continue
        print(f"[rsed] {total} total replacements")
        return total

    def __omp_prelude_docs__() -> list[dict[str, str]]:
        """Return prelude helper docs for templating."""
        categories = [
            ("File I/O", ["read", "write", "append", "touch", "cat"]),
            ("File operations", ["cp", "mv", "rm", "mkdir"]),
            ("Navigation", ["pwd", "cd", "ls", "tree", "stat"]),
            ("Search", ["find", "glob_files", "grep", "rgrep"]),
            ("Text processing", ["head", "tail", "sort_lines", "uniq", "cols", "wc"]),
            ("Find and replace", ["replace", "sed", "rsed"]),
            ("Batch operations", ["batch", "diff"]),
            ("Shell bridge", ["run", "bash", "env"]),
        ]
        helpers: list[dict[str, str]] = []
        for category, names in categories:
            for name in names:
                obj = globals().get(name)
                if not callable(obj):
                    continue
                signature = str(inspect.signature(obj))
                doc = inspect.getdoc(obj) or ""
                docline = doc.splitlines()[0] if doc else ""
                helpers.append(
                    {
                        "name": name,
                        "signature": signature,
                        "docstring": docline,
                        "category": category,
                    }
                )
        return helpers
