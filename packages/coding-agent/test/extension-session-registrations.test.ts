/**
 * What an extension registers while a session is running belongs to that session: it runs as that
 * session's work, and it is withdrawn when that session ends, so the next session on the same
 * runtime sees a true picture — the tool absent, not listed and answering nothing. What the
 * extension's factory registers at load serves every session. A `ctx` and a timer a session holds
 * are that session's, and do nothing once it has gone, whichever session the runtime serves next.
 */
import { afterEach, describe, expect, test } from "bun:test";
import * as path from "node:path";
import { Type } from "@oh-my-pi/omptype/typebox";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { ExtensionRuntime, loadExtensionFromFactory } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/loader";
import { ExtensionRunner } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/runner";
import type {
	ExtensionActions,
	ExtensionAPI,
	ExtensionContext,
	ExtensionContextActions,
	ExtensionUIContext,
} from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";
import { TempDir } from "@oh-my-pi/pi-utils";

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

/** The actions a runner is initialized with: only what these tests read is real. */
function actions(): [ExtensionActions, ExtensionContextActions] {
	// The runner stores these and calls only the members a test exercises.
	const host = {
		sendMessage() {},
		sendUserMessage() {},
		appendEntry() {},
		setLabel() {},
		getActiveTools: () => [],
		getAllTools: () => [],
		setActiveTools: async () => {},
		getCommands: () => [],
		setModel: async () => false,
		getThinkingLevel: () => undefined,
		setThinkingLevel() {},
		getSessionName: () => undefined,
		setSessionName: async () => {},
	} as unknown as ExtensionActions;
	const context = {
		getModel: () => undefined,
		isIdle: () => true,
		abort() {},
		hasPendingMessages: () => false,
		shutdown() {},
		getContextUsage: () => undefined,
		compact: async () => {},
		getSystemPrompt: () => [],
	} as unknown as ExtensionContextActions;
	return [host, context];
}

/** A runtime and runner reused for one session after another, as a host that keeps them does. */
async function reusedRuntime(factory: (pi: ExtensionAPI) => void) {
	const dir = TempDir.createSync("@session-registrations-");
	const auth = await AuthStorage.create(path.join(dir.path(), "auth.db"));
	const registry = new ModelRegistry(auth, path.join(dir.path(), "models.json"));
	const runtime = new ExtensionRuntime();
	const extension = await loadExtensionFromFactory(factory, dir.path(), new EventBus(), runtime, "registrations");
	const runner = new ExtensionRunner([extension], runtime, dir.path(), SessionManager.inMemory(dir.path()), registry);
	const [host, context] = actions();
	runner.initialize(host, context, undefined, { ...runner.getUIContext() }, "rpc");
	const releases: Array<() => void> = [];
	cleanups.push(() => {
		for (const release of releases) release();
		auth.close();
		dir.removeSync();
	});
	/** Starts the next session on the runtime and answers its release. */
	const session = (): (() => void) => {
		const release = runtime.beginSession();
		releases.push(release);
		return release;
	};
	return { runtime, runner, registry, session };
}

const toolNames = (runner: ExtensionRunner): string[] =>
	runner
		.getAllRegisteredTools()
		.map(tool => tool.definition.name)
		.sort();

const tool = (name: string, answer: string) => ({
	name,
	label: name,
	description: `answers ${answer}`,
	parameters: Type.Object({}),
	execute: async () => ({ content: [{ type: "text" as const, text: answer }] }),
});

