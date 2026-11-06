import { afterEach, describe, expect, it } from "bun:test";
import * as path from "node:path";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { loadExtensions } from "@oh-my-pi/pi-coding-agent/extensibility/extensions";
import { emitSessionShutdownEvent, ExtensionRunner } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/runner";
import { loadExtensionFromFactory } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/loader";
import type { ExtensionRegistration } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/registrations";
import type {
	Extension,
	ExtensionAPI,
	ExtensionRuntime,
} from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";
import { TempDir } from "@oh-my-pi/pi-utils";
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

		runner.setSuspendedExtensions(extension => extension === other);
		runner.setSuspendedExtensions(() => true);
		runner.setSuspendedExtensions(() => false);
		await emitSessionShutdownEvent(runner);
		runner.setSuspendedExtensions(() => true);

		expect(seen).toEqual(["suspended", "resumed"]);
	});
});

describe("createAgentSession and preloaded extension registrations", () => {
	const cleanups: Array<() => void | Promise<void>> = [];

	afterEach(async () => {
		for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
	});

	it("suspends a caller's preloaded load when startup fails, so a retry adopts it live", async () => {
		const tempDir = TempDir.createSync("@omp-preloaded-registrations-");
		cleanups.push(() => tempDir.removeSync());
		const cwd = tempDir.path();
		const eventBus = new EventBus();
		const preloaded = await loadExtensions([], cwd, eventBus);
		// Fails startup after extension loading, the way a model-restore failure does before auto-resume retries.
		const extension = await loadExtensionFromFactory(
			pi => pi.registerProvider("broken", { streamSimple: (() => {}) as never }),
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

		// The retry (with the broken provider withdrawn) adopts the load, which acts again.
		preloaded.runtime.pendingProviderRegistrations = [];
		const { session } = await attempt();
		expect(extension.registrations?.suspended).toBe(false);
		await session.dispose();
		expect(log.at(-1)).toBe("preloaded:release");
	});
});
