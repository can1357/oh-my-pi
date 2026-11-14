import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AuthStorage } from "@oh-my-pi/pi-ai";
import { logger, removeSyncWithRetries, Snowflake } from "@oh-my-pi/pi-utils";
import { ModelRegistry } from "../../src/config/model-registry";
import type { CustomTool } from "../../src/extensibility/custom-tools/types";
import { bindPreparedExtensions, importExtensionModule } from "../../src/extensibility/extensions/loader";
import type { PreparedExtension } from "../../src/extensibility/extensions/types";
import { type LocalProtocolOptions, resolveLocalRoot } from "../../src/internal-urls/local-protocol";
import { MCPManager } from "../../src/mcp/manager";
import type { MCPStdioServerConfig } from "../../src/mcp/types";
import type { ExecutorOptions } from "../../src/task/executor";
import { isMainThread } from "../../src/thread/identity";
import { authService } from "../../src/thread/services/auth";
import {
	bridgeIntegrationOptions,
	integrationsThreadService,
	toWorkerCustomTool,
} from "../../src/thread/services/integrations";
import { settingsThreadService } from "../../src/thread/services/settings";
import type { IntegrationsProbe } from "../fixtures/integrations-worker";
import { createInMemoryAuthStorage } from "../helpers/agent-session-setup";
import { type ServiceWorker, startServiceWorker } from "../helpers/service-worker";

const FIXTURES = path.join(import.meta.dir, "..", "fixtures");

interface SeenContext {
	cwd: string;
	idle: boolean;
	queued: boolean;
	sameRegistry: boolean;
	localSession: string | null | undefined;
	onMain: boolean;
}

/**
 * Wait for the stdio MCP fixture (a separate process) to have logged `frame`. Its frame log is the
 * only observable; there is no in-process event to await, so this polls the file.
 */
async function untilLogged(logPath: string, frame: string, timeoutMs = 5_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!(fs.existsSync(logPath) && fs.readFileSync(logPath, "utf8").includes(frame))) {
		if (Date.now() > deadline) throw new Error(`MCP fixture never logged ${frame}`);
		await Bun.sleep(20);
	}
}

