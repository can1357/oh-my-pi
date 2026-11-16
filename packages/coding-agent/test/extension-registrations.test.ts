import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { loadExtensions } from "@oh-my-pi/pi-coding-agent/extensibility/extensions";
import { emitSessionShutdownEvent, ExtensionRunner } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/runner";
import * as extensionLoader from "@oh-my-pi/pi-coding-agent/extensibility/extensions/loader";
import { loadExtensionFromFactory } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/loader";
import type { ExtensionRegistration } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/registrations";
import * as startupDeferral from "@oh-my-pi/pi-coding-agent/extensibility/extensions/startup-deferral";
import type {
	Extension,
	ExtensionActions,
	ExtensionAPI,
	ExtensionContextActions,
	ExtensionRuntime,
} from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import {
	DefaultResourceLoader,
	createAgentSession as legacyCreateAgentSession,
} from "@oh-my-pi/pi-coding-agent/extensibility/legacy-pi-coding-agent-shim";
import { PluginManager } from "@oh-my-pi/pi-coding-agent/extensibility/plugins/manager";
import { createAcpSessionFactory } from "@oh-my-pi/pi-coding-agent/main";
import { initializeExtensions } from "@oh-my-pi/pi-coding-agent/modes/runtime-init";
import * as sdkModule from "@oh-my-pi/pi-coding-agent/sdk";
import {
	type CreateAgentSessionOptions,
	type CreateAgentSessionResult,
	createAgentSession,
	type LoadExtensionsResult,
	loadCliExtensionProviders,
	loadSessionExtensions,
} from "@oh-my-pi/pi-coding-agent/sdk";
import type { AgentStorage } from "@oh-my-pi/pi-coding-agent/session/agent-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";
import * as piUtils from "@oh-my-pi/pi-utils";
import { TempDir } from "@oh-my-pi/pi-utils";
import type { Subprocess } from "bun";
import { createInMemoryAuthStorage } from "./helpers/agent-session-setup";

/**
 * Contract: what an extension load registers outside its session state follows the load. A live
 * suspension pauses it and a resume restarts it (never releasing it); teardown — session shutdown,
 * suspended loads included — releases it exactly once, and anything registered after teardown is
 * released at once. `pi.onSuspensionChange` reports this load's own suspensions and nothing after
 * teardown.
 */
function runtime(): ExtensionRuntime {
	return { flagValues: new Map(), pendingProviderRegistrations: [] } as unknown as ExtensionRuntime;
}

function runnerFor(extensions: Extension[]): ExtensionRunner {
	return new ExtensionRunner(extensions, runtime(), "/tmp", { getCwd: () => "/tmp" } as never, {} as never);
}

async function load(name: string, factory: (pi: ExtensionAPI) => void = () => {}): Promise<Extension> {
	return loadExtensionFromFactory(factory, "/tmp", new EventBus(), runtime(), name);
}

/** A registration that logs what happens to it as `<name>:<event>`. */
function probe(name: string, log: string[]): ExtensionRegistration {
	return {
		release: () => log.push(`${name}:release`),
		suspend: suspended => log.push(`${name}:${suspended ? "suspend" : "resume"}`),
	};
}

function register(extension: Extension, registration: ExtensionRegistration): void {
	if (!extension.registrations) throw new Error("loader extensions carry registrations");
	extension.registrations.add(registration);
}

/** Wire a runner's extension actions, as a mode does once its session exists (stubs suffice here). */
function initialize(runner: ExtensionRunner): void {
	runner.initialize({} as ExtensionActions, {} as ExtensionContextActions);
}

/** Spy on `loadExtensions` so every load it makes carries a probe named after the module file. */
function probeLoadedModules(log: string[]): void {
	const load = extensionLoader.loadExtensions;
	vi.spyOn(extensionLoader, "loadExtensions").mockImplementation(async (...args) => {
		const result = await load(...args);
		for (const extension of result.extensions) register(extension, probe(path.basename(extension.path), log));
		return result;
	});
}

