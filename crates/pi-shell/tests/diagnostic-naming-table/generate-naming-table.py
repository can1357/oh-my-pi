#!/usr/bin/env python3
"""Record Bash diagnostic names. Python 3.11+, Linux, two explicit Bash paths.

All fixtures and evidence are created below --output. No repository is modified.
Run --verify-existing to repeat all probes and compare without rewriting the table.
The optional main column consumes an existing native addon via the supplied matrix.py.
"""
import argparse
import ast
import base64
import contextlib
import errno
import hashlib
import io
import json
import os
from pathlib import Path
import pty
import re
import select
import shlex
import signal
import subprocess
import sys
import tempfile
import termios
import time

VERSIONS = ("5.2.21", "5.3.0")
KINDS = {
    "parser": {"probe": ")", "producer": "parser_error", "detail": "Unexpected token; active function/child inputs use eval to reach the parser during that activation."},
    "runtime": {"probe": "missing_naming_table_command", "producer": "get_name_for_error", "detail": "Command lookup failure; Bash's command-not-found emitter calls internal_error/error_prolog, which obtains its name through get_name_for_error."},
    "builtin": {"probe": "cd ./missing", "producer": "builtin_error", "detail": "The cd builtin reports ENOENT through builtin_error_prolog."},
    "general": {"probe": ": > ./missing/output", "producer": "error_prolog", "detail": "Redirection failure calls internal_error -> error_prolog(1); unlike builtin_error it has no builtin-name segment."},
}
PATHS = ["top", "script-operand", "source", "nested-source", "function", "function-after-source", "eval", "command-substitution", "heredoc-body", "heredoc-substitution", "subshell", "pipeline-left", "pipeline-right"]
for trap in ("exit", "err", "return", "debug"):
    PATHS += [f"trap-{trap}-{phase}" for phase in ("top", "function", "source", "nested-source", "after-source")]
MODES = ("noninteractive", "interactive-command-pty", "interactive-read-pty")
PROMPT = b"__NAMING_TABLE_READY__ "


def dumps(value):
    return json.dumps(value, ensure_ascii=True, indent=2) + "\n"


def blob(data):
    return {"text": data.decode("utf-8", "surrogateescape"), "base64": base64.b64encode(data).decode("ascii"), "length": len(data)}


def payload(kind, active=False):
    return 'eval ")"' if kind == "parser" and active else KINDS[kind]["probe"]


