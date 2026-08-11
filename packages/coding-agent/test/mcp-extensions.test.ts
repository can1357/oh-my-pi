import { describe, expect, it } from "bun:test";
import { completeMCPRequest, connectToServer } from "@pk-nerdsaver-ai/pi-coding-agent/mcp/client";
import {
	createMCPExtensionRuntime,
	type MCPExtensionDefinition,
	MCPExtensionRegistry,
	validateMCPExtensionConfig,
} from "@pk-nerdsaver-ai/pi-coding-agent/mcp/extensions";
import {
	MCP_MODERN_PROTOCOL_VERSION,
	type MCPDiscoverResult,
	type MCPNegotiatedExtensionState,
} from "@pk-nerdsaver-ai/pi-coding-agent/mcp/types";
import { createMockTransport, createModernMockConnection } from "./mcp-test-utils";

const extensionId = "com.example/typed";

function discovery(capabilities: MCPDiscoverResult["capabilities"]): MCPDiscoverResult {
	return {
		resultType: "complete",
		supportedVersions: [MCP_MODERN_PROTOCOL_VERSION],
		capabilities,
		ttlMs: 60_000,
		cacheScope: "public",
	};
}

function provider(events: string[] = []): MCPExtensionDefinition {
	return {
		id: extensionId,
		clientSettings: config => ({ clientMode: config.settings?.clientMode ?? "safe" }),
		parseServerSettings: settings => (settings.serverMode === "active" ? { serverMode: "active" } : undefined),
		resultTypes: [
			{
				method: "tools/call",
				resultType: "com.example/deferred",
				validate: result => (typeof result.ticket === "string" ? undefined : "ticket must be a string"),
			},
		],
		hooks: {
			onNegotiated: (_connection, state) => events.push(`negotiated:${state.id}`),
			onNotification: (_connection, method) => events.push(`notification:${method}`),
		},
	};
}

