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
	ExtensionCommandContextActions,
	ExtensionContext,
	ExtensionContextActions,
	ExtensionUIContext,
	SessionStopEvent,
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

describe("what a session registered, held by the host after the session ends", () => {
	test("a tool's retained callbacks do not run once their session has ended", async () => {
		const calls: string[] = [];
		const h = await reusedRuntime(pi => {
			pi.on("session_start", () => {
				pi.registerTool({
					...tool("held", "A"),
					execute: async () => {
						calls.push("execute");
						return { content: [{ type: "text" as const, text: "A" }] };
					},
					describeCall: () => {
						calls.push("describeCall");
						return undefined;
					},
					// The renderer's return type is the host's component; nothing here is drawn.
					renderCall: (() => {
						calls.push("renderCall");
						return undefined;
					}) as never,
					onSession: () => void calls.push("onSession"),
				});
			});
		});
		const endA = h.session();
		await h.runner.emit({ type: "session_start" });
		// What a host keeps of the tool — its adapter holds the admitted definition.
		const held = h.runner.getAllRegisteredTools().find(entry => entry.definition.name === "held")?.definition;
		if (!held) throw new Error("the session's tool was not registered");
		endA();
		h.session();
		let executed = "returned";
		try {
			await held.execute("late", {}, undefined, undefined, h.runner.createContext());
		} catch (error) {
			executed = String(error);
		}
		held.describeCall?.({}, {} as never);
		held.renderCall?.({}, {} as never, {} as never);
		await held.onSession?.({ reason: "start" } as never, h.runner.createContext());

		expect({ calls, executed }).toEqual({
			calls: [],
			executed: expect.stringContaining("the session that registered this tool has ended"),
		});
	});

	test("a composer shape's drawing methods do not run once their session has ended", async () => {
		const calls: string[] = [];
		const h = await reusedRuntime(pi => {
			pi.on("session_start", () => {
				pi.registerComposerShape({
					label: "Session shape",
					style: {
						id: "session-shape",
						filledSurface: true,
						sideBorders: false,
						verticalChrome: false,
						statusAttachment: "inside",
						bottomBar: false,
						bottomBarGap: 0,
						defaultPromptGutter: true,
						defaultPaddingX: () => (calls.push("defaultPaddingX"), 1),
						sideChromeWidth: () => (calls.push("sideChromeWidth"), 0),
						renderTop: () => (calls.push("renderTop"), "top"),
						renderRow: () => (calls.push("renderRow"), ["row"]),
						renderBottom: () => (calls.push("renderBottom"), "bottom"),
					} as never,
				});
			});
		});
		const endA = h.session();
		await h.runner.emit({ type: "session_start" });
		// The host installs what the runner hands it, and keeps drawing through it.
		const installed = h.runner.getComposerShapes().find(shape => shape.style.id === "session-shape")?.style;
		if (!installed) throw new Error("the session's shape was not registered");
		installed.renderTop({ width: 40 } as never);
		const live = [...calls];
		endA();
		h.session();
		calls.length = 0;
		for (const draw of [
			() => installed.defaultPaddingX(undefined),
			() => installed.sideChromeWidth(1),
			() => installed.renderTop({ width: 40 } as never),
			() => installed.renderRow({ width: 40 } as never),
			() => installed.renderBottom({ width: 40 } as never),
		]) {
			try {
				draw();
			} catch {
				// The host's `box` fallback may want a fuller context than this probe gives it.
			}
		}

		expect({ live, afterEnd: calls, filledSurface: installed.filledSurface }).toEqual({
			live: ["renderTop"],
			afterEnd: [],
			filledSurface: false,
		});
	});

	test("a session flag's value is withdrawn with its declaration, whatever it was set to", async () => {
		const h = await reusedRuntime(pi => {
			pi.on("session_start", () => {
				pi.registerFlag("session-flag", { type: "string", default: "default" });
			});
		});
		const endA = h.session();
		await h.runner.emit({ type: "session_start" });
		h.runner.setFlagValue("session-flag", "chosen-by-the-user");
		const during = h.runner.getFlagValues().get("session-flag");
		endA();
		h.session();

		expect({ during, after: h.runner.getFlagValues().has("session-flag") }).toEqual({
			during: "chosen-by-the-user",
			after: false,
		});
	});
});