def make_probe(path, kind):
    p = payload(kind)
    active = payload(kind, True)
    files = {}
    note = ""
    if path in ("top", "script-operand"):
        command = ":\n" + p
    elif path == "source":
        command = ":\n. ./src"
        files = {"src": ":\n" + p + "\n"}
    elif path == "nested-source":
        command = ":\n. ./f1"
        files = {"f1": ":\n. ./f2\n", "f2": ":\n:\n. ./f3\n", "f3": ":\n:\n:\n" + p + "\n"}
    elif path == "function":
        command = 'f() {\n:\n' + active + '\n}\n:\nf'
        note = "Syntax is parsed by eval inside f, not while parsing f's definition."
    elif path == "function-after-source":
        command = ". ./defs\n:\nf"
        files = {"defs": 'f() {\n:\n' + active + '\n}\n'}
        note = "defs has returned; the function defined there is still active. Syntax uses eval."
    elif path == "eval":
        command = ":\neval " + shlex.quote(":\n" + p)
    elif path == "command-substitution":
        command = ":\nx=$(" + ("if)" if kind == "parser" else ":\n" + p + ")")
    elif path == "heredoc-body":
        command = "cat <<'END'\n" + p + "\nEND"
        note = "A quoted here-document body is data, not command/parser input. This literal producer probe does not execute; silence is an observed negative, not missing coverage. See heredoc-expansion-general for unquoted body expansion."
    elif path == "heredoc-substitution":
        command = "cat <<EOF\n$(" + ("if)" if kind == "parser" else p + ")") + "\nEOF"
        note = "The substitution is parsed/expanded while the here-document body is consumed."
    elif path == "subshell":
        command = ":\n(\n:\n" + active + "\n)"
        note = "Syntax uses eval inside the running subshell, not a malformed outer subshell declaration."
    elif path in ("pipeline-left", "pipeline-right"):
        group = "{\n:\n" + active + "\n}"
        command = group + " | cat" if path.endswith("left") else "printf '' | " + group
        note = "Syntax uses eval in the running pipeline element."
    elif path.startswith("trap-"):
        _, trap, phase = path.split("-", 2)
        t = trap.upper()
        trap_body = p
        # DEBUG may run before several commands; a non-parser body disables itself.
        # A syntax error cannot execute an earlier disable, so its repeats are retained.
        if trap == "debug" and kind != "parser":
            trap_body = "trap - DEBUG; " + p
        install = "trap " + shlex.quote(trap_body) + " " + t
        enable = {"exit": "", "err": "set -E; ", "return": "set -T; ", "debug": "set -T; "}[trap]
        trigger = {"exit": "exit 7", "err": "false", "return": "return 3", "debug": ":"}[trap]
        if phase == "top":
            command = enable + install + "; " + (":" if trap == "return" else trigger)
            note = "Top-level RETURN has no function/source return and must not fire." if trap == "return" else "Trap fires at top level" + (" during shell exit." if trap == "exit" else ".")
        elif phase == "function":
            command = enable + "f() {\n" + install + "; " + trigger + "\n}; f"
            note = "Trap is installed in a function" + ("; EXIT fires while exiting from that activation." if trap == "exit" else ".")
        elif phase == "source":
            command = enable + ". ./src"
            files = {"src": ":\n" + install + "; " + trigger + "\n"}
            note = "Trap is installed in src; " + ("RETURN fires after src's activation is removed." if trap == "return" else "the trigger is in that source.")
        elif phase == "nested-source":
            command = enable + ". ./f1"
            files = {"f1": ":\n. ./f2\n", "f2": ":\n. ./f3\n", "f3": ":\n" + install + "; " + trigger + "\n"}
            note = "f1 sources f2 sources f3. EXIT unwinds nested sources; RETURN can fire repeatedly while different outer sources remain active. All emissions are retained."
        else:
            if trap == "return":
                command = enable + install + "; . ./src"
                files = {"src": "return 3\n"}
                note = "Round-six boundary: RETURN fires after the source has returned, with no active source."
            else:
                command = enable + ". ./src; " + install + "; " + trigger
                files = {"src": ":\n"}
                note = "The source has returned before the trap is installed and triggered."
    else:
        raise ValueError(path)
    return {"command": command, "files": files, "note": note}


def probes():
    rows = {}
    for path in PATHS:
        for kind in KINDS:
            for mode in MODES:
                # A script operand is a distinct parser-input mode, not terminal stdin.
                if path == "script-operand" and mode == "interactive-read-pty":
                    continue
                rid = f"{path}.{kind}.{mode}"
                row = dict(id=rid, path=path, kind=kind, mode=mode, **make_probe(path, kind))
                row["regressions"] = []
                if path == "trap-return-after-source":
                    row["regressions"].append("round6-return-after-source")
                if path == "heredoc-substitution" and kind == "parser":
                    row["regressions"].append("round6-heredoc-inner-input")
                rows[rid] = row
    # A nested parser can run with either an active source or a returned definition
    # source. These compositions measure that boundary rather than inferring it.
    for inner_path in ("function", "eval", "command-substitution", "heredoc-substitution", "subshell", "pipeline-left", "pipeline-right"):
        for depth in (1, 3):
            source_path = "source" if depth == 1 else "nested-source"
            for kind in KINDS:
                inner = make_probe(inner_path, kind)
                source = "src" if depth == 1 else "f3"
                files = dict(inner["files"])
                files[source] = ":\n" + inner["command"] + "\n"
                if depth == 3:
                    files.update({"f1": ":\n. ./f2\n", "f2": ":\n. ./f3\n"})
                command = ":\n. ./" + (source if depth == 1 else "f1")
                for mode in MODES:
                    rid = f"{source_path}-{inner_path}.{kind}.{mode}"
                    rows[rid] = dict(id=rid, path=inner_path, kind=kind, mode=mode, command=command, files=files,
                                     note=f"{inner_path} while {depth} sourced file(s) remain active. " + inner["note"],
                                     regressions=["round6-heredoc-inner-input"] if inner_path == "heredoc-substitution" and kind == "parser" else [])
    extra = [
        ("round6-return-exact", "trap-return-after-source", "builtin+parser", 'set -T; trap \'cd ./trapmissing; eval ")"\' RETURN; . ./src; cd ./post', {"src": "return 3\n"}, "round6-return-after-source"),
        ("round6-heredoc-exact", "heredoc-substitution", "parser", "cat <<EOF\n$(if)\nEOF", {}, "round6-heredoc-inner-input"),
        ("heredoc-inner-prefix", "heredoc-substitution", "parser", "cat <<EOF\nprefix $(if) suffix\nEOF", {}, "round6-heredoc-inner-input"),
        ("heredoc-inner-later-line", "heredoc-substitution", "parser", ":\ncat <<EOF\nfirst\nprefix $(if) suffix\nEOF", {}, "round6-heredoc-inner-input"),
        ("heredoc-expansion-general", "heredoc-body", "general", "cat <<EOF\n${bad!}\nEOF", {}, None),
        ("heredoc-delimiter-warning", "heredoc-body", "general", "cat <<END\nbody", {}, None),
        ("raw-function-definition-parser", "function", "parser", "f() {\n)\n}; f", {}, None),
        ("raw-subshell-definition-parser", "subshell", "parser", "(\n)\n", {}, None),
        ("eval-nested-parser", "eval", "parser", "eval 'eval \" ) \"'", {}, None),
        ("comsub-eval-parser", "command-substitution", "parser", 'x=$(eval ")")', {}, None),
        ("backtick-parser", "command-substitution", "parser", "x=`if)`", {}, None),
        ("unquoted-heredoc-literal-runtime", "heredoc-body", "runtime", "cat <<EOF\nmissing_naming_table_command\nEOF", {}, None),
        ("unquoted-heredoc-literal-builtin", "heredoc-body", "builtin", "cat <<EOF\ncd ./missing\nEOF", {}, None),
        ("unquoted-heredoc-literal-parser", "heredoc-body", "parser", "cat <<EOF\n)\nEOF", {}, None),
    ]
    for name, path, kind, command, files, regression in extra:
        for mode in MODES:
            rid = name + "." + mode
            rows[rid] = dict(id=rid, path=path, kind=kind, mode=mode, command=command, files=files,
                             note="Exact boundary/alternative parser-input probe; see command and files.",
                             regressions=[regression] if regression else [])
    return rows