describe("extension load registrations", () => {
	it("pause on suspension, restart on resume, and release once on shutdown, suspended loads included", async () => {
		const log: string[] = [];
		const active = await load("active");
		const paused = await load("paused");
		register(active, probe("active", log));
		register(paused, probe("paused", log));
		const runner = runnerFor([active, paused]);

		runner.setSuspendedExtensions(extension => extension === paused);
		runner.setSuspendedExtensions(() => true);
		runner.setSuspendedExtensions(extension => extension === paused);
		await emitSessionShutdownEvent(runner);
		await emitSessionShutdownEvent(runner);

		expect(log).toEqual(["paused:suspend", "active:suspend", "active:resume", "active:release", "paused:release"]);
	});

	it("start suspended when registered during a suspension, and release at once after teardown", async () => {
		const log: string[] = [];
		const extension = await load("bridge");
		const runner = runnerFor([extension]);

		runner.setSuspendedExtensions(() => true);
		register(extension, probe("late", log));
		await emitSessionShutdownEvent(runner);
		register(extension, probe("after", log));

		expect(log).toEqual(["late:suspend", "late:release", "after:release"]);
	});

	it("tell a load about its own suspensions through pi.onSuspensionChange until it is torn down", async () => {
		const seen: string[] = [];
		const watched = await load("watched", pi => {
			pi.onSuspensionChange(suspended => seen.push(suspended ? "suspended" : "resumed"));
		});
		const other = await load("other");
		const runner = runnerFor([watched, other]);
		initialize(runner);

		runner.setSuspendedExtensions(extension => extension === other);
		runner.setSuspendedExtensions(() => true);
		runner.setSuspendedExtensions(() => false);
		await emitSessionShutdownEvent(runner);
		runner.setSuspendedExtensions(() => true);

		expect(seen).toEqual(["suspended", "resumed"]);
	});

	it("tell a load of its suspension only once the runner's active list matches it", async () => {
		const seen: string[] = [];
		const watched = await load("watched", pi => {
			// What a listener would read through the API (its commands, tools) follows this list.
			// Only called after `runner` below is set.
			pi.onSuspensionChange(suspended => {
				seen.push(`${suspended ? "suspended" : "resumed"}:${runner.isExtensionActive("watched")}`);
			});
		});
		const runner = runnerFor([watched]);
		initialize(runner);

		runner.setSuspendedExtensions(() => true);
		runner.setSuspendedExtensions(() => false);
		expect(seen).toEqual(["suspended:false", "resumed:true"]);
		await emitSessionShutdownEvent(runner);
	});

	it("hold a load's suspension news until its session's actions are wired, delivering only what it missed", async () => {
		const log: string[] = [];
		const seen: string[] = [];
		const watched = await load("watched", pi => {
			pi.onSuspensionChange(suspended => seen.push(suspended ? "suspended" : "resumed"));
		});
		register(watched, probe("watched", log));
		const runner = runnerFor([watched]);

		// A live settings edit before the mode initializes the runner: registrations follow at once.
		runner.setSuspendedExtensions(() => true);
		expect(log).toEqual(["watched:suspend"]);
		expect(seen).toEqual([]);
		initialize(runner);
		expect(seen).toEqual(["suspended"]);
		await emitSessionShutdownEvent(runner);
	});

	it("add a load that arrives while the latest suspension covers it suspended, giving it session_start once resumed", async () => {
		const log: string[] = [];
		const started: string[] = [];
		const lateStarted = Promise.withResolvers<void>();
		const early = await load("early");
		const runner = runnerFor([early]);
		initialize(runner);
		await runner.emit({ type: "session_start" });
		// A live disable reached the runner before this startup-deferred load was bound.
		runner.setSuspendedExtensions(extension => extension.path === "late");
		const late = await load("late", pi => {
			pi.on("session_start", () => {
				started.push("late");
				lateStarted.resolve();
			});
		});
		register(late, probe("late", log));

		await runner.addExtensions([late]);
		expect(runner.isExtensionActive("late")).toBe(false);
		expect(log).toEqual(["late:suspend"]);
		expect(started).toEqual([]);

		runner.setSuspendedExtensions(() => false);
		expect(runner.isExtensionActive("late")).toBe(true);
		expect(log).toEqual(["late:suspend", "late:resume"]);
		await lateStarted.promise;
		expect(started).toEqual(["late"]);
		await emitSessionShutdownEvent(runner);
	});

	it("connect a load that joins suspended to tool registration, so a tool it registers after resuming reaches the session", async () => {
		const registered: string[] = [];
		const early = await load("early");
		const runner = runnerFor([early]);
		initialize(runner);
		runner.onToolRegistered(tool => {
			registered.push(tool.definition.name);
		});
		runner.setSuspendedExtensions(extension => extension.path === "late");
		let api: ExtensionAPI | undefined;
		const late = await load("late", pi => {
			api = pi;
		});
		await runner.addExtensions([late]);
		runner.setSuspendedExtensions(() => false);

		// Registered after an await in its replayed session_start, or from a timer, say.
		api?.registerTool({
			name: "late_tool",
			label: "Late tool",
			description: "Registered after the load resumed",
			parameters: api.typebox.Type.Object({}),
			execute: async () => ({ content: [], details: {} }),
		});
		expect(registered).toEqual(["late_tool"]);
		await emitSessionShutdownEvent(runner);
	});

	it("do not start again on resume a load that session_start reached before a live edit suspended it mid-broadcast", async () => {
		const events: string[] = [];
		const first = await load("first", pi => {
			pi.on("session_start", () => {
				events.push("first:start");
			});
			pi.on("session_switch", () => {
				events.push("first:switch");
			});
		});
		// A handler later in the broadcast triggers a live disable of the load before it.
		const second = await load("second", pi => {
			pi.on("session_start", () => {
				// Runs during the broadcast below, once `runner` is set.
				runner.setSuspendedExtensions(extension => extension === first);
			});
		});
		const runner = runnerFor([first, second]);
		initialize(runner);
		await runner.emit({ type: "session_start" });
		expect(runner.isExtensionActive("first")).toBe(false);

		runner.setSuspendedExtensions(() => false);
		// Deliveries to one load run in order, so a replay would land before this event.
		await runner.emit({ type: "session_switch", reason: "new", previousSessionFile: undefined });
		expect(events).toEqual(["first:start", "first:switch"]);
		await emitSessionShutdownEvent(runner);
	});
});