describe("what a session registers", () => {
	test("is withdrawn when the session ends, restoring what it replaced, and load-time registrations stay", async () => {
		const h = await reusedRuntime(pi => {
			pi.registerTool(tool("loaded", "load"));
			pi.registerTool(tool("replaced", "load"));
			pi.registerCommand("loaded-command", { handler: async () => {} });
			pi.on("session_start", () => {
				pi.registerTool(tool("from-session", "session"));
				pi.registerTool(tool("replaced", "session"));
				pi.registerCommand("session-command", { handler: async () => {} });
				pi.registerFlag("session-flag", { type: "boolean", default: true });
				pi.registerShortcut("ctrl+alt+s", { handler: () => {} });
			});
		});
		const endA = h.session();
		await h.runner.emit({ type: "session_start" });
		const duringA = {
			tools: toolNames(h.runner),
			replacedBy: h.runner.getAllRegisteredTools().find(entry => entry.definition.name === "replaced")?.definition
				.description,
			command: h.runner.getCommand("session-command") !== undefined,
			flag: h.runner.getFlags().has("session-flag"),
			shortcut: h.runner.getShortcuts().has("ctrl+alt+s"),
		};
		endA();
		h.session();
		const inB = {
			tools: toolNames(h.runner),
			replacedBy: h.runner.getAllRegisteredTools().find(entry => entry.definition.name === "replaced")?.definition
				.description,
			command: h.runner.getCommand("session-command") !== undefined,
			loadedCommand: h.runner.getCommand("loaded-command") !== undefined,
			flag: h.runner.getFlags().has("session-flag"),
			shortcut: h.runner.getShortcuts().has("ctrl+alt+s"),
		};

		expect(duringA).toEqual({
			tools: ["from-session", "loaded", "replaced"],
			replacedBy: "answers session",
			command: true,
			flag: true,
			shortcut: true,
		});
		expect(inB).toEqual({
			tools: ["loaded", "replaced"],
			replacedBy: "answers load",
			command: false,
			loadedCommand: true,
			flag: false,
			shortcut: false,
		});
	});

	test("a handler registered during a session is not called in the next one; one registered at load is", async () => {
		const calls: string[] = [];
		const h = await reusedRuntime(pi => {
			pi.on("session_start", () => {
				calls.push("load-time handler");
				pi.on("session_shutdown", () => void calls.push("session-time handler"));
			});
		});
		const endA = h.session();
		await h.runner.emit({ type: "session_start" });
		await h.runner.emit({ type: "session_shutdown" });
		endA();
		h.session();
		calls.push("-- B --");
		await h.runner.emit({ type: "session_shutdown" });

		expect(calls).toEqual(["load-time handler", "session-time handler", "-- B --"]);
	});

	test("a provider registered during a session leaves the registry with it; one registered at load stays", async () => {
		const provider = (id: string) => ({
			api: "openai-completions" as const,
			baseUrl: "http://127.0.0.1:9/v1",
			apiKey: "local-key",
			models: [
				{
					id,
					name: id,
					reasoning: false,
					input: ["text" as const],
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
					contextWindow: 8_000,
					maxTokens: 1_000,
				},
			],
		});
		const h = await reusedRuntime(pi => {
			pi.on("session_start", () => {
				pi.registerProvider("session-provider", provider("session-model"));
			});
		});
		// The host drains what the factory queued at load, with its owner, as `sdk.ts` does.
		for (const { name, config, sourceId, owner } of h.runtime.pendingProviderRegistrations.splice(0)) {
			h.registry.registerProvider(name, config, sourceId, owner);
		}
		h.registry.registerProvider("load-provider", provider("load-model"), "registrations", h.runtime);
		const endA = h.session();
		await h.runner.emit({ type: "session_start" });
		const duringA = {
			session: h.registry.find("session-provider", "session-model") !== undefined,
			load: h.registry.find("load-provider", "load-model") !== undefined,
		};
		endA();
		h.session();
		const inB = {
			session: h.registry.find("session-provider", "session-model") !== undefined,
			load: h.registry.find("load-provider", "load-model") !== undefined,
		};

		expect(duringA).toEqual({ session: true, load: true });
		expect(inB).toEqual({ session: false, load: true });
	});

	test("a session that has ended can register nothing", async () => {
		let api: ExtensionAPI | undefined;
		const h = await reusedRuntime(pi => {
			api = pi;
			pi.on("session_start", async () => {
				// Runs on after the session has ended: the continuation is still that session's work.
				await ended.promise;
				try {
					pi.registerTool(tool("late", "late"));
					outcome.resolve("registered");
				} catch (error) {
					outcome.resolve(String(error));
				}
			});
		});
		const ended = Promise.withResolvers<void>();
		const outcome = Promise.withResolvers<string>();
		const endA = h.session();
		const dispatched = h.runner.emit({ type: "session_start" });
		endA();
		h.session();
		ended.resolve();
		const result = await outcome.promise;
		await dispatched.catch(() => undefined);

		expect(api).toBeDefined();
		expect(result).toContain("its session has ended");
		expect(toolNames(h.runner)).toEqual([]);
	});
});

describe("what a session holds, once it has gone", () => {
	test("a ctx.ui it saved writes nothing while the runtime serves the next session", async () => {
		const writes: string[] = [];
		let saved: ExtensionContext | undefined;
		const h = await reusedRuntime(pi => {
			pi.on("session_start", (_event, ctx) => {
				saved = ctx;
			});
		});
		const ui: ExtensionUIContext = {
			...h.runner.getUIContext(),
			notify: message => void writes.push(message),
		};
		const [host, context] = actions();
		h.runner.initialize(host, context, undefined, ui, "rpc");
		const endA = h.session();
		await h.runner.emit({ type: "session_start" });
		saved?.ui.notify("live");
		endA();
		h.session();
		let refused = false;
		try {
			// Called from outside any admission, as code the session set going elsewhere would.
			saved?.ui.notify("PLANTED BY A DISPOSED SESSION");
		} catch {
			refused = true;
		}

		expect({ writes, refused }).toEqual({ writes: ["live"], refused: true });
	});

	test("a timer it scheduled after the shutdown sweep does not run in the next session", async () => {
		const fired: string[] = [];
		const swept = Promise.withResolvers<void>();
		const scheduled = Promise.withResolvers<void>();
		const h = await reusedRuntime(pi => {
			pi.on("session_start", async (_event, ctx) => {
				// A continuation of this session's handler, running on after the shutdown sweep.
				await swept.promise;
				ctx.setTimeout(() => void fired.push("timer"), 20);
				scheduled.resolve();
			});
		});
		const endA = h.session();
		const started = h.runner.emit({ type: "session_start" });
		await h.runner.emit({ type: "session_shutdown" });
		swept.resolve();
		await scheduled.promise;
		await started.catch(() => undefined);
		endA();
		h.session();
		// Real time on purpose: the managed timer is a real one.
		await Bun.sleep(80);

		expect(fired).toEqual([]);
	});
});