def environment(directory):
    return {"PATH": "/usr/bin:/bin", "HOME": str(directory), "LC_ALL": "C", "TERM": "dumb", "PS1": PROMPT.decode(), "PS2": "", "HISTFILE": "/dev/null", "TMPDIR": str(directory)}


def terminal_run(binary, argv, directory, command=None):
    pid, fd = pty.fork()
    if pid == 0:
        try:
            os.chdir(directory)
            attrs = termios.tcgetattr(0)
            attrs[3] &= ~termios.ECHO
            attrs[1] &= ~termios.OPOST
            termios.tcsetattr(0, termios.TCSANOW, attrs)
            os.execve(binary, argv, environment(directory))
        except BaseException:
            os._exit(125)
    data = bytearray()
    status = None
    sent = command is None
    seen_prompts = 0
    deadline = time.monotonic() + 12
    try:
        while time.monotonic() < deadline:
            ready, _, _ = select.select([fd], [], [], 0.025)
            if ready:
                try:
                    chunk = os.read(fd, 65536)
                except OSError as exc:
                    if exc.errno != errno.EIO:
                        raise
                    break
                if not chunk:
                    break
                data.extend(chunk)
                if command is not None:
                    prompts = data.count(PROMPT)
                    if not sent and prompts:
                        # EOF may terminate a nested here-document reader first.
                        os.write(fd, command.encode() + b"\n\x04")
                        sent = True
                    elif sent and prompts > seen_prompts:
                        # A subsequent primary prompt needs its own terminal EOF.
                        os.write(fd, b"\x04")
                    seen_prompts = prompts
            if status is None:
                done, wait_status = os.waitpid(pid, os.WNOHANG)
                if done:
                    status = wait_status
                # Continue reading until PTY EIO, including output queued at exit.
        else:
            raise TimeoutError("PTY probe exceeded 12 seconds; argv=" + repr(argv) + "; output=" + repr(bytes(data[-8192:])))
    finally:
        if status is None:
            done, wait_status = os.waitpid(pid, os.WNOHANG)
            if not done:
                os.kill(pid, signal.SIGKILL)
                _, wait_status = os.waitpid(pid, 0)
            status = wait_status
        os.close(fd)
    if not sent:
        raise AssertionError("terminal-read probe never received a prompt")
    raw = bytes(data)
    if b"no job control" in raw or b"cannot set terminal process group" in raw:
        raise AssertionError("PTY does not have job control: " + repr(raw))
    # Prompts and the terminal-input EOF notice are not diagnostic prologues.
    cleaned = raw.replace(PROMPT, b"")
    notice = b""
    if command is not None:
        if cleaned.startswith(b"exit\n"):
            notice = b"exit\n"
            cleaned = cleaned[5:]
        elif cleaned.endswith(b"exit\n"):
            notice = b"exit\n"
            cleaned = cleaned[:-5]
        else:
            # EXIT diagnostics follow the notice; it can be in the middle.
            index = cleaned.find(b"\nexit\n")
            if index >= 0:
                notice = b"exit\n"
                cleaned = cleaned[:index + 1] + cleaned[index + 6:]
    return os.waitstatus_to_exitcode(status), cleaned, raw, notice


