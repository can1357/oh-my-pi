import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
	drainTmuxWindowQueue,
	restoreTmuxWindowName,
	sanitizeTmuxWindowName,
	setTmuxCommandRunnerForTesting,
	setTmuxWindowName,
	setTmuxWindowNameEnabled,
	type TmuxCommandRunner,
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
		async capture(args) {
			calls.push(args);
			return this.captured;
		},
		runSync(args) {
			calls.push(args);
		},
	};
}

let runner: RecordingRunner;

beforeEach(() => {
	runner = createRunner();
	setTmuxCommandRunnerForTesting(runner);
	setTmuxWindowNameEnabled(true);
	Bun.env.TMUX = "/tmp/tmux-1000/default,1234,0";
	Bun.env.TMUX_PANE = "%7";
});

afterEach(() => {
	setTmuxCommandRunnerForTesting(undefined);
	setTmuxWindowNameEnabled(false);
	delete Bun.env.TMUX;
	delete Bun.env.TMUX_PANE;
});

/** Every `rename-window` argv the runner saw, in order. */
function renamedNames(): string[] {
	return runner.calls.filter(args => args[0] === "rename-window").map(args => args[3] as string);
}

describe("sanitizeTmuxWindowName", () => {
	it("strips dots and colons, which break later `-t <name>` lookups", () => {
		expect(sanitizeTmuxWindowName("feat: fix.thing")).toBe("feat fixthing");
		expect(sanitizeTmuxWindowName("v1.2.3")).toBe("v123");
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
		expect(sanitizeTmuxWindowName("...")).toBeUndefined();
		expect(sanitizeTmuxWindowName("   ")).toBeUndefined();
		expect(sanitizeTmuxWindowName(undefined)).toBeUndefined();
	});
});

describe("setTmuxWindowName", () => {
	it("renames the window addressed by TMUX_PANE with an argv array", async () => {
		setTmuxWindowName("Refactor: the parser", "/tmp/project");
		await drainTmuxWindowQueue();

		expect(runner.calls).toContainEqual(["rename-window", "-t", "%7", "Refactor the parser"]);
	});

	it("falls back to the cwd basename when the session name sanitizes away", async () => {
		setTmuxWindowName("...", "/tmp/my-project");
		await drainTmuxWindowQueue();

		expect(renamedNames()).toEqual(["my-project"]);
	});

	it("falls back to the cwd basename when the session is unnamed", async () => {
		setTmuxWindowName(undefined, "/tmp/my-project/");
		await drainTmuxWindowQueue();

		expect(renamedNames()).toEqual(["my-project"]);
	});

	it("captures the original window name before the first rename", async () => {
		setTmuxWindowName("first", "/tmp/project");
		await drainTmuxWindowQueue();

		expect(runner.calls[0]).toEqual(["display-message", "-p", "-t", "%7", "#{window_name}\t#{automatic-rename}"]);
		expect(runner.calls[1]).toEqual(["rename-window", "-t", "%7", "first"]);
	});

	it("captures only once across repeated renames", async () => {
		setTmuxWindowName("first", "/tmp/project");
		setTmuxWindowName("second", "/tmp/project");
		await drainTmuxWindowQueue();

		expect(runner.calls.filter(args => args[0] === "display-message")).toHaveLength(1);
		expect(renamedNames()).toEqual(["first", "second"]);
	});

	it("is a no-op when the sanitized name is unchanged", async () => {
		setTmuxWindowName("same name", "/tmp/project");
		await drainTmuxWindowQueue();
		// Sanitizing collapses both spellings onto the same window name.
		setTmuxWindowName("same   name", "/tmp/project");
		await drainTmuxWindowQueue();

		expect(renamedNames()).toEqual(["same name"]);
	});

	it("is a no-op outside tmux", async () => {
		delete Bun.env.TMUX;
		setTmuxWindowName("session", "/tmp/project");
		await drainTmuxWindowQueue();

		expect(runner.calls).toEqual([]);
	});

	it("is a no-op without TMUX_PANE", async () => {
		delete Bun.env.TMUX_PANE;
		setTmuxWindowName("session", "/tmp/project");
		await drainTmuxWindowQueue();

		expect(runner.calls).toEqual([]);
	});

	it("is a no-op when the setting is disabled", async () => {
		setTmuxWindowNameEnabled(false);
		setTmuxWindowName("session", "/tmp/project");
		await drainTmuxWindowQueue();

		expect(runner.calls).toEqual([]);
	});
});

describe("restoreTmuxWindowName", () => {
	it("restores the captured name and automatic-rename state", async () => {
		setTmuxWindowName("session", "/tmp/project");
		await drainTmuxWindowQueue();
		runner.calls.length = 0;

		restoreTmuxWindowName();
		await drainTmuxWindowQueue();

		expect(runner.calls).toEqual([
			["rename-window", "-t", "%7", "shell"],
			["set-window-option", "-t", "%7", "automatic-rename", "on"],
		]);
	});

	it("restores synchronously, because the caller exits the process immediately after", async () => {
		setTmuxWindowName("session", "/tmp/project");
		await drainTmuxWindowQueue();
		runner.calls.length = 0;

		// Deliberately NOT awaited: an enqueued async spawn never runs once the
		// shutdown path calls process.exit, stranding the window on the omp name
		// with automatic-rename left off.
		restoreTmuxWindowName();

		expect(runner.calls).toEqual([
			["rename-window", "-t", "%7", "shell"],
			["set-window-option", "-t", "%7", "automatic-rename", "on"],
		]);
	});

	it("restores automatic-rename off when the window was explicitly named", async () => {
		runner.captured = "build\t0";
		setTmuxWindowName("session", "/tmp/project");
		await drainTmuxWindowQueue();
		runner.calls.length = 0;

		restoreTmuxWindowName();
		await drainTmuxWindowQueue();

		expect(runner.calls).toEqual([
			["rename-window", "-t", "%7", "build"],
			["set-window-option", "-t", "%7", "automatic-rename", "off"],
		]);
	});

	it("skips restore when the original window could not be captured", async () => {
		runner.captured = undefined;
		setTmuxWindowName("session", "/tmp/project");
		await drainTmuxWindowQueue();
		runner.calls.length = 0;

		restoreTmuxWindowName();
		await drainTmuxWindowQueue();

		expect(runner.calls).toEqual([]);
	});

	it("skips restore when no rename ever happened", async () => {
		restoreTmuxWindowName();
		await drainTmuxWindowQueue();

		expect(runner.calls).toEqual([]);
	});
});
