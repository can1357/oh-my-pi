import { expect, it } from "bun:test";
import * as path from "node:path";
import { pythonPath } from "./python";

const PY = path.join(import.meta.dir, "../../bench/memory-eval/py");

it.skipIf(pythonPath === undefined).each([
	["untracked code hidden by local status config", "local", "does not have: ['shadow_module.py']"],
	["untracked code hidden by global status config", "global", "does not have: ['shadow_module.py']"],
	["a tracked edit hidden by assume-unchanged", "--assume-unchanged", "has local changes to ['evaluator.py']"],
	["a tracked edit hidden by skip-worktree", "--skip-worktree", "has local changes to ['evaluator.py']"],
	[
		"an edit hidden by core.worktree pointing at another clean tree",
		"core.worktree",
		"has local changes to ['evaluator.py']",
	],
	["an ignored shadow module", "ignored", "does not have: ['numpy.py']"],
	["an edit hidden by a clean filter", "filter", "has local changes to ['evaluator.py']"],
])("rejects %s, but accepts the clean pin", async (_name, mode, refusal) => {
	const proc = Bun.spawn(
		[
			pythonPath!,
			"-c",
			`
import os
import subprocess
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, sys.argv[1])
from pinned_source import require_pinned

with tempfile.TemporaryDirectory(prefix="memory-eval-pin-") as tmp:
    home = Path(tmp)
    os.environ.update(HOME=tmp, USERPROFILE=tmp, XDG_CONFIG_HOME=str(home / "config"))
    for key in list(os.environ):
        if key.upper().startswith("GIT_"):
            del os.environ[key]
    os.environ["GIT_CONFIG_NOSYSTEM"] = "1"
    repo = home / "evaluator"
    repo.mkdir()
    def git(*args):
        return subprocess.run(["git", "-C", str(repo), *args], check=True, capture_output=True, text=True).stdout.strip()
    git("init", "-q")
    (repo / "evaluator.py").write_text("PINNED = True\\n")
    git("add", "evaluator.py")
    git("-c", "user.name=pin-test", "-c", "user.email=pin-test@example.invalid", "-c", "core.hooksPath=" + str(home / "no-hooks"), "commit", "-q", "-m", "pinned")
    commit = git("rev-parse", "HEAD")
    # Running the evaluator leaves ignored bytecode caches; those must not count as a modified checkout.
    (repo / ".git" / "info" / "exclude").write_text("__pycache__/\\nnumpy.py\\n")
    (repo / "__pycache__").mkdir()
    (repo / "__pycache__" / "evaluator.cpython-313.pyc").write_bytes(b"cache")
    require_pinned(repo, commit)
    print("clean pin accepted", flush=True)
    mode = sys.argv[2]
    if mode == "ignored":
        (repo / "numpy.py").write_text("raise RuntimeError('ignored shadow dependency')\\n")
    elif mode == "filter":
        # A clean filter that always yields the pinned bytes makes git see the pinned blob whatever is on disk.
        # The edit keeps the size: git counts a size change as modified without running the filter.
        (repo / ".git" / "info" / "attributes").write_text("evaluator.py filter=hide\\n")
        git("config", "filter.hide.clean", "printf 'PINNED = True\\\\n'")
        (repo / "evaluator.py").write_text("PINNED = 9999\\n")
        assert git("status", "--porcelain") == "", "the filter should hide the edit from git status"
    elif mode == "core.worktree":
        other = home / "other"
        other.mkdir()
        (other / "evaluator.py").write_text("PINNED = True\\n")
        git("config", "core.worktree", str(other))
        (repo / "evaluator.py").write_text("raise RuntimeError('edited evaluator code')\\n")
    elif mode.startswith("--"):
        git("update-index", mode, "evaluator.py")
        (repo / "evaluator.py").write_text("raise RuntimeError('edited evaluator code')\\n")
    else:
        git("config", "--" + mode, "status.showUntrackedFiles", "no")
        (repo / "shadow_module.py").write_text("raise RuntimeError('untracked evaluator code')\\n")
    require_pinned(repo, commit)
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
	expect(stdout.trim()).toBe("clean pin accepted");
	expect(code).toBe(1);
	expect(stderr).toContain(refusal);
});

// CPython trusts a cached .pyc whose source has the recorded mtime and size, without comparing contents.
it.skipIf(pythonPath === undefined)("runs the pinned source, not bytecode cached from an edited copy", async () => {
	const proc = Bun.spawn(
		[
			pythonPath!,
			"-c",
			`
import os
import subprocess
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, sys.argv[1])
from pinned_source import require_pinned

with tempfile.TemporaryDirectory(prefix="memory-eval-pyc-") as tmp:
    home = Path(tmp)
    for key in list(os.environ):
        if key.upper().startswith("GIT_"):
            del os.environ[key]
    os.environ.update(HOME=tmp, XDG_CONFIG_HOME=str(home / "config"), GIT_CONFIG_NOSYSTEM="1")
    repo = home / "evaluator"
    repo.mkdir()
    def git(*args):
        return subprocess.run(["git", "-C", str(repo), *args], check=True, capture_output=True, text=True).stdout.strip()
    git("init", "-q")
    (repo / ".gitignore").write_text("__pycache__/\\n")
    source = repo / "scorer.py"
    source.write_text("VALUE = 1\\n")
    git("add", ".gitignore", "scorer.py")
    git("-c", "user.name=t", "-c", "user.email=t@example.invalid", "-c", "core.hooksPath=" + str(home / "no-hooks"), "commit", "-q", "-m", "pinned")
    commit = git("rev-parse", "HEAD")
    stamp = 1_700_000_000
    # Cache bytecode from an edited copy of the same size and mtime, then restore the pinned source.
    source.write_text("VALUE = 2\\n")
    os.utime(source, (stamp, stamp))
    subprocess.run([sys.executable, "-c", "import scorer"], cwd=repo, check=True)
    source.write_text("VALUE = 1\\n")
    os.utime(source, (stamp, stamp))
    require_pinned(repo, commit)
    sys.path.insert(0, str(repo))
    import scorer
    print(scorer.VALUE)
`,
			PY,
		],
		{ stdout: "pipe", stderr: "pipe" },
	);
	const [code, stdout, stderr] = await Promise.all([
		proc.exited,
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
	]);
	expect(stderr).toBe("");
	expect(code).toBe(0);
	expect(stdout.trim()).toBe("1");
});
