import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
	sanitizeTmuxWindowName,
	type TmuxCommandRunner,
	TmuxWindowNamer,
} from "@oh-my-pi/pi-coding-agent/utils/tmux-session";

interface RecordingRunner extends TmuxCommandRunner {
	calls: string[][];
	captured: string | undefined;
}

function createRunner(captured: string | undefined = "shell\t1"): RecordingRunner {
	const calls: string[][] = [];
	return {
		calls,
		captured,
		async run(args) {
			calls.push(args);
		},
		captureSync(args) {
			calls.push(args);
			return this.captured;
		},
		runSync(args) {
			calls.push(args);
		},
	};
}

let runner: RecordingRunner;
let namer: TmuxWindowNamer;
/**
 * `TMUX_PANE` feeds `getTerminalId()`, which keys the terminal-session
 * breadcrumbs every SessionManager suite reads. Restore whatever the developer's
 * shell actually had instead of deleting, so running this file inside tmux does
 * not strip that identity from every test file after it in the same process.
 */
const ambientTmuxEnv = { TMUX: Bun.env.TMUX, TMUX_PANE: Bun.env.TMUX_PANE };

beforeEach(() => {
	runner = createRunner();
	namer = new TmuxWindowNamer(runner);
	namer.setEnabled(true);
	Bun.env.TMUX = "/tmp/tmux-1000/default,1234,0";
	Bun.env.TMUX_PANE = "%7";
});

afterEach(() => {
	// Also cancels the postmortem cleanup the namer registers on first capture,
	// so a namer from this suite never fires against the real tmux at exit.
	namer.restore();
	for (const [key, value] of Object.entries(ambientTmuxEnv)) {
		if (value === undefined) delete Bun.env[key];
		else Bun.env[key] = value;
	}
});

/** Every `rename-window` argv the runner saw, in order. */
function renamedNames(): string[] {
	return runner.calls.filter(args => args[0] === "rename-window").map(args => args[4] as string);
}

describe("sanitizeTmuxWindowName", () => {
	it("keeps dots and colons, which tmux only treats as separators in `-t` targets", () => {
		expect(sanitizeTmuxWindowName("Refactor: the parser")).toBe("Refactor: the parser");
		expect(sanitizeTmuxWindowName("feat: fix.thing")).toBe("feat: fix.thing");
		expect(sanitizeTmuxWindowName("v1.2.3")).toBe("v1.2.3");
	});

	it("strips control characters so a session name cannot inject terminal escapes", () => {
		expect(sanitizeTmuxWindowName("safe\u001b]0;evil\u0007name")).toBe("safe]0;evilname");
		expect(sanitizeTmuxWindowName("tab\tsep\u007f")).toBe("tabsep");
	});

	it("collapses whitespace runs and trims", () => {
		expect(sanitizeTmuxWindowName("  refactor   the    parser  ")).toBe("refactor the parser");
	});

	it("caps the name at 64 characters", () => {
		const sanitized = sanitizeTmuxWindowName("a".repeat(100));
		expect(sanitized).toHaveLength(64);
	});

	it("returns undefined when nothing survives sanitizing", () => {
		expect(sanitizeTmuxWindowName("\u0000\u0007")).toBeUndefined();
		expect(sanitizeTmuxWindowName("   ")).toBeUndefined();
		expect(sanitizeTmuxWindowName(undefined)).toBeUndefined();
	});
});

