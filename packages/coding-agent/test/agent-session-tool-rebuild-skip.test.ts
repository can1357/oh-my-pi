import { afterEach, describe, expect, it, vi } from "bun:test";
import { type } from "@oh-my-pi/omptype";
import { Agent, type AgentMessage, type AgentTool } from "@oh-my-pi/pi-agent-core";
import type { Message, Model } from "@oh-my-pi/pi-ai";
import { createMockModel, type MockResponseSource } from "@oh-my-pi/pi-ai/providers/mock";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { CustomTool } from "@oh-my-pi/pi-coding-agent/extensibility/custom-tools/types";
import type { ExtensionRunner } from "@oh-my-pi/pi-coding-agent/extensibility/extensions";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { type CustomMessage, convertToLlm } from "@oh-my-pi/pi-coding-agent/session/messages";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import {
	collectMountedMCPToolRoutes,
	projectMountedMCPXdevGuidance,
} from "@oh-my-pi/pi-coding-agent/session/session-tools";
import { listXdevTools, XDEV_EXTERNAL_DESCRIPTION_CAP, type XdevState } from "@oh-my-pi/pi-coding-agent/tools/xdev";
import { logger } from "@oh-my-pi/pi-utils";

// Cache-stability invariant: when MCP servers reconnect with byte-identical tool
// definitions, `refreshMCPTools` must not rebuild the system prompt. A rebuild
// invalidates the Anthropic prompt-cache breakpoint placed on the system block
// and forces a full prefix re-encode on the next request.

function createModel(): Model<"openai-responses"> {
	return buildModel({
		id: "mock",
		name: "mock",
		api: "openai-responses",
		provider: "openai",
		baseUrl: "https://example.invalid",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 8192,
		maxTokens: 2048,
	});
}

function createBasicTool(name: string, label: string, description = `${label} tool`): AgentTool {
	return {
		name,
		label,
		description,
		parameters: type({ value: "string" }),
		strict: true,
		async execute() {
			return { content: [{ type: "text", text: `${name} executed` }] };
		},
	};
}

function createMcpCustomTool(name: string, serverName: string, mcpToolName: string, description: string): CustomTool {
	return {
		name,
		label: `${serverName}/${mcpToolName}`,
		description,
		parameters: type({ q: "string" }),
		strict: true,
		mcpServerName: serverName,
		mcpToolName,
		async execute() {
			return { content: [{ type: "text", text: `${name} executed` }] };
		},
	} as CustomTool;
}

/** Rendered xd:// mount notices within one provider call's messages. */
function mountNoticesIn(messages: Message[]): string[] {
	return messages.flatMap(message => {
		const { content } = message;
		const text =
			typeof content === "string"
				? content
				: content.flatMap(part => (part.type === "text" ? [part.text] : [])).join("");
		return text.includes("xd:// device inventory changed.") ? [text] : [];
	});
}

function createTestXdevState(): XdevState {
	return {
		tools: new Map(),
		mountedNames: new Set(),
		builtInNames: new Set(["read", "write"]),
		isActive: () => true,
	};
}

