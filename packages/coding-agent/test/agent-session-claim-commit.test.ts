import { afterEach, beforeAll, expect, it } from "bun:test";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { createMockModel, type MockResponseSource } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { ExtensionRuntime, loadExtensionFromFactory } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/loader";
import { ExtensionRunner } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/runner";
import { TtsrManager } from "@oh-my-pi/pi-coding-agent/export/ttsr";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { resolveLocalUrlToPath } from "@oh-my-pi/pi-coding-agent/internal-urls";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { MEMORY_RECALL_CHANGES_MESSAGE_TYPE } from "@oh-my-pi/pi-coding-agent/memory-backend/recall-entry";
import { loadMnemopiConfig } from "@oh-my-pi/pi-coding-agent/mnemopi/config";
import {
	loadMnemopi,
	loadMnemopiCore,
	MnemopiSessionState,
	setMnemopiSessionState,
} from "@oh-my-pi/pi-coding-agent/mnemopi/state";
import { convertToLlm, USER_INTERRUPT_LABEL } from "@oh-my-pi/pi-coding-agent/session/messages";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";
import { getThemeByName, setThemeInstance } from "@oh-my-pi/pi-tui/theme";
import { TempDir } from "@oh-my-pi/pi-utils";

/**
 * A prompt commits what it delivers only at its claim: staged memory and policy are
 * published, and the once-only approved plan is checked again, right before the agent
 * takes the prompt. A prompt cancelled while it waits behind another run publishes no
 * memory, and a plan another run delivered meanwhile is not delivered twice.
 */
const resources: Array<{ session: AgentSession; auth: AuthStorage; dir: TempDir; releases: (() => void)[] }> = [];
beforeAll(async () => {
	setThemeInstance((await getThemeByName("dark"))!);
	await Promise.all([loadMnemopi(), loadMnemopiCore()]);
});
afterEach(async () => {
	for (const h of resources.splice(0)) {
		h.releases.forEach(r => r());
		await h.session.dispose();
		h.auth.close();
		await h.dir.remove();
	}
});
async function setup(responses: MockResponseSource, ttsrManager?: TtsrManager, withRunner = true, withMemory = false) {
	const dir = TempDir.createSync("@claim-commit-");
	const auth = await AuthStorage.create(":memory:");
	auth.keys.setRuntime("anthropic", "test-key");
	const registry = new ModelRegistry(auth, dir.join("models.yml"));
	const manager = SessionManager.create(dir.path(), dir.join("sessions"));
	const runtime = new ExtensionRuntime();
	let hook: (() => Promise<void>) | undefined;
	const extension = await loadExtensionFromFactory(
		pi => {
			pi.on("before_agent_start", async () => {
				await hook?.();
			});
		},
		dir.path(),
		new EventBus(),
		runtime,
		"claim-commit-probe",
	);
	const runner = new ExtensionRunner([extension], runtime, dir.path(), manager, registry);
	const mock = createMockModel({ responses, handler: { content: ["done"] } });
	const settings = Settings.isolated({
		"compaction.enabled": false,
		"retry.enabled": false,
		"todo.enabled": false,
		"ask.notify": "off",
		"speech.enabled": false,
		...(withMemory
			? {
					"memory.backend": "mnemopi",
					"mnemopi.scoping": "global",
					"mnemopi.dbPath": dir.join("real-memory.db"),
					"mnemopi.noEmbeddings": true,
					"mnemopi.llmMode": "none",
					"mnemopi.autoRetain": false,
				}
			: {}),
	});
	const agent = new Agent({
		getApiKey: () => "test-key",
		convertToLlm,
		initialState: { model: getBundledModel("anthropic", "claude-sonnet-4-5")!, systemPrompt: ["Test"], tools: [] },
		streamFn: mock.stream,
	});
	const session = new AgentSession({
		agent,
		sessionManager: manager,
		settings,
		modelRegistry: registry,
		extensionRunner: withRunner ? runner : undefined,
		toolRegistry: new Map(),
		ttsrManager,
	});
	const releases: (() => void)[] = [];
	resources.push({ session, auth, dir, releases });
	function gate() {
		const entered = Promise.withResolvers<void>(),
			released = Promise.withResolvers<void>();
		releases.push(() => released.resolve());
		return {
			entered: entered.promise,
			release: () => released.resolve(),
			wait: async () => {
				entered.resolve();
				await released.promise;
			},
		};
	}
	function holdKey() {
		const g = gate(),
			orig = registry.getApiKey.bind(registry);
		registry.getApiKey = async (...args) => {
			registry.getApiKey = orig;
			await g.wait();
			return orig(...args);
		};
		return g;
	}
	function holdHook() {
		const g = gate();
		hook = async () => {
			hook = undefined;
			await g.wait();
		};
		return g;
	}
	async function saved() {
		await session.settleInFlightMessagePersistence();
		await manager.flush();
		return (await Bun.file(manager.getSessionFile()!).text())
			.trim()
			.split("\n")
			.map(l => JSON.parse(l));
	}
	function cancel() {
		session.buildAskReanswerContext({} as never).abort();
	}
	return { session, agent, mock, manager, registry, dir, settings, gate, holdKey, holdHook, saved, cancel };
}