describe("TmuxWindowNamer.sync", () => {
	it("renames the window addressed by TMUX_PANE with an argv array", async () => {
		namer.sync("Refactor: the parser", "/tmp/project");
		await namer.drain();

		expect(runner.calls).toContainEqual(["rename-window", "-t", "%7", "--", "Refactor: the parser"]);
	});

	it("passes `--` so a name starting with `-` is not parsed as a tmux flag", async () => {
		namer.sync("-debug", "/tmp/project");
		await namer.drain();

		expect(runner.calls).toContainEqual(["rename-window", "-t", "%7", "--", "-debug"]);
	});

	it("falls back to the cwd basename when the session name sanitizes away", async () => {
		namer.sync("\u0000", "/tmp/my-project");
		await namer.drain();

		expect(renamedNames()).toEqual(["my-project"]);
	});

	it("falls back to the cwd basename when the session is unnamed", async () => {
		namer.sync(undefined, "/tmp/my-project/");
		await namer.drain();

		expect(renamedNames()).toEqual(["my-project"]);
	});

	it("captures the original window name before the first rename", async () => {
		namer.sync("first", "/tmp/project");
		await namer.drain();

		expect(runner.calls[0]).toEqual(["display-message", "-p", "-t", "%7", "#{window_name}\t#{automatic-rename}"]);
		expect(runner.calls[1]).toEqual(["rename-window", "-t", "%7", "--", "first"]);
	});

	it("captures only once across repeated renames", async () => {
		namer.sync("first", "/tmp/project");
		namer.sync("second", "/tmp/project");
		await namer.drain();

		expect(runner.calls.filter(args => args[0] === "display-message")).toHaveLength(1);
		expect(renamedNames()).toEqual(["first", "second"]);
	});

	it("is a no-op when the sanitized name is unchanged", async () => {
		namer.sync("same name", "/tmp/project");
		await namer.drain();
		// Sanitizing collapses both spellings onto the same window name.
		namer.sync("same   name", "/tmp/project");
		await namer.drain();

		expect(renamedNames()).toEqual(["same name"]);
	});

	it("is a no-op outside tmux", async () => {
		delete Bun.env.TMUX;
		namer.sync("session", "/tmp/project");
		await namer.drain();

		expect(runner.calls).toEqual([]);
	});

	it("is a no-op without TMUX_PANE", async () => {
		delete Bun.env.TMUX_PANE;
		namer.sync("session", "/tmp/project");
		await namer.drain();

		expect(runner.calls).toEqual([]);
	});

	it("is a no-op when the setting is disabled", async () => {
		namer.setEnabled(false);
		namer.sync("session", "/tmp/project");
		await namer.drain();

		expect(runner.calls).toEqual([]);
	});

	it("keeps two in-process namers from sharing capture or restore state", async () => {
		const otherRunner = createRunner("build\t0");
		const other = new TmuxWindowNamer(otherRunner);
		other.setEnabled(true);

		namer.sync("first", "/tmp/project");
		other.sync("second", "/tmp/project");
		await Promise.all([namer.drain(), other.drain()]);
		// One namer shutting down must not clear the other's restore target.
		other.restore();
		runner.calls.length = 0;
		namer.restore();

		expect(otherRunner.calls).toContainEqual(["rename-window", "-t", "%7", "--", "build"]);
		expect(runner.calls).toEqual([
			["rename-window", "-t", "%7", "--", "shell"],
			["set-window-option", "-t", "%7", "automatic-rename", "on"],
		]);
	});
});

describe("TmuxWindowNamer.restore", () => {
	it("restores the captured name and automatic-rename state", async () => {
		namer.sync("session", "/tmp/project");
		await namer.drain();
		runner.calls.length = 0;

		namer.restore();
		await namer.drain();

		expect(runner.calls).toEqual([
			["rename-window", "-t", "%7", "--", "shell"],
			["set-window-option", "-t", "%7", "automatic-rename", "on"],
		]);
	});

	it("restores synchronously, because the caller exits the process immediately after", async () => {
		namer.sync("session", "/tmp/project");
		await namer.drain();
		runner.calls.length = 0;

		// Deliberately NOT awaited: an enqueued async spawn never runs once the
		// shutdown path calls process.exit, stranding the window on the omp name
		// with automatic-rename left off.
		namer.restore();

		expect(runner.calls).toEqual([
			["rename-window", "-t", "%7", "--", "shell"],
			["set-window-option", "-t", "%7", "automatic-rename", "on"],
		]);
	});

	it("restores an original name starting with `-` behind `--`", async () => {
		runner.captured = "-shell\t0";
		namer.sync("session", "/tmp/project");
		await namer.drain();
		runner.calls.length = 0;

		namer.restore();

		expect(runner.calls).toEqual([
			["rename-window", "-t", "%7", "--", "-shell"],
			["set-window-option", "-t", "%7", "automatic-rename", "off"],
		]);
	});

	it("restores automatic-rename off when the window was explicitly named", async () => {
		runner.captured = "build\t0";
		namer.sync("session", "/tmp/project");
		await namer.drain();
		runner.calls.length = 0;

		namer.restore();
		await namer.drain();

		expect(runner.calls).toEqual([
			["rename-window", "-t", "%7", "--", "build"],
			["set-window-option", "-t", "%7", "automatic-rename", "off"],
		]);
	});

	it("skips restore when the original window could not be captured", async () => {
		runner.captured = undefined;
		namer.sync("session", "/tmp/project");
		await namer.drain();
		runner.calls.length = 0;

		namer.restore();
		await namer.drain();

		expect(runner.calls).toEqual([]);
	});

	it("skips restore when no rename ever happened", async () => {
		namer.restore();
		await namer.drain();

		expect(runner.calls).toEqual([]);
	});

	/**
	 * Regression for a shutdown that begins before the queued rename has run.
	 * The original name is captured synchronously, so restore always has its
	 * target, and the queued rename must not re-apply the omp name afterwards.
	 */
	it("restores, and drops the still-queued rename, when shutdown beats the queue", async () => {
		namer.sync("session", "/tmp/project");
		// No drain: the rename is still sitting in the queue.
		namer.restore();

		expect(runner.calls).toEqual([
			["display-message", "-p", "-t", "%7", "#{window_name}\t#{automatic-rename}"],
			["rename-window", "-t", "%7", "--", "shell"],
			["set-window-option", "-t", "%7", "automatic-rename", "on"],
		]);

		await namer.drain();

		expect(renamedNames()).toEqual(["shell"]);
	});

	it("ignores a rename requested after restore", async () => {
		namer.sync("session", "/tmp/project");
		await namer.drain();
		namer.restore();
		runner.calls.length = 0;

		namer.sync("later", "/tmp/project");
		await namer.drain();

		expect(runner.calls).toEqual([]);
	});
});
