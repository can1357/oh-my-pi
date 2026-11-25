/**
 * Regression coverage for session-owned idle recaps. An owner refresh with no
 * state change must not abort a recap request that is already in flight.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { EphemeralTurnResult } from "@oh-my-pi/pi-coding-agent/session/agent-session-types";
import { IdleMaintenance, type IdleMaintenanceSession } from "@oh-my-pi/pi-coding-agent/session/idle-maintenance";
import { closeSessionIndex } from "@oh-my-pi/pi-coding-agent/session/session-index";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { removeSyncWithRetries, setAgentDir } from "@oh-my-pi/pi-utils";
import { createAssistantMessage } from "./helpers/agent-session-setup";
import { elapse, flush } from "./helpers/fake-clock";
import { beginSettingsTest, restoreSettingsTestState, type SettingsTestState } from "./helpers/settings-test-state";

const RECAP = "Implemented the fix. Next: run the focused regression test.";

describe("IdleMaintenance recaps", () => {
	let root: string;
	let settingsState: SettingsTestState;
	let maintenance: IdleMaintenance | undefined;

	beforeEach(() => {
		root = fs.mkdtempSync(path.join(os.tmpdir(), "omp-idle-maintenance-"));
		settingsState = beginSettingsTest();
		setAgentDir(path.join(root, "agent"));
		closeSessionIndex();
		vi.useFakeTimers();
		maintenance = undefined;
	});

	afterEach(() => {
		maintenance?.dispose();
		vi.useRealTimers();
		closeSessionIndex();
		restoreSettingsTestState(settingsState);
		removeSyncWithRetries(root);
	});

	it("keeps an in-flight recap alive when an unchanged settled session refreshes", async () => {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected built-in anthropic model to exist");
		const response = Promise.withResolvers<EphemeralTurnResult>();
		let signal: AbortSignal | undefined;
		let observe: Parameters<IdleMaintenanceSession["subscribe"]>[0] | undefined;
		const session: IdleMaintenanceSession = {
			settings: Settings.isolated({ "recap.idleSeconds": 1 }),
			sessionManager: SessionManager.inMemory(),
			isCompacting: false,
			isSessionTransitioning: false,
			isRunActive: false,
			isStreaming: false,
			hasAdmittedSubmission: false,
			queuedMessageCount: 0,
			model,
			messages: [createAssistantMessage("Work finished.")],
			subscribe: listener => {
				observe = listener;
				return () => {
					if (observe === listener) observe = undefined;
				};
			},
			waitForRunEnd: async () => {},
			waitForAdmittedSubmissions: async () => {},
			getContextUsage: () => undefined,
			getGoalModeState: () => undefined,
			getTodoPhases: () => [],
			runIdleCompaction: async () => {},
			promptCacheEntry: undefined,
			runEphemeralTurn: options => {
				signal = options.signal;
				return response.promise;
			},
		};
		const recaps: string[] = [];
		maintenance = new IdleMaintenance(session, { onRecap: recap => recaps.push(recap) });
		observe?.({ type: "agent_end", messages: session.messages });
		await flush();
		await elapse(1_000);
		expect(signal).toBeDefined();
		expect(signal?.aborted).toBe(false);

		// Regression: an unchanged refresh used to abort the request because the settled predicate was inverted.
		maintenance.refresh();

		expect(signal?.aborted).toBe(false);
		response.resolve({ replyText: RECAP, assistantMessage: createAssistantMessage(RECAP) });
		await flush();
		expect(recaps).toEqual([RECAP]);
	});
});