const payload = (content: string) => ({ customType: "review-context", content, display: false });
async function plan(h: Awaited<ReturnType<typeof setup>>) {
	const url = "local://review-plan.md";
	const path = resolveLocalUrlToPath(url, {
		getArtifactsDir: () => h.manager.getArtifactsDir(),
		getSessionId: () => h.manager.getSessionId(),
	});
	await Bun.write(path, "# Approved plan\n\nREVIEW-APPROVED-PLAN-CONTENT\n");
	h.session.setPlanReferencePath(url);
}

it("does not duplicate an approved plan when hidden work claims before a prepared client", async () => {
	const started = Promise.withResolvers<void>(),
		release = Promise.withResolvers<void>();
	const h = await setup([
		async () => {
			started.resolve();
			await release.promise;
			return { content: ["hidden done"] };
		},
	]);
	await plan(h);
	const hook = h.holdHook();
	const client = h.session.prompt("execute approved plan");
	await hook.entered;
	h.session.queueDeferredMessage({ ...payload("autonomous event"), role: "custom", timestamp: Date.now() });
	await started.promise;
	const waiting = Promise.withResolvers<void>();
	const originalWait = h.agent.waitForIdle.bind(h.agent);
	h.agent.waitForIdle = () => {
		waiting.resolve();
		return originalWait();
	};
	hook.release();
	await waiting.promise;
	release.resolve();
	await client;
	await h.session.waitForIdle();
	const refs = h.session.messages.filter(m => m.role === "custom" && m.customType === "plan-mode-reference");
	const deliveredCopies =
		JSON.stringify(h.mock.calls.at(-1)!.context).split("REVIEW-APPROVED-PLAN-CONTENT").length - 1;

	expect(deliveredCopies).toBe(1);
	expect(refs).toHaveLength(1);
});

it("delivers an actual Mnemopi changed-memory notice after cancelling a waiting prompt", async () => {
	const started = Promise.withResolvers<void>(),
		release = Promise.withResolvers<void>();
	const h = await setup(
		[
			{ content: ["first done"] },
			async () => {
				started.resolve();
				await release.promise;
				return { content: ["old done"] };
			},
			{ content: ["retry done"] },
		],
		undefined,
		true,
		true,
	);
	const config = loadMnemopiConfig(h.settings, h.dir.path());
	const first = new MnemopiSessionState({ sessionId: h.session.sessionId, config, session: h.session });
	setMnemopiSessionState(h.session, first);
	const id = first.rememberScoped("The deploy host is alpha-7.");
	await h.session.prompt("Where is the deploy host?");
	expect(JSON.stringify(h.mock.calls[0]!.context)).toContain("alpha-7");
	expect(first.editScopedMemory("update", id, { content: "The deploy host is beta-9." }).status).toBe("updated");

	setMnemopiSessionState(h.session, undefined);
	await first.dispose({ consolidate: false });

	const resumed = new MnemopiSessionState({ sessionId: h.session.sessionId, config, session: h.session });
	setMnemopiSessionState(h.session, resumed);

	const hook = h.holdHook();
	const client = h.session.prompt("Use the current deploy host");
	await hook.entered;

	const autonomous = h.agent.prompt("older autonomous work");
	await started.promise;

	const waiting = Promise.withResolvers<void>();
	const originalWait = h.agent.waitForIdle.bind(h.agent);
	h.agent.waitForIdle = () => {
		waiting.resolve();
		return originalWait();
	};
	hook.release();

	await waiting.promise;

	const stopping = h.session.abort({ reason: USER_INTERRUPT_LABEL });
	release.resolve();
	await Promise.all([client, autonomous, stopping]);
	await h.session.waitForIdle();
	await h.session.prompt("Which deploy host should I use now?");
	await h.session.waitForIdle();
	const notes = h.session.messages.filter(
		m => m.role === "custom" && m.customType === MEMORY_RECALL_CHANGES_MESSAGE_TYPE,
	);
	const final = JSON.stringify(h.mock.calls.at(-1)!.context);

	expect(final).toContain("beta-9");
	expect(notes).toHaveLength(1);
});
