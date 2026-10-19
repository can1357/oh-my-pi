import { expect, it } from "bun:test";
import * as path from "node:path";
import { pythonPath } from "./python";

const PY = path.join(import.meta.dir, "../../bench/memory-eval/py");

it.skipIf(pythonPath === undefined).each([
	["untracked code hidden by local status config", "local", "has local changes"],
	["untracked code hidden by global status config", "global", "has local changes"],
	["a tracked edit hidden by assume-unchanged", "--assume-unchanged", "index flags hide changes to ['evaluator.py']"],
	["a tracked edit hidden by skip-worktree", "--skip-worktree", "index flags hide changes to ['evaluator.py']"],
	["an edit hidden by core.worktree pointing at another clean tree", "core.worktree", "work tree is"],
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
    require_pinned(repo, commit)
    print("clean pin accepted", flush=True)
    mode = sys.argv[2]
    if mode == "core.worktree":
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
