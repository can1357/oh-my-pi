/**
 * The bash tool's persistent shell: state set by one call (variables,
 * functions, options) is visible to the next call through the default
 * auto-background path, including after a call moved to the background and
 * after a call that exited non-zero. That `exit` and errexit keep the native
 * session is pinned in `crates/pi-shell` (`exit_and_errexit_keep_session_state`):
 * pull-request CI runs these tests against main's native addon.
 */
import { afterEach, beforeEach, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { AsyncJobManager } from "../src/async";
import { Settings } from "../src/config/settings";
import { executeBash, releaseShellSessions, __test } from "../src/exec/bash-executor";
import type { ShellRunResult } from "@oh-my-pi/pi-natives";
import type { ToolSession } from "../src/tools";
import { BashTool } from "../src/tools/bash";

let cwd: string;
let manager: AsyncJobManager;

beforeEach(async () => {
	cwd = await fs.mkdtemp(path.join(os.tmpdir(), "omp-bash-session-state-"));
	manager = new AsyncJobManager({});
});

afterEach(async () => {
	await manager.dispose();
	releaseShellSessions(cwd);
	await fs.rm(cwd, { recursive: true, force: true });
});

function bashTool(settings: Record<string, unknown> = {}, overrides: Partial<ToolSession> = {}): BashTool {
	const session: ToolSession = {
		cwd,
		hasUI: false,
		getSessionFile: () => null,
		getSessionId: () => cwd,
		getSessionSpawns: () => "*",
		asyncJobManager: manager,
		settings: Settings.isolated(settings),
		...overrides,
	};
	return new BashTool(session);
}

async function run(tool: BashTool, command: string) {
	const result = await tool.execute("bash-session-state", { command });
	const text = result.content.find(block => block.type === "text")?.text ?? "";
	return { text, async: result.details?.async };
}

it.each([
	{ managed: false, settings: { "bash.autoBackground.enabled": false } },
	{ managed: true, settings: { "bash.autoBackground.enabled": true } },
])("does not stream or return a run trace when visualization is disabled (managed: $managed)", async ({ settings }) => {
	const tool = bashTool({ ...settings, "display.shellVisualization": false });
	let frames = 0;
	let tracedFrames = 0;
	const result = await tool.execute("trace-disabled", { command: "printf 'plain output\\n'" }, undefined, update => {
		frames++;
		if (update.details?.trace) tracedFrames++;
	});
	expect(frames).toBeGreaterThan(0);
	expect(tracedFrames).toBe(0);
	expect(result.details?.trace).toBeUndefined();
	expect(result.content.find(block => block.type === "text")?.text).toContain("plain output");
});

it.skipIf(process.platform === "win32")("keeps a variable set by one call for the next call", async () => {
	const tool = bashTool();
	await run(tool, "PI_STATE_VAR=kept");
	expect((await run(tool, 'printf "%s" "$PI_STATE_VAR"')).text).toBe("kept");
});

it.skipIf(process.platform === "win32")("keeps a function defined by one call callable in the next call", async () => {
	const tool = bashTool();
	await run(tool, "pi_state_fn() { printf 'called %s' \"$1\"; }");
	expect((await run(tool, "pi_state_fn twice")).text).toBe("called twice");
});

it.skipIf(process.platform === "win32")(
	"keeps state set by a call that moved to the background once it finishes",
	async () => {
		const tool = bashTool({ "bash.autoBackground.thresholdMs": 100 });
		const started = await run(tool, "PI_STATE_VAR=from-bg; pi_bg_fn() { printf fn; }; sleep 1");
		expect(started.async?.state).toBe("running");
		await manager.waitForAll();
		expect((await run(tool, 'printf "%s:" "$PI_STATE_VAR"; pi_bg_fn')).text).toBe("from-bg:fn");
	},
	10_000,
);

it.skipIf(process.platform === "win32")("keeps state and options after a call that exits non-zero", async () => {
	const tool = bashTool();
	await run(tool, "set -uo pipefail; PI_STATE_VAR=kept");
	expect((await run(tool, "false")).text).toContain("Command exited with code 1");
	expect((await run(tool, 'printf "%s %s" "$PI_STATE_VAR" "$-"')).text).toMatch(/^kept \S*u\S*$/);
});

it.skipIf(process.platform === "win32")(
	"runs calls that overlap a backgrounded one in a copy of the session shell and leaves it intact",
	async () => {
		const tool = bashTool({ "bash.autoBackground.thresholdMs": 100 });
		await run(tool, "PI_STATE_VAR=kept");
		expect((await run(tool, "sleep 2")).async?.state).toBe("running");

		const overlapping = await run(tool, 'printf "[%s]" "$PI_STATE_VAR"; PI_STATE_VAR=lost');
		expect(overlapping.text).toStartWith("[kept]");
		expect(overlapping.text).toContain("Ran in a copy of the busy session shell");
		// An overlapping call that itself moves to the background says so in its start result.
		const promoted = await run(tool, "sleep 0.5");
		expect(promoted.async?.state).toBe("running");
		expect(promoted.text).toContain("Ran in a copy of the busy session shell");

		await manager.waitForAll();
		expect((await run(tool, 'printf "%s" "$PI_STATE_VAR"')).text).toBe("kept");
	},
	10_000,
);

it.skipIf(process.platform === "win32")(
	"runs a call in the shell of the session it started in when the session changes first",
	async () => {
		const [first, second] = [`${cwd}:first`, `${cwd}:second`];
		let sessionId = first;
		const heldAllocation = Promise.withResolvers<{ id?: string; path?: string }>();
		let allocations = 0;
		const tool = bashTool(
			{ "bash.autoBackground.thresholdMs": 100 },
			{
				getSessionId: () => sessionId,
				// Holds the first call before its shell starts, so the session changes underneath it.
				allocateOutputArtifact: async () => (allocations++ === 0 ? heldAllocation.promise : {}),
			},
		);
		try {
			expect((await run(tool, "PI_STATE_VAR=from-first")).async?.state).toBe("running");
			sessionId = second;
			heldAllocation.resolve({});
			await manager.waitForAll();

			expect((await run(tool, 'printf "[%s]" "$PI_STATE_VAR"')).text).toBe("[]");
			// The left session's shell was dropped when that call finished.
			sessionId = first;
			expect((await run(tool, 'printf "[%s]" "$PI_STATE_VAR"')).text).toBe("[]");
		} finally {
			releaseShellSessions(first);
			releaseShellSessions(second);
		}
	},
	10_000,
);

// The notice assertions below inject their native result through the
// `__test.run` seam, so they run the same on every addon version
// (pull-request CI tests against main's prebuilt addon, which predates the
// flag). The flag itself is pinned in `crates/pi-shell`
// (`exit_and_errexit_report_ended_by_exit`); a source-built addon is
// additionally checked end-to-end by the native-backed test below.

function nativeResult(overrides: Record<string, unknown> = {}) {
	return {
		exitCode: 0,
		cancelled: false,
		timedOut: false,
		minimized: undefined,
		workingDir: undefined,
		endedByExit: false,
		...overrides,
	};
}

it("says so when exit or an armed set -e ends the call before its remaining statements run", async () => {
	__test.run = async (_shell, request) => {
		expect(request.command).toBeString();
		if (request.command.includes("echo never-ran")) return nativeResult({ endedByExit: true });
		if (request.command === "false") return nativeResult({ exitCode: 1 });
		return nativeResult();
	};
	try {
		const tool = bashTool();
		const aborted = await run(tool, "false; echo never-ran");
		expect(aborted.text).toContain("Stopped by `exit` or an armed `set -e`");
		expect(aborted.text).toContain("the rest of this call did not run");
		// Options armed by an earlier call keep applying; the notice says so.
		expect(aborted.text).toContain("stay set in this session");

		const failed = await run(tool, "false");
		expect(failed.text).toContain("Command exited with code 1");
		expect(failed.text).not.toContain("Stopped by `exit`");
	} finally {
		__test.run = undefined;
	}
});

it("does not promise options persist when the aborted call ran in a forked session shell", async () => {
	const firstRunStarted = Promise.withResolvers<void>();
	let finishFirst!: (result: ShellRunResult) => void;
	__test.run = (_shell, request) => {
		if (request.command.includes("BLOCK-FIRST-CALL")) {
			const first = Promise.withResolvers<ShellRunResult>();
			finishFirst = first.resolve;
			firstRunStarted.resolve();
			return first.promise;
		}
		return Promise.resolve(nativeResult({ endedByExit: true }));
	};
	try {
		const tool = bashTool();
		const first = run(tool, "echo BLOCK-FIRST-CALL");
		await firstRunStarted.promise;
		// The first call owns the persistent session; this one overlaps it
		// and runs in a fork, so its options die with it.
		const aborted = await run(tool, "set -e; false; echo never-ran");
		expect(aborted.text).toContain("Ran in a copy of the busy session shell");
		expect(aborted.text).toContain("Stopped by `exit` or an armed `set -e`");
		expect(aborted.text).toContain("the rest of this call did not run");
		expect(aborted.text).not.toContain("stay set in this session");
		finishFirst(nativeResult());
		await first;
	} finally {
		__test.run = undefined;
	}
});

it("classifies a per-job `:async:` shell as ephemeral", async () => {
	__test.run = () => Promise.resolve(nativeResult({ endedByExit: true }));
	try {
		// A background job runs in a per-job shell the executor drops when
		// the call settles, so its options cannot reach a later call: the
		// result must not claim a persistent session.
		const result = await executeBash("set -e; false; echo never-ran", {
			minimize: false,
			sessionKey: "probe-session:async:job-1",
		});
		expect(result.endedByExit).toBe(true);
		expect(result.ephemeralShell).toBe(true);
	} finally {
		__test.run = undefined;
	}
});

it.skipIf(process.platform === "win32")(
	"reports a cut-short exit end-to-end when the loaded addon carries the flag",
	async () => {
		const probe = await executeBash("exit 3; echo never", { minimize: false });
		if (probe.endedByExit !== true) return; // addon predates the flag

		const tool = bashTool();
		await run(tool, "set -e; PI_ERREXIT_ARMED=1");
		const aborted = await run(tool, "false; echo never-ran");
		expect(aborted.text).toContain("Stopped by `exit` or an armed `set -e`");
		expect(aborted.text).toContain("the rest of this call did not run");
		// Options armed by an earlier call keep applying; the notice says so.
		expect(aborted.text).toContain("stay set in this session");

		const exited = await run(tool, "exit 3; echo never-ran");
		expect(exited.text).toContain("Stopped by `exit` or an armed `set -e`");

		// A trailing exit ends the call exactly where its input ends: no notice.
		const trailing = await run(tool, "exit 0");
		expect(trailing.text).not.toContain("Stopped by `exit`");

		await run(tool, "set +e");
		const failed = await run(tool, "false");
		expect(failed.text).toContain("Command exited with code 1");
		expect(failed.text).not.toContain("Stopped by `exit`");
	},
);
