import { expect, it } from "bun:test";
import * as path from "node:path";
import { pythonPath } from "./python";

const PY = path.join(import.meta.dir, "../../bench/memory-eval/py");

/** Runs `body` (Python) after building a one-commit repo `repo` holding `evaluator.py` (`PINNED = True`). */
async function inRepo(mode: string, body: string): Promise<{ code: number; stdout: string; stderr: string }> {
	const proc = Bun.spawn(
		[
			pythonPath!,
			"-c",
			`
import os
import subprocess
import sys
import tempfile
import zlib
from pathlib import Path

sys.path.insert(0, sys.argv[1])
from pinned_source import pinned_snapshot

with tempfile.TemporaryDirectory(prefix="memory-eval-pin-") as tmp:
    home = Path(tmp)
    for key in list(os.environ):
        if key.upper().startswith("GIT_"):
            del os.environ[key]
    os.environ.update(HOME=tmp, USERPROFILE=tmp, XDG_CONFIG_HOME=str(home / "config"), GIT_CONFIG_NOSYSTEM="1")
    repo = home / "evaluator"
    repo.mkdir()
    def git(*args):
        return subprocess.run(["git", "-C", str(repo), *args], check=True, capture_output=True, text=True).stdout.strip()
    git("init", "-q")
    (repo / "evaluator.py").write_text("PINNED = True\\n")
    git("add", "evaluator.py")
    git("-c", "user.name=t", "-c", "user.email=t@example.invalid", "-c", "core.hooksPath=" + str(home / "no-hooks"), "commit", "-q", "-m", "pinned")
    commit = git("rev-parse", "HEAD")
    mode = sys.argv[2]
${body}
`,
			PY,
			mode,
		],
		{ stdout: "pipe", stderr: "pipe" },
	);
	const [code, stdout, stderr] = await Promise.all([
		proc.exited,
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
	]);
	return { code, stdout: stdout.trim(), stderr };
}

// Each mode edits or shadows the evaluator in the clone in a way git status does not report (or, for CRLF, in a
// way that is not an edit at all). The snapshot must hold exactly the pinned files either way.
const TAMPER = `
    if mode in ("local", "global"):
        git("config", "--" + mode, "status.showUntrackedFiles", "no")
        (repo / "shadow_module.py").write_text("SHADOW = True\\n")
    elif mode == "ignored":
        (repo / ".git" / "info" / "exclude").write_text("shadow_module.py\\n")
        (repo / "shadow_module.py").write_text("SHADOW = True\\n")
    elif mode.startswith("--"):
        git("update-index", mode, "evaluator.py")
        (repo / "evaluator.py").write_text("PINNED = 9999\\n")
    elif mode == "core.worktree":
        other = home / "other"
        other.mkdir()
        (other / "evaluator.py").write_text("PINNED = True\\n")
        git("config", "core.worktree", str(other))
        (repo / "evaluator.py").write_text("PINNED = 9999\\n")
    elif mode == "filter":
        # A clean filter yielding the pinned bytes hides a same-size edit from git status.
        (repo / ".git" / "info" / "attributes").write_text("evaluator.py filter=hide\\n")
        git("config", "filter.hide.clean", "printf 'PINNED = True\\\\n'")
        (repo / "evaluator.py").write_text("PINNED = 9999\\n")
    elif mode == "crlf":
        # Git for Windows' default: LF blobs, CRLF on disk, and a clean status.
        git("config", "core.autocrlf", "true")
        (repo / "evaluator.py").unlink()
        git("checkout", "--", "evaluator.py")
        assert (repo / "evaluator.py").read_bytes() == b"PINNED = True\\r\\n"
    elif mode == "stale-pyc":
        # CPython trusts a cached .pyc whose source has the recorded size and mtime, without comparing contents.
        stamp = 1_700_000_000
        source = repo / "evaluator.py"
        source.write_text("PINNED = 9999\\n")
        os.utime(source, (stamp, stamp))
        subprocess.run([sys.executable, "-c", "import evaluator"], cwd=repo, check=True)
        source.write_text("PINNED = True\\n")
        os.utime(source, (stamp, stamp))
    source = pinned_snapshot(repo, commit)
    sys.path.insert(0, str(source))
    import evaluator
    print(evaluator.PINNED, (source / "shadow_module.py").exists(), (source / "evaluator.py").read_bytes())
`;

it.skipIf(pythonPath === undefined).each([
	["untracked code hidden by local status config", "local"],
	["untracked code hidden by global status config", "global"],
	["an ignored shadow module", "ignored"],
	["a tracked edit hidden by assume-unchanged", "--assume-unchanged"],
	["a tracked edit hidden by skip-worktree", "--skip-worktree"],
	["an edit hidden by core.worktree pointing at another clean tree", "core.worktree"],
	["a same-size edit hidden by a clean filter", "filter"],
	["a clean CRLF checkout", "crlf"],
	["bytecode cached from an edited copy", "stale-pyc"],
])("imports exactly the pinned files despite %s", async (_name, mode) => {
	const { code, stdout, stderr } = await inRepo(mode, TAMPER);
	expect(stderr).toBe("");
	expect(code).toBe(0);
	expect(stdout).toBe("True False b'PINNED = True\\n'");
});

it.skipIf(pythonPath === undefined)("refuses a commit the clone does not hold", async () => {
	const { code, stderr } = await inRepo("missing", `    pinned_snapshot(repo, "0" * 40)`);
	expect(code).toBe(1);
	expect(stderr).toContain("cannot read commit 0000000000000000000000000000000000000000");
});

it.skipIf(pythonPath === undefined)("refuses an object file rewritten with other bytes", async () => {
	const { code, stderr } = await inRepo(
		"corrupt",
		`
    blob = git("rev-parse", "HEAD:evaluator.py")
    object_path = repo / ".git" / "objects" / blob[:2] / blob[2:]
    object_path.chmod(0o644)
    object_path.write_bytes(zlib.compress(b"blob 14\\0PINNED = 9999\\n"))
    pinned_snapshot(repo, commit)
`,
	);
	expect(code).toBe(1);
	expect(stderr).toContain("for evaluator.py does not match its id");
});
