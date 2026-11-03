import { type MessagePort, parentPort } from "node:worker_threads";
import type { AgentToolResult } from "@oh-my-pi/pi-agent-core";
import type { ModelRegistry } from "../../src/config/model-registry";
import type { CustomTool, CustomToolContext } from "../../src/extensibility/custom-tools/types";
import { bindPreparedExtensions } from "../../src/extensibility/extensions/loader";
import type { PreparedExtension } from "../../src/extensibility/extensions/types";
import { type LocalProtocolOptions, resolveLocalRoot } from "../../src/internal-urls/local-protocol";
import { MCPManager } from "../../src/mcp/manager";
import { SessionManager } from "../../src/session/session-manager";
import { createMCPProxyTools, type ExecutorOptions } from "../../src/task/executor";
import { setCurrentThreadId } from "../../src/thread/identity";
import type { WorkerThreadLink } from "../../src/thread/protocol";
import { type RpcFrame, RpcLink } from "../../src/thread/rpc";
import { authService } from "../../src/thread/services/auth";
import { integrationsThreadService } from "../../src/thread/services/integrations";
import { RemoteMCPManager } from "../../src/thread/services/mcp-remote";
import { settingsThreadService } from "../../src/thread/services/settings";

/** Outcome of one tool call made from the worker. */
export interface ToolCallOutcome {
	text: string;
	updates: string[];
	error?: string;
	errorName?: string;
}

/** Worker-side operations the test drives; each crosses to main as an async function. */
export interface IntegrationsProbe {
	/** What the worker's `MCPManager` statics report. */
	mcpGlobal(): Promise<{ available: boolean; remote: boolean; servers: string[]; tools: string[] }>;
	/** Call an MCP tool through `createMCPProxyTools(MCPManager.instance())`, as a child session would. */
	mcpCall(
		registry: ModelRegistry,
		toolName: string,
		args: Record<string, unknown>,
		signal?: AbortSignal,
	): Promise<ToolCallOutcome>;
	/** Subscribe to the remote manager's tool changes; the returned promise settles on the first one. */
	watchTools(): Promise<{ changed: Promise<void> }>;
	/** Execute a main-defined custom tool with a worker-side context; optionally abort on its first update. */
	customCall(
		tool: CustomTool,
		registry: ModelRegistry,
		args: Record<string, unknown>,
		abortOnUpdate?: boolean,
	): Promise<ToolCallOutcome & { abortsSeen: number }>;
	/** Read bridged executor options synchronously, as the child does. */
	readOptions(options: ExecutorOptions): Promise<{
		roots: unknown;
		suffix: string | undefined;
		localRoot: string;
		approvalTargets: readonly string[] | undefined;
	}>;
	/** Read local-protocol getters synchronously, twice with an awaited gap the test fills. */
	localRoot(options: LocalProtocolOptions): Promise<string>;
	/** Bind prepared extensions in this thread and list the commands they registered. */
	bindExtensions(prepared: PreparedExtension[], cwd: string): Promise<{ commands: string[]; errors: string[] }>;
}

function isTestGlobals(value: unknown): value is { ready(probe: IntegrationsProbe): void } {
	return typeof value === "object" && value !== null && typeof Reflect.get(value, "ready") === "function";
}

function resultText(result: AgentToolResult<unknown>): string {
	return result.content.map(part => (part.type === "text" ? part.text : `[${part.type}]`)).join("");
}

async function runTool(
	tool: CustomTool,
	ctx: CustomToolContext,
	args: Record<string, unknown>,
	abort: AbortSignal | "on-update" | undefined,
): Promise<ToolCallOutcome> {
	const updates: string[] = [];
	const controller = new AbortController();
	const signal = abort instanceof AbortSignal ? abort : controller.signal;
	try {
		const result = await tool.execute(
			"call-1",
			args,
			partial => {
				updates.push(resultText(partial));
				if (abort === "on-update") controller.abort();
			},
			ctx,
			signal,
		);
		return { text: resultText(result), updates };
	} catch (error) {
		return {
			text: "",
			updates,
			error: error instanceof Error ? error.message : String(error),
			errorName: error instanceof Error ? error.name : undefined,
		};
	}
}