describe("createAgentSession and preloaded extension registrations", () => {
	const cleanups: Array<() => void | Promise<void>> = [];

	afterEach(async () => {
		for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
	});

	it("suspends a caller's preloaded load when startup fails, so a retry adopts it live and tells it once its actions are wired", async () => {
		const tempDir = TempDir.createSync("@omp-preloaded-registrations-");
		cleanups.push(() => tempDir.removeSync());
		const cwd = tempDir.path();
		const eventBus = new EventBus();
		const preloaded = await loadExtensions([], cwd, eventBus);
		// Fails startup after extension loading, the way a model-restore failure does before auto-resume retries.
		const resumes: string[] = [];
		const extension = await loadExtensionFromFactory(
			pi => {
				pi.registerProvider("broken", { streamSimple: (() => {}) as never });
				// A resume listener may act through the extension API, as an extension resuming its own work does.
				pi.onSuspensionChange(suspended => {
					if (!suspended) resumes.push(`active tools: ${pi.getActiveTools().length > 0}`);
				});
			},
			cwd,
			eventBus,
			preloaded.runtime,
			"<inline-0>",
		);
		preloaded.extensions.push(extension);
		const log: string[] = [];
		register(extension, probe("preloaded", log));
		const authStorage = createInMemoryAuthStorage();
		cleanups.push(() => authStorage.close());
		const attempt = (options: { customSystemPrompt?: string } = {}) =>
			createAgentSession({
				cwd,
				agentDir: cwd,
				authStorage,
				modelRegistry: new ModelRegistry(authStorage, path.join(cwd, "models.yml")),
				sessionManager: SessionManager.inMemory(cwd),
				settings: Settings.isolated(),
				eventBus,
				preloadedExtensions: preloaded,
				enableLsp: false,
				enableMCP: false,
				skills: [],
				rules: [],
				contextFiles: [],
				promptTemplates: [],
				slashCommands: [],
				...(options.customSystemPrompt ? { systemPromptTemplate: "x", customSystemPrompt: "y" } : {}),
			});

		// Fails at its very first check, before any setup.
		await expect(attempt({ customSystemPrompt: "y" })).rejects.toThrow("cannot be combined");
		expect(log).toEqual(["preloaded:suspend"]);
		// Fails after extensions loaded.
		await expect(attempt()).rejects.toThrow('"api" is required');
		expect(extension.registrations?.released).toBe(false);
		expect(extension.registrations?.suspended).toBe(true);

		// The retry (with the broken provider withdrawn) adopts the load: its registrations act again
		// at once, and its resume listener hears of it once the session's mode wires the actions it uses.
		preloaded.runtime.pendingProviderRegistrations = [];
		const { session } = await attempt();
		expect(extension.registrations?.suspended).toBe(false);
		expect(log.at(-1)).toBe("preloaded:resume");
		expect(resumes).toEqual([]);
		await initializeExtensions(session, { reportSendError: () => {}, reportRuntimeError: () => {} });
		expect(resumes).toEqual(["active tools: true"]);
		await session.dispose();
		expect(log.at(-1)).toBe("preloaded:release");
	});

	it("releases a startup-deferred load when binding it into the session fails before the runner adopts it", async () => {
		const tempDir = TempDir.createSync("@omp-deferred-registrations-");
		cleanups.push(() => tempDir.removeSync());
		const cwd = tempDir.path();
		const deferredPath = path.join(cwd, "deferred.ts");
		// The registry rejects the provider this load queued (no `api`) when the bind drains it.
		await Bun.write(
			deferredPath,
			`export default function (pi) { pi.registerProvider("broken", { streamSimple: () => {} }); }\n`,
		);
		const deferred: Extension[] = [];
		const loadExtensionsFn = extensionLoader.loadExtensions;
		vi.spyOn(extensionLoader, "loadExtensions").mockImplementation(async (paths, ...rest) => {
			const result = await loadExtensionsFn(paths, ...rest);
			if (paths.includes(deferredPath)) deferred.push(...result.extensions);
			return result;
		});
		cleanups.push(() => vi.restoreAllMocks());
		const authStorage = createInMemoryAuthStorage();
		cleanups.push(() => authStorage.close());
		const { session } = await createAgentSession({
			cwd,
			agentDir: cwd,
			authStorage,
			modelRegistry: new ModelRegistry(authStorage, path.join(cwd, "models.yml")),
			sessionManager: SessionManager.inMemory(cwd),
			settings: Settings.isolated(),
			deferredExtensionPaths: [deferredPath],
			enableLsp: false,
			enableMCP: false,
			skills: [],
			rules: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
		});
		cleanups.push(() => session.dispose());

		await session.loadDeferredExtensions();

		// No runner took the load, so the session's shutdown would never reach it.
		expect(deferred).toHaveLength(1);
		expect(session.extensionRunner?.getLoadedExtensions()).not.toContain(deferred[0]);
		expect(deferred[0]?.registrations?.released).toBe(true);
	});
});