describe("AgentSession refreshMCPTools rebuild skipping", () => {
	const sessions: AgentSession[] = [];

	afterEach(async () => {
		for (const session of sessions.splice(0)) {
			await session.dispose();
		}
		vi.restoreAllMocks();
	});

	interface NewSessionOptions {
		getMcpServerInstructions?: () => Map<string, string> | undefined;
		xdev?: XdevState;
		lazyWrite?: boolean;
		deviceOnlyWrite?: boolean;
		/** Scripted mock model responses; enables driving `session.prompt()`. */
		responses?: MockResponseSource;
		/** Persisted history seeded into the agent, e.g. to model a resumed session. */
		initialMessages?: AgentMessage[];
		/**
		 * Make the rebuild stub render the mounted xd:// catalog into the prompt and
		 * report it via `xdevCatalogNames`, modelling the production `xdevDocsAll`
		 * path. Existing tests leave this off, so their rebuild carries no catalog.
		 */
		exposeXdevCatalog?: boolean;
		/** Optional per-turn system prompt replacement returned by before_agent_start. */
		beforeAgentStartSystemPrompt?: string[];
	}

	function newSession(
		rebuildSystemPrompt: (toolNames: string[]) => Promise<string>,
		options: NewSessionOptions = {},
	): {
		session: AgentSession;
		/** Provider-call message snapshots (LLM-converted), one per model request. */
		contexts: Message[][];
		/** Provider-call system prompt snapshots, one per model request. */
		systemPrompts: string[][];
		/** Mutable registry shared with the session, for lifecycle-only mount fixtures. */
		toolRegistry: Map<string, AgentTool>;
		isDeviceOnlyWrite: () => boolean;
		isPendingFullWriteDescription: () => boolean;
		isToolActive: (name: string) => boolean;
	} {
		const readTool = createBasicTool("read", "Read");
		const initialMcp = createMcpCustomTool("mcp__nucleus_search", "nucleus", "search", "Search nucleus");
		const writeTool = createBasicTool("write", "Write");
		const toolRegistry = options.xdev?.tools ?? new Map<string, AgentTool>();
		let deviceOnlyWrite = options.deviceOnlyWrite === true;
		let pendingFullWriteDescription = false;
		toolRegistry.set(readTool.name, readTool);
		toolRegistry.set(initialMcp.name, initialMcp as unknown as AgentTool);
		if (options.xdev && !options.lazyWrite) toolRegistry.set(writeTool.name, writeTool);
		const mock = options.responses ? createMockModel({ responses: options.responses }) : undefined;
		const contexts: Message[][] = [];
		const systemPrompts: string[][] = [];
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: {
				model: createModel(),
				systemPrompt: ["initial"],
				tools: options.xdev
					? options.lazyWrite
						? [readTool, initialMcp as unknown as AgentTool]
						: [readTool, writeTool, initialMcp as unknown as AgentTool]
					: [readTool, initialMcp as unknown as AgentTool],
				messages: options.initialMessages ?? [],
			},
			convertToLlm,
			streamFn: mock
				? (model, context, streamOptions) => {
						contexts.push([...context.messages]);
						systemPrompts.push([...(context.systemPrompt ?? [])]);
						return mock.stream(model, context, streamOptions);
					}
				: undefined,
		});
		const activeToolNames = new Set(agent.state.tools.map(tool => tool.name));
		const session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated({ "compaction.enabled": false }),
			modelRegistry: { getApiKey: async () => "test-key" } as never,
			toolRegistry,
			builtInToolNames: options.xdev && !options.lazyWrite ? ["read", "write"] : ["read"],
			ensureWriteRegistered: async () => {
				if (!options.xdev) return false;
				if (!toolRegistry.has("write")) toolRegistry.set("write", writeTool);
				return true;
			},
			setActiveToolNames: names => {
				activeToolNames.clear();
				for (const name of names) activeToolNames.add(name);
			},
			isDeviceOnlyWrite: () => deviceOnlyWrite,
			setDeviceOnlyWrite: enabled => {
				deviceOnlyWrite = enabled;
			},
			setPendingFullWriteDescription: enabled => {
				pendingFullWriteDescription = enabled;
			},
			extensionRunner: options.beforeAgentStartSystemPrompt
				? ({
						emitBeforeAgentStart: async () => ({ systemPrompt: options.beforeAgentStartSystemPrompt }),
						emit: async () => undefined,
					} as unknown as ExtensionRunner)
				: undefined,
			rebuildSystemPrompt: async (toolNames, _tools) => {
				const base = await rebuildSystemPrompt(toolNames);
				if (!options.exposeXdevCatalog) return { systemPrompt: [base] };
				const catalog = options.xdev ? [...options.xdev.mountedNames] : [];
				return { systemPrompt: [`${base}\nxd:// catalog: ${catalog.join(",")}`], xdevCatalogNames: catalog };
			},
			getMcpServerInstructions: options.getMcpServerInstructions,
			xdev: options.xdev,
		});
		sessions.push(session);
		return {
			session,
			contexts,
			systemPrompts,
			toolRegistry,
			isDeviceOnlyWrite: () => deviceOnlyWrite,
			isPendingFullWriteDescription: () => pendingFullWriteDescription,
			isToolActive: name => activeToolNames.has(name),
		};
	}

	it("skips rebuild when an MCP refresh produces an identical tool set", async () => {
		let rebuildCount = 0;
		const { session } = newSession(async toolNames => {
			rebuildCount++;
			return `tools:${toolNames.join(",")}`;
		});
		// The session constructor does not run rebuildSystemPrompt; baseline=0.
		expect(rebuildCount).toBe(0);

		const initialMcp = createMcpCustomTool("mcp__nucleus_search", "nucleus", "search", "Search nucleus");

		// First refresh: no signature recorded yet, must rebuild.
		await session.refreshMCPTools([initialMcp]);
		expect(rebuildCount).toBe(1);

		// Second refresh with byte-identical metadata: must NOT rebuild.
		await session.refreshMCPTools([initialMcp]);
		expect(rebuildCount).toBe(1);

		// Third refresh, again identical: still no rebuild.

		await session.refreshMCPTools([initialMcp]);
		expect(rebuildCount).toBe(1);
	});

	it("warns and keeps the stable winner when distinct MCP tools mint the same name", async () => {
		const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
		const { session, toolRegistry } = newSession(async toolNames => `tools:${toolNames.join(",")}`);
		const dotted = createMcpCustomTool("mcp__foo_bar_lookup", "foo.bar", "lookup", "Lookup from dotted");
		const underscored = createMcpCustomTool("mcp__foo_bar_lookup", "foo_bar", "lookup", "Lookup from underscored");

		await session.refreshMCPTools([dotted, underscored]);

		expect(toolRegistry.get("mcp__foo_bar_lookup")?.label).toBe("foo.bar/lookup");
		expect(warn).toHaveBeenCalledWith("MCP tool name collision; keeping stable winner", {
			name: "mcp__foo_bar_lookup",
			keptServer: "foo.bar",
			keptTool: "lookup",
			ignoredServer: "foo_bar",
			ignoredTool: "lookup",
		});
	});

	it("serializes concurrent MCP refreshes before committing rebuilt prompts", async () => {
		const firstRebuildStarted = Promise.withResolvers<void>();
		const releaseFirstRebuild = Promise.withResolvers<void>();
		const releaseSecondRebuild = Promise.withResolvers<void>();
		let rebuildCount = 0;
		const { session } = newSession(async toolNames => {
			rebuildCount++;
			if (rebuildCount === 1) {
				firstRebuildStarted.resolve();
				await releaseFirstRebuild.promise;
			} else {
				await releaseSecondRebuild.promise;
			}
			return `tools:${toolNames.join(",")}`;
		});
		const search = createMcpCustomTool("mcp__nucleus_search", "nucleus", "search", "Search nucleus");
		const fetch = createMcpCustomTool("mcp__nucleus_fetch", "nucleus", "fetch", "Fetch nucleus");

		const olderRefresh = session.refreshMCPTools([search]);
		await firstRebuildStarted.promise;
		const newerRefresh = session.refreshMCPTools([search, fetch]);

		// Even if the newer rebuild would be allowed to resolve first, it cannot
		// start until the older refresh has committed.
		releaseSecondRebuild.resolve();
		expect(rebuildCount).toBe(1);

		releaseFirstRebuild.resolve();
		await Promise.all([olderRefresh, newerRefresh]);
		expect(rebuildCount).toBe(2);
		expect(session.systemPrompt).toEqual(["tools:read,mcp__nucleus_search,mcp__nucleus_fetch"]);
	});

	it("serializes explicit prompt refreshes with registry mutations", async () => {
		const mutationEntered = Promise.withResolvers<void>();
		const releaseMutation = Promise.withResolvers<void>();
		const releaseStaleRefresh = Promise.withResolvers<void>();
		const lateTool = createBasicTool("late_prompt_tool", "Late Prompt Tool");
		const { session, toolRegistry } = newSession(async toolNames => {
			if (!toolNames.includes(lateTool.name)) await releaseStaleRefresh.promise;
			return `tools:${toolNames.join(",")}`;
		});

		const mutation = session.runToolRegistryMutation(async () => {
			mutationEntered.resolve();
			await releaseMutation.promise;
			toolRegistry.set(lateTool.name, lateTool);
			await session.setActiveToolsByName([...session.getEnabledToolNames(), lateTool.name]);
		});
		await mutationEntered.promise;
		const explicitRefresh = session.refreshBaseSystemPrompt();
		await Promise.resolve();

		releaseMutation.resolve();
		await mutation;
		releaseStaleRefresh.resolve();
		await explicitRefresh;

		expect(session.systemPrompt).toEqual(["tools:read,mcp__nucleus_search,late_prompt_tool"]);
	});

	it("keeps queued mutations serialized when a waiting caller aborts", async () => {
		const firstMutationEntered = Promise.withResolvers<void>();
		const releaseFirstMutation = Promise.withResolvers<void>();
		const { session } = newSession(async toolNames => `tools:${toolNames.join(",")}`);
		const firstMutation = session.runToolRegistryMutation(async () => {
			firstMutationEntered.resolve();
			await releaseFirstMutation.promise;
		});
		await firstMutationEntered.promise;

		const controller = new AbortController();
		let abortedMutationRan = false;
		const abortedMutation = session.runToolRegistryMutation(async () => {
			abortedMutationRan = true;
		}, controller.signal);
		controller.abort(new Error("cancel queued mutation"));
		await expect(abortedMutation).rejects.toThrow("cancel queued mutation");

		let thirdMutationRan = false;
		const thirdMutation = session.runToolRegistryMutation(async () => {
			thirdMutationRan = true;
		});
		await Promise.resolve();
		expect(thirdMutationRan).toBe(false);

		releaseFirstMutation.resolve();
		await Promise.all([firstMutation, thirdMutation]);
		expect(abortedMutationRan).toBe(false);
		expect(thirdMutationRan).toBe(true);
	});

	it("drops queued and in-flight MCP prompt commits when disposal begins", async () => {
		const firstRebuildStarted = Promise.withResolvers<void>();
		const releaseFirstRebuild = Promise.withResolvers<void>();
		let rebuildCount = 0;
		const { session, toolRegistry } = newSession(async toolNames => {
			rebuildCount++;
			firstRebuildStarted.resolve();
			await releaseFirstRebuild.promise;
			return `tools:${toolNames.join(",")}`;
		});
		const initialPrompt = [...session.systemPrompt];
		const initialToolNames = session.getActiveToolNames();
		const initialSearchTool = toolRegistry.get("mcp__nucleus_search");
		const search = createMcpCustomTool("mcp__nucleus_search", "nucleus", "search", "Search nucleus");
		const fetch = createMcpCustomTool("mcp__nucleus_fetch", "nucleus", "fetch", "Fetch nucleus");

		const inFlightRefresh = session.refreshMCPTools([search]);
		await firstRebuildStarted.promise;
		const queuedRefresh = session.refreshMCPTools([search, fetch]);
		session.beginDispose();
		releaseFirstRebuild.resolve();

		await Promise.all([inFlightRefresh, queuedRefresh]);
		expect(rebuildCount).toBe(1);
		expect(session.systemPrompt).toEqual(initialPrompt);
		expect(session.getActiveToolNames()).toEqual(initialToolNames);
		expect(toolRegistry.get("mcp__nucleus_search")).toBe(initialSearchTool);
		expect(toolRegistry.has("mcp__nucleus_fetch")).toBe(false);
	});

	it("rebuilds generated guidance when its ordered mounted MCP route projection changes", async () => {
		const xdevState = createTestXdevState();
		const serverInstructions = new Map([
			["archive", "Archive instructions"],
			["nucleus", "Nucleus instructions"],
		]);
		const renderedPrompts: string[] = [];
		let rebuildCount = 0;
		const { session } = newSession(
			async () => {
				rebuildCount++;
				const projection = projectMountedMCPXdevGuidance(collectMountedMCPToolRoutes(listXdevTools(xdevState)));
				const generatedPrompt = `mounted:${projection.mappings
					.map(mapping => `${mapping.label}=${mapping.path}`)
					.join(",")}`;
				renderedPrompts.push(generatedPrompt);
				return generatedPrompt;
			},
			{ xdev: xdevState, getMcpServerInstructions: () => serverInstructions },
		);
		const search = createMcpCustomTool("mcp__nucleus_search", "nucleus", "search", "Search nucleus");
		const fetch = createMcpCustomTool("mcp__nucleus_fetch", "nucleus", "fetch", "Fetch nucleus");
		const uninstructed = createMcpCustomTool("mcp__silent_ping", "silent", "ping", "Ping silently");
		const searchPrompt = 'mounted:"search"=xd://mcp__nucleus_search';
		const searchAndUninstructedPrompt = 'mounted:"search"=xd://mcp__nucleus_search,"ping"=xd://mcp__silent_ping';
		const searchFetchAndUninstructedPrompt =
			'mounted:"search"=xd://mcp__nucleus_search,"fetch"=xd://mcp__nucleus_fetch,"ping"=xd://mcp__silent_ping';

		await session.refreshMCPTools([search]);
		expect(rebuildCount).toBe(1);
		expect(session.systemPrompt).toEqual([searchPrompt]);

		// A new object with the same ordered route identity is still the same
		// externally rendered inventory, so reconnecting it must preserve the
		// cached prompt rather than rebuilding.
		const equivalentSearch = createMcpCustomTool("mcp__nucleus_search", "nucleus", "search", "Search nucleus");
		await session.refreshMCPTools([equivalentSearch]);
		expect(rebuildCount).toBe(1);
		expect(session.systemPrompt).toEqual([searchPrompt]);

		// Global route guidance is independent of optional server instructions.
		// Adding a route for a server absent from the instructions map must rebuild.
		await session.refreshMCPTools([equivalentSearch, uninstructed]);
		expect(rebuildCount).toBe(2);
		expect(session.systemPrompt).toEqual([searchAndUninstructedPrompt]);

		await session.refreshMCPTools([equivalentSearch, fetch, uninstructed]);
		expect(rebuildCount).toBe(3);
		expect(session.systemPrompt).toEqual([searchFetchAndUninstructedPrompt]);

		const fetchSearchAndUninstructedPrompt =
			'mounted:"fetch"=xd://mcp__nucleus_fetch,"search"=xd://mcp__nucleus_search,"ping"=xd://mcp__silent_ping';
		await session.refreshMCPTools([fetch, equivalentSearch, uninstructed]);
		expect(rebuildCount).toBe(4);
		expect(session.systemPrompt).toEqual([fetchSearchAndUninstructedPrompt]);

		const replacementSearch = createMcpCustomTool("mcp__nucleus_search", "nucleus", "search", "Search nucleus");
		await session.refreshMCPTools([replacementSearch, uninstructed]);
		expect(rebuildCount).toBe(5);
		expect(session.systemPrompt).toEqual([searchAndUninstructedPrompt]);
		const stableLabel = replacementSearch.label;
		const reownedSearch = {
			...createMcpCustomTool("mcp__nucleus_search", "archive", "search", "Search nucleus"),
			label: stableLabel,
		};
		// Ownership alone is not rendered in the global route projection.
		await session.refreshMCPTools([reownedSearch, uninstructed]);
		expect(rebuildCount).toBe(5);
		expect(session.systemPrompt).toEqual([searchAndUninstructedPrompt]);

		const renamedOriginalSearch = {
			...createMcpCustomTool("mcp__nucleus_search", "archive", "lookup", "Search nucleus"),
			label: stableLabel,
		};
		const renamedOriginalAndUninstructedPrompt =
			'mounted:"lookup"=xd://mcp__nucleus_search,"ping"=xd://mcp__silent_ping';
		await session.refreshMCPTools([renamedOriginalSearch, uninstructed]);
		expect(rebuildCount).toBe(6);
		expect(session.systemPrompt).toEqual([renamedOriginalAndUninstructedPrompt]);

		const remountedSearch = {
			...createMcpCustomTool("mcp__archive_lookup", "archive", "lookup", "Search nucleus"),
			label: stableLabel,
		};
		const remountedAndUninstructedPrompt = 'mounted:"lookup"=xd://mcp__archive_lookup,"ping"=xd://mcp__silent_ping';
		await session.refreshMCPTools([remountedSearch, uninstructed]);
		expect(rebuildCount).toBe(7);
		expect(session.systemPrompt).toEqual([remountedAndUninstructedPrompt]);

		const equivalentRemountedSearch = {
			...createMcpCustomTool("mcp__archive_lookup", "archive", "lookup", "Search nucleus"),
			label: stableLabel,
		};
		await session.refreshMCPTools([equivalentRemountedSearch, uninstructed]);
		expect(rebuildCount).toBe(7);
		expect(session.systemPrompt).toEqual([remountedAndUninstructedPrompt]);

		// Removing the uninstructed server's rendered route also changes guidance.
		const remountedPrompt = 'mounted:"lookup"=xd://mcp__archive_lookup';
		await session.refreshMCPTools([equivalentRemountedSearch]);
		expect(rebuildCount).toBe(8);
		expect(session.systemPrompt).toEqual([remountedPrompt]);
		expect(renderedPrompts).toEqual([
			searchPrompt,
			searchAndUninstructedPrompt,
			searchFetchAndUninstructedPrompt,
			fetchSearchAndUninstructedPrompt,
			searchAndUninstructedPrompt,
			renamedOriginalAndUninstructedPrompt,
			remountedAndUninstructedPrompt,
			remountedPrompt,
		]);
	});

	it("skips rebuild when only an omitted mounted MCP mapping changes", async () => {
		const xdevState = createTestXdevState();
		let rebuildCount = 0;
		const { session } = newSession(
			async () => {
				rebuildCount++;
				return "bounded mounted MCP guidance";
			},
			{ xdev: xdevState },
		);
		const tools = Array.from({ length: 65 }, (_, index) =>
			createMcpCustomTool(`mcp__archive_tool_${index}`, "archive", `tool_${index}`, "Archive tool"),
		);

		await session.refreshMCPTools(tools);
		expect(rebuildCount).toBe(1);

		const changedOmittedTool = {
			...createMcpCustomTool("mcp__archive_tool_64", "archive", "renamed_tail", "Archive tool"),
			label: tools[64]!.label,
		};
		await session.refreshMCPTools([...tools.slice(0, 64), changedOmittedTool]);
		expect(rebuildCount).toBe(1);
	});

	it("skips rebuild when only non-MCP xd mounts change", async () => {
		const xdevState = createTestXdevState();
		let rebuildCount = 0;
		const { session, toolRegistry } = newSession(
			async toolNames => {
				rebuildCount++;
				return `tools:${toolNames.join(",")}`;
			},
			{ xdev: xdevState },
		);
		const search = createMcpCustomTool("mcp__nucleus_search", "nucleus", "search", "Search nucleus");
		const catalog = {
			...createBasicTool("catalog_lookup", "Catalog Lookup"),
			loadMode: "discoverable" as const,
		};
		toolRegistry.set(catalog.name, catalog);

		await session.refreshMCPTools([search]);
		expect(rebuildCount).toBe(1);

		// Ordinary xd:// inventory changes travel through mount notices and do
		// not affect the global MCP-route guidance or its rebuild signature.
		await session.setActiveToolPresentation(
			["read", "write", search.name, catalog.name],
			[search.name, catalog.name],
		);
		expect(session.getMountedXdevToolNames()).toContain(catalog.name);
		expect(rebuildCount).toBe(1);

		await session.setActiveToolPresentation(["read", "write", search.name], [search.name]);
		expect(session.getMountedXdevToolNames()).not.toContain(catalog.name);
		expect(rebuildCount).toBe(1);
	});

	it("rebuilds when an MCP tool's description changes", async () => {
		let rebuildCount = 0;
		const { session } = newSession(async toolNames => {
			rebuildCount++;
			return `tools:${toolNames.join(",")}`;
		});

		const v1 = createMcpCustomTool("mcp__nucleus_search", "nucleus", "search", "Search v1");
		await session.refreshMCPTools([v1]);
		expect(rebuildCount).toBe(1);

		const v2 = createMcpCustomTool("mcp__nucleus_search", "nucleus", "search", "Search v2");
		await session.refreshMCPTools([v2]);
		expect(rebuildCount).toBe(2);
	});

	it("rebuilds when the active tool list changes via setActiveToolsByName", async () => {
		let rebuildCount = 0;
		const { session } = newSession(async toolNames => {
			rebuildCount++;
			return `tools:${toolNames.join(",")}`;
		});

		const a = createMcpCustomTool("mcp__nucleus_search", "nucleus", "search", "Search");
		const b = createMcpCustomTool("mcp__nucleus_explain", "nucleus", "explain", "Explain");

		// Connected MCP tools are all enabled after refresh.
		await session.refreshMCPTools([a, b]);
		const baseline = rebuildCount;
		expect(baseline).toBeGreaterThanOrEqual(1);

		// Remove one active tool: the active list shrinks, so rebuild must fire.
		await session.setActiveToolsByName(["read", "mcp__nucleus_search"]);
		expect(rebuildCount).toBe(baseline + 1);

		// Same list again: skip.
		await session.setActiveToolsByName(["read", "mcp__nucleus_search"]);
		expect(rebuildCount).toBe(baseline + 1);

		// Restore it: rebuild fires again.
		await session.setActiveToolsByName(["read", "mcp__nucleus_search", "mcp__nucleus_explain"]);
		expect(rebuildCount).toBe(baseline + 2);
	});

	it("updates live active-tool predicates before rebuilding the prompt", async () => {
		const activeToolNames = new Set(["read", "bash", "grep"]);
		const readTool = createBasicTool("read", "Read");
		const bashTool = createBasicTool("bash", "Bash");
		const grepTool = createBasicTool("grep", "Grep");
		Object.defineProperty(bashTool, "description", {
			get: () => (activeToolNames.has("grep") ? "bash sees grep" : "bash hides grep"),
			enumerable: true,
			configurable: true,
		});
		const toolRegistry = new Map<string, AgentTool>([
			[readTool.name, readTool],
			[bashTool.name, bashTool],
			[grepTool.name, grepTool],
		]);
		const agent = new Agent({
			initialState: {
				model: createModel(),
				systemPrompt: ["initial"],
				tools: [readTool, bashTool, grepTool],
				messages: [],
			},
		});
		const session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated({ "compaction.enabled": false }),
			modelRegistry: {} as never,
			toolRegistry,
			setActiveToolNames: names => {
				activeToolNames.clear();
				for (const name of names) {
					activeToolNames.add(name);
				}
			},
			rebuildSystemPrompt: async (_toolNames, tools) => ({
				systemPrompt: [tools.get("bash")?.description ?? "missing bash"],
			}),
		});
		sessions.push(session);

		await session.setActiveToolsByName(["read", "bash"]);

		expect(agent.state.systemPrompt).toEqual(["bash hides grep"]);
	});

	it("does not skip when refreshBaseSystemPrompt is called explicitly", async () => {
		let rebuildCount = 0;
		const { session } = newSession(async toolNames => {
			rebuildCount++;
			return `tools:${toolNames.join(",")}`;
		});

		const tool = createMcpCustomTool("mcp__nucleus_search", "nucleus", "search", "Search");
		await session.refreshMCPTools([tool]);
		expect(rebuildCount).toBe(1);

		// Explicit refresh must always rebuild (callers use it to pick up env-side changes
		// such as edit mode toggles, which are invisible to our tool signature).
		await session.refreshBaseSystemPrompt();
		expect(rebuildCount).toBe(2);

		// Subsequent identical MCP refresh should still skip after the explicit refresh
		// freshens the cached signature.
		await session.refreshMCPTools([tool]);
		expect(rebuildCount).toBe(2);
	});

	it("rebuilds when the refresh argument tool order changes", async () => {
		let rebuildCount = 0;
		const { session } = newSession(async toolNames => {
			rebuildCount++;
			return `tools:${toolNames.join(",")}`;
		});

		const a = createMcpCustomTool("mcp__nucleus_a", "nucleus", "a", "A");
		const b = createMcpCustomTool("mcp__nucleus_b", "nucleus", "b", "B");

		// All connected MCP tools are active, so their ordering contributes to the
		// rendered prompt and changing it must rebuild.
		await session.refreshMCPTools([a, b]);
		expect(rebuildCount).toBe(1);

		await session.refreshMCPTools([b, a]);
		expect(rebuildCount).toBe(2);
	});

	it("rebuilds when an MCP tool's label changes", async () => {
		// Tool labels are rendered into the prompt body (`{{label}}: \`{{name}}\``),
		// so a label change — even with name and description constant — must force
		// a rebuild. Otherwise we'd serve a stale label after an MCP server upgrade.
		let rebuildCount = 0;
		const { session } = newSession(async toolNames => {
			rebuildCount++;
			return `tools:${toolNames.join(",")}`;
		});

		const v1 = createMcpCustomTool("mcp__nucleus_search", "nucleus", "search", "Search");
		// Override the auto-derived label so the test mutates only the label.
		const v1WithLabel = { ...v1, label: "old label" } as typeof v1;
		await session.refreshMCPTools([v1WithLabel]);
		expect(rebuildCount).toBe(1);

		const v2WithLabel = { ...v1, label: "new label" } as typeof v1;
		await session.refreshMCPTools([v2WithLabel]);
		expect(rebuildCount).toBe(2);
	});

	it("rebuilds when MCP server instructions text changes", async () => {
		// `rebuildSystemPrompt` embeds per-server `instructions` text into the appended
		// prompt. The signature must include this so a server upgrade that changes
		// instructions while keeping tools constant still triggers a rebuild.
		let rebuildCount = 0;
		const instructions = new Map<string, string>([["nucleus", "v1 instructions"]]);
		const { session } = newSession(
			async toolNames => {
				rebuildCount++;
				return `tools:${toolNames.join(",")}`;
			},
			{ getMcpServerInstructions: () => instructions },
		);

		const tool = createMcpCustomTool("mcp__nucleus_search", "nucleus", "search", "Search");
		await session.refreshMCPTools([tool]);
		expect(rebuildCount).toBe(1);

		// Same tools, same instructions: skip.
		await session.refreshMCPTools([tool]);
		expect(rebuildCount).toBe(1);

		// Mutate the live instructions map (callers return the live reference).
		instructions.set("nucleus", "v2 instructions");
		await session.refreshMCPTools([tool]);
		expect(rebuildCount).toBe(2);

		// Adding a new server's instructions also triggers rebuild.
		instructions.set("glean", "glean instructions");
		await session.refreshMCPTools([tool]);
		expect(rebuildCount).toBe(3);
	});

	it("rebuilds when an MCP registry tool's metadata changes", async () => {
		// All connected MCP tools are enabled. The signature must capture the full
		// registry so a description change cannot leave stale prompt metadata cached.
		let rebuildCount = 0;
		const { session } = newSession(async toolNames => {
			rebuildCount++;
			return `tools:${toolNames.join(",")}`;
		}, {});

		const active = createMcpCustomTool("mcp__nucleus_search", "nucleus", "search", "Search");
		const secondary = createMcpCustomTool("mcp__nucleus_explain", "nucleus", "explain", "Explain v1");

		await session.refreshMCPTools([active, secondary]);
		const baseline = rebuildCount;
		expect(baseline).toBeGreaterThanOrEqual(1);

		// Same registry: skip.
		await session.refreshMCPTools([active, secondary]);
		expect(rebuildCount).toBe(baseline);

		// Mutate the secondary tool's description: the signature must differ and force
		// a rebuild.
		const secondaryV2 = createMcpCustomTool("mcp__nucleus_explain", "nucleus", "explain", "Explain v2");
		await session.refreshMCPTools([active, secondaryV2]);
		expect(rebuildCount).toBe(baseline + 1);
	});
	it("rebuilds when an MCP tool's customWireName changes", async () => {
		// `customWireName` overrides the model-facing tool name (e.g. `edit` exposes
		// itself as `apply_patch` to GPT-5). The wire name is rendered into the prompt
		// body via `toolPromptNames`, so a wire-name flip with the rest of the metadata
		// constant would otherwise leave a stale system prompt that advertises the wrong
		// callable name to the model. The signature must catch this.
		let rebuildCount = 0;
		const { session } = newSession(async toolNames => {
			rebuildCount++;
			return `tools:${toolNames.join(",")}`;
		});

		// Attach a custom wire name to the MCP tool. `applyToolProxy` forwards arbitrary
		// properties from the underlying CustomTool to the wrapper, so the AgentTool the
		// signature inspects exposes `customWireName` as if it were declared on the type.
		const v1 = createMcpCustomTool("mcp__nucleus_search", "nucleus", "search", "Search");
		const v1WithWire = { ...v1, customWireName: "wire_v1" } as typeof v1 & { customWireName: string };
		await session.refreshMCPTools([v1WithWire]);
		expect(rebuildCount).toBe(1);

		// Same wire name: skip.
		await session.refreshMCPTools([v1WithWire]);
		expect(rebuildCount).toBe(1);

		// Wire name changes while name/label/description stay constant: must rebuild.
		const v2WithWire = { ...v1, customWireName: "wire_v2" } as typeof v1 & { customWireName: string };
		await session.refreshMCPTools([v2WithWire]);
		expect(rebuildCount).toBe(2);

		// Drop wire name entirely: must rebuild (signature must differ from `wire_v2`).
		await session.refreshMCPTools([v1]);
		expect(rebuildCount).toBe(3);
	});

	it("rebuilds when a tool's getter-based description reflects new settings state", async () => {
		// Built-in tools whose prompt-rendered metadata depends on settings expose
		// `description` via getters that re-evaluate on every access (TaskTool reads
		// task.disabledAgents/maxConcurrency/isolation.enabled/simple/async.enabled, and
		// EditTool resolves through the current edit-mode definition). The signature
		// reads `tool.description` live each call, so a settings flip that mutates the
		// rendered string must change the signature on the next
		// `#applyActiveToolsByName`.
		let rebuildCount = 0;
		const { session } = newSession(
			async toolNames => {
				rebuildCount++;
				return `tools:${toolNames.join(",")}`;
			},
			// The dynamic tool is active, so the signature reads its description via
			// the active tool metadata segment.
			{},
		);

		// Reuse the initially-active MCP name so the tool stays in the active list
		// across refreshes - we want to defend the path where `tool.description` is read
		// for the active descriptionSegment, not just the registrySegment.
		const settingState = { disabled: "none" };
		const dynamicTool = createMcpCustomTool("mcp__nucleus_search", "nucleus", "search", "placeholder");
		Object.defineProperty(dynamicTool, "description", {
			get: () => `dynamic disabled=${settingState.disabled}`,
			enumerable: true,
			configurable: true,
		});

		await session.refreshMCPTools([dynamicTool]);
		const baseline = rebuildCount;
		expect(baseline).toBeGreaterThanOrEqual(1);

		// Same underlying state, same tool object identity: skip.
		await session.refreshMCPTools([dynamicTool]);
		expect(rebuildCount).toBe(baseline);

		// Mutate the settings-backed state. The tool object identity does not change,
		// but its `description` getter now returns a new string. The signature must
		// pick this up live (no per-tool caching) and force a rebuild.
		settingState.disabled = "plan,scout";
		await session.refreshMCPTools([dynamicTool]);
		expect(rebuildCount).toBe(baseline + 1);

		// Same state again: skip.
		await session.refreshMCPTools([dynamicTool]);
		expect(rebuildCount).toBe(baseline + 1);
	});

	it("does not rebuild when MCP server instructions change only beyond the 4000-char truncation boundary", async () => {
		// `rebuildSystemPrompt` (sdk.ts) truncates each server instruction to 4000 chars
		// before embedding it. The `getMcpServerInstructions` callback must therefore
		// return pre-truncated strings so the signature hashes exactly what the prompt
		// builder uses. Changes beyond char 4000 cannot affect rendered prompt bytes
		// and must NOT trigger a rebuild.
		const prefix = "A".repeat(4000);
		const instructions = new Map<string, string>([["nucleus", `${prefix}_tail_v1`]]);
		let rebuildCount = 0;
		const { session } = newSession(
			async toolNames => {
				rebuildCount++;
				return `tools:${toolNames.join(",")}`;
			},
			{
				getMcpServerInstructions: () => {
					// Mirror what sdk.ts does: truncate to 4000 chars before returning.
					const out = new Map<string, string>();
					for (const [name, text] of instructions) {
						out.set(name, text.length > 4000 ? text.slice(0, 4000) : text);
					}
					return out;
				},
			},
		);
		const tool = createMcpCustomTool("mcp__nucleus_search", "nucleus", "search", "Search");

		await session.refreshMCPTools([tool]);
		expect(rebuildCount).toBe(1);

		// Mutate only the text beyond char 4000: truncated string is identical → skip.
		instructions.set("nucleus", `${prefix}_tail_v2`);
		await session.refreshMCPTools([tool]);
		expect(rebuildCount).toBe(1);

		// Mutate within the first 4000 chars: truncated string differs → rebuild.
		instructions.set("nucleus", `${"B".repeat(4000)}_tail_v2`);
		await session.refreshMCPTools([tool]);
		expect(rebuildCount).toBe(2);
	});

	it("waits for the next user prompt before delivering xd:// mount notices", async () => {
		const firstCallStarted = Promise.withResolvers<void>();
		const releaseFirstCall = Promise.withResolvers<void>();
		let rebuildCount = 0;
		const { session, contexts } = newSession(
			async toolNames => {
				rebuildCount++;
				return `tools:${toolNames.join(",")}`;
			},
			{
				xdev: createTestXdevState(),
				responses: [
					async () => {
						firstCallStarted.resolve();
						await releaseFirstCall.promise;
						return { content: ["first answer"] };
					},
					{ content: ["second answer"] },
					{ content: ["third answer"] },
				],
			},
		);
		const search = createMcpCustomTool("mcp__nucleus_search", "nucleus", "search", "Search nucleus");
		const fetch = createMcpCustomTool("mcp__nucleus_fetch", "nucleus", "fetch", "Fetch nucleus");

		// Devices mount while the first request is in flight. The refresh must
		// not turn the hidden notice into a second, unsolicited provider call.
		const firstPrompt = session.prompt("hello");
		await firstCallStarted.promise;
		await session.refreshMCPTools([search]);
		await session.refreshMCPTools([search, fetch]);
		releaseFirstCall.resolve();
		await firstPrompt;
		expect(rebuildCount).toBe(2);
		expect(contexts).toHaveLength(1);
		expect(mountNoticesIn(contexts[0])).toHaveLength(0);

		// The next user prompt carries one coalesced notice for both mounts.
		await session.prompt("again");
		expect(contexts).toHaveLength(2);
		const mountNotices = mountNoticesIn(contexts[1]);
		expect(mountNotices).toHaveLength(1);
		expect(mountNotices[0]).toContain("Available tools.");
		expect(mountNotices[0]).toContain("xd://mcp__nucleus_search");
		expect(mountNotices[0]).toContain("xd://mcp__nucleus_fetch");
		expect(mountNotices[0]).not.toContain("Unmounted; writes fail:");

		// A later unmount is likewise held for the following user prompt.
		await session.refreshMCPTools([search]);
		expect(rebuildCount).toBe(3);
		expect(contexts).toHaveLength(2);
		await session.prompt("third");
		const allNotices = mountNoticesIn(contexts[2]);
		expect(allNotices).toHaveLength(2);
		expect(allNotices[1]).toContain("Unmounted; writes fail:");
		expect(allNotices[1]).toContain("xd://mcp__nucleus_fetch");
		expect(allNotices[1]).not.toContain("Available tools.");
	});

	it("caps dynamic xd:// mount-notice summaries", async () => {
		const { session, contexts } = newSession(async toolNames => `tools:${toolNames.join(",")}`, {
			xdev: createTestXdevState(),
			responses: [{ content: ["ok"] }],
		});
		const description = `Search ${"x".repeat(XDEV_EXTERNAL_DESCRIPTION_CAP * 3)} TAIL`;
		const search = createMcpCustomTool("mcp__nucleus_search", "nucleus", "search", description);

		await session.refreshMCPTools([search]);
		await session.prompt("hello");

		const notices = mountNoticesIn(contexts[0]);
		expect(notices).toHaveLength(1);
		expect(notices[0]).toContain("xd://mcp__nucleus_search");
		expect(notices[0]).not.toContain("TAIL");
	});

	it("inlines configured late xd:// device docs in mount notices", async () => {
		const { session, contexts } = newSession(async toolNames => `tools:${toolNames.join(",")}`, {
			xdev: createTestXdevState(),
			responses: [{ content: ["ok"] }],
		});
		session.settings.set("tools.xdevDocs", "builtins");
		session.settings.set("tools.xdevInlineDevices", ["mcp__nucleus_*"]);
		const search = createMcpCustomTool("mcp__nucleus_search", "nucleus", "search", "Search nucleus");

		await session.refreshMCPTools([search]);
		await session.prompt("hello");

		const notices = mountNoticesIn(contexts[0]);
		expect(notices).toHaveLength(1);
		expect(notices[0]).toContain("## mcp__nucleus_search");
		expect(notices[0]).toContain("## Schema");
	});

	it("drops a mount delta that cancels out before the next prompt", async () => {
		const { session, contexts } = newSession(async toolNames => `tools:${toolNames.join(",")}`, {
			xdev: createTestXdevState(),
			responses: [{ content: ["ok"] }],
		});
		const search = createMcpCustomTool("mcp__nucleus_search", "nucleus", "search", "Search nucleus");
		const fetch = createMcpCustomTool("mcp__nucleus_fetch", "nucleus", "fetch", "Fetch nucleus");

		// fetch mounts and unmounts before the model ever hears about it → the
		// coalesced notice must not mention it in either direction.
		await session.refreshMCPTools([search]);
		await session.refreshMCPTools([search, fetch]);
		await session.refreshMCPTools([search]);

		await session.prompt("hello");
		const notices = mountNoticesIn(contexts[0]);
		expect(notices).toHaveLength(1);
		expect(notices[0]).toContain("xd://mcp__nucleus_search");
		expect(notices[0]).not.toContain("mcp__nucleus_fetch");
		expect(notices[0]).not.toContain("Unmounted; writes fail:");
	});

	it.each([
		{
			priorNotice: {
				role: "custom",
				customType: "xdev-mount-notice",
				content: "The xd:// device inventory changed.\n\nxd://mcp__nucleus_search became available.",
				details: { added: ["mcp__nucleus_search"], removed: [] },
				attribution: "agent",
				display: false,
				timestamp: 1,
			} satisfies AgentMessage,
		},
		{
			priorNotice: {
				role: "custom",
				customType: "xdev-mount-notice",
				content: `<system-notice>
The xd:// device inventory changed.
These tools became available:
- xd://mcp__nucleus_search — Search nucleus
- xd://mcp__retired — Retired device
Read \`xd://<tool>\` for docs + JSON schema before first use; write the JSON args object to \`xd://<tool>\` to execute.
No longer mounted (writes to these devices will fail):
- xd://mcp__retired
Configured inline device docs:
These tools became available:
- xd://mcp__nucleus_fetch — This is inline documentation, not an inventory entry.
</system-notice>`,
				attribution: "agent",
				display: false,
				timestamp: 1,
			} satisfies AgentMessage,
		},
	])("does not re-announce devices a resumed session already announced in history", async ({ priorNotice }) => {
		// Model a process resume / host reconnect: persisted history already carries
		// a mount notice for mcp__nucleus_search, but the fresh in-memory mount set
		// starts empty. When the device reconnects, the notice must NOT re-splice a
		// redundant developer message — doing so busts the provider prompt-cache
		// prefix and re-bills the whole suffix on metered providers.
		const { session, contexts } = newSession(async toolNames => `tools:${toolNames.join(",")}`, {
			xdev: createTestXdevState(),
			responses: [{ content: ["ok"] }, { content: ["ok"] }],
			initialMessages: [priorNotice],
		});
		const search = createMcpCustomTool("mcp__nucleus_search", "nucleus", "search", "Search nucleus");
		const fetch = createMcpCustomTool("mcp__nucleus_fetch", "nucleus", "fetch", "Fetch nucleus");

		// The already-announced device reconnects: no new notice is spliced in.
		await session.refreshMCPTools([search]);
		await session.prompt("hello");
		const afterReconnect = session.agent.state.messages.filter(
			message => message.role === "custom" && message.customType === "xdev-mount-notice",
		);
		expect(afterReconnect).toHaveLength(1);
		expect(mountNoticesIn(contexts[0])).toHaveLength(1); // only the pre-existing history notice

		// A genuinely new device still announces, and only for itself.
		await session.refreshMCPTools([search, fetch]);
		await session.prompt("again");
		const afterNewDevice = session.agent.state.messages.filter(
			(message): message is CustomMessage => message.role === "custom" && message.customType === "xdev-mount-notice",
		);
		expect(afterNewDevice).toHaveLength(2);
		const fetchNotice = afterNewDevice[1];
		const fetchText = typeof fetchNotice.content === "string" ? fetchNotice.content : "";
		expect(fetchText).toContain("xd://mcp__nucleus_fetch");
		expect(fetchText).not.toContain("xd://mcp__nucleus_search");
	});

	it("does not re-list catalog devices in a mount notice when the rebuild exposes them (#7139)", async () => {
		const { session, contexts } = newSession(async toolNames => `tools:${toolNames.join(",")}`, {
			xdev: createTestXdevState(),
			responses: [{ content: ["ok"] }, { content: ["ok"] }],
			exposeXdevCatalog: true,
		});
		const search = createMcpCustomTool("mcp__nucleus_search", "nucleus", "search", "Search nucleus");
		const fetch = createMcpCustomTool("mcp__nucleus_fetch", "nucleus", "fetch", "Fetch nucleus");

		// Fresh deferred-discovery session: the post-refresh rebuild renders the
		// mounted catalog into the base prompt, so a same-turn mount notice would
		// duplicate the whole catalog verbatim before the first user turn.
		await session.refreshMCPTools([search]);
		await session.prompt("hi");
		expect(session.systemPrompt.join("\n")).toContain("mcp__nucleus_search");
		expect(
			session.agent.state.messages.filter(m => m.role === "custom" && m.customType === "xdev-mount-notice"),
		).toHaveLength(0);
		expect(mountNoticesIn(contexts[0])).toHaveLength(0);

		// A later device the next rebuild also exposes stays notice-free too.
		await session.refreshMCPTools([search, fetch]);
		await session.prompt("again");
		expect(session.systemPrompt.join("\n")).toContain("mcp__nucleus_fetch");
		expect(
			session.agent.state.messages.filter(m => m.role === "custom" && m.customType === "xdev-mount-notice"),
		).toHaveLength(0);
	});

	it("keeps the mount notice when before_agent_start replaces the catalog prompt (#7139)", async () => {
		const replacementPrompt = ["extension replacement"];
		const { session, contexts, systemPrompts } = newSession(async toolNames => `tools:${toolNames.join(",")}`, {
			xdev: createTestXdevState(),
			responses: [{ content: ["ok"] }],
			exposeXdevCatalog: true,
			beforeAgentStartSystemPrompt: replacementPrompt,
		});
		const search = createMcpCustomTool("mcp__nucleus_search", "nucleus", "search", "Search nucleus");

		// The base prompt rebuild exposes the device, but the per-turn extension
		// replaces that prompt before the provider call. The mount notice is now
		// the only channel making the newly mounted device visible on this turn.
		await session.refreshMCPTools([search]);
		await session.prompt("hi");

		expect(systemPrompts[0]).toEqual(replacementPrompt);
		const notices = mountNoticesIn(contexts[0]);
		expect(notices).toHaveLength(1);
		expect(notices[0]).toContain("xd://mcp__nucleus_search");
	});

	it("does not emit an unmount notice for a catalog device unmounted before delivery (#7139)", async () => {
		const { session } = newSession(async toolNames => `tools:${toolNames.join(",")}`, {
			xdev: createTestXdevState(),
			responses: [{ content: ["ok"] }],
			exposeXdevCatalog: true,
		});
		const search = createMcpCustomTool("mcp__nucleus_search", "nucleus", "search", "Search nucleus");

		// Deferred discovery mounts the device, then the server disconnects before
		// the first user prompt is ever sent. Because the pending add is only marked
		// announced at delivery, the unmount coalesces it away — the model, which
		// never saw a request carrying the device, must not receive a "No longer
		// mounted" notice for it.
		await session.refreshMCPTools([search]);
		await session.refreshMCPTools([]);
		await session.prompt("hi");
		expect(
			session.agent.state.messages.filter(m => m.role === "custom" && m.customType === "xdev-mount-notice"),
		).toHaveLength(0);
	});

	it("re-announces a device after the transcript is replaced by /new", async () => {
		const xdev = createTestXdevState();
		const { session } = newSession(async toolNames => `tools:${toolNames.join(",")}`, {
			xdev,
			responses: [{ content: ["ok"] }, { content: ["ok"] }],
		});
		const search = createMcpCustomTool("mcp__nucleus_search", "nucleus", "search", "Search nucleus");

		// Announce the device in the original transcript.
		await session.refreshMCPTools([search]);
		await session.prompt("hello");
		expect(
			session.agent.state.messages.filter(
				message => message.role === "custom" && message.customType === "xdev-mount-notice",
			),
		).toHaveLength(1);

		// /new swaps in a fresh transcript that no longer carries the notice. A
		// resume/reconnect rebuilds the mount set from scratch, so model the device
		// dropping out across the boundary.
		await session.newSession();
		xdev.mountedNames.clear();

		// The same device reconnects into the new transcript: because the announced
		// baseline was reset with the transcript, it must announce again (otherwise
		// the new conversation never learns the device is available).
		await session.refreshMCPTools([search]);
		await session.prompt("world");
		const newTranscriptNotices = session.agent.state.messages.filter(
			(message): message is CustomMessage => message.role === "custom" && message.customType === "xdev-mount-notice",
		);
		expect(newTranscriptNotices).toHaveLength(1);
		const text = typeof newTranscriptNotices[0].content === "string" ? newTranscriptNotices[0].content : "";
		expect(text).toContain("xd://mcp__nucleus_search");
	});

	it("preserves an undelivered mount notice across a branch that does not rebuild the prompt", async () => {
		const { session } = newSession(async toolNames => `tools:${toolNames.join(",")}`, {
			xdev: createTestXdevState(),
			responses: [{ content: ["ok"] }, { content: ["ok"] }],
		});
		session.subscribe(() => {});
		const search = createMcpCustomTool("mcp__nucleus_search", "nucleus", "search", "Search nucleus");

		// A user turn establishes a branch point.
		await session.prompt("first");
		// The device mounts but the user branches before the next prompt consumes
		// its queued notice. `branch()` does not rebuild the base system prompt, so
		// the delta is the only channel that can tell the branched transcript the
		// device exists.
		await session.refreshMCPTools([search]);
		const branchable = session.getUserMessagesForBranching();
		expect(branchable.length).toBeGreaterThan(0);
		await session.branch(branchable[0].entryId);

		await session.prompt("second");
		const notices = session.agent.state.messages.filter(
			(message): message is CustomMessage => message.role === "custom" && message.customType === "xdev-mount-notice",
		);
		expect(notices).toHaveLength(1);
		const text = typeof notices[0].content === "string" ? notices[0].content : "";
		expect(text).toContain("xd://mcp__nucleus_search");
	});

	it("keeps xd:// mount deltas model-visible without rendering them during quiet startup", async () => {
		const { session, contexts } = newSession(async toolNames => `tools:${toolNames.join(",")}`, {
			xdev: createTestXdevState(),
			responses: [{ content: ["ok"] }],
		});
		session.settings.set("startup.quiet", true);
		const notices: string[] = [];
		session.subscribe(event => {
			if (event.type === "notice" && event.source === "xdev") notices.push(event.message);
		});

		const search = createMcpCustomTool("mcp__nucleus_search", "nucleus", "search", "Search nucleus");
		await session.refreshMCPTools([search]);

		expect(notices).toEqual([]);
		await session.prompt("hello");
		const delivered = mountNoticesIn(contexts[0]);
		expect(delivered).toHaveLength(1);
		expect(delivered[0]).toContain("xd://mcp__nucleus_search");
	});
	it("keeps device-only write access until a full-write activation commits", async () => {
		let blockRebuild = false;
		const rebuildStarted = Promise.withResolvers<void>();
		const releaseRebuild = Promise.withResolvers<void>();
		const { session, isDeviceOnlyWrite, isPendingFullWriteDescription } = newSession(
			async toolNames => {
				if (blockRebuild) {
					rebuildStarted.resolve();
					await releaseRebuild.promise;
				}
				return `tools:${toolNames.join(",")}`;
			},
			{ xdev: createTestXdevState(), deviceOnlyWrite: true },
		);

		blockRebuild = true;
		const activation = session.setActiveToolsByName(["read", "write"]);
		try {
			await rebuildStarted.promise;
			expect(isDeviceOnlyWrite()).toBe(true);
			expect(isPendingFullWriteDescription()).toBe(true);
		} finally {
			releaseRebuild.resolve();
		}
		await activation;

		expect(isDeviceOnlyWrite()).toBe(false);
		expect(isPendingFullWriteDescription()).toBe(false);
	});

	it("restores device-only write access when a full-write prompt rebuild fails", async () => {
		let failRebuild = false;
		const { session, isDeviceOnlyWrite } = newSession(
			async toolNames => {
				if (failRebuild) throw new Error("rebuild failed");
				return `tools:${toolNames.join(",")}`;
			},
			{ xdev: createTestXdevState(), deviceOnlyWrite: true },
		);
		expect(isDeviceOnlyWrite()).toBe(true);
		const activeBefore = session.getActiveToolNames();

		failRebuild = true;
		await expect(session.setActiveToolsByName(["read", "write"])).rejects.toThrow("rebuild failed");

		expect(isDeviceOnlyWrite()).toBe(true);
		expect(session.getActiveToolNames()).toEqual(activeBefore);
	});

	it("restores full write mode when transport reactivation fails", async () => {
		let failRebuild = false;
		const { session, isDeviceOnlyWrite } = newSession(
			async toolNames => {
				if (failRebuild) throw new Error("rebuild failed");
				return `tools:${toolNames.join(",")}`;
			},
			{ xdev: createTestXdevState() },
		);
		await session.setActiveToolsByName(["read"]);
		expect(isDeviceOnlyWrite()).toBe(false);
		const activeBefore = session.getActiveToolNames();

		session.setPlanModeState({ enabled: true, planFilePath: "local://PLAN.md" });
		failRebuild = true;
		await expect(session.setActiveToolsByName(["read", "write"])).rejects.toThrow("rebuild failed");

		expect(isDeviceOnlyWrite()).toBe(false);
		expect(session.getActiveToolNames()).toEqual(activeBefore);
	});

	it("revokes the active write predicate during rebuild and restores it on failure", async () => {
		let blockRebuild = false;
		const rebuildStarted = Promise.withResolvers<void>();
		const releaseRebuild = Promise.withResolvers<void>();
		const { session, isToolActive } = newSession(
			async toolNames => {
				if (blockRebuild) {
					rebuildStarted.resolve();
					await releaseRebuild.promise;
					throw new Error("rebuild failed");
				}
				return `tools:${toolNames.join(",")}`;
			},
			{ xdev: createTestXdevState() },
		);
		expect(isToolActive("write")).toBe(true);

		blockRebuild = true;
		const deactivation = session.setActiveToolsByName(["read"]);
		try {
			await rebuildStarted.promise;
			expect(isToolActive("write")).toBe(false);
			expect(session.getActiveToolNames()).toContain("write");
		} finally {
			releaseRebuild.resolve();
		}
		await expect(deactivation).rejects.toThrow("rebuild failed");

		expect(isToolActive("write")).toBe(true);
		expect(session.getActiveToolNames()).toContain("write");
	});

	it("does not register write while rolling back a direct-tool rebuild failure", async () => {
		let failRebuild = true;
		const xdevState = createTestXdevState();
		const { session } = newSession(
			async toolNames => {
				if (failRebuild) throw new Error("rebuild failed");
				return `tools:${toolNames.join(",")}`;
			},
			{ xdev: xdevState, lazyWrite: true },
		);
		const search = createMcpCustomTool("mcp__nucleus_search", "nucleus", "search", "Search nucleus");
		const activeBefore = session.getActiveToolNames();
		const mountedBefore = session.getMountedXdevToolNames();

		await expect(session.refreshMCPTools([search])).rejects.toThrow("rebuild failed");

		expect(session.getActiveToolNames()).toEqual(activeBefore);
		expect(session.getMountedXdevToolNames()).toEqual(mountedBefore);
		expect(session.getToolByName("write")).toBeUndefined();
		expect(session.hasBuiltInTool("write")).toBe(false);

		failRebuild = false;
		await session.refreshMCPTools([search]);
		expect(session.getActiveToolNames()).toContain(search.name);
		expect(session.getActiveToolNames()).not.toContain("write");
		expect(session.getMountedXdevToolNames()).not.toContain(search.name);
	});

	it("rolls back MCP catalog replacement when prompt rebuild fails", async () => {
		let failRebuild = false;
		const xdevState = createTestXdevState();
		const { session } = newSession(
			async toolNames => {
				if (failRebuild) throw new Error("rebuild failed");
				return `tools:${toolNames.join(",")}`;
			},
			{ xdev: xdevState },
		);
		const oldTool = createMcpCustomTool("mcp__nucleus_old", "nucleus", "old", "Old tool");
		const newTool = createMcpCustomTool("mcp__nucleus_new", "nucleus", "new", "New tool");
		await session.refreshMCPTools([oldTool]);
		failRebuild = true;

		await expect(session.refreshMCPTools([newTool])).rejects.toThrow("rebuild failed");
		expect(session.getToolByName(oldTool.name)).toBeDefined();
		expect(session.getToolByName(newTool.name)).toBeUndefined();
		expect(session.getMountedXdevToolNames()).toContain(oldTool.name);

		failRebuild = false;
		await session.refreshMCPTools([newTool]);
		expect(session.getToolByName(oldTool.name)).toBeUndefined();
		expect(session.getToolByName(newTool.name)).toBeDefined();
		expect(session.getMountedXdevToolNames()).toContain(newTool.name);
	});

	it("rolls back RPC catalog replacement when prompt rebuild fails", async () => {
		let failRebuild = false;
		const xdevState = createTestXdevState();
		const { session } = newSession(
			async toolNames => {
				if (failRebuild) throw new Error("rebuild failed");
				return `tools:${toolNames.join(",")}`;
			},
			{ xdev: xdevState },
		);
		// Non-discoverable RPC tools stay active top-level, so replacing the catalog
		// (old → new) changes the rebuild signature on its own — the replacement
		// itself must trigger the failing rebuild that gets rolled back.
		const oldTool = createBasicTool("rpc_old", "RPC Old");
		const newTool = createBasicTool("rpc_new", "RPC New");
		await session.refreshRpcHostTools([oldTool]);
		failRebuild = true;

		await expect(session.refreshRpcHostTools([newTool])).rejects.toThrow("rebuild failed");
		expect(session.getToolByName(oldTool.name)).toBeDefined();
		expect(session.getToolByName(newTool.name)).toBeUndefined();
		expect(session.getActiveToolNames()).toContain(oldTool.name);
		expect(session.getActiveToolNames()).not.toContain(newTool.name);

		failRebuild = false;
		await session.refreshRpcHostTools([newTool]);
		expect(session.getToolByName(oldTool.name)).toBeUndefined();
		expect(session.getToolByName(newTool.name)).toBeDefined();
		expect(session.getActiveToolNames()).toContain(newTool.name);
	});

	it("keeps mixed-case plugin devices mounted when MCP tools refresh", async () => {
		const xdevState = createTestXdevState();
		const { session, toolRegistry } = newSession(async toolNames => `tools:${toolNames.join(",")}`, {
			xdev: xdevState,
		});
		const pluginTool = { ...createBasicTool("CaseAdd", "Case Add"), loadMode: "discoverable" as const };
		toolRegistry.set(pluginTool.name, pluginTool);
		xdevState.mountedNames.add(pluginTool.name);

		await session.refreshMCPTools([
			createMcpCustomTool("mcp__nucleus_search", "nucleus", "search", "Search nucleus"),
		]);

		expect(session.getMountedXdevToolNames()).toContain("CaseAdd");
		expect(session.getToolByName("CaseAdd")).toBeDefined();
	});
});
