import { afterEach, beforeAll, expect, it } from "bun:test";
import { Agent, type QueuedMessagePreparation } from "@oh-my-pi/pi-agent-core";
import { createMockModel, type MockResponseSource } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { lookup } from "@oh-my-pi/pi-coding-agent/config/registry";
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
import { type } from "@oh-my-pi/omptype";
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
	let policy: string[] | (() => string[]) | undefined;
	const extension = await loadExtensionFromFactory(
		pi => {
			pi.on("before_agent_start", async () => {
				const systemPrompt = typeof policy === "function" ? policy() : policy;
				await hook?.();
				return systemPrompt ? { systemPrompt } : undefined;
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
		rebuildSystemPrompt: async names => ({ systemPrompt: [`Available: ${names.join(",")}`] }),
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
	function setPolicy(value: string[] | (() => string[])) {
		policy = value;
	}
	return { session, agent, mock, manager, registry, dir, settings, gate, holdKey, holdHook, saved, cancel, setPolicy };
}

const payload = (content: string) => ({ customType: "review-context", content, display: false });
async function plan(
	h: { manager: SessionManager; session: AgentSession },
	url = "local://review-plan.md",
	content = "REVIEW-APPROVED-PLAN-CONTENT",
) {
	const path = resolveLocalUrlToPath(url, {
		getArtifactsDir: () => h.manager.getArtifactsDir(),
		getSessionId: () => h.manager.getSessionId(),
	});
	await Bun.write(path, `# Approved plan\n\n${content}\n`);
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

it("delivers the replacement approved plan at a waiting prompt's claim and persists it for later prompts", async () => {
	const started = Promise.withResolvers<void>();
	const h = await setup([
		async () => {
			started.resolve();
			await hidden.wait();
			return { content: ["hidden done"] };
		},
	]);
	const hidden = h.gate();
	await plan(h);
	const hook = h.holdHook();
	const client = h.session.prompt("execute the approved plan");
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
	const replacement = "local://replacement-plan.md";
	await plan(h, replacement, "REPLACEMENT-APPROVED-PLAN-CONTENT");
	h.session.setPlanModeState({ enabled: true, planFilePath: replacement });
	h.session.setPlanModeState(undefined);
	hidden.release();
	await client;
	await h.session.waitForIdle();
	const request = JSON.stringify(h.mock.calls.at(-1)!.context);
	await h.session.prompt("continue executing");
	const nextRequest = JSON.stringify(h.mock.calls.at(-1)!.context);
	const saved = JSON.stringify(await h.saved());
	expect(request.split("REPLACEMENT-APPROVED-PLAN-CONTENT")).toHaveLength(2);
	expect(request.split("REVIEW-APPROVED-PLAN-CONTENT")).toHaveLength(2);
	expect(nextRequest).toContain("REPLACEMENT-APPROVED-PLAN-CONTENT");
	expect(saved.split("REPLACEMENT-APPROVED-PLAN-CONTENT")).toHaveLength(2);
	expect(saved.split("REVIEW-APPROVED-PLAN-CONTENT")).toHaveLength(2);
});

it("does not publish an obsolete inline plan when a replacement reuses the same path during preparation", async () => {
	const h = await setup([]);
	await plan(h);
	const hook = h.holdHook();
	const client = h.session.prompt("execute the approved plan");
	await hook.entered;
	const file = resolveLocalUrlToPath("local://review-plan.md", {
		getArtifactsDir: () => h.manager.getArtifactsDir(),
		getSessionId: () => h.manager.getSessionId(),
	});
	await Bun.write(file, "# Approved plan\n\nREPLACEMENT-AT-SAME-PATH\n");
	hook.release();
	await client;
	const request = JSON.stringify(h.mock.calls.at(-1)!.context);
	expect(request).toContain("REPLACEMENT-AT-SAME-PATH");
	expect(request).not.toContain("REVIEW-APPROVED-PLAN-CONTENT");
	await h.session.prompt("continue the approved plan");
	const nextRequest = JSON.stringify(h.mock.calls.at(-1)!.context);
	expect(nextRequest).toContain("REPLACEMENT-AT-SAME-PATH");
	expect(nextRequest).not.toContain("REVIEW-APPROVED-PLAN-CONTENT");
	expect(JSON.stringify(await h.saved())).not.toContain("REVIEW-APPROVED-PLAN-CONTENT");
});

it("delivers current roster policy when a prefix-binding model keeps the base prompt unchanged", async () => {
	const h = await setup([]);
	h.agent.setModel(getBundledModel("anthropic", "claude-sonnet-5-5")!);
	const tools = ["alpha", "beta"].map(name => ({
		name: `mcp__review_${name}`,
		label: name,
		description: `Run ${name}`,
		parameters: type({}),
		strict: true,
		mcpServerName: "review",
		mcpToolName: name,
		async execute() {
			return { content: [{ type: "text" as const, text: "ok" }] };
		},
	}));
	await h.session.refreshMCPTools(tools);
	await h.session.setActiveToolsByName(["mcp__review_alpha"]);
	await h.session.prompt("warm cache");
	h.setPolicy(() => [`POLICY_FOR_${h.session.getActiveToolNames().join(",")}`]);
	const hook = h.holdHook();
	const turn = h.session.prompt("use current tools");
	await hook.entered;
	const base = [...h.session.systemPrompt];
	await h.session.setActiveToolsByName(["mcp__review_beta"]);
	expect(h.session.systemPrompt).toEqual(base);
	hook.release();
	await turn;
	const request = h.mock.calls.at(-1)!.context;
	expect(request.tools?.map(tool => tool.name)).toEqual(["mcp__review_beta"]);
	expect(JSON.stringify(request.systemPrompt)).toContain("POLICY_FOR_mcp__review_beta");
	expect(JSON.stringify(request.systemPrompt)).not.toContain("POLICY_FOR_mcp__review_alpha");
});

it("delivers current policy after a custom session entry changes during preparation", async () => {
	const h = await setup([]);
	h.manager.appendCustomEntry("policy-mode", { enabled: true });
	h.setPolicy(() => {
		const entry = h.manager
			.getBranch()
			.findLast(entry => entry.type === "custom" && entry.customType === "policy-mode");
		const data = entry?.type === "custom" ? entry.data : undefined;
		return [
			data && typeof data === "object" && "enabled" in data && data.enabled === true
				? "OBSOLETE_ALLOWED_POLICY"
				: "CURRENT_READONLY_POLICY",
		];
	});
	const hook = h.holdHook();
	const turn = h.session.prompt("honor current policy");
	await hook.entered;
	h.manager.appendCustomEntry("policy-mode", { enabled: false });
	await h.manager.flush();
	hook.release();
	await turn;
	const request = JSON.stringify(h.mock.calls.at(-1)!.context);
	expect(request).toContain("CURRENT_READONLY_POLICY");
	expect(request).not.toContain("OBSOLETE_ALLOWED_POLICY");
	expect(JSON.stringify(await h.saved())).toContain('"enabled":false');
});

it("delivers a preparation whose own hook appends a custom entry without repeating the hook", async () => {
	const h = await setup([]);
	let hooks = 0;
	h.setPolicy(() => {
		h.manager.appendCustomEntry("hook-audit", { attempt: ++hooks });
		return ["SELF_AUTHORED_POLICY"];
	});
	await h.session.prompt("run the audited task");
	expect(hooks).toBe(1);
	expect(JSON.stringify(h.mock.calls[0]!.context.systemPrompt)).toContain("SELF_AUTHORED_POLICY");
	expect(JSON.stringify(await h.saved())).toContain('"attempt":1');
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

it("restages changed memory and extension policy instead of publishing a waiting prompt's obsolete preparation", async () => {
	const h = await setup(
		[
			{ content: ["first done"] },
			async () => {
				await hidden.wait();
				return { content: ["hidden done"] };
			},
		],
		undefined,
		true,
		true,
	);
	const hidden = h.gate();
	const config = loadMnemopiConfig(h.settings, h.dir.path());
	const first = new MnemopiSessionState({ sessionId: h.session.sessionId, config, session: h.session });
	setMnemopiSessionState(h.session, first);
	const id = first.rememberScoped("The deploy host is alpha-7.");
	await h.session.prompt("Where is the deploy host?");
	setMnemopiSessionState(h.session, undefined);
	await first.dispose({ consolidate: false });
	const resumed = new MnemopiSessionState({ sessionId: h.session.sessionId, config, session: h.session });
	setMnemopiSessionState(h.session, resumed);
	expect(resumed.editScopedMemory("update", id, { content: "The deploy host is beta-9." }).status).toBe("updated");
	h.setPolicy(["OBSOLETE-EXTENSION-POLICY"]);
	const hook = h.holdHook();
	const client = h.session.prompt("Use the current deploy host");
	await hook.entered;
	const autonomous = h.agent.prompt("older autonomous work");
	await hidden.entered;
	const waiting = Promise.withResolvers<void>();
	const originalWait = h.agent.waitForIdle.bind(h.agent);
	h.agent.waitForIdle = () => {
		waiting.resolve();
		return originalWait();
	};
	hook.release();
	await waiting.promise;
	expect(resumed.editScopedMemory("update", id, { content: "The deploy host is gamma-11." }).status).toBe("updated");
	h.setPolicy(["CURRENT-EXTENSION-POLICY"]);
	hidden.release();
	await Promise.all([client, autonomous]);
	await h.session.waitForIdle();
	const final = JSON.stringify(h.mock.calls.at(-1)!.context);
	expect(final).toContain("CURRENT-EXTENSION-POLICY");
	expect(final).not.toContain("OBSOLETE-EXTENSION-POLICY");
	expect(final).toContain("gamma-11");
	expect(final).not.toContain("beta-9");
	const saved = JSON.stringify(await h.saved());
	expect(saved).toContain("gamma-11");
	expect(saved).not.toContain("beta-9");
});

it("reprepares after each SQLite memory edit and publishes only the latest change notice", async () => {
	const h = await setup([], undefined, true, true);
	const config = loadMnemopiConfig(h.settings, h.dir.path());
	const first = new MnemopiSessionState({ sessionId: h.session.sessionId, config, session: h.session });
	setMnemopiSessionState(h.session, first);
	const id = first.rememberScoped("Deploy to MEMORY_ALPHA");
	const recallCount = first.memory.beam.db.query<{ recall_count: number }, [string]>(
		"SELECT recall_count FROM working_memory WHERE id = ?",
	);
	const warmHook = h.holdHook();
	const warm = h.session.prompt("deploy location");
	await warmHook.entered;
	expect(recallCount.get(id)?.recall_count).toBe(0);
	warmHook.release();
	await warm;
	expect(recallCount.get(id)?.recall_count).toBe(1);
	setMnemopiSessionState(h.session, undefined);
	await first.dispose({ consolidate: false });
	const resumed = new MnemopiSessionState({ sessionId: h.session.sessionId, config, session: h.session });
	setMnemopiSessionState(h.session, resumed);
	resumed.editScopedMemory("update", id, { content: "Deploy to MEMORY_BETA" });
	const firstHook = h.holdHook();
	const turn = h.session.prompt("where now");
	await firstHook.entered;
	resumed.editScopedMemory("update", id, { content: "Deploy to MEMORY_GAMMA" });
	const secondHook = h.holdHook();
	firstHook.release();
	await secondHook.entered;
	resumed.editScopedMemory("update", id, { content: "Deploy to MEMORY_DELTA" });
	secondHook.release();
	await turn;
	const request = JSON.stringify(h.mock.calls.at(-1)!.context);
	const saved = JSON.stringify(await h.saved());
	expect(request).toContain("MEMORY_DELTA");
	expect(request).not.toContain("MEMORY_BETA");
	expect(request).not.toContain("MEMORY_GAMMA");
	expect(saved).not.toContain("MEMORY_BETA");
	expect(saved).not.toContain("MEMORY_GAMMA");
	expect(
		h.session.messages.filter(
			message => message.role === "custom" && message.customType === MEMORY_RECALL_CHANGES_MESSAGE_TYPE,
		),
	).toHaveLength(1);
});

it("declines after three source changes without publishing stale policy and restores the client input", async () => {
	const h = await setup([]);
	const dropped: string[] = [];
	h.session.setPromptDropped(prompt => dropped.push(prompt.text));
	let attempts = 0;
	h.setPolicy(() => {
		lookup("todo.enabled")!.override(h.settings, ++attempts % 2 !== 0);
		return [`UNPUBLISHED_POLICY_${attempts}`];
	});
	await expect(h.session.prompt("bounded current-source task")).rejects.toThrow("System prompt changed repeatedly");
	expect(attempts).toBe(3);
	expect(h.mock.calls).toHaveLength(0);
	expect(h.session.systemPrompt.join("\n")).not.toContain("UNPUBLISHED_POLICY");
	expect(JSON.stringify(h.manager.getEntries())).not.toContain("UNPUBLISHED_POLICY");
	expect(dropped).toEqual(["bounded current-source task"]);
});

it("reprepares a queued policy superseded between preparation resolution and its claim", async () => {
	const h = await setup([]);
	h.manager.appendCustomEntry("queued-policy", "old");
	h.setPolicy(() => {
		const entry = h.manager
			.getBranch()
			.findLast(entry => entry.type === "custom" && entry.customType === "queued-policy");
		return [entry?.type === "custom" && entry.data === "new" ? "CURRENT_QUEUED_POLICY" : "OBSOLETE_QUEUED_POLICY"];
	});
	const prepare = h.agent.prepareQueuedMessages!;
	let changed = false;
	h.agent.prepareQueuedMessages = async (...args) => {
		const preparation = await prepare(...args);
		if (!changed) {
			changed = true;
			h.manager.appendCustomEntry("queued-policy", "new");
		}
		return preparation;
	};
	await h.session.steer("use the current queued policy");
	await h.session.waitForIdle();
	expect(h.mock.calls).toHaveLength(1);
	expect(JSON.stringify(h.mock.calls[0]!.context.systemPrompt)).toContain("CURRENT_QUEUED_POLICY");
	expect(JSON.stringify(h.mock.calls[0]!.context.systemPrompt)).not.toContain("OBSOLETE_QUEUED_POLICY");
});

it("declines three superseded queued claims without sending stale policy or losing the queued input", async () => {
	const h = await setup([]);
	let attempts = 0;
	h.setPolicy(() => [`UNPUBLISHED_QUEUED_POLICY_${++attempts}`]);
	const prepare = h.agent.prepareQueuedMessages!;
	const invalidate = (preparation: QueuedMessagePreparation): QueuedMessagePreparation => {
		h.manager.appendCustomEntry("claim-invalidated", attempts);
		const retry = preparation.retry;
		return {
			commit: () => preparation.commit(),
			retry: retry ? async () => invalidate(await retry()) : undefined,
		};
	};
	h.agent.prepareQueuedMessages = async (...args) => {
		const preparation = await prepare(...args);
		return preparation ? invalidate(preparation) : undefined;
	};
	await h.session.steer("retain the bounded queued task");
	await h.session.waitForIdle();
	expect(attempts).toBe(3);
	expect(h.mock.calls).toHaveLength(0);
	expect(h.session.systemPrompt.join("\n")).not.toContain("UNPUBLISHED_QUEUED_POLICY");
	expect(h.agent.peekSteeringQueue()).toMatchObject([
		{ content: [{ type: "text", text: "retain the bounded queued task" }] },
	]);
});