function workerContext(registry: ModelRegistry, onAbort: () => void): CustomToolContext {
	return {
		sessionManager: SessionManager.inMemory("/tmp/worker-cwd"),
		modelRegistry: registry,
		model: undefined,
		isIdle: () => false,
		hasQueuedMessages: () => true,
		abort: onAbort,
		localProtocolOptions: { getArtifactsDir: () => "/tmp/worker-artifacts", getSessionId: () => "worker-session" },
	};
}

function buildProbe(): IntegrationsProbe {
	let unwatch: (() => void) | undefined;
	return {
		mcpGlobal: async () => {
			const manager = MCPManager.instance();
			return {
				available: MCPManager.available(),
				remote: manager instanceof RemoteMCPManager,
				servers: manager?.getConnectedServers() ?? [],
				tools: manager?.getTools().map(tool => tool.name) ?? [],
			};
		},
		mcpCall: async (registry, toolName, args, signal) => {
			const manager = MCPManager.instance();
			if (!manager) throw new Error("no MCP manager in worker");
			const tool = createMCPProxyTools(manager).find(candidate => candidate.name === toolName);
			if (!tool) throw new Error(`no proxy for ${toolName}`);
			return runTool(
				tool,
				workerContext(registry, () => {}),
				args,
				signal,
			);
		},
		watchTools: async () => {
			unwatch?.();
			const { promise, resolve } = Promise.withResolvers<void>();
			unwatch = MCPManager.instance()?.addToolsChangedListener(() => resolve());
			return { changed: promise };
		},
		customCall: async (tool, registry, args, abortOnUpdate) => {
			let abortsSeen = 0;
			const outcome = await runTool(
				tool,
				workerContext(registry, () => {
					abortsSeen++;
				}),
				args,
				abortOnUpdate ? "on-update" : undefined,
			);
			return { ...outcome, abortsSeen };
		},
		readOptions: async options => ({
			roots: options.extensionRoots?.(),
			suffix: options.preparedSession?.promptSuffix("model-x"),
			localRoot: options.localProtocolOptions ? resolveLocalRoot(options.localProtocolOptions) : "",
			approvalTargets: options.customTools?.[0]?.approvalCacheTargets?.({ path: "a.txt" }),
		}),
		localRoot: async options => resolveLocalRoot(options),
		bindExtensions: async (prepared, cwd) => {
			const result = await bindPreparedExtensions(prepared, cwd);
			return {
				commands: result.extensions.flatMap(extension => [...extension.commands.keys()]),
				errors: result.errors.map(entry => entry.error),
			};
		},
	};
}

const port = parentPort;
if (!port) throw new Error("fixture must run in a worker");

port.once("message", (init: { sync: MessagePort; counter: SharedArrayBuffer }) => {
	setCurrentThreadId("w1");
	const link: WorkerThreadLink = new RpcLink(
		{
			send: frame => port.postMessage(frame),
			listen: handler => {
				const listener = (frame: RpcFrame): void => handler(frame);
				port.on("message", listener);
				return () => port.off("message", listener);
			},
		},
		{ name: "integrations-fixture", sync: { port: init.sync, counter: new Int32Array(init.counter) } },
	);
	const services = [settingsThreadService, authService, integrationsThreadService];
	for (const service of services) service.installWorker?.(link);
	link.handle("ping", nonce => nonce);
	link.handle("boot", async globals => {
		for (const service of services) await service.boot?.(globals[service.name], link);
		const test = globals.test;
		if (!isTestGlobals(test)) throw new Error("integrations fixture: missing test globals");
		await test.ready(buildProbe());
	});
	port.postMessage({ ready: true });
});