describe("a dispatch under way when its session ends", () => {
	test("runs its remaining load-time handlers, and their result reaches the host", async () => {
		const seen: string[] = [];
		let release: (() => void) | undefined;
		const h = await reusedRuntime(pi => {
			pi.on("session_start", () => void seen.push("load-1"));
			pi.on("session_start", async () => {
				seen.push("load-2 enter");
				release?.();
				await Promise.resolve();
				seen.push("load-2 leave");
			});
			pi.on("session_start", () => void seen.push("load-3"));
			pi.on("session_stop", () => {
				release?.();
				return undefined;
			});
			pi.on("session_stop", () => ({ decision: "block" as const, reason: "an extension objects" }));
		});
		const errors: string[] = [];
		h.runner.onError(error => void errors.push(error.error));
		release = h.session();
		await h.runner.emit({ type: "session_start" });
		release = h.session();
		const stopped = await h.runner.emitSessionStop({
			// Only the signal is read by the dispatch; the rest of the event is the handlers' to ignore.
			...({} as Omit<SessionStopEvent, "type" | "signal">),
			signal: new AbortController().signal,
		});

		expect({ seen, stopped, errors }).toEqual({
			seen: ["load-1", "load-2 enter", "load-2 leave", "load-3"],
			stopped: expect.objectContaining({ decision: "block" }),
			errors: [],
		});
	});
});

describe("a provider", () => {
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

	test("a session that replaced a load-time provider twice gives the next session the load-time catalog", async () => {
		const h = await reusedRuntime(pi => {
			pi.registerProvider("shared", provider("load"));
			pi.on("session_start", () => {
				pi.registerProvider("shared", provider("A1"));
				pi.registerProvider("shared", provider("A2"));
			});
		});
		// The host drains what the factory queued at load, with its owner, as `sdk.ts` does.
		for (const { name, config, sourceId, owner } of h.runtime.pendingProviderRegistrations.splice(0)) {
			h.registry.registerProvider(name, config, sourceId, owner);
		}
		const endA = h.session();
		await h.runner.emit({ type: "session_start" });
		const duringA = h.registry.find("shared", "A2") !== undefined;
		endA();
		h.session();

		expect({
			duringA,
			loadInB: h.registry.find("shared", "load") !== undefined,
			a2InB: h.registry.find("shared", "A2") !== undefined,
		}).toEqual({ duringA: true, loadInB: true, a2InB: false });
	});

	test("an ended session's continuation can neither register nor unregister one", async () => {
		const outcomes: string[] = [];
		const resume = Promise.withResolvers<void>();
		const done = Promise.withResolvers<void>();
		const attempt = (call: () => void): string => {
			try {
				call();
				return "returned";
			} catch (error) {
				return String(error);
			}
		};
		let api: ExtensionAPI | undefined;
		const h = await reusedRuntime(pi => {
			api = pi;
			pi.on("session_start", async () => {
				await resume.promise;
				outcomes.push(attempt(() => pi.registerProvider("late", provider("late-model"))));
				outcomes.push(attempt(() => pi.unregisterProvider("b-provider")));
				done.resolve();
			});
		});
		const endA = h.session();
		const started = h.runner.emit({ type: "session_start" });
		endA();
		h.session();
		h.registry.registerProvider("b-provider", provider("b-model"), "registrations", h.runtime);
		resume.resolve();
		await done.promise;
		await started.catch(() => undefined);

		expect(api).toBeDefined();
		expect(outcomes).toEqual([
			expect.stringContaining("its session has ended"),
			expect.stringContaining("its session has ended"),
		]);
		expect(h.registry.find("b-provider", "b-model")).toBeDefined();
		expect(h.registry.find("late", "late-model")).toBeUndefined();
	});
});

/** `source`, with every function it has — its own and its prototype chain's — recorded at the host
 *  under `label` when it is called: what reaches the host is counted there, not inferred from
 *  whether a member threw. */
function watched<T extends object>(source: T, label: string, reached: string[]): T {
	return new Proxy(source, {
		get(target, key) {
			const value: unknown = Reflect.get(target, key, target);
			if (typeof value !== "function" || typeof key !== "string") return value;
			return (...args: unknown[]) => {
				reached.push(`${label}.${key}`);
				return Reflect.apply(value, target, args);
			};
		},
	});
}

/** A reused runtime whose every host service is watched: the actions, the context and command
 *  actions with their optional members, the UI, the history, the registry, the memory backend,
 *  the `local://` options, the job snapshot and the annotations factory. */
