import { expect, it } from "bun:test";
import * as path from "node:path";
import { pythonPath } from "./python";

const PY = path.join(import.meta.dir, "../../bench/memory-eval/py");

it.skipIf(pythonPath === undefined).each(["local", "global"])(
	"rejects untracked evaluator code hidden by %s Git configuration, but accepts the clean pin",
	async scope => {
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
    git("-c", "user.name=pin-test", "-c", "user.email=pin-test@example.invalid", "-c", "core.hooksPath=" + str(home / "no-hooks"), "commit", "-q", "--allow-empty", "-m", "pinned")
    commit = git("rev-parse", "HEAD")
    git("config", "--" + sys.argv[2], "status.showUntrackedFiles", "no")
    require_pinned(repo, commit)
    print("clean pin accepted", flush=True)
    (repo / "shadow_module.py").write_text("raise RuntimeError('untracked evaluator code')\\n")
    require_pinned(repo, commit)
`,
				PY,
				scope,
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
		expect(stderr).toContain("has local changes");
	},
);
