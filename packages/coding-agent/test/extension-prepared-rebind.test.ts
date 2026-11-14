import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { bindPreparedExtensions, loadExtensions } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/loader";
import type { ExtensionAPI, ExtensionFactory } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import { initializeExtensions } from "@oh-my-pi/pi-coding-agent/modes/runtime-init";
import { createWarpEventBridgeExtension } from "@oh-my-pi/pi-coding-agent/modes/warp-events";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";

const temporaryDirectories: string[] = [];
const authStorages: AuthStorage[] = [];
const originalWarpProtocolVersion = process.env.WARP_CLI_AGENT_PROTOCOL_VERSION;
const WARP_SENTINEL = "warp://cli-agent;";

afterEach(async () => {
	vi.restoreAllMocks();
	if (originalWarpProtocolVersion === undefined) delete process.env.WARP_CLI_AGENT_PROTOCOL_VERSION;
	else process.env.WARP_CLI_AGENT_PROTOCOL_VERSION = originalWarpProtocolVersion;
	for (const storage of authStorages.splice(0)) storage.close();
	await Promise.all(
		temporaryDirectories.splice(0).map(directory => fs.rm(directory, { recursive: true, force: true })),
	);
});

/** `session_id` of each Warp CLI-agent event written to stdout, plain or tmux-wrapped. */
function warpEventSessionIds(writes: readonly unknown[][]): unknown[] {
	return writes.flatMap(([data]) => {
		if (typeof data !== "string") return [];
		const start = data.indexOf(WARP_SENTINEL);
		if (start === -1) return [];
		const body = data.slice(start + WARP_SENTINEL.length, data.indexOf("\x07", start));
		return [Reflect.get(JSON.parse(body), "session_id")];
	});
}

describe("prepared extension rebinding", () => {
	it("binds a fresh session extension without evaluating the module again", async () => {
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), "omp-prepared-extension-"));
		temporaryDirectories.push(directory);
		const parentDirectory = path.join(directory, "parent");
		const childDirectory = path.join(directory, "child");
		await Promise.all([fs.mkdir(parentDirectory), fs.mkdir(childDirectory)]);
		const extensionPath = path.join(directory, "counter.ts");
		const counterKey = `__omp_prepared_extension_${crypto.randomUUID().replaceAll("-", "")}`;
		const bindingsKey = `${counterKey}_bindings`;
		await Bun.write(
			extensionPath,
			`Reflect.set(globalThis, ${JSON.stringify(counterKey)}, Number(Reflect.get(globalThis, ${JSON.stringify(counterKey)}) ?? 0) + 1);\nexport default function counterExtension(api) {\n  const bindings = Reflect.get(globalThis, ${JSON.stringify(bindingsKey)}) ?? [];\n  bindings.push(api);\n  Reflect.set(globalThis, ${JSON.stringify(bindingsKey)}, bindings);\n}\n`,
		);

		const parentEventBus = new EventBus();
		const childEventBus = new EventBus();
		const parent = await loadExtensions([extensionPath], parentDirectory, parentEventBus);
		const prepared = parent.preparedExtensions;
		expect(prepared).toHaveLength(1);
		expect(Reflect.get(globalThis, counterKey)).toBe(1);

		const child = await bindPreparedExtensions(prepared ?? [], childDirectory, childEventBus);

		expect(Reflect.get(globalThis, counterKey)).toBe(1);
		expect(child.extensions).toHaveLength(1);
		expect(child.extensions[0]).not.toBe(parent.extensions[0]);
		expect(child.runtime).not.toBe(parent.runtime);

		const bindings = Reflect.get(globalThis, bindingsKey) as ExtensionAPI[];
		expect(bindings).toHaveLength(2);
		expect(bindings[0]).not.toBe(bindings[1]);
		expect(bindings[0]?.events).toBe(parentEventBus);
		expect(bindings[1]?.events).toBe(childEventBus);
		// Print cwd via Bun, not `pwd`: on Windows Git-for-Windows' pwd.exe reports MSYS paths (`/tmp/...`).
		const printCwd = ["-e", "process.stdout.write(process.cwd())"];
		const [parentPwd, childPwd] = await Promise.all([
			bindings[0]!.exec(process.execPath, printCwd),
			bindings[1]!.exec(process.execPath, printCwd),
		]);
		expect(parentPwd.stdout.trim()).toBe(await fs.realpath(parentDirectory));
		expect(childPwd.stdout.trim()).toBe(await fs.realpath(childDirectory));
		Reflect.deleteProperty(globalThis, counterKey);
		Reflect.deleteProperty(globalThis, bindingsKey);
	});

	it("rebinds SDK inline factories in in-process children but keeps the Warp bridge on the top-level session", async () => {
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), "omp-prepared-inline-"));
		temporaryDirectories.push(directory);
		const authStorage = await AuthStorage.create(":memory:");
		authStorages.push(authStorage);
		const base = {
			cwd: directory,
			agentDir: directory,
			authStorage,
			modelRegistry: new ModelRegistry(authStorage, path.join(directory, "models.yml")),
			settings: Settings.isolated({ "marketplace.autoUpdate": "off", "compaction.enabled": false }),
			disableExtensionDiscovery: true,
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			rules: [],
			preloadedCustomToolPaths: [],
			enableMCP: false,
			enableLsp: false,
			skipPythonPreflight: true,
		};
		const bindings: ExtensionAPI[] = [];
		const sdkExtension: ExtensionFactory = api => {
			bindings.push(api);
		};
		const parentEventBus = new EventBus();
		const childEventBus = new EventBus();
		process.env.WARP_CLI_AGENT_PROTOCOL_VERSION = "1";
		const write = vi.spyOn(process.stdout, "write").mockReturnValue(true);
		const reporters = { reportSendError: vi.fn(), reportRuntimeError: vi.fn() };

		// The interactive CLI's shape: caller factories plus its top-level-only Warp bridge.
		const { session: parent } = await createAgentSession({
			...base,
			sessionManager: SessionManager.inMemory(directory),
			eventBus: parentEventBus,
			extensions: [sdkExtension],
			topLevelExtensions: [createWarpEventBridgeExtension()],
		});
		try {
			// An in-process subagent inherits exactly the parent's prepared extensions.
			const { session: child } = await createAgentSession({
				...base,
				sessionManager: SessionManager.inMemory(directory),
				eventBus: childEventBus,
				preloadedPreparedExtensions: parent.preparedExtensions,
			});
			try {
				await initializeExtensions(parent, reporters);
				await initializeExtensions(child, reporters);

				// The SDK factory ran again, against the child's own ExtensionAPI.
				expect(bindings).toHaveLength(2);
				expect(bindings[0]?.events).toBe(parentEventBus);
				expect(bindings[1]?.events).toBe(childEventBus);
				// Only the top-level session announced itself to Warp; the child never did.
				expect(warpEventSessionIds(write.mock.calls)).toEqual([parent.sessionManager.getSessionId()]);
			} finally {
				await child.dispose();
			}
		} finally {
			await parent.dispose();
		}
	}, 30_000);
});