describe("ACP session/new and its trusted extension loads", () => {
	it("releases the loads' registrations when the session it builds them for fails to start", async () => {
		const tempDir = TempDir.createSync("@omp-acp-trusted-registrations-");
		const authStorage = createInMemoryAuthStorage();
		try {
			const extensionPath = path.join(tempDir.path(), "trusted.ts");
			await Bun.write(extensionPath, "export default function () {}\n");
			let handed: readonly Extension[] = [];
			const factory = createAcpSessionFactory({
				baseOptions: { additionalExtensionPaths: [extensionPath] } as CreateAgentSessionOptions,
				settings: Settings.isolated({}),
				sessionDir: tempDir.join("sessions"),
				authStorage,
				modelRegistry: new ModelRegistry(authStorage),
				parsedArgs: { invalidFlagValues: [], trustedExtensions: [extensionPath] },
				rawArgs: [],
				createSession: async options => {
					handed = options.preloadedExtensions?.extensions ?? [];
					throw new Error("startup failed");
				},
			});

			await expect(factory(tempDir.path())).rejects.toThrow("startup failed");
			// createAgentSession would only suspend them for a retry; ACP never retries this request.
			expect(handed).toHaveLength(1);
			expect(handed[0]?.registrations?.released).toBe(true);
		} finally {
			authStorage.close();
			tempDir.removeSync();
		}
	});
});

