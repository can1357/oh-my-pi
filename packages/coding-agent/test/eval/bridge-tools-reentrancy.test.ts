import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { TempDir } from "@oh-my-pi/pi-utils";
import { Settings } from "../../src/config/settings";
import { getActiveEvalBridgeSession, runWithEvalBridgeSession } from "../../src/eval/bridge-reentrancy";
import { PythonKernel } from "../../src/eval/py/kernel";
import { describeEvalTools } from "../../src/task/eval-tools";
import type { ToolSession } from "../../src/tools";
import { beginSettingsTest, restoreSettingsTestState, type SettingsTestState } from "../helpers/settings-test-state";

// Contract for the #18644 fix: resolving kernel-defined `tools` for a subagent
// spawned from a running eval cell must fail fast instead of round-tripping to
// the blocked kernel. The fault-injection test that fails pre-fix by timeout
// lives in bridge-tools-deadlock.test.ts (it imports only pre-existing modules
// so its pre-fix failure is the hang itself, not a missing import).

let tempDir: TempDir;
let settingsState: SettingsTestState;

beforeEach(() => {
	settingsState = beginSettingsTest();
	tempDir = TempDir.createSync("@eval-bridge-tools-reentrancy-");
});

afterEach(() => {
	vi.restoreAllMocks();
	restoreSettingsTestState(settingsState);
	tempDir.removeSync();
});

function makeSession(): { session: ToolSession; sessionId: string } {
	const sessionId = `bridge-reentrancy-${crypto.randomUUID()}`;
	const session = {
		cwd: tempDir.path(),
		hasUI: false,
		settings: Settings.isolated(),
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		getArtifactsDir: () => null,
		getSessionId: () => sessionId,
		getEvalSessionId: () => sessionId,
		getToolByName: () => undefined,
	} as unknown as ToolSession;
	return { session, sessionId };
}

describe("eval bridge tools re-entrancy (#18644)", () => {
	it("describeEvalTools under the bridge marker rejects without touching the kernel", async () => {
		const { session } = makeSession();
		const invokeSpy = vi.spyOn(PythonKernel.prototype, "invokeTool");
		await expect(runWithEvalBridgeSession(session, () => describeEvalTools(session, ["probe_echo"]))).rejects.toThrow(
			/blocked waiting for this spawn call/,
		);
		expect(invokeSpy).not.toHaveBeenCalled();
	}, 10_000);

	it("unknown names under the bridge marker fail fast instead of hanging", async () => {
		const { session } = makeSession();
		await expect(
			runWithEvalBridgeSession(session, () => describeEvalTools(session, ["NoSuchToolZZZ"])),
		).rejects.toThrow(/blocked waiting for this spawn call/);
	}, 10_000);
	it("a different session under the bridge marker keeps the live kernel path", async () => {
		const blocked = makeSession();
		const other = makeSession();
		// No live kernel: the live path reports unknown tools, proving the guard
		// only trips for the blocked kernel's own session.
		await expect(
			runWithEvalBridgeSession(blocked.session, () => describeEvalTools(other.session, ["probe_echo"])),
		).rejects.toThrow(/Unknown eval tool\(s\): probe_echo/);
	}, 10_000);

	it("no marker is set outside a bridge call", () => {
		expect(getActiveEvalBridgeSession()).toBeUndefined();
	});
});