def run_probe(row, binary, root):
    with tempfile.TemporaryDirectory(prefix="cell-", dir=root) as work:
        directory = Path(work)
        for name, content in row["files"].items():
            target = directory / name
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text(content)
        argv = ["bash", "--noprofile", "--norc", "--noediting"]
        terminal = row["mode"] != "noninteractive"
        if terminal:
            argv += ["-i"]
        if row["path"] == "script-operand":
            (directory / "run.sh").write_text(row["command"] + "\n")
            argv += ["./run.sh"]
        elif row["mode"] != "interactive-read-pty":
            argv += ["-c", row["command"]]
        if terminal:
            status, emitted, raw, notice = terminal_run(binary, argv, directory, row["command"] if row["mode"] == "interactive-read-pty" else None)
            result = {"status": status, "stream": "combined-terminal", "emitted": blob(emitted), "terminal_bytes": blob(raw), "terminal_eof_notice": blob(notice)}
        else:
            child = subprocess.run(argv, executable=binary, cwd=directory, env=environment(directory), stdin=subprocess.DEVNULL, capture_output=True, timeout=12)
            result = {"status": child.returncode, "stream": "stderr", "emitted": blob(child.stderr), "stdout": blob(child.stdout)}
        result["diagnostics"], result["other_output"] = decompose(base64.b64decode(result["emitted"]["base64"]))
        result["diagnostic_emitted"] = bool(result["diagnostics"])
        return result


# Parse the emitted name, including Bash's synthetic "environment" input name,
# rather than guessing its value from a fixture's filename or invocation state.
PROLOG = re.compile(rb"^(?P<name>[^:\n]+):(?P<tail>.*)$")
SEGMENT = re.compile(rb"^(?: (?P<label>-c|eval|command substitution|debug trap|return trap|exit trap|error trap):| (?P<input>\./(?:run\.sh|src|defs|f[123])):| line (?P<line>[0-9]+):)")


def decompose(data):
    diagnostics = []
    other = bytearray()
    accounted = bytearray()
    for line in data.splitlines(keepends=True):
        accounted.extend(line)
        m = PROLOG.match(line.rstrip(b"\n"))
        if not m:
            if b"syntax error" in line or b"command not found" in line or b"No such file" in line:
                raise AssertionError("unclassified diagnostic: " + repr(line))
            other.extend(line)
            continue
        tail = m["tail"]
        prefix = m["name"] + b":"
        labels = []
        name_segments = [m["name"].decode()]
        number = None
        while True:
            seg = SEGMENT.match(tail)
            if not seg:
                break
            prefix += seg[0]
            tail = tail[len(seg[0]):]
            if seg["line"] is not None:
                number = int(seg["line"])
            elif seg["input"] is not None:
                name_segments.append(seg["input"].decode())
            else:
                labels.append(seg["label"].decode())
        if tail.startswith(b" "):
            prefix += b" "
            tail = tail[1:]
        ending = b"\n" if line.endswith(b"\n") else b""
        context = tail.startswith(b"`") and tail.endswith(b"'")
        item = {"full": blob(line), "name": m["name"].decode(), "name_segments": name_segments,
                "name_segment": ": ".join(name_segments), "line_present": number is not None, "line": number,
                "labels": labels, "prologue": blob(prefix), "message": blob(tail), "newline": blob(ending),
                "is_context_line": context, "context_echo": blob(tail[1:-1]) if context else None}
        assert prefix + tail + ending == line
        diagnostics.append(item)
    assert bytes(accounted) == data
    return diagnostics, blob(bytes(other))


