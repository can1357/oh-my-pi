import { afterEach, beforeAll, expect, it, vi } from "bun:test";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { createMockModel, type MockResponseSource } from "@oh-my-pi/pi-ai/providers/mock";
import { Effort } from "@oh-my-pi/pi-catalog/effort";
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
import { type } from "@oh-my-pi/omptype";
import { TempDir } from "@oh-my-pi/pi-utils";

/** Claim-time commits publish nothing for a cancelled waiting prompt. */
const resources: Array<{ session: AgentSession; auth: AuthStorage; dir: TempDir; releases: (() => void)[] }> = [];
beforeAll(async () => {
	setThemeInstance((await getThemeByName("dark"))!);
	await Promise.all([loadMnemopi(), loadMnemopiCore()]);
});
afterEach(async () => {
	vi.restoreAllMocks();
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
	const hook = h.holdKey();
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

it("delivers the current plan only after interrupt cleanup when preparation is replaced during the wait", async () => {
	const h = await setup([]);
	const cleanup = h.gate();
	const onTaskAborted = h.session.goalRuntime.onTaskAborted.bind(h.session.goalRuntime);
	h.session.goalRuntime.onTaskAborted = async options => {
		await cleanup.wait();
		return onTaskAborted(options);
	};
	try {
		const stopping = h.session.abort({ reason: USER_INTERRUPT_LABEL });
		await cleanup.entered;
		await plan(h);
		const key = h.holdKey();
		const client = h.session.prompt("execute the current plan after cleanup");
		await key.entered;
		await plan(h, "local://replacement-plan.md", "CURRENT-PLAN-AFTER-INTERRUPT");
		key.release();
		for (let tick = 0; tick < 20; tick++) {
			const next = Promise.withResolvers<void>();
			setImmediate(next.resolve);
			await next.promise;
		}
		const requestsDuringCleanup = h.mock.calls.length;
		cleanup.release();
		await Promise.all([stopping, client]);
		await h.session.waitForIdle();

		expect(requestsDuringCleanup).toBe(0);
		expect(h.mock.calls).toHaveLength(1);
		const request = JSON.stringify(h.mock.calls[0]!.context);
		expect(request).toContain("CURRENT-PLAN-AFTER-INTERRUPT");
		expect(request).not.toContain("REVIEW-APPROVED-PLAN-CONTENT");
		expect(JSON.stringify(await h.saved())).toContain("CURRENT-PLAN-AFTER-INTERRUPT");
	} finally {
		h.session.goalRuntime.onTaskAborted = onTaskAborted;
		cleanup.release();
	}
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
	const hook = h.holdKey();
	const client = h.session.prompt("execute the approved plan");
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
	const replacement = "local://replacement-plan.md";
	await plan(h, replacement, "REPLACEMENT-APPROVED-PLAN-CONTENT");
	h.session.setPlanModeState({ enabled: true, planFilePath: replacement });
	h.session.setPlanModeState(undefined);
	hidden.release();
	await Promise.all([client, autonomous]);
	await h.session.waitForIdle();
	const request = JSON.stringify(h.mock.calls.at(-1)!.context);
	await h.session.prompt("continue executing");
	const nextRequest = JSON.stringify(h.mock.calls.at(-1)!.context);
	const saved = JSON.stringify(await h.saved());
	expect(request.split("REPLACEMENT-APPROVED-PLAN-CONTENT")).toHaveLength(2);
	expect(request).not.toContain("REVIEW-APPROVED-PLAN-CONTENT");
	expect(nextRequest).toContain("REPLACEMENT-APPROVED-PLAN-CONTENT");
	expect(nextRequest).not.toContain("REVIEW-APPROVED-PLAN-CONTENT");
	expect(saved.split("REPLACEMENT-APPROVED-PLAN-CONTENT")).toHaveLength(2);
	expect(saved).not.toContain("REVIEW-APPROVED-PLAN-CONTENT");
});

it("delivers paused goal policy after a prepared prompt waits for interrupt cleanup", async () => {
	const h = await setup([]);
	await h.session.goalRuntime.createGoal({ objective: "interrupt-owned activation" });
	const cleanup = h.gate();
	const onTaskAborted = h.session.goalRuntime.onTaskAborted.bind(h.session.goalRuntime);
	h.session.goalRuntime.onTaskAborted = async options => {
		await cleanup.wait();
		return onTaskAborted(options);
	};
	h.setPolicy(() => [`GOAL_STATUS_${h.session.getGoalModeState()!.goal.status}`]);
	try {
		const stopping = h.session.abort({ reason: USER_INTERRUPT_LABEL });
		await cleanup.entered;
		const key = h.holdKey();
		const hook = h.holdHook();
		let prepared = false;
		void hook.entered.then(() => {
			prepared = true;
		});
		const turn = h.session.prompt("start after goal cleanup");
		await key.entered;
		key.release();
		for (let tick = 0; tick < 20; tick++) {
			const next = Promise.withResolvers<void>();
			setImmediate(next.resolve);
			await next.promise;
		}
		const requestsDuringCleanup = h.mock.calls.length;
		expect(prepared).toBe(false);
		cleanup.release();
		await hook.entered;
		hook.release();
		await Promise.all([stopping, turn]);
		expect(requestsDuringCleanup).toBe(0);
		expect(h.mock.calls).toHaveLength(1);
		const request = JSON.stringify(h.mock.calls[0]!.context);
		expect(request).toContain("GOAL_STATUS_paused");
		expect(request).not.toContain("GOAL_STATUS_active");
	} finally {
		h.session.goalRuntime.onTaskAborted = onTaskAborted;
		cleanup.release();
	}
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

	const hook = h.holdKey();
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

it("restages changed memory instead of publishing a waiting prompt's obsolete preparation", async () => {
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
	const hook = h.holdKey();
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
	hidden.release();
	await Promise.all([client, autonomous]);
	await h.session.waitForIdle();
	const final = JSON.stringify(h.mock.calls.at(-1)!.context);
	expect(final).toContain("gamma-11");
	expect(final).not.toContain("beta-9");
	const saved = JSON.stringify(await h.saved());
	expect(saved).toContain("gamma-11");
	expect(saved).not.toContain("beta-9");
	await h.session.prompt("continue with the current deploy host");
	const next = JSON.stringify(h.mock.calls.at(-1)!.context);
	expect(next).toContain("gamma-11");
	expect(next).not.toContain("beta-9");
});

it("delivers once when a hook reapplies the selected thinking level", async () => {
	const h = await setup([]);
	h.session.setThinkingLevel(Effort.High);
	let hooks = 0;
	h.setPolicy(() => {
		hooks++;
		h.session.setThinkingLevel(Effort.High);
		return ["STABLE_THINKING_POLICY"];
	});
	await h.session.prompt("run with the selected effort");
	expect(hooks).toBe(1);
	expect(h.mock.calls).toHaveLength(1);
	expect(JSON.stringify(h.mock.calls[0]!.context.systemPrompt)).toContain("STABLE_THINKING_POLICY");
	expect(h.session.messages.filter(message => message.role === "user")).toHaveLength(1);
});

it("keeps alpha after queued alpha to beta to alpha tool selections", async () => {
	const h = await setup([]);
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
	const beta = h.session.setActiveToolsByName(["mcp__review_beta"]);
	const alpha = h.session.setActiveToolsByName(["mcp__review_alpha"]);
	await Promise.all([beta, alpha]);
	await h.session.prompt("use the last selected tools");
	expect(h.session.getActiveToolNames()).toEqual(["mcp__review_alpha"]);
	expect(h.mock.calls[0]!.context.tools?.map(tool => tool.name)).toEqual(["mcp__review_alpha"]);
});

it("delivers current extension policy after a prepared prompt waits for another run", async () => {
	const h = await setup([
		async () => {
			await hidden.wait();
			return { content: ["older work done"] };
		},
	]);
	const hidden = h.gate();
	h.setPolicy(["OBSOLETE-EXTENSION-POLICY"]);
	const hook = h.holdKey();
	const client = h.session.prompt("use current extension policy");
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
	h.setPolicy(["CURRENT-EXTENSION-POLICY"]);
	hidden.release();
	await Promise.all([client, autonomous]);
	const request = h.mock.calls.at(-1)!.context;
	expect(JSON.stringify(request.systemPrompt)).toContain("CURRENT-EXTENSION-POLICY");
	expect(JSON.stringify(request.systemPrompt)).not.toContain("OBSOLETE-EXTENSION-POLICY");
	expect(
		request.messages.filter(
			message => message.role === "user" && JSON.stringify(message.content).includes("use current extension policy"),
		),
	).toHaveLength(1);
});

it("delivers a reserved prompt before work launched by its preparation hook", async () => {
	const h = await setup([]);
	const runs: Promise<void>[] = [];
	let hooks = 0;
	h.setPolicy(() => {
		hooks++;
		runs.push(h.agent.prompt("later work"));
		return ["RESERVED_POLICY"];
	});
	await h.session.prompt("deliver reserved work");
	await Promise.all(runs);
	expect(hooks).toBe(1);
	expect(h.mock.calls).toHaveLength(2);
	expect(JSON.stringify(h.mock.calls[0]!.context)).toContain("deliver reserved work");
	expect(JSON.stringify(h.mock.calls[0]!.context)).not.toContain("later work");
});

it("waits before fresh recall and records exactly one delivered recall", async () => {
	const h = await setup(
		[
			async () => {
				await held.wait();
				return { content: ["older done"] };
			},
		],
		undefined,
		true,
		true,
	);
	const state = new MnemopiSessionState({
		sessionId: h.session.sessionId,
		config: loadMnemopiConfig(h.settings, h.dir.path()),
		session: h.session,
	});
	setMnemopiSessionState(h.session, state);
	const id = state.rememberScoped("Deploy axolotl blue deployment host is alpha seven.");
	const counts = () =>
		state.memory!.beam.db.query("SELECT recall_count, last_recalled FROM working_memory WHERE id = ?").get(id) as {
			recall_count: number;
			last_recalled: string | null;
		};
	const before = counts();
	const key = h.holdKey();
	const client = h.session.prompt("Where is Deploy axolotl blue deployment host?");
	await key.entered;
	const held = h.gate();
	const autonomous = h.agent.prompt("older work");
	await held.entered;
	const waiting = Promise.withResolvers<void>();
	const originalWait = h.agent.waitForIdle.bind(h.agent);
	h.agent.waitForIdle = () => {
		waiting.resolve();
		return originalWait();
	};
	key.release();
	await waiting.promise;
	expect(counts()).toEqual(before);
	const hook = h.holdHook();
	held.release();
	await hook.entered;
	const prepared = counts();
	expect(prepared.recall_count).toBe(1);
	hook.release();
	await Promise.all([client, autonomous]);
	expect(counts()).toEqual(prepared);
	expect(prepared.last_recalled).not.toBeNull();
	expect(JSON.stringify(h.mock.calls.at(-1)!.context)).toContain("alpha seven");
});

it("does not let a later producer claim between preparation and delivery", async () => {
	const h = await setup([]);
	const hook = h.holdHook();
	let hooks = 0;
	h.setPolicy(() => {
		hooks++;
		return ["RESERVED_POLICY"];
	});
	const client = h.session.prompt("reserved client");
	await hook.entered;
	const later = h.agent.prompt("later producer");
	expect(h.agent.state.isStreaming).toBe(false);
	hook.release();
	await Promise.all([client, later]);
	expect(hooks).toBe(1);
	expect(JSON.stringify(h.mock.calls[0]!.context)).toContain("reserved client");
	expect(JSON.stringify(h.mock.calls[0]!.context)).not.toContain("later producer");
});

it("does not recall memory for a prompt interrupted while waiting", async () => {
	const h = await setup(
		[
			async () => {
				await held.wait();
				return { content: ["older done"] };
			},
		],
		undefined,
		true,
		true,
	);
	const state = new MnemopiSessionState({
		sessionId: h.session.sessionId,
		config: loadMnemopiConfig(h.settings, h.dir.path()),
		session: h.session,
	});
	setMnemopiSessionState(h.session, state);
	const id = state.rememberScoped("Deploy axolotl blue deployment host is alpha seven.");
	const sql = state.memory!.beam.db.query("SELECT recall_count, last_recalled FROM working_memory WHERE id = ?");
	const before = sql.get(id);
	const key = h.holdKey();
	const client = h.session.prompt("Where is Deploy axolotl blue deployment host?");
	await key.entered;
	const held = h.gate();
	const older = h.agent.prompt("older work");
	await held.entered;
	const waiting = Promise.withResolvers<void>();
	const originalWait = h.agent.waitForIdle.bind(h.agent);
	h.agent.waitForIdle = () => {
		waiting.resolve();
		return originalWait();
	};
	key.release();
	await waiting.promise;
	const stopping = h.session.abort({ reason: USER_INTERRUPT_LABEL });
	held.release();
	await Promise.all([client, older, stopping]);
	expect(sql.get(id)).toEqual(before);
	await h.session.prompt("Where is Deploy axolotl blue deployment host now?");
	expect(sql.get(id)).toMatchObject({ recall_count: 1 });
});

for (const cancellation of ["interrupt", "dispose"] as const) {
	it(`releases a preparation reservation immediately on ${cancellation}`, async () => {
		const h = await setup([]);
		const hook = h.holdHook();
		const client = h.session.prompt("cancelled preparation");
		await hook.entered;
		if (cancellation === "interrupt") await h.session.abort({ reason: USER_INTERRUPT_LABEL });
		else h.session.beginDispose();
		// The old hook is still held: releasing only in its finally would deadlock this run.
		await h.agent.prompt("later prompt");
		expect(h.mock.calls).toHaveLength(1);
		expect(JSON.stringify(h.mock.calls[0]!.context)).toContain("later prompt");
		expect(JSON.stringify(h.mock.calls[0]!.context)).not.toContain("cancelled preparation");
		hook.release();
		await client;
	});
}

it("releases admission when preparation sizing throws", async () => {
	const h = await setup([]);
	const hook = h.holdHook();
	const client = h.session.prompt("failed preparation").then(
		() => undefined,
		error => error,
	);
	await hook.entered;
	const later = h.agent.prompt("later prompt");
	vi.spyOn(h.agent.tokenizer, "countMessages").mockImplementationOnce(() => {
		throw new Error("preparation sizing failed");
	});
	hook.release();
	expect(await client).toMatchObject({ message: "preparation sizing failed" });
	await later;
	expect(h.mock.calls).toHaveLength(1);
	expect(JSON.stringify(h.mock.calls[0]!.context)).toContain("later prompt");
	expect(JSON.stringify(h.mock.calls[0]!.context)).not.toContain("failed preparation");
});

it("dispatches a waiting prompt ahead of a producer that starts at every idle event", async () => {
	const h = await setup([
		async () => {
			await held.wait();
			return { content: ["older done"] };
		},
	]);
	const held = h.gate();
	const key = h.holdKey();
	let hooks = 0;
	h.setPolicy(() => {
		hooks++;
		return ["CURRENT_POLICY"];
	});
	const client = h.session.prompt("waiting original client");
	await key.entered;
	const older = h.agent.prompt("older run");
	await held.entered;
	const waiting = Promise.withResolvers<void>();
	const originalWait = h.agent.waitForIdle.bind(h.agent);
	h.agent.waitForIdle = () => {
		waiting.resolve();
		return originalWait();
	};
	key.release();
	await waiting.promise;
	const runs: Promise<void>[] = [];
	const unsubscribe = h.agent.subscribe(event => {
		if (event.type === "agent_end" && runs.length < 9) runs.push(h.agent.prompt(`later run ${runs.length}`));
	});
	try {
		held.release();
		await older;
		await client;
		for (let i = 0; i < runs.length; i++) await runs[i];
		expect(hooks).toBe(1);
		expect(JSON.stringify(h.mock.calls[1]!.context)).toContain("waiting original client");
		expect(JSON.stringify(h.mock.calls[1]!.context)).not.toContain("later run");
	} finally {
		unsubscribe();
		await Promise.all(runs);
	}
});
