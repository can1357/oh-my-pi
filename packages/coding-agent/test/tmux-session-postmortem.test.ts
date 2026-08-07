import { describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/**
 * Renames the window through a `TmuxWindowNamer`, then signals itself. Every
 * tmux argv is appended to `TMUX_PROBE_LOG` so the parent can assert what the
 * child did after it is gone.
 */
const PROBE = `
import { appendFileSync } from "node:fs";
import { TmuxWindowNamer } from "@oh-my-pi/pi-coding-agent/utils/tmux-session";

const log = process.env.TMUX_PROBE_LOG;
const record = args => appendFileSync(log, \`\${JSON.stringify(args)}\\n\`);
const namer = new TmuxWindowNamer({
	async run(args) { record(args); },
	captureSync(args) { record(args); return "shell\\t1"; },
	runSync(args) { record(args); },
});
namer.setEnabled(true);
namer.sync("probe session", "/tmp/project");
await namer.drain();
process.kill(process.pid, "SIGTERM");
// Keep the child event loop alive so the platform can deliver the signal.
// A real kernel signal cannot be driven by fake timers.
await Bun.sleep(10_000);
`;

/**
 * `InteractiveMode.shutdown()` never runs on SIGINT/SIGTERM/SIGHUP or a fatal
 * error — postmortem runs its registered callbacks and exits — so the tmux
 * window restore has to reach the window from that path too.
 *
 * Exercised in a real child process: `postmortem.cleanup()` latches its stage
 * for the lifetime of the process, so triggering it in-process would poison
 * every later test in the same worker.
 */
describe("TmuxWindowNamer postmortem restore", () => {
	it("restores the window when a signal kills the process without shutdown()", async () => {
		const logFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "omp-tmux-probe-")), "calls.jsonl");
		const proc = Bun.spawn([process.execPath, "-e", PROBE], {
			cwd: path.resolve(import.meta.dir, "../../.."),
			env: {
				...process.env,
				TMUX: "/tmp/tmux-1000/default,1234,0",
				TMUX_PANE: "%7",
				TMUX_PROBE_LOG: logFile,
			},
			stdin: "ignore",
			stdout: "ignore",
			stderr: "pipe",
		});
		// Real process signals cannot use fake timers; this only bounds a wedged child.
		const watchdog = setTimeout(() => proc.kill("SIGKILL"), 15_000);
		let stderr = "";
		try {
			[, stderr] = await Promise.all([proc.exited, new Response(proc.stderr).text()]);
		} finally {
			clearTimeout(watchdog);
		}

		const calls = fs
			.readFileSync(logFile, "utf8")
			.split("\n")
			.filter(Boolean)
			.map(line => JSON.parse(line) as string[]);

		expect(stderr).toBe("");
		expect(calls).toEqual([
			["display-message", "-p", "-t", "%7", "#{window_name}\t#{automatic-rename}"],
			["rename-window", "-t", "%7", "--", "probe session"],
			["rename-window", "-t", "%7", "--", "shell"],
			["set-window-option", "-t", "%7", "automatic-rename", "on"],
		]);
	}, 30_000);
});
