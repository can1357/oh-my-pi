import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import type { Model } from "@oh-my-pi/pi-ai";
import { createMockModel, type MockResponse } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { ExtensionRuntime, loadExtensionFromFactory } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/loader";
import { ExtensionRunner } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/runner";
import type { ExtensionFactory } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import {
	AgentSession,
	type AgentSessionEvent,
	PromptDroppedError,
} from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { SessionTools } from "@oh-my-pi/pi-coding-agent/session/session-tools";
import { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import { TempDir } from "@oh-my-pi/pi-utils";
import { mockSchedulerWaitWithClock } from "./helpers/mock-scheduler-clock";

// `beginDispose()` ends the work a session has in flight that has not reached the
// agent: after it, that work switches no model, appends no entry, sends no request
// and announces no result. Each case holds one await of that work open, begins
// disposal inside it, then lets it go on.

function bundled(provider: string, id: string): Model {
	const model = getBundledModel(provider, id);
	if (!model) throw new Error(`Expected the bundled model ${provider}/${id}`);
	return model;
}

const primary = bundled("anthropic", "claude-sonnet-4-5");
const fallback = bundled("openai", "gpt-4o-mini");
const fireworksFast = bundled("fireworks", "kimi-k3-fast");
const primarySelector = `${primary.provider}/${primary.id}`;
const fallbackSelector = `${fallback.provider}/${fallback.id}`;

describe("AgentSession.beginDispose and in-flight work", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;
	const sessions: AgentSession[] = [];

	beforeAll(async () => {
		tempDir = TempDir.createSync("@pi-begin-dispose-");
		await initTheme();
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
		authStorage.keys.setRuntime("anthropic", "anthropic-test-key");
		authStorage.keys.setRuntime("openai", "openai-test-key");
		authStorage.keys.setRuntime("fireworks", "fireworks-test-key");
		modelRegistry = new ModelRegistry(authStorage, path.join(tempDir.path(), "models.yml"));
	});

	afterAll(() => {
		authStorage.close();
		tempDir.removeSync();
	});

	afterEach(async () => {
		for (const session of sessions.splice(0)) await session.dispose();
		vi.restoreAllMocks();
	});

	/** A session whose requests are recorded, and whose events after `beginDispose()` are kept apart. */
	async function createSession(options: {
		model?: Model;
		settings?: Record<string, unknown>;
		respond?: (model: Model) => MockResponse;
		extension?: ExtensionFactory;
	}) {
		const model = options.model ?? primary;
		// No probe reaches a provider; a case that needs a reserve replaces this.
		vi.spyOn(modelRegistry.authStorage.health, "model").mockResolvedValue({ state: "healthy", accounts: [] });
		const requested: string[] = [];
		const mock = createMockModel();
		const agent = new Agent({
			getApiKey: requestModel => `${requestModel.provider}-test-key`,
			initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] },
			streamFn: (requestModel, context, streamOptions) => {
				requested.push(`${requestModel.provider}/${requestModel.id}`);
				mock.push(options.respond?.(requestModel) ?? { content: ["done"] });
				return mock.stream(requestModel, context, streamOptions);
			},
		});
		const settings = Settings.isolated({
			"compaction.enabled": false,
			"retry.fallbackChains": { default: [fallbackSelector] },
			...options.settings,
		});
		settings.setModelRole("default", `${model.provider}/${model.id}`);
		const sessionManager = SessionManager.inMemory();
		let extensionRunner: ExtensionRunner | undefined;
		if (options.extension) {
			const runtime = new ExtensionRuntime();
			const extension = await loadExtensionFromFactory(
				options.extension,
				tempDir.path(),
				new EventBus(),
				runtime,
				"begin-dispose-probe",
			);
			extensionRunner = new ExtensionRunner([extension], runtime, tempDir.path(), sessionManager, modelRegistry);
		}
		const session = new AgentSession({ agent, sessionManager, settings, modelRegistry, extensionRunner });
		sessions.push(session);
		const afterDisposal: AgentSessionEvent[] = [];
		session.subscribe(event => {
			if (session.isDisposed) afterDisposal.push(event);
		});
		return { session, sessionManager, requested, afterDisposal };
	}

	/** One held await: `started` settles when the work reaches it, `release` lets the work go on. */
	function hold<T>() {
		const started = Promise.withResolvers<void>();
		const release = Promise.withResolvers<T>();
		return { started, release };
	}

	it("drops a prompt whose credential lookup is in flight, and tells its caller", async () => {
		const { session, sessionManager, requested } = await createSession({});
		const lookup = hold<string>();
		vi.spyOn(modelRegistry, "getApiKey").mockImplementation(async () => {
			lookup.started.resolve();
			return lookup.release.promise;
		});

		const prompt = session.prompt("a prompt whose key is still being looked up");
		await lookup.started.promise;
		session.beginDispose();
		lookup.release.resolve("anthropic-test-key");

		const outcome = await prompt.then(
			() => "resolved",
			(error: unknown) => error,
		);

		expect(requested).toEqual([]);
		expect(sessionManager.getEntries().filter(entry => entry.type === "message")).toEqual([]);
		// No `throwOnDrop`: a disposing session reports its drop to every caller.
		expect(outcome).toMatchObject({ name: "PromptDroppedError", sessionDisposed: true });
	});

	it("rejects, rather than resolves, a prompt dropped because its primary has no key once disposal began", async () => {
		const { session, sessionManager, requested } = await createSession({});
		const lookup = hold<void>();
		vi.spyOn(modelRegistry, "getApiKey").mockImplementation(async requestModel => {
			if (requestModel.provider !== primary.provider) return `${requestModel.provider}-test-key`;
			lookup.started.resolve();
			await lookup.release.promise;
			return undefined;
		});

		const prompt = session.prompt("a prompt whose primary key is missing");
		await lookup.started.promise;
		session.beginDispose();
		lookup.release.resolve();

		const outcome = await prompt.then(
			() => "resolved",
			(error: unknown) => error,
		);

		// A keyed fallback exists, but switching to it would happen after disposal.
		expect(requested).toEqual([]);
		expect(session.model?.id).toBe(primary.id);
		expect(sessionManager.getEntries().filter(entry => entry.type === "message")).toEqual([]);
		expect(outcome).toBeInstanceOf(PromptDroppedError);
	});

	it("restores no primary, writes nothing and sends nothing when disposal begins during the restore", async () => {
		const { session, sessionManager, requested, afterDisposal } = await createSession({});
		let phase: "missing" | "held" = "missing";
		const lookup = hold<void>();
		vi.spyOn(modelRegistry, "getApiKey").mockImplementation(async requestModel => {
			if (requestModel.provider !== primary.provider) return `${requestModel.provider}-test-key`;
			if (phase === "missing") return undefined;
			lookup.started.resolve();
			await lookup.release.promise;
			return "anthropic-test-key";
		});
		// The first prompt walks to the unpinned fallback because the primary has no key.
		await session.prompt("first, on the fallback");
		expect(session.model?.id).toBe(fallback.id);
		const entriesBefore = sessionManager.getEntries().length;

		phase = "held";
		const prompt = session.prompt("second, which would restore the primary");
		await lookup.started.promise;
		session.beginDispose();
		lookup.release.resolve();

		const outcome = await prompt.then(
			() => "resolved",
			(error: unknown) => error,
		);

		expect(requested).toEqual([fallbackSelector]);
		expect(session.model?.id).toBe(fallback.id);
		expect(afterDisposal.map(event => event.type)).not.toContain("model_changed");
		expect(sessionManager.getEntries().slice(entriesBefore)).toEqual([]);
		expect(outcome).toBeInstanceOf(PromptDroppedError);
	});

	it("announces no usage fallback whose prompt re-sync outlasts beginDispose", async () => {
		const { session, requested, afterDisposal } = await createSession({
			settings: { "retry.usageAwareFallback": true, "retry.usageReservePolicy": "confirm" },
		});
		vi.spyOn(modelRegistry.authStorage.health, "model").mockImplementation(async provider =>
			provider === primary.provider
				? {
						state: "reserve",
						accounts: [
							{
								credentialId: 1,
								credentialType: "oauth",
								selected: true,
								state: "reserve",
								remainingFraction: 0.05,
							},
						],
					}
				: { state: "healthy", accounts: [] },
		);
		session.setUsageFallbackConfirmer(async () => true);
		const resync = hold<void>();
		vi.spyOn(SessionTools.prototype, "syncAfterModelChange").mockImplementation(async (_previous, options) => {
			if (!options?.retryFallback) return;
			resync.started.resolve();
			await resync.release.promise;
		});

		const prompt = session.prompt("leave the reserve-bound model");
		await resync.started.promise;
		session.beginDispose();
		resync.release.resolve();

		const outcome = await prompt.then(
			() => "resolved",
			(error: unknown) => error,
		);

		expect(afterDisposal.map(event => event.type)).not.toContain("retry_fallback_applied");
		expect(requested).toEqual([]);
		expect(outcome).toBeInstanceOf(PromptDroppedError);
	});

	it("announces no Fireworks Fast degrade whose re-sync outlasts beginDispose, and settles the prompt", async () => {
		const { session, requested, afterDisposal } = await createSession({
			model: fireworksFast,
			settings: { "retry.baseDelayMs": 5, "retry.fallbackChains": {} },
			respond: requestModel =>
				requestModel.id === fireworksFast.id
					? { throw: "rate limit exceeded retry-after-ms=200" }
					: { content: ["the base model answered"] },
		});
		const resync = hold<void>();
		vi.spyOn(SessionTools.prototype, "syncAfterModelChange").mockImplementation(async (_previous, options) => {
			if (!options?.retryFallback) return;
			resync.started.resolve();
			await resync.release.promise;
		});
		mockSchedulerWaitWithClock();

		const prompt = session.prompt("degrade off Fast");
		await resync.started.promise;
		session.beginDispose();
		resync.release.resolve();
		await prompt;

		expect(requested).toEqual([`${fireworksFast.provider}/${fireworksFast.id}`]);
		expect(afterDisposal.map(event => event.type)).not.toContain("retry_fallback_applied");
	});

	it("commits no compaction that a session_before_compact hook returns after beginDispose", async () => {
		const hook = hold<void>();
		const { session, sessionManager, afterDisposal } = await createSession({
			settings: { "compaction.keepRecentTokens": 1 },
			extension: pi => {
				pi.on("session_before_compact", async event => {
					hook.started.resolve();
					await hook.release.promise;
					return {
						compaction: {
							summary: "a summary returned after disposal began",
							shortSummary: undefined,
							firstKeptEntryId: event.preparation.firstKeptEntryId,
							tokensBefore: event.preparation.tokensBefore,
							details: {},
						},
					};
				});
			},
		});
		await session.prompt("a first task with enough words to leave something to compact");
		await session.prompt("a second task to keep");
		const entriesBefore = sessionManager.getEntries().length;

		const compacting = session.compact(undefined, { mode: "soft" }).catch(() => undefined);
		await hook.started.promise;
		session.beginDispose();
		hook.release.resolve();
		await compacting;

		expect(
			sessionManager
				.getEntries()
				.slice(entriesBefore)
				.map(entry => entry.type),
		).not.toContain("compaction");
		// The one event left closes the manual_compaction_start listeners already saw, as aborted.
		const ends = afterDisposal.filter(event => event.type === "manual_compaction_end");
		expect(ends.map(event => (event.type === "manual_compaction_end" ? event.aborted : undefined))).toEqual([true]);
	});

	it("moves no tree leaf for a session_before_tree summary returned after beginDispose", async () => {
		const hook = hold<void>();
		const { session, sessionManager } = await createSession({
			extension: pi => {
				pi.on("session_before_tree", async () => {
					hook.started.resolve();
					await hook.release.promise;
					return { summary: { summary: "a branch summary returned after disposal began" } };
				});
			},
		});
		await session.prompt("the first task");
		await session.prompt("the second task");
		const firstUser = sessionManager
			.getBranch()
			.find(entry => entry.type === "message" && entry.message.role === "user");
		if (!firstUser) throw new Error("Expected the first user message entry");
		const leafBefore = sessionManager.getLeafId();
		const entriesBefore = sessionManager.getEntries().length;

		const navigating = session.navigateTree(firstUser.id, { summarize: true });
		await hook.started.promise;
		session.beginDispose();
		hook.release.resolve();

		expect(await navigating).toMatchObject({ cancelled: true, aborted: true });
		expect(sessionManager.getLeafId()).toBe(leafBefore);
		expect(sessionManager.getEntries()).toHaveLength(entriesBefore);
	});

	it("settles a prompt whose retry is announced as disposal begins, and sends no retry", async () => {
		const { session, requested } = await createSession({
			settings: { "retry.modelFallback": false, "retry.baseDelayMs": 5 },
			respond: () => ({ throw: "503 service unavailable" }),
		});
		const retryEnds: string[] = [];
		session.subscribe(event => {
			if (event.type === "auto_retry_start") session.beginDispose();
			if (event.type === "auto_retry_end") retryEnds.push(event.finalError ?? "");
		});
		mockSchedulerWaitWithClock();

		// Before the fix this prompt never settled: the retry's continuation was skipped
		// on the disposed session and nothing resolved the retry it was waiting on.
		await session.prompt("fail once while being disposed");

		expect(requested).toEqual([primarySelector]);
		expect(retryEnds).toEqual(["Retry cancelled"]);
	});
});