def validate_versions(binaries):
    recorded = {}
    for version, binary in zip(VERSIONS, binaries):
        result = subprocess.run(["bash", "--noprofile", "--norc", "-c", "printf '%s' \"$BASH_VERSION\""], executable=binary, env={"LC_ALL": "C", "PATH": "/usr/bin:/bin"}, capture_output=True, check=True)
        text = result.stdout.decode()
        if not text.startswith(version + "("):
            raise AssertionError(f"Expected Bash {version}; observed {text}")
        recorded[version] = text
    return recorded


def measure_main(args, rows, root):
    """Use the lane harness unchanged except its temp root and explicit Bun path."""
    if not args.main_tree:
        return {"measured": False, "reason": "Optional main column not requested; no addon build is performed."}, {}
    if not args.matrix or not args.bun:
        raise ValueError("--main-tree requires --matrix and --bun")
    tree = Path(args.main_tree).resolve()
    revision = subprocess.check_output(["git", "-C", str(tree), "rev-parse", "HEAD"], text=True).strip()
    # Read-only provenance: do not call a modified engine unmodified main.
    subprocess.run(["git", "-C", str(tree), "diff", "--quiet", "HEAD", "--", "crates/pi-shell", "crates/pi-natives", "packages/natives/src", "Cargo.toml", "Cargo.lock"], check=True)
    control_paths = {"top", "source", "nested-source", "function", "function-after-source", "eval", "command-substitution", "heredoc-substitution", "subshell", "pipeline-left", "pipeline-right"}
    selected = [r for r in rows.values() if r["mode"] == "noninteractive" and (
        r["id"] == f"{r['path']}.{r['kind']}.noninteractive" and (
            r["path"] in control_paths or r["path"].startswith("trap-") and r["kind"] == "builtin")
        or r["id"].startswith(("round6-", "heredoc-inner-")))]
    cases = []
    for row in selected:
        setup = "; ".join("printf %s " + shlex.quote(text) + " > " + shlex.quote(name) for name, text in row["files"].items())
        cases.append({"id": row["id"], "script": row["command"], "setup": setup, "nobash": True, "outer": 20, "timeoutMs": 10000})
    case_path = args.output / "main-cases.json"
    case_path.write_text(dumps(cases))
    out_path = root / "matrix-main.jsonl"
    source = Path(args.matrix).read_text()
    module = ast.parse(source, filename=str(args.matrix))
    last = module.body[-1]
    if not (isinstance(last, ast.Expr) and isinstance(last.value, ast.Call) and isinstance(last.value.func, ast.Name) and last.value.func.id == "main"):
        raise AssertionError("matrix.py entry point changed; inspect it before using this adapter")
    module.body.pop()
    namespace = {"__file__": str(Path(args.matrix).resolve()), "__name__": "naming_matrix"}
    exec(compile(module, str(args.matrix), "exec"), namespace)
    namespace["TMP"] = str(root)
    namespace["BUN"] = str(Path(args.bun).resolve())
    saved_argv = sys.argv
    log = io.StringIO()
    try:
        sys.argv = [str(args.matrix), str(case_path), str(tree), str(out_path), "upstream-main"]
        with contextlib.redirect_stdout(log):
            namespace["main"]()
    finally:
        sys.argv = saved_argv
    (args.output / "main-harness.log").write_text(log.getvalue())
    results = {}
    addon_versions = set()
    addon_digests = {}
    for line in out_path.read_text().splitlines():
        item = json.loads(line)
        engine = item["engine"]["upstream-main"]
        if engine["hung"] or engine["res"] is None or engine["rc"] != 0:
            raise AssertionError("main probe failed: " + dumps(item))
        res = engine["res"]
        if Path(res["addon"]).resolve().parent != tree / "packages/natives/native":
            raise AssertionError("main loaded an addon outside the specified tree")
        addon_versions.add(res["version"])
        if res["addon"] not in addon_digests:
            with open(res["addon"], "rb") as addon:
                addon_digests[res["addon"]] = hashlib.file_digest(addon, "sha256").hexdigest()
        run = res["results"][0]
        if run.get("error") or run.get("timedOut") or run.get("cancelled"):
            raise AssertionError("main did not finish: " + item["id"] + "; error=" + str(run.get("error")) + "; timedOut=" + str(run.get("timedOut")) + "; cancelled=" + str(run.get("cancelled")))
        data = engine["out"].encode()
        diagnostics, other = decompose(data)
        results[item["id"]] = {"status": run["exitCode"], "stream": "combined-addon", "emitted": blob(data), "diagnostics": diagnostics, "other_output": other, "diagnostic_emitted": bool(diagnostics)}
    # Save normalized observations, not host-specific loader paths or timings.
    metadata = {"measured": True, "revision": revision, "addon_versions": sorted(addon_versions), "addon_sha256": sorted(addon_digests.values()), "row_count": len(results), "harness_sha256": hashlib.sha256(source.encode()).hexdigest(), "scope": "Noninteractive baseline command/source/function/child rows, builtin trap rows, and exact regression probes only. Shell.run returns combined output; no build or worktree edit. Rust sources and Cargo manifests match HEAD.", "limits": "Interactive, script-operand, source-composition, and non-builtin trap controls are not measured in this optional column. A broader initial main sweep reached a nonterminating DEBUG-trap parser probe; the timed-out probe is not rerun."}
    return metadata, results


