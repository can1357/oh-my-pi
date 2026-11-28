/**
 * The OOM adjustment of tool processes on Linux.
 *
 * A tool process (a shell process, a kernel, a probe, a shell that reads
 * the user's rc files) runs with `oom_score_adj` 1000, the kernel's
 * maximum, and what it starts inherits the value: when the kernel picks one
 * process to kill for lack of memory, it kills a tool process before Oh My
 * Pi. A cgroup killed as a whole (`memory.oom.group=1`) takes Oh My Pi too.
 *
 * The tool process sets its own value in the first code it runs, which Oh
 * My Pi supplies (an entry of this build, a shell's `-c` string), so Oh My
 * Pi spawns the program itself: the spawn reports the program's own exec
 * error, and Oh My Pi's value does not change. A program whose first code
 * is not Oh My Pi's, or that runs code of its own before it (Python's
 * `sitecustomize`), starts through the launcher of `ptree.ts`
 * (`spawnToolProcess`, `exec`'s `toolOomScore`), which sets the value before
 * the program's exec.
 */
import * as fs from "node:fs";

/**
 * Give this process the OOM adjustment of tool processes (Linux), best
 * effort: where the write is refused, the value stays. Only for the first
 * code of a tool process: Oh My Pi itself keeps its value. `score` is the
 * file to write, the process's own adjustment.
 */
export function setToolOomScore(score = "/proc/self/oom_score_adj"): void {
	if (process.platform !== "linux") return;
	try {
		fs.writeFileSync(score, "1000");
	} catch {
		// No writable /proc, or a refused value: the process keeps its own.
	}
}

/**
 * `script`, a shell's `-c` string, run as a tool process: on Linux it first
 * sets the shell's own OOM adjustment, which what the script starts
 * inherits. `posix` is sh, bash and zsh syntax: `>|` writes past
 * `noclobber`, and a refused write says nothing. The script starts with
 * status 0 in both syntaxes, whether or not the write took. `score` is the
 * file the shell writes, its own adjustment, as one shell word. Off Linux
 * `script` is returned as it is.
 */
export function toolShellScript(
	script: string,
	syntax: "posix" | "fish" = "posix",
	score = "/proc/self/oom_score_adj",
): string {
	if (process.platform !== "linux") return script;
	const prelude =
		syntax === "fish"
			? `test -w ${score}; and printf 1000 > ${score}; true`
			: `{ printf 1000 >| ${score}; } 2>/dev/null || :`;
	// One line: the script's own line numbers stay the ones its errors name.
	return `${prelude}; ${script}`;
}