describe("typed MCP extension foundation", () => {
	it("keeps the no-extension capability snapshot byte-for-byte empty", async () => {
		let captured: Record<string, unknown> | undefined;
		const transport = createMockTransport(new Map([["server/discover", [discovery({})]]]), (_method, params) => {
			captured = params;
		});

		const connection = await connectToServer(
			"no-extensions",
			{ type: "stdio", command: "server" },
			{ transportFactory: async () => transport },
		);

		expect(captured?._meta).toEqual({
			"io.modelcontextprotocol/protocolVersion": MCP_MODERN_PROTOCOL_VERSION,
			"io.modelcontextprotocol/clientCapabilities": {},
			"io.modelcontextprotocol/clientInfo": { name: "omp-coding-agent", version: "1.0.0" },
		});
		expect(connection.extensions).toBeUndefined();
	});

	it("advertises and negotiates only an enabled, registered, validated provider", async () => {
		const events: string[] = [];
		const registry = MCPExtensionRegistry.create([provider(events)]);
		const runtime = createMCPExtensionRuntime(registry, {
			[extensionId]: { enabled: true, settings: { clientMode: "strict" } },
		});
		let captured: Record<string, unknown> | undefined;
		const transport = createMockTransport(
			new Map([["server/discover", [discovery({ extensions: { [extensionId]: { serverMode: "active" } } })]]]),
			(_method, params) => {
				captured = params;
			},
		);

		const connection = await connectToServer(
			"registered",
			{ type: "stdio", command: "server" },
			{ transportFactory: async () => transport, extensionRuntime: runtime },
		);

		expect(captured?._meta).toMatchObject({
			"io.modelcontextprotocol/clientCapabilities": {
				extensions: { [extensionId]: { clientMode: "strict" } },
			},
		});
		expect(connection.extensions?.get(extensionId)).toEqual({
			id: extensionId,
			serverSettings: { serverMode: "active" },
			clientSettings: { clientMode: "strict" },
		});
		expect(Object.isFrozen(connection.extensions)).toBe(true);
		expect(Object.isFrozen(connection.extensions?.get(extensionId))).toBe(true);
		expect(Object.isFrozen(connection.extensions?.get(extensionId)?.serverSettings)).toBe(true);
		expect("set" in (connection.extensions ?? {})).toBe(false);
		expect(events).toEqual([`negotiated:${extensionId}`]);
		expect(runtime.onNotification(connection, `${extensionId}/changed`, {})).toBe(true);
		expect(runtime.onNotification(connection, "com.untrusted/changed", {})).toBe(false);
		expect(events).toEqual([`negotiated:${extensionId}`, `notification:${extensionId}/changed`]);

		const validator = runtime.acceptedResultTypeValidator(connection, "tools/call", "com.example/deferred");
		expect(validator?.({ ticket: "job-1" })).toBeUndefined();
		expect(validator?.({})).toBe("ticket must be a string");
		expect(runtime.acceptedResultTypeValidator(connection, "tools/list", "com.example/deferred")).toBeUndefined();
	});

	it("fails closed for disabled config, malformed offers, unknown config, and invalid registrations", async () => {
		const definition = provider();
		const registry = MCPExtensionRegistry.create([definition]);
		const disabled = createMCPExtensionRuntime(registry, { [extensionId]: { enabled: false } });
		expect(disabled.clientExtensionCapabilities()).toBeUndefined();
		expect(validateMCPExtensionConfig(registry, "test", { "com.untrusted/unknown": { enabled: true } })).toEqual([
			'MCP server "test" config enables unregistered extension "com.untrusted/unknown"',
		]);
		expect(() => MCPExtensionRegistry.create([definition, definition])).toThrow("Duplicate MCP extension identifier");
		expect(() =>
			MCPExtensionRegistry.create([
				{
					...definition,
					resultTypes: [{ method: "tools/call", resultType: "complete", validate: () => undefined }],
				},
			]),
		).toThrow("cannot register reserved resultType");

		const runtime = createMCPExtensionRuntime(registry, { [extensionId]: { enabled: true } });
		const connection = await connectToServer(
			"malformed-offer",
			{ type: "stdio", command: "server" },
			{
				transportFactory: async () =>
					createMockTransport(
						new Map([
							[
								"server/discover",
								[
									discovery({
										extensions: { [extensionId]: { serverMode: "wrong" }, "com.untrusted/other": {} },
									}),
								],
							],
						]),
					),
				extensionRuntime: runtime,
			},
		);
		expect(connection.capabilities.extensions).toEqual({
			[extensionId]: { serverMode: "wrong" },
			"com.untrusted/other": {},
		});
		expect(connection.extensions?.size).toBe(0);
	});

	it("rejects an unknown extension result type on a connection without a negotiated provider", async () => {
		const connection = createModernMockConnection(
			{ tools: {} },
			createMockTransport(new Map([["tools/call", [{ resultType: "com.untrusted/deferred", ticket: "job-1" }]]])),
		);

		await expect(
			completeMCPRequest(connection, "tools/call", { name: "test", arguments: {} }, undefined),
		).rejects.toThrow('modern resultType must be "complete" or "input_required"');
	});
	it("deeply freezes extension definitions and rejects post-registration mutation", () => {
		const eras: ("modern" | "legacy")[] = ["modern"];
		const resultSpec = {
			method: "tools/call",
			resultType: "com.example/custom-result",
			validate: () => undefined,
		};
		const hooks = {
			onNotification: () => {},
		};
		const mutableDef: MCPExtensionDefinition = {
			id: "com.example/mutable",
			eras,
			clientSettings: () => ({ ok: true }),
			parseServerSettings: s => s,
			resultTypes: [resultSpec],
			hooks,
		};

		const registry = MCPExtensionRegistry.create([mutableDef]);
		const registered = registry.get("com.example/mutable")!;

		expect(Object.isFrozen(registered)).toBe(true);
		expect(Object.isFrozen(registered.eras)).toBe(true);
		expect(Object.isFrozen(registered.resultTypes)).toBe(true);
		expect(Object.isFrozen(registered.resultTypes![0])).toBe(true);
		expect(Object.isFrozen(registered.hooks)).toBe(true);

		// Mutate original arrays/objects
		eras.push("legacy");
		resultSpec.method = "prompts/get";
		hooks.onNotification = () => {};

		// Registry snapshot must be untouched
		expect(registered.eras).toEqual(["modern"]);
		expect(registered.resultTypes![0].method).toBe("tools/call");
	});

	it("fails early on duplicate result contract registration across extensions", () => {
		const ext1: MCPExtensionDefinition = {
			id: "com.example/first",
			clientSettings: () => ({}),
			parseServerSettings: s => s,
			resultTypes: [
				{
					method: "tools/call",
					resultType: "com.example/shared-result",
					validate: () => undefined,
				},
			],
		};
		const ext2: MCPExtensionDefinition = {
			id: "com.example/second",
			clientSettings: () => ({}),
			parseServerSettings: s => s,
			resultTypes: [
				{
					method: "tools/call",
					resultType: "com.example/shared-result",
					validate: () => undefined,
				},
			],
		};

		expect(() => MCPExtensionRegistry.create([ext1, ext2])).toThrow(
			'Duplicate resultType registration for method "tools/call" and resultType "com.example/shared-result"',
		);
	});

	it("dispatches notifications deterministically using longest-match without insertion-order dependency", () => {
		const events: string[] = [];
		const parentExt: MCPExtensionDefinition = {
			id: "com.example/parent",
			clientSettings: () => ({}),
			parseServerSettings: s => s,
			hooks: {
				onNotification: (_conn, method) => events.push(`parent:${method}`),
			},
		};
		const childExt: MCPExtensionDefinition = {
			id: "com.example/parent/child",
			clientSettings: () => ({}),
			parseServerSettings: s => s,
			hooks: {
				onNotification: (_conn, method) => events.push(`child:${method}`),
			},
		};

		const registry = MCPExtensionRegistry.create([parentExt, childExt]);
		const runtime = createMCPExtensionRuntime(registry, {
			"com.example/parent": { enabled: true },
			"com.example/parent/child": { enabled: true },
		});

		// Connection Map with parent first
		const extensionsOrder1 = new Map<string, MCPNegotiatedExtensionState>([
			["com.example/parent", { id: "com.example/parent", serverSettings: undefined, clientSettings: {} }],
			[
				"com.example/parent/child",
				{ id: "com.example/parent/child", serverSettings: undefined, clientSettings: {} },
			],
		]);
		const conn1 = {
			...createModernMockConnection({}, createMockTransport(new Map<string, unknown[]>())),
			extensions: extensionsOrder1,
		};

		// Connection Map with child first
		const extensionsOrder2 = new Map<string, MCPNegotiatedExtensionState>([
			[
				"com.example/parent/child",
				{ id: "com.example/parent/child", serverSettings: undefined, clientSettings: {} },
			],
			["com.example/parent", { id: "com.example/parent", serverSettings: undefined, clientSettings: {} }],
		]);
		const conn2 = {
			...createModernMockConnection({}, createMockTransport(new Map<string, unknown[]>())),
			extensions: extensionsOrder2,
		};
		// Dispatch for sub-namespace method MUST hit child (longest match) regardless of insertion order
		expect(runtime.onNotification(conn1, "com.example/parent/child/notify", {})).toBe(true);
		expect(events).toEqual(["child:com.example/parent/child/notify"]);
		events.length = 0;

		expect(runtime.onNotification(conn2, "com.example/parent/child/notify", {})).toBe(true);
		expect(events).toEqual(["child:com.example/parent/child/notify"]);
		events.length = 0;

		// Dispatch for parent-only namespace method MUST hit parent
		expect(runtime.onNotification(conn1, "com.example/parent/other", {})).toBe(true);
		expect(events).toEqual(["parent:com.example/parent/other"]);
	});
	it("validates custom resultTypes in completeMCPRequest via negotiated extension runtime", async () => {
		const registry = MCPExtensionRegistry.create([provider()]);
		const runtime = createMCPExtensionRuntime(registry, {
			[extensionId]: { enabled: true },
		});

		const validTransport = createMockTransport(
			new Map([
				["server/discover", [discovery({ extensions: { [extensionId]: { serverMode: "active" } } })]],
				["tools/call", [{ resultType: "com.example/deferred", ticket: "job-42" }]],
			]),
		);

		const connection = await connectToServer(
			"custom-result-valid",
			{ type: "stdio", command: "server" },
			{ transportFactory: async () => validTransport, extensionRuntime: runtime },
		);

		const result = await completeMCPRequest<Record<string, unknown>>(
			connection,
			"tools/call",
			{ name: "test", arguments: {} },
			undefined,
		);
		expect(result).toEqual({ resultType: "com.example/deferred", ticket: "job-42" });

		const invalidTransport = createMockTransport(
			new Map([
				["server/discover", [discovery({ extensions: { [extensionId]: { serverMode: "active" } } })]],
				["tools/call", [{ resultType: "com.example/deferred", ticket: 123 }]],
			]),
		);

		const invalidConnection = await connectToServer(
			"custom-result-invalid",
			{ type: "stdio", command: "server" },
			{ transportFactory: async () => invalidTransport, extensionRuntime: runtime },
		);

		await expect(
			completeMCPRequest(invalidConnection, "tools/call", { name: "test", arguments: {} }, undefined),
		).rejects.toThrow('invalid extension resultType "com.example/deferred": ticket must be a string');
	});
});