def comparison(result):
    # PTY prompts are retained for audit but are not diagnostic version differences.
    return {k: result[k] for k in ("status", "emitted", "diagnostics", "other_output")}


def record(args):
    binaries = (args.bash52, args.bash53)
    versions = validate_versions(binaries)
    rows = probes()
    args.output.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="recording-", dir=args.output) as work:
        root = Path(work)
        for row in rows.values():
            try:
                row["bash"] = {v: run_probe(row, b, root) for v, b in zip(VERSIONS, binaries)}
            except BaseException as exc:
                failure = {"row": row, "error": repr(exc)}
                (args.output / "recording-failure.json").write_text(dumps(failure))
                raise RuntimeError("Probe failed: " + row["id"] + "; " + str(exc)) from exc
            row["versions_differ"] = comparison(row["bash"][VERSIONS[0]]) != comparison(row["bash"][VERSIONS[1]])
        if args.verify_existing or args.reuse_main:
            saved = json.loads((args.output / "naming-table.json").read_text())
            main_metadata = saved["upstream_main"]
            main_results = {rid: row["upstream_main"] for rid, row in saved["rows"].items() if "upstream_main" in row}
            for result in main_results.values():
                result["diagnostics"], result["other_output"] = decompose(base64.b64decode(result["emitted"]["base64"]))
        else:
            main_metadata, main_results = measure_main(args, rows, root)
        for rid, result in main_results.items():
            rows[rid]["upstream_main"] = result
    grid = {path: {kind: {version: sum(r["path"] == path and r["kind"] == kind for r in rows.values()) for version in VERSIONS} for kind in KINDS} for path in PATHS}
    assert all(count > 0 for kinds in grid.values() for versions_ in kinds.values() for count in versions_.values())
    differences = [rid for rid, row in rows.items() if row["versions_differ"]]
    result = {"schema": 1, "question": "Exact emitted diagnostic bytes and name/line/context decomposition by path, producer probe, shell interactivity, and Bash version.",
              "environment": {"locale": "C", "argv0": "bash", "startup_files": False, "path": "/usr/bin:/bin", "terminal": "A controlling PTY, ECHO and OPOST disabled, TERM=dumb; terminal-read mode uses canonical input and EOF, not a pipe."},
              "bash_versions": versions, "kinds": KINDS, "modes": list(MODES), "paths": PATHS,
              "row_count": len(rows), "bash_observation_count": 2 * len(rows), "coverage": grid,
              "version_difference_count": len(differences), "version_difference_rows": differences,
              "upstream_main": main_metadata, "rows": rows}
    return result


def inline(value):
    return "`" + json.dumps(value, ensure_ascii=True).replace("|", "\\|").replace("`", "\\u0060") + "`"