async function watchedRuntime(factory: (pi: ExtensionAPI) => void) {
	const dir = TempDir.createSync("@session-registrations-watched-");
	const auth = await AuthStorage.create(path.join(dir.path(), "auth.db"));
	const reached: string[] = [];
	const registry = watched(new ModelRegistry(auth, path.join(dir.path(), "models.json")), "registry", reached);
	const sessionManager = watched(SessionManager.inMemory(dir.path()), "sessionManager", reached);
	const runtime = new ExtensionRuntime();
	const extension = await loadExtensionFromFactory(factory, dir.path(), new EventBus(), runtime, "watched");
	const runner = new ExtensionRunner(
		[extension],
		runtime,
		dir.path(),
		sessionManager,
		registry,
		() =>
			watched(
				{ status: async () => ({}), search: async () => [], save: async () => ({}) },
				"memory",
				reached,
			) as never,
		undefined,
		watched({ getArtifactsDir: () => dir.path(), getSessionId: () => "id" }, "localProtocol", reached),
		watched({ snapshot: () => null }, "jobs", reached).snapshot,
		undefined,
		(_getContext, sendUserMessage) =>
			watched(
				{ submit: async () => sendUserMessage("annotated"), open: async () => undefined },
				"annotations",
				reached,
			) as never,
	);
	const [host] = actions();
	const hostActions = watched(host, "actions", reached);
	const contextActions = watched(
		{
			...actions()[1],
			resolvePlanReview: () => false,
			getPendingPlanReview: () => undefined,
			openPlanReview: async () => false,
			sessionModes: { getState: () => ({}) as never, set: async () => ({}) as never },
			runEphemeralTurn: async () => ({}) as never,
			startLive: async () => ({ sdpAnswer: "answer", voice: "voice", stop: async () => {} }),
		} satisfies ExtensionContextActions,
		"ctx",
		reached,
	);
	const commandActions = watched(
		{
			getContextUsage: () => undefined,
			waitForIdle: async () => {},
			newSession: async () => ({ cancelled: false }),
			branch: async () => ({ cancelled: false }),
			navigateTree: async () => ({ cancelled: false }),
			compact: async () => {},
			switchSession: async () => ({ cancelled: false }),
			reload: async () => {},
		} satisfies ExtensionCommandContextActions,
		"command",
		reached,
	);
	const ui = watched({ ...runner.getUIContext() }, "ui", reached);
	runner.initialize(hostActions, contextActions, commandActions, ui, "tui");
	const releases: Array<() => void> = [];
	cleanups.push(() => {
		for (const release of releases) release();
		auth.close();
		dir.removeSync();
	});
	const session = (): (() => void) => {
		const release = runtime.beginSession();
		releases.push(release);
		return release;
	};
	return { runtime, runner, reached, session, hostActions, contextActions, commandActions };
}

/** Calls every function member of `target` with no arguments, and reads every getter, to `depth`
 *  levels through what the members answer — the facades a context hands included. */
async function callEverything(target: object, depth: number, seen = new Set<object>()): Promise<void> {
	if (depth === 0 || seen.has(target)) return;
	seen.add(target);
	const keys = new Set<string>();
	for (let at: object | null = target; at !== null && at !== Object.prototype; at = Object.getPrototypeOf(at)) {
		for (const key of Object.getOwnPropertyNames(at)) if (key !== "constructor") keys.add(key);
	}
	for (const key of keys) {
		let value: unknown;
		try {
			value = Reflect.get(target, key, target);
		} catch {
			continue;
		}
		if (typeof value === "function") {
			try {
				value = await Reflect.apply(value, target, []);
			} catch {
				continue;
			}
		}
		if (typeof value === "object" && value !== null) await callEverything(value, depth - 1, seen);
	}
}