describe("plugin install extension validation", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("releases the registrations of the loads it makes only to validate the plugin", async () => {
		const tempDir = TempDir.createSync("@omp-plugin-validate-registrations-");
		try {
			const pluginsDir = tempDir.join("plugins");
			const nodeModules = path.join(pluginsDir, "node_modules");
			await fs.mkdir(nodeModules, { recursive: true });
			await Bun.write(
				path.join(pluginsDir, "package.json"),
				JSON.stringify({ name: "omp-plugins", dependencies: {} }),
			);
			vi.spyOn(piUtils, "getPluginsDir").mockReturnValue(pluginsDir);
			vi.spyOn(piUtils, "getPluginsNodeModules").mockReturnValue(nodeModules);
			vi.spyOn(piUtils, "getPluginsPackageJson").mockReturnValue(path.join(pluginsDir, "package.json"));
			vi.spyOn(piUtils, "getPluginsLockfile").mockReturnValue(tempDir.join("omp-plugins.lock.json"));
			vi.spyOn(piUtils, "getProjectDir").mockReturnValue(tempDir.path());
			vi.spyOn(piUtils, "getProjectPluginOverridesPath").mockReturnValue(tempDir.join("plugin-overrides.json"));
			// `bun install` drops a package that declares one extension.
			vi.spyOn(Bun, "spawn").mockImplementation(((cmd: string[]) => {
				const packageDir = path.join(nodeModules, "validated-plugin");
				const installed =
					cmd[1] === "install"
						? Promise.all([
								Bun.write(
									path.join(packageDir, "package.json"),
									JSON.stringify({
										name: "validated-plugin",
										version: "1.0.0",
										omp: { extensions: ["./ext.ts"] },
									}),
								),
								Bun.write(path.join(packageDir, "ext.ts"), "export default function () {}\n"),
							])
						: Promise.resolve();
				return {
					pid: 1,
					stdout: new Response("").body,
					stderr: new Response("").body,
					exited: installed.then(() => 0),
				} as Subprocess;
			}) as typeof Bun.spawn);
			const log: string[] = [];
			probeLoadedModules(log);

			await new PluginManager(tempDir.path()).install("validated-plugin");

			// No runner adopts a validation load, so nothing else would ever release it.
			expect(log).toEqual(["ext.ts:release"]);
		} finally {
			tempDir.removeSync();
		}
	});
});

describe("loads made only for their providers", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("release their registrations once a CLI has drained their providers", async () => {
		const tempDir = TempDir.createSync("@omp-cli-provider-registrations-");
		const authStorage = createInMemoryAuthStorage();
		try {
			const extensionPath = tempDir.join("provider.ts");
			await Bun.write(extensionPath, "export default function () {}\n");
			const log: string[] = [];
			probeLoadedModules(log);

			await loadCliExtensionProviders(new ModelRegistry(authStorage), Settings.isolated(), tempDir.path(), {
				disableExtensionDiscovery: true,
				additionalExtensionPaths: [extensionPath],
				discoverModels: false,
			});

			// No runner adopts them, and a long-lived caller (`auth-gateway-stdio`) outlives the call.
			expect(log).toEqual(["provider.ts:release"]);
		} finally {
			authStorage.close();
			tempDir.removeSync();
		}
	});

	it("release the loads whose startup verdicts cannot be recorded, since the caller never gets them", async () => {
		const tempDir = TempDir.createSync("@omp-session-load-registrations-");
		try {
			const extensionPath = tempDir.join("provider.ts");
			await Bun.write(extensionPath, "export default function () {}\n");
			const log: string[] = [];
			probeLoadedModules(log);
			const settings = Settings.isolated();
			vi.spyOn(settings, "getStorage").mockReturnValue({} as AgentStorage);
			vi.spyOn(startupDeferral, "recordStartupVerdicts").mockRejectedValue(new Error("disk full"));

			await expect(
				loadSessionExtensions(
					{ disableExtensionDiscovery: true, additionalExtensionPaths: [extensionPath] },
					tempDir.path(),
					settings,
					new EventBus(),
				),
			).rejects.toThrow("disk full");
			expect(log).toEqual(["provider.ts:release"]);
		} finally {
			tempDir.removeSync();
		}
	});
});