def markdown(table):
    out = [
        "# Measured diagnostic naming table", "",
        f"{table['row_count']} stable rows; {table['bash_observation_count']} Bash observations; {table['version_difference_count']} rows differ between Bash versions.", "",
        "## Reproduce", "", "```sh",
        'python3 generate-naming-table.py --bash52 "$BASH52" --bash53 "$BASH53" --output . --reuse-main',
        'python3 generate-naming-table.py --bash52 "$BASH52" --bash53 "$BASH53" --output . --verify-existing',
        "```", "",
        "These commands use the committed table. `--reuse-main` rerecords every Bash row and regenerates the files while preserving the explicitly pinned optional-main observations. `--verify-existing` repeats every Bash probe and byte-compares the complete JSON and Markdown without rewriting them. Neither flag remeasures main. For an initial Bash-only recording, omit both flags. For a fresh optional-main recording, instead add `--main-tree \"$MAIN_TREE\" --matrix \"$MATRIX\" --bun \"$BUN\"`. Use an already built, unmodified upstream main tree. The adapter executes matrix.py's existing functions with only its temporary directory and Bun executable overridden; it does not edit the harness or the tree.", "",
        "## Method and interpretation", "",
        "The JSON is the source of the tables below. Each row contains the complete command and fixture files, full output bytes as text and base64, exit status, and the decomposition of every diagnostic line. JSON escapes are notation, not replacement bytes. `full`, `prologue`, `message`, `newline`, and `context_echo` have byte lengths and base64; prologue + message + newline reconstructs the emitted line. No output, line number, path, or context is normalized.", "",
        "`name` is the first emitted name. `name_segments` preserves each name component in a compound prefix, and `name_segment` joins them exactly: for example, an interactive parser can emit `bash: ./src: line 2: ...`. The name segment there is `bash: ./src`, not just `bash`, and the line marker is present. Labels such as `eval`, `-c`, and `command substitution` are recorded separately. A context line has its exact inner echo in `context_echo`.", "",
        "All Bash runs use argv[0]=bash, no startup files, LC_ALL=C, PATH=/usr/bin:/bin, and fresh fixture directories. Interactive-command rows run -i -c on a controlling pseudo-terminal. Interactive-read rows run -i --noediting and read the probe from the terminal. Script-operand rows run ./run.sh, with and without -i, and therefore have no terminal-read variant. Terminal output is merged, exactly as a user sees it. ECHO and OPOST are disabled so input echo and terminal LF-to-CRLF translation do not alter the measured diagnostic bytes. Full terminal transcripts are retained; only the known prompt and EOF notice are separated from `emitted`. Other command output remains in `other_output`.", "",
        "The four kind names identify producer probes, not four disjoint Bash call graphs: get_name_for_error also supplies error_prolog and builtin_error_prolog. Runtime lookup and general redirection errors both use internal_error/error_prolog; they remain separate semantic rows because a renderer must not invent a builtin-name segment on redirection errors. Syntax in a running function, subshell, or pipeline is triggered by eval; malformed declarations are separate rows because the outer parser rejects them before the activation exists. Command-substitution syntax has both direct-parser and eval-parser rows.", "",
        "A literal here-document body does not execute commands or shell grammar. Its four quoted-body cells, and three unquoted literal controls, explicitly record no diagnostic. An unquoted expansion error and a missing-delimiter warning are additional general-prolog rows. Silence means the supplied probe did not emit a diagnostic; it does not prove no other probe could do so. Top-level RETURN without a function/source return is likewise a measured no-fire control. DEBUG syntax can fire more than once because its invalid body cannot execute a trap-disable command; every emission is retained.", "",
        "Trap rows distinguish top level, a function, a sourced file, three nested sources, and a source that already returned. In nested RETURN rows the same installed trap can run once per returning source; do not flatten those diagnostics to one prefix. EXIT rows include exit from inside a function/source and nested-source unwinding. Function-after-source rows separately measure a live function whose definition source is no longer active. Additional compositions run a function, eval, substitution, subshell, or either pipeline element while one or three source activations remain live.", "",
        "A future renderer change needs a measured row for each new emitted segment and each relevant reachable activation/parser path. This finite table covers the listed paths and probes; it is not an exhaustive inventory of all Bash diagnostic messages or all possible products of nested shell constructs. Bash 5.3.0 is the target for every listed version difference.", "",
        "Bash versions:", "",
    ]
    out += [f"- {v}: {inline(banner)}" for v, banner in table["bash_versions"].items()]
    out += ["", "## Path × kind coverage", "", "Each cell is the number of rows per Bash version (5.2.21 / 5.3.0). These include silent controls. Every primary path has the four kinds in each applicable input mode. The three additional exact RETURN-trap reproductions have kind builtin+parser and are not counted twice in this four-kind grid.", "", "| Path | parser | runtime | builtin | general |", "|---|---:|---:|---:|---:|"]
    for path, kinds in table["coverage"].items():
        out.append("| " + path + " | " + " | ".join(" / ".join(str(kinds[k][v]) for v in VERSIONS) for k in KINDS) + " |")
    out += ["", "## Version differences", "", f"Count: {table['version_difference_count']}. Comparison includes complete emitted bytes and status; prompt bytes are not compared. Each identifier is suitable for citation in the pull-request body.", ""]
    out += ["- " + rid for rid in table["version_difference_rows"]] or ["None observed in these probes."]
    out += ["", "## Optional upstream-main control", "", inline(table["upstream_main"]), "", "Only noninteractive command rows are measured through the addon's Shell.run. Interactive and script-operand cells have no main claim. The complete combined output and status are retained, rather than the harness's normalized comparison.", "", "## Round-six regression boundaries", ""]
    for rid in ("round6-return-exact.noninteractive", "round6-heredoc-exact.noninteractive"):
        row = table["rows"][rid]
        out += ["### " + rid, "", "```bash", row["command"], "```", "", "Fixture files: " + inline(row["files"]), ""]
        for version, result in row["bash"].items():
            out += [f"Bash {version}, status {result['status']}, exact diagnostic bytes:", "", "```json", json.dumps(result["emitted"]["text"], ensure_ascii=True), "```", ""]
        if "upstream_main" in row:
            result = row["upstream_main"]
            out += [f"Main, status {result['status']}, exact combined bytes:", "", "```json", json.dumps(result["emitted"]["text"], ensure_ascii=True), "```", ""]
    out += ["## Complete row table", "", "Open the JSON row with the same identifier for its executable probe and fixture bytes. `name; line; labels; echo` below lists each emitted line in order. A null line means no `line N` segment. A null echo means the line is not a parser-context line. `none` is a measured no-diagnostic cell, not an omission. Full emitted output is a JSON string, including every newline.", "", "| Row | Bash 5.2.21: full output; decomposition | Bash 5.3.0: full output; decomposition | Main combined output | Versions differ |", "|---|---|---|---|---|"]
    for rid, row in table["rows"].items():
        cells = []
        for version in VERSIONS:
            result = row["bash"][version]
            segments = [{"name": d["name_segment"], "line": d["line"], "labels": d["labels"], "echo": d["context_echo"]["text"] if d["context_echo"] else None} for d in result["diagnostics"]]
            cells.append(inline(result["emitted"]["text"]) + "; " + (inline(segments) if segments else "none"))
        main = inline(row["upstream_main"]["emitted"]["text"]) if "upstream_main" in row else "not measured"
        mark = "yes — 5.3 wins" if row["versions_differ"] else "no"
        if row["regressions"]:
            mark += "; " + ", ".join(row["regressions"])
        out.append("| " + rid + " | " + " | ".join(cells) + " | " + main + " | " + mark + " |")
    return "\n".join(out) + "\n"


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--bash52", required=True)
    parser.add_argument("--bash53", required=True)
    parser.add_argument("--output", type=Path, default=Path(__file__).resolve().parent)
    parser.add_argument("--verify-existing", action="store_true")
    parser.add_argument("--main-tree")
    parser.add_argument("--matrix")
    parser.add_argument("--bun")
    parser.add_argument("--reuse-main", action="store_true", help="Rerecord all Bash rows while preserving existing, pinned optional-main observations")
    args = parser.parse_args()
    args.output = args.output.resolve()
    table = record(args)
    encoded = dumps(table).encode()
    report = markdown(table).encode()
    if args.verify_existing:
        original = (args.output / "naming-table.json").read_bytes()
        original_md = (args.output / "naming-table.md").read_bytes()
        if original != encoded or original_md != report:
            (args.output / "reproduction-candidate.json").write_bytes(encoded)
            (args.output / "reproduction-candidate.md").write_bytes(report)
            raise AssertionError("Rerun differs; inspect reproduction-candidate files")
    else:
        (args.output / "naming-table.json").write_bytes(encoded)
        (args.output / "naming-table.md").write_bytes(report)
    receipt = {"operation": "verify-existing" if args.verify_existing else "record", "rows": table["row_count"], "bash_observations": table["bash_observation_count"], "version_differences": table["version_difference_count"], "main_rows": table["upstream_main"].get("row_count", 0), "json_sha256": hashlib.sha256(encoded).hexdigest(), "markdown_sha256": hashlib.sha256(report).hexdigest(), "identical_json": True if args.verify_existing else None, "identical_markdown": True if args.verify_existing else None}
    (args.output / ("reproduction-receipt.json" if args.verify_existing else "recording-receipt.json")).write_text(dumps(receipt))
    print(dumps(receipt), end="")


if __name__ == "__main__":
    main()