describe("a ctx a session kept, once that session has gone", () => {
	test("reaches no host service through any member, the undefined call of one that installs or clears included", async () => {
		let kept: ExtensionContext | undefined;
		const h = await watchedRuntime(pi => {
			pi.on("session_start", (_event, ctx) => {
				kept = ctx;
			});
		});
		const endA = h.session();
		await h.runner.emit({ type: "session_start" });
		const command = h.runner.createCommandContext();
		if (!kept) throw new Error("session_start did not run");
		// While the session is live these reach the host: what is watched is the host itself.
		h.reached.length = 0;
		kept.abort();
		kept.ui.getEditorText();
		kept.sessionManager.getEntries();
		kept.models.current();
		const live = [...h.reached];
		endA();
		// The next session is live, on the same runtime and runner.
		h.session();
		h.reached.length = 0;
		await callEverything(kept, 4);
		await callEverything(command, 4);
		// Real time on purpose: a timer that slipped through would be a real one.
		await Bun.sleep(40);

		expect({ live, afterwards: h.reached }).toEqual({
			live: ["ctx.abort", "ui.getEditorText", "sessionManager.getEntries", "ctx.getModel"],
			afterwards: [],
		});
	});

	test("drives neither host once `initialize` has bound the runner to the next one", async () => {
		let kept: ExtensionContext | undefined;
		const h = await watchedRuntime(pi => {
			pi.on("session_start", (_event, ctx) => {
				kept = ctx;
			});
		});
		const endA = h.session();
		await h.runner.emit({ type: "session_start" });
		endA();
		h.session();
		const next: string[] = [];
		const nextContext = watched({ ...actions()[1] }, "next.ctx", next);
		const nextUI = watched({ ...h.runner.getUIContext() }, "next.ui", next);
		h.runner.initialize(watched(actions()[0], "next.actions", next), nextContext, undefined, nextUI, "tui");
		h.reached.length = 0;
		const outcomes = [
			() => kept?.abort(),
			() => kept?.shutdown(),
			() => kept?.compact(),
			() => kept?.ui.setFooter(undefined),
			() => kept?.ui.setEditorComponent(undefined),
			() => kept?.ui.setWorkingMessage(undefined),
		].map(call => {
			try {
				call();
				return "ran";
			} catch (error) {
				return String(error);
			}
		});

		expect({ outcomes, first: h.reached, next }).toEqual({
			outcomes: Array(6).fill(expect.stringContaining("Extension session retired")),
			first: [],
			next: [],
		});
	});

	test("schedules no timer: refused, and nothing fires while the next session is live", async () => {
		let kept: ExtensionContext | undefined;
		const h = await reusedRuntime(pi => {
			pi.on("session_start", (_event, ctx) => {
				kept = ctx;
			});
		});
		const endA = h.session();
		await h.runner.emit({ type: "session_start" });
		endA();
		h.session();
		let fired = 0;
		const scheduling = [
			() => kept?.setTimeout(() => void fired++, 5),
			() => kept?.setInterval(() => void fired++, 5),
		].map(schedule => {
			try {
				schedule();
				return "scheduled";
			} catch (error) {
				return String(error);
			}
		});
		// Real time on purpose: the managed timers are real ones.
		await Bun.sleep(60);
		h.runner.clearManagedTimers();

		expect({ scheduling, fired }).toEqual({
			scheduling: Array(2).fill(expect.stringContaining("Extension session retired")),
			fired: 0,
		});
	});

	test("a timer it scheduled while live does nothing once it has gone, though the next session is live", async () => {
		let kept: ExtensionContext | undefined;
		const h = await reusedRuntime(pi => {
			pi.on("session_start", (_event, ctx) => {
				kept = ctx;
			});
		});
		const endA = h.session();
		await h.runner.emit({ type: "session_start" });
		let fired = 0;
		// Scheduled from outside any admission, while A is live: the timer is A's, whoever calls.
		kept?.setTimeout(() => void fired++, 30);
		endA();
		h.session();
		await Bun.sleep(80);
		h.runner.clearManagedTimers();

		expect(fired).toBe(0);
	});
});

describe("a dispatch a finishing handler starts", () => {
	test("runs nothing, and says so through onError for each handler it skips", async () => {
		const seen: string[] = [];
		const errors: Array<{ event: string; error: string }> = [];
		// Bound once the runtime exists; the handler reads them when it runs.
		const bound: { end?: () => void; runner?: ExtensionRunner } = {};
		let nested: unknown = "not started";
		const h = await reusedRuntime(pi => {
			pi.on("session_stop", async () => {
				seen.push("outer-1");
				bound.end?.();
				await Promise.resolve();
				// Still finishing the session's dispatch, it starts another, as host code it calls would.
				nested = await bound.runner?.emitSessionStop({
					...({} as Omit<SessionStopEvent, "type" | "signal">),
					signal: new AbortController().signal,
				});
				return undefined;
			});
			pi.on("session_stop", () => {
				seen.push("outer-2");
				return undefined;
			});
		});
		bound.runner = h.runner;
		h.runner.onError(error => void errors.push({ event: error.event, error: error.error }));
		bound.end = h.session();
		await h.runner.emitSessionStop({
			...({} as Omit<SessionStopEvent, "type" | "signal">),
			signal: new AbortController().signal,
		});

		expect({ seen, nested, errors }).toEqual({
			seen: ["outer-1", "outer-2"],
			nested: undefined,
			errors: Array(2).fill({ event: "session_stop", error: expect.stringContaining("had ended before it began") }),
		});
	});
});