describe("integrations thread service", () => {
	let dir: string;
	let authStorage: AuthStorage;
	let registry: ModelRegistry;
	let manager: MCPManager;
	let frameLog: string;
	let fixture: ServiceWorker<IntegrationsProbe>;
	let probe: IntegrationsProbe;

	beforeEach(async () => {
		dir = path.join(os.tmpdir(), `omp-integrations-thread-${Snowflake.next()}`);
		fs.mkdirSync(dir, { recursive: true });
		frameLog = path.join(dir, "frames.log");
		authStorage = createInMemoryAuthStorage();
		registry = new ModelRegistry(authStorage, path.join(dir, "models.yml"));
		manager = new MCPManager(dir, null, async () => ({ configs: {}, sources: {}, exaApiKeys: [] }));
		const configs: Record<string, MCPStdioServerConfig> = {
			progress: { type: "stdio", command: process.execPath, args: [path.join(FIXTURES, "progress-mcp.ts")] },
			cancel: {
				type: "stdio",
				command: process.execPath,
				args: [path.join(FIXTURES, "cancellable-mcp.ts"), frameLog],
			},
		};
		await manager.connectServers(configs, {});
		expect((await manager.waitForStartup(0)).failed).toEqual([]);
		MCPManager.setInstance(manager);
		fixture = await startServiceWorker<IntegrationsProbe>(
			new URL("../fixtures/integrations-worker.ts", import.meta.url),
			[settingsThreadService, authService, integrationsThreadService],
		);
		probe = fixture.probe;
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		await fixture.stop();
		MCPManager.resetForTests();
		await manager.disconnectAll();
		authStorage.close();
		removeSyncWithRetries(dir);
	});

	function toolNamed(suffix: string): string {
		const name = manager.getTools().find(tool => tool.name.endsWith(suffix))?.name;
		if (!name) throw new Error(`no MCP tool ending in ${suffix}`);
		return name;
	}

	it("routes the worker's MCPManager globals and tool calls to main's manager", async () => {
		const global = await probe.mcpGlobal();
		expect(global.available).toBe(true);
		expect(global.remote).toBe(true);
		expect(global.servers.sort()).toEqual(["cancel", "progress"]);
		expect(global.tools.sort()).toEqual(
			manager
				.getTools()
				.map(tool => tool.name)
				.sort(),
		);

		const outcome = await probe.mcpCall(registry, toolNamed("progress_tool"), { steps: 3 });
		expect(outcome.error).toBeUndefined();
		expect(outcome.text).toStartWith("progress complete");
		// The MCP tool throttles progress to one update per interval; at least the first must stream through.
		expect(outcome.updates.length).toBeGreaterThanOrEqual(1);

		const echoed = await probe.mcpCall(registry, toolNamed("echo"), { text: "from worker" });
		expect(echoed.text).toBe("from worker");
	}, 20_000);

	it("aborts a worker's MCP call on main's connection", async () => {
		const controller = new AbortController();
		const call = probe.mcpCall(registry, toolNamed("hang"), { text: "x" }, controller.signal);
		await untilLogged(frameLog, '"tools/call"');
		controller.abort();
		const outcome = await call;
		expect(outcome.errorName).toBe("ToolAbortError");
		await untilLogged(frameLog, "notifications/cancelled");
	}, 20_000);

	it("delivers main's tool-change notifications to worker subscribers", async () => {
		const { changed } = await probe.watchTools();
		await manager.disconnectServer("cancel");
		await changed;
	}, 20_000);

	it("runs a main-defined custom tool with a worker context, streaming updates and abort", async () => {
		const seen: SeenContext[] = [];
		const tool: CustomTool = {
			name: "kernel_tool",
			label: "kernel_tool",
			description: "Kernel-defined tool living on main.",
			parameters: { type: "object", properties: {} },
			async execute(_toolCallId, params, onUpdate, ctx, signal) {
				seen.push({
					cwd: ctx.sessionManager.getCwd(),
					idle: ctx.isIdle(),
					queued: ctx.hasQueuedMessages(),
					sameRegistry: ctx.modelRegistry === registry,
					localSession: ctx.localProtocolOptions?.getSessionId?.(),
					onMain: isMainThread(),
				});
				onUpdate?.({ content: [{ type: "text", text: "step 1" }], details: undefined });
				onUpdate?.({ content: [{ type: "text", text: "step 2" }], details: undefined });
				if (Reflect.get(Object(params), "hang") === true && signal) {
					const { promise, reject } = Promise.withResolvers<never>();
					const fail = (): void => {
						ctx.abort();
						reject(signal.reason);
					};
					if (signal.aborted) fail();
					else signal.addEventListener("abort", fail, { once: true });
					await promise;
				}
				return { content: [{ type: "text", text: "done" }], details: undefined };
			},
		};
		const view = toWorkerCustomTool(tool);
		expect(toWorkerCustomTool(tool)).toBe(view);

		const outcome = await probe.customCall(view, registry, {});
		expect(outcome).toMatchObject({ text: "done", updates: ["step 1", "step 2"], abortsSeen: 0 });
		expect(seen).toEqual([
			{
				cwd: "/tmp/worker-cwd",
				idle: false,
				queued: true,
				sameRegistry: true,
				localSession: "worker-session",
				onMain: true,
			},
		]);

		const aborted = await probe.customCall(view, registry, { hang: true }, true);
		expect(aborted.errorName).toBe("AbortError");
		expect(aborted.abortsSeen).toBe(1);
	}, 20_000);

	it("makes bridged executor options and local-protocol getters synchronous in the worker", async () => {
		let artifacts = path.join(dir, "artifacts-a");
		const local: LocalProtocolOptions = { getArtifactsDir: () => artifacts, getSessionId: () => "parent" };
		const roots = { explicit: ["/ext"], mode: "merge" as const, configured: [], configuredLevel: "user" as const };
		const options: ExecutorOptions = {
			cwd: dir,
			agent: { name: "probe", description: "probe", systemPrompt: "", source: "bundled" },
			task: "t",
			index: 0,
			id: "probe-0",
			extensionRoots: () => roots,
			preparedSession: { fork: { sourceFile: "source.jsonl" }, promptSuffix: model => `suffix:${model}` },
			localProtocolOptions: local,
			customTools: [
				{
					name: "approval_tool",
					label: "approval_tool",
					description: "",
					parameters: { type: "object" },
					approvalCacheTargets: args => [String(Reflect.get(Object(args), "path"))],
					execute: async () => ({ content: [], details: undefined }),
				},
			],
		};
		const read = await probe.readOptions(bridgeIntegrationOptions(options));
		expect(read).toEqual({
			roots,
			suffix: "suffix:model-x",
			localRoot: resolveLocalRoot(local),
			approvalTargets: ["a.txt"],
		});

		expect(await probe.localRoot(local)).toBe(resolveLocalRoot(local));
		artifacts = path.join(dir, "artifacts-b");
		expect(await probe.localRoot(local)).toBe(resolveLocalRoot(local));
	}, 20_000);

	it("re-binds a parent-prepared extension against the worker's own ExtensionAPI", async () => {
		const prepared = await importExtensionModule(path.join(FIXTURES, "integrations-extension.ts"), dir);
		expect(prepared.error).toBeNull();
		const local = await bindPreparedExtensions([prepared], dir);
		expect(local.extensions.flatMap(extension => [...extension.commands.keys()])).toEqual(["thread-main"]);

		expect(await probe.bindExtensions([prepared], dir)).toEqual({ commands: ["thread-worker"], errors: [] });
	}, 20_000);

	it("binds module-backed extensions in the worker and reports, once, an inline factory it cannot import", async () => {
		const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
		const inline: PreparedExtension = {
			path: "<inline-0>",
			resolvedPath: "<inline-0>",
			factory: function sdkInlineFactory(pi) {
				pi.registerCommand("inline-hook", { description: "SDK inline factory", handler: async () => {} });
			},
			error: null,
		};
		const fileBacked = await importExtensionModule(path.join(FIXTURES, "integrations-extension.ts"), dir);

		// Two worker-hosted spawns: neither treats the `<inline-0>` source id as a module to import.
		for (let spawn = 0; spawn < 2; spawn++) {
			expect(await probe.bindExtensions([inline, fileBacked], dir)).toEqual({
				commands: ["thread-worker"],
				errors: [],
			});
		}
		// The lost hooks are reported by the parent once, naming the extension, not dropped silently.
		const reports = warn.mock.calls.filter(([, context]) => context?.extension === inline.path);
		expect(reports.map(([, context]) => context)).toEqual([{ extension: "<inline-0>", factory: "sdkInlineFactory" }]);
	}, 20_000);
});