describe("legacy DefaultResourceLoader snapshots", () => {
	const tempDirs: TempDir[] = [];
	afterEach(() => {
		vi.restoreAllMocks();
		for (const tempDir of tempDirs.splice(0)) tempDir.removeSync();
	});

	/**
	 * A loader with two inline extensions. Reload `n`'s loads carry probes `n.0` and `n.1`; `override`
	 * sees them and the snapshot it replaces, and may also throw from the later skills override.
	 */
	function loader(
		log: string[],
		override?: (base: LoadExtensionsResult, previous: LoadExtensionsResult | undefined) => LoadExtensionsResult,
		failSkills?: () => boolean,
	): DefaultResourceLoader {
		const tempDir = TempDir.createSync("@omp-legacy-loader-registrations-");
		tempDirs.push(tempDir);
		let reloads = 0;
		let previous: LoadExtensionsResult | undefined;
		return new DefaultResourceLoader({
			cwd: tempDir.path(),
			agentDir: tempDir.path(),
			settingsManager: Settings.isolated(),
			noExtensions: true,
			noSkills: true,
			noPromptTemplates: true,
			noThemes: true,
			noContextFiles: true,
			extensionFactories: [() => {}, () => {}],
			extensionsOverride: base => {
				reloads++;
				base.extensions.forEach((extension, index) => {
					register(extension, probe(`${reloads}.${index}`, log));
				});
				previous = override ? override(base, previous) : base;
				return previous;
			},
			skillsOverride: base => {
				if (failSkills?.()) throw new Error("skills override failed");
				return base;
			},
		});
	}

	/** Open a session through the legacy entry point; returns the extensions it forwarded. */
	async function openSession(instance: DefaultResourceLoader, options: CreateAgentSessionOptions = {}) {
		let forwarded: CreateAgentSessionOptions | undefined;
		vi.spyOn(sdkModule, "createAgentSession").mockImplementation(async received => {
			forwarded = received;
			return { session: {} } as unknown as CreateAgentSessionResult;
		});
		await legacyCreateAgentSession({ ...options, resourceLoader: instance });
		return forwarded?.preloadedExtensions;
	}

	it("release a replaced snapshot nobody received, and never one a session adopted", async () => {
		const log: string[] = [];
		const instance = loader(log);
		await instance.reload();
		await instance.reload();
		expect(log).toEqual(["1.0:release", "1.1:release"]);

		expect((await openSession(instance))?.extensions).toHaveLength(2);
		await instance.reload();
		expect(log).toHaveLength(2);
	});

	it("keep an adopted load an override carried into a later snapshot", async () => {
		const log: string[] = [];
		// The second reload's override reuses the snapshot the session adopted; the third moves on.
		let reloads = 0;
		const instance = loader(log, (base, previous) => (++reloads === 2 && previous ? previous : base));
		await instance.reload();
		await openSession(instance);
		await instance.reload();
		await instance.reload();
		expect(log).toEqual(["2.0:release", "2.1:release"]);
	});

	it("release a snapshot the session did not take because it was given its own extensions", async () => {
		const log: string[] = [];
		const instance = loader(log);
		await instance.reload();
		const own = await loadExtensions([], "/tmp", new EventBus());
		expect(await openSession(instance, { preloadedExtensions: own })).toBe(own);
		await instance.reload();
		expect(log).toEqual(["1.0:release", "1.1:release"]);
	});

	it("release the loads an extensionsOverride drops, and not one it kept as a copy", async () => {
		const log: string[] = [];
		const instance = loader(log, base => ({ ...base, extensions: [{ ...base.extensions[0]! }] }));
		await instance.reload();
		expect(log).toEqual(["1.1:release"]);
	});

	it("release the loads an extensionsOverride removes from the base result in place", async () => {
		const log: string[] = [];
		const instance = loader(log, base => {
			base.extensions.splice(1);
			return base;
		});
		await instance.reload();
		expect(log).toEqual(["1.1:release"]);
	});

	it("release a reload's loads when a later override fails, keeping the current snapshot", async () => {
		const log: string[] = [];
		let fail = false;
		const instance = loader(log, undefined, () => fail);
		await instance.reload();
		const current = instance.getExtensions();
		fail = true;
		await expect(instance.reload()).rejects.toThrow("skills override failed");
		expect(log).toEqual(["2.0:release", "2.1:release"]);
		expect(instance.getExtensions()).toBe(current);
	});

	it("release the loads made before an inline factory throws", async () => {
		const tempDir = TempDir.createSync("@omp-legacy-loader-registrations-");
		tempDirs.push(tempDir);
		const log: string[] = [];
		const load = extensionLoader.loadExtensionFromFactory;
		vi.spyOn(extensionLoader, "loadExtensionFromFactory").mockImplementation(async (...args) => {
			const extension = await load(...args);
			register(extension, probe(extension.path, log));
			return extension;
		});
		const instance = new DefaultResourceLoader({
			cwd: tempDir.path(),
			agentDir: tempDir.path(),
			settingsManager: Settings.isolated(),
			noExtensions: true,
			noSkills: true,
			noPromptTemplates: true,
			noThemes: true,
			noContextFiles: true,
			extensionFactories: [
				() => {},
				() => {
					throw new Error("second factory failed");
				},
			],
		});

		await expect(instance.reload()).rejects.toThrow("second factory failed");
		expect(log).toEqual(["<inline-loader-0>:release"]);
	});
});