describe("a session's work under way", () => {
	test("holds that session's disposal, and not the next session's", async () => {
		const proceed = Promise.withResolvers<void>();
		const entered = Promise.withResolvers<void>();
		// Bound once the runtime exists; the handler reads them when it runs.
		const bound: { endA?: () => void; beginB?: () => () => void } = {};
		let endB: (() => void) | undefined;
		const h = await reusedRuntime(pi => {
			pi.on("session_start", async () => {
				bound.endA?.();
				endB = bound.beginB?.();
				entered.resolve();
				await proceed.promise;
			});
		});
		bound.endA = h.session();
		const a = h.runtime.sessionGeneration;
		bound.beginB = () => h.session();
		const dispatch = h.runner.emit({ type: "session_start" });
		await entered.promise;
		const b = h.runtime.sessionGeneration;
		// B, which did nothing, ends while A's dispatch is still running.
		endB?.();
		let bDrained = false;
		const bWait = h.runner.waitForPendingHandlerWork(b).then(() => {
			bDrained = true;
		});
		await Bun.sleep(20);
		const during = {
			bDrained,
			bPending: h.runner.hasPendingHandlerWork(b),
			aPending: h.runner.hasPendingHandlerWork(a),
			bCallbacks: h.runtime.hasPendingCallbacks(b),
			aCallbacks: h.runtime.hasPendingCallbacks(a),
		};
		proceed.resolve();
		await dispatch;
		await bWait;
		await h.runner.waitForPendingHandlerWork(a);

		expect({ during, aAfter: h.runner.hasPendingHandlerWork(a) }).toEqual({
			during: { bDrained: true, bPending: false, aPending: true, bCallbacks: false, aCallbacks: true },
			aAfter: false,
		});
	});
});

describe("a live call a session starts", () => {
	test("hands the host copies and the session's callbacks, and its stop works after the session ends", async () => {
		let kept: ExtensionContext | undefined;
		const h = await reusedRuntime(pi => {
			pi.on("session_start", (_event, ctx) => {
				kept = ctx;
			});
		});
		let handed: Parameters<NonNullable<ExtensionContextActions["startLive"]>>[0] | undefined;
		let stops = 0;
		const [host, context] = actions();
		h.runner.initialize(
			host,
			{
				...context,
				startLive: async options => {
					handed = options;
					return { sdpAnswer: "answer", voice: "alloy", stop: async () => void stops++ };
				},
			},
			undefined,
			{ ...h.runner.getUIContext() },
			"tui",
		);
		const endA = h.session();
		await h.runner.emit({ type: "session_start" });
		const phases: string[] = [];
		const options = { sdpOffer: "offer", onPhase: (phase: string) => void phases.push(phase) };
		const live = await kept?.startLive?.(options as never);
		handed?.onPhase?.("listening");
		endA();
		h.session();
		handed?.onPhase?.("working");
		await live?.stop();

		expect({
			sameOptions: (handed as unknown) === options,
			sameCallback: (handed?.onPhase as unknown) === options.onPhase,
			phases,
			live: live && { sdpAnswer: live.sdpAnswer, voice: live.voice },
			stops,
		}).toEqual({
			sameOptions: false,
			sameCallback: false,
			phases: ["listening"],
			live: { sdpAnswer: "answer", voice: "alloy" },
			stops: 1,
		});
	});
});

describe("a tool call's additional-context channel", () => {
	test("is the context's own: it hands the call a string, and refuses once the session has gone", async () => {
		const h = await reusedRuntime(() => {});
		const endA = h.session();
		const reported: unknown[] = [];
		const addAdditionalContext = (text: string) => void reported.push(text);
		const ctx = h.runner.createContext(undefined, {
			toolName: "custom-tool",
			context: { addAdditionalContext } as never,
		});
		ctx.addAdditionalContext?.({ toString: () => "converted" } as never);
		endA();
		h.session();
		let refused = "ran";
		try {
			ctx.addAdditionalContext?.("after");
		} catch (error) {
			refused = String(error);
		}

		expect({
			hostFunction: (ctx.addAdditionalContext as unknown) === addAdditionalContext,
			reported,
			refused,
		}).toEqual({
			hostFunction: false,
			reported: ["converted"],
			refused: expect.stringContaining("Extension session retired"),
		});
	});
});
