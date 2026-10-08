/**
 * Contract: while joined as a collab guest, an extension reacting to a
 * mirrored host lifecycle event cannot start or queue a turn on the replica
 * session. The replica only mirrors the host; a local turn would run on the
 * guest's own model and credentials and diverge from the host transcript.
 *
 * Wiring under test is the production path: a real `AgentSession` + real
 * `ExtensionRunner`, extension actions bound by `ExtensionUiController`, and
 * the guest's `GuestLifecycleEmitter` feeding a mirrored `agent_end`.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import type { CollabGuestLink } from "@oh-my-pi/pi-coding-agent/collab/guest";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { ExtensionAPI, ExtensionUIContext } from "@oh-my-pi/pi-coding-agent/extensibility/extensions";
import { GuestLifecycleEmitter } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/lifecycle-mirror";
import { ExtensionRuntime, loadExtensionFromFactory } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/loader";
import { ExtensionRunner } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/runner";
import { ExtensionUiController } from "@oh-my-pi/pi-coding-agent/modes/controllers/extension-ui-controller";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { convertToLlm } from "@oh-my-pi/pi-coding-agent/session/messages";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";
import { TempDir } from "@oh-my-pi/pi-utils";

describe("collab guest extension turn guard", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let session: AgentSession | undefined;

	beforeEach(async () => {
		tempDir = TempDir.createSync("@pi-guest-ext-turn-guard-");
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "auth.db"));
	});

	afterEach(async () => {
		await session?.dispose();
		session = undefined;
		authStorage.close();
		tempDir.removeSync();
	});

	it("refuses extension-initiated turns triggered by a mirrored agent_end, and allows them after leaving", async () => {
		const modelRegistry = new ModelRegistry(authStorage);
		const sessionManager = SessionManager.inMemory(tempDir.path());
		const runtime = new ExtensionRuntime();

		// One-shot reaction per mirrored settle: the extension's own local turn
		// (after leaving) emits an agent_end too and must not re-trigger.
		let onAgentEnd: ((pi: ExtensionAPI) => void) | undefined;
		let handled = Promise.withResolvers<void>();
		const extension = await loadExtensionFromFactory(
			pi => {
				pi.on("agent_end", () => {
					const react = onAgentEnd;
					onAgentEnd = undefined;
					if (!react) return;
					react(pi);
					handled.resolve();
				});
			},
			tempDir.path(),
			new EventBus(),
			runtime,
			"plan-mode-like",
		);
		const runner = new ExtensionRunner([extension], runtime, tempDir.path(), sessionManager, modelRegistry);

		const mock = createMockModel({ provider: "openai", id: "gpt-test", handler: () => ({ content: ["ok"] }) });
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model: mock.model, systemPrompt: ["Test"], tools: [], messages: [] },
			convertToLlm,
			streamFn: mock.stream,
		});
		const settings = Settings.isolated({ "compaction.enabled": false, "todo.enabled": false });
		settings.setModelRole("default", `${mock.model.provider}/${mock.model.id}`);
		const agentSession = new AgentSession({
			agent,
			sessionManager,
			settings,
			modelRegistry,
			toolRegistry: new Map(),
			extensionRunner: runner,
		});
		session = agentSession;

		const statuses: string[] = [];
		const errors: string[] = [];
		const ctx = {
			session: agentSession,
			sessionManager,
			collabGuest: {} as CollabGuestLink,
			showStatus: (message: string) => statuses.push(message),
			showError: (message: string) => errors.push(message),
			syncComposerShape: () => {},
		} as unknown as InteractiveModeContext;
		new ExtensionUiController(ctx).initializeHookRunner({} as ExtensionUIContext, false);

		const mirror = new GuestLifecycleEmitter();
		const mirrorHostRun = async (): Promise<void> => {
			mirror.emit(runner, { type: "agent_start" });
			mirror.emit(runner, { type: "agent_end", messages: [], isTerminal: true });
			await handled.promise;
			// Every turn-starting action is admitted synchronously; wait for any
			// admitted one to dispatch and its turn to finish.
			await agentSession.waitForAdmittedSubmissions();
			await agentSession.waitForIdle();
		};

		// Joined: plan-mode's "Execute" after the host settles, plus the other
		// turn-starting delivery modes.
		onAgentEnd = pi => {
			pi.sendMessage({ customType: "plan-execute", content: "EXECUTE_PLAN", display: true }, { triggerTurn: true });
			pi.sendMessage(
				{ customType: "plan-followup", content: "FOLLOW_UP", display: false },
				{ deliverAs: "followUp" },
			);
			pi.sendUserMessage("USER_CONTINUE");
		};
		await mirrorHostRun();

		expect(mock.calls).toHaveLength(0);
		expect(agentSession.messages).toHaveLength(0);
		expect(errors).toEqual([]);
		expect(statuses).toHaveLength(3);
		for (const status of statuses) expect(status).toContain("host-only during a collab session");

		// Left the session: the same reaction now owns a real local turn.
		ctx.collabGuest = undefined;
		handled = Promise.withResolvers<void>();
		onAgentEnd = pi => {
			pi.sendMessage({ customType: "plan-execute", content: "EXECUTE_PLAN", display: true }, { triggerTurn: true });
		};
		await mirrorHostRun();

		expect(mock.calls).toHaveLength(1);
		expect(JSON.stringify(mock.calls[0].context.messages)).toContain("EXECUTE_PLAN");
		expect(errors).toEqual([]);
	});
});
