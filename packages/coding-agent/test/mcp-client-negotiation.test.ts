import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	callTool,
	connectToServer,
	getConnectionProtocol,
	listTools,
} from "@pk-nerdsaver-ai/pi-coding-agent/mcp/client";
import {
	buildModernRequestParams,
	extractMCPToolHeaderValues,
	MCP_CLIENT_INFO,
	MCP_MODERN_PROTOCOL_VERSION,
	type MCPDiscoverResult,
	type MCPInitializeResult,
	type MCPToolHeaderMetadata,
	type MCPTransportProtocolConfiguration,
} from "@pk-nerdsaver-ai/pi-coding-agent/mcp/types";
import { createMockTransport } from "./mcp-test-utils";

type CapturedRequest = {
	method: string;
	params: Record<string, unknown> | undefined;
};

function modernDiscovery(capabilities: MCPDiscoverResult["capabilities"] = {}): MCPDiscoverResult {
	return {
		resultType: "complete",
		supportedVersions: [MCP_MODERN_PROTOCOL_VERSION],
		capabilities,
		_meta: {
			"io.modelcontextprotocol/serverInfo": {
				name: "modern-server",
				version: "2.0.0",
			},
		},
		ttlMs: 60_000,
		cacheScope: "public",
	};
}

function legacyInitialize(): MCPInitializeResult {
	return {
		protocolVersion: "2025-03-26",
		capabilities: { tools: {} },
		serverInfo: { name: "legacy-server", version: "1.0.0" },
	};
}

function slowStdioDiscoveryServer(tracePath: string): string {
	return `
		const { appendFileSync } = require("node:fs");
		const tracePath = ${JSON.stringify(tracePath)};
		let buffered = "";
		const writeResponse = (id, result) => {
			process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\\n");
		};
		process.stdin.setEncoding("utf8");
		process.stdin.on("data", chunk => {
			buffered += chunk;
			const lines = buffered.split("\\n");
			buffered = lines.pop() ?? "";
			for (const line of lines) {
				if (!line) continue;
				const request = JSON.parse(line);
				appendFileSync(tracePath, process.pid + ":" + request.method + "\\n");
				if (request.method === "server/discover") {
					setTimeout(
						() =>
							writeResponse(request.id, {
								resultType: "complete",
								supportedVersions: ["2026-07-28"],
								capabilities: {},
							}),
						4_000,
					);
				} else if (request.method === "initialize") {
					writeResponse(request.id, {
						protocolVersion: "2025-03-26",
						capabilities: { tools: {} },
						serverInfo: { name: "legacy-server", version: "1.0.0" },
					});
				}
			}
		});
	`;
}

function exitingStdioProbeServer(tracePath: string, fallbackMarkerPath: string): string {
	return `
		const { appendFileSync, existsSync, writeFileSync } = require("node:fs");
		const tracePath = ${JSON.stringify(tracePath)};
		const fallbackMarkerPath = ${JSON.stringify(fallbackMarkerPath)};
		const fallbackProcess = existsSync(fallbackMarkerPath);
		let buffered = "";
		const writeResponse = (id, result, error) => {
			process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, ...(error ? { error } : { result }) }) + "\\n");
		};
		process.stdin.setEncoding("utf8");
		process.stdin.on("data", chunk => {
			buffered += chunk;
			const lines = buffered.split("\\n");
			buffered = lines.pop() ?? "";
			for (const line of lines) {
				if (!line) continue;
				const request = JSON.parse(line);
				appendFileSync(tracePath, process.pid + ":" + request.method + "\\n");
				if (!fallbackProcess) {
					writeFileSync(fallbackMarkerPath, "legacy");
					process.exit(0);
				} else if (request.method === "server/discover") {
					writeResponse(request.id, undefined, { code: -32601, message: "Method not found" });
				} else if (request.method === "initialize") {
					writeResponse(request.id, {
						protocolVersion: "2025-03-26",
						capabilities: { tools: {} },
						serverInfo: { name: "legacy-server", version: "1.0.0" },
					});
				}
			}
		});
	`;
}

describe("MCP dual-era connection negotiation", () => {
	it("snapshots required modern metadata instead of retaining caller references", () => {
		const clientCapabilities = {
			extensions: {
				"com.example/settings": {
					nested: { enabled: true },
				},
			},
		};
		const clientInfo = { name: "test-client", version: "1.0.0" };
		const request = buildModernRequestParams(
			{},
			{ version: MCP_MODERN_PROTOCOL_VERSION, clientCapabilities },
			undefined,
			clientInfo,
		);

		clientCapabilities.extensions["com.example/settings"]!.nested.enabled = false;
		clientInfo.name = "mutated-client";

		expect(request._meta["io.modelcontextprotocol/clientCapabilities"]).toEqual({
			extensions: {
				"com.example/settings": {
					nested: { enabled: true },
				},
			},
		});
		expect(request._meta["io.modelcontextprotocol/clientInfo"]).toEqual({
			name: "test-client",
			version: "1.0.0",
		});
	});
	it("uses metadata-bearing server/discover first for a modern server without initialize", async () => {
		const requests: CapturedRequest[] = [];
		const transport = createMockTransport(
			new Map([["server/discover", [modernDiscovery({ tools: {} })]]]),
			(method, params) => requests.push({ method, params }),
		);

		const connection = await connectToServer(
			"modern",
			{ type: "stdio", command: "modern-server" },
			{ transportFactory: async () => transport },
		);

		expect(requests.map(request => request.method)).toEqual(["server/discover"]);
		expect(requests[0]?.params).toEqual({
			_meta: {
				"io.modelcontextprotocol/protocolVersion": MCP_MODERN_PROTOCOL_VERSION,
				"io.modelcontextprotocol/clientCapabilities": {},
				"io.modelcontextprotocol/clientInfo": MCP_CLIENT_INFO,
			},
		});
		expect(getConnectionProtocol(connection)).toEqual({
			era: "modern",
			version: MCP_MODERN_PROTOCOL_VERSION,
			supportedVersions: [MCP_MODERN_PROTOCOL_VERSION],
			clientCapabilities: {},
			capabilities: { tools: { listChanged: false } },
			serverInfo: { name: "modern-server", version: "2.0.0" },
		});
		expect(transport.onRequest).toBeUndefined();
		expect(connection.resultHints?.discovery).toMatchObject({
			era: "modern",
			ttlMs: 60_000,
			cacheScope: "public",
			scopeConsistent: true,
		});
	});

	it("rejects modern discovery without required cache hints instead of downgrading", async () => {
		const requests: string[] = [];
		const transport = createMockTransport(
			new Map([
				[
					"server/discover",
					[
						{
							resultType: "complete",
							supportedVersions: [MCP_MODERN_PROTOCOL_VERSION],
							capabilities: {},
						},
					],
				],
			]),
			method => requests.push(method),
		);

		await expect(
			connectToServer(
				"missing-cache-hints",
				{ type: "stdio", command: "modern-server" },
				{ transportFactory: async () => transport },
			),
		).rejects.toThrow("ttlMs");
		expect(requests).toEqual(["server/discover"]);
	});

	it("requires a configured HTTP transport to acknowledge connected modern settings", async () => {
		const transport = createMockTransport(new Map([["server/discover", [modernDiscovery({ tools: {} })]]]));
		transport.configureProtocol = () => {};

		await expect(
			connectToServer(
				"unacknowledged-http",
				{ type: "http", url: "https://modern.example.test/mcp" },
				{ transportFactory: async () => transport },
			),
		).rejects.toThrow("did not acknowledge the connected modern protocol settings");
	});

	it("accepts a configured HTTP transport after it acknowledges modern settings", async () => {
		const transport = createMockTransport(new Map([["server/discover", [modernDiscovery({ tools: {} })]]]));
		let appliedConfiguration: MCPTransportProtocolConfiguration | undefined;
		transport.configureProtocol = configuration => {
			appliedConfiguration = configuration;
		};
		transport.getProtocolConfiguration = () => appliedConfiguration;

		const connection = await connectToServer(
			"acknowledged-http",
			{ type: "http", url: "https://modern.example.test/mcp" },
			{ transportFactory: async () => transport },
		);

		expect(connection.protocol?.era).toBe("modern");
		expect(appliedConfiguration).toMatchObject({
			era: "modern",
			phase: "connected",
			version: MCP_MODERN_PROTOCOL_VERSION,
		});
	});

	it("retries server/discover after recognized -32022 using the mutual modern version", async () => {
		const requests: CapturedRequest[] = [];
		const unsupportedVersion = Object.assign(new Error("Unsupported protocol version"), {
			code: -32022,
			data: {
				supported: [MCP_MODERN_PROTOCOL_VERSION],
				requested: "2027-01-01",
			},
		});
		const transport = createMockTransport(
			new Map([["server/discover", [unsupportedVersion, modernDiscovery()]]]),
			(method, params) => requests.push({ method, params }),
		);

		const connection = await connectToServer(
			"version-retry",
			{ type: "stdio", command: "modern-server" },
			{ transportFactory: async () => transport },
		);

		expect(requests.map(request => request.method)).toEqual(["server/discover", "server/discover"]);
		for (const request of requests) {
			expect(request.params?._meta).toMatchObject({
				"io.modelcontextprotocol/protocolVersion": MCP_MODERN_PROTOCOL_VERSION,
			});
		}
		expect(connection.protocol?.era).toBe("modern");
	});

	it("falls back to legacy initialization after an unrecognized stdio probe failure", async () => {
		const requests: CapturedRequest[] = [];
		const notifications: string[] = [];
		const transport = createMockTransport(
			new Map([
				["server/discover", [new Error("MCP error -32601: Method not found")]],
				["initialize", [legacyInitialize()]],
			]),
			(method, params) => requests.push({ method, params }),
			method => notifications.push(method),
		);

		const connection = await connectToServer(
			"legacy-fallback",
			{ type: "stdio", command: "legacy-server" },
			{ transportFactory: async () => transport },
		);

		expect(requests.map(request => request.method)).toEqual(["server/discover", "initialize"]);
		expect(connection.protocol).toEqual({
			era: "legacy",
			version: "2025-03-26",
			capabilities: { tools: { listChanged: false } },
		});
		expect(notifications).toEqual(["notifications/initialized"]);
	});

	it("replaces a slow stdio probe transport before legacy frames are initialized", async () => {
		const slowRequests: CapturedRequest[] = [];
		const legacyRequests: CapturedRequest[] = [];
		const slowTransport = createMockTransport(
			new Map([["server/discover", [new Promise<never>(() => {})]]]),
			(method, params) => slowRequests.push({ method, params }),
		);
		let slowTransportCloseCalls = 0;
		slowTransport.close = async () => {
			slowTransportCloseCalls++;
		};
		const legacyTransport = createMockTransport(new Map([["initialize", [legacyInitialize()]]]), (method, params) =>
			legacyRequests.push({ method, params }),
		);
		let transportFactoryCalls = 0;

		const connection = await connectToServer(
			"legacy-timeout",
			{ type: "stdio", command: "legacy-server", timeout: 80 },
			{
				transportFactory: async () => {
					transportFactoryCalls++;
					return transportFactoryCalls === 1 ? slowTransport : legacyTransport;
				},
			},
		);

		expect(transportFactoryCalls).toBe(2);
		expect(slowTransportCloseCalls).toBe(1);
		expect(slowRequests.map(request => request.method)).toEqual(["server/discover"]);
		expect(legacyRequests.map(request => request.method)).toEqual(["initialize"]);
		expect(connection.transport).toBe(legacyTransport);
		expect(connection.protocol?.era).toBe("legacy");
	});

	it("uses a fresh stdio process for legacy frames after a framed slow modern probe", async () => {
		const traceDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "omp-mcp-slow-discover-"));
		const tracePath = path.join(traceDirectory, "frames.log");
		try {
			const connection = await connectToServer("framed-slow-legacy", {
				type: "stdio",
				command: process.execPath,
				args: ["-e", slowStdioDiscoveryServer(tracePath)],
				timeout: 2_000,
			});
			try {
				const frames = (await fs.readFile(tracePath, "utf8"))
					.trim()
					.split("\n")
					.map(frame => {
						const separator = frame.indexOf(":");
						return { processId: frame.slice(0, separator), method: frame.slice(separator + 1) };
					});

				expect(frames.slice(0, 2).map(frame => frame.method)).toEqual(["server/discover", "initialize"]);
				expect(frames[0]?.processId).not.toBe(frames[1]?.processId);
				expect(connection.protocol?.era).toBe("legacy");
			} finally {
				await connection.transport.close();
			}
		} finally {
			await fs.rm(traceDirectory, { recursive: true, force: true });
		}
	});

	it("recreates a disconnected stdio probe process before legacy initialization", async () => {
		const traceDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "omp-mcp-exited-discover-"));
		const tracePath = path.join(traceDirectory, "frames.log");
		const fallbackMarkerPath = path.join(traceDirectory, "fallback.marker");
		try {
			const connection = await connectToServer("framed-exited-legacy", {
				type: "stdio",
				command: process.execPath,
				args: ["-e", exitingStdioProbeServer(tracePath, fallbackMarkerPath)],
				timeout: 2_000,
			});
			try {
				const frames = (await fs.readFile(tracePath, "utf8"))
					.trim()
					.split("\n")
					.map(frame => {
						const separator = frame.indexOf(":");
						return { processId: frame.slice(0, separator), method: frame.slice(separator + 1) };
					});

				expect(frames.map(frame => frame.method)).toEqual(["server/discover", "initialize"]);
				expect(frames[0]?.processId).not.toBe(frames[1]?.processId);
				expect(connection.protocol?.era).toBe("legacy");
			} finally {
				await connection.transport.close();
			}
		} finally {
			await fs.rm(traceDirectory, { recursive: true, force: true });
		}
	});

	it("protects modern reserved metadata while retaining caller metadata on high-level calls", async () => {
		const requests: CapturedRequest[] = [];
		const transport = createMockTransport(
			new Map([
				["server/discover", [modernDiscovery({ tools: {} })]],
				["tools/call", [{ content: [{ type: "text", text: "ok" }] }]],
			]),
			(method, params) => requests.push({ method, params }),
		);
		const connection = await connectToServer(
			"modern-metadata",
			{ type: "stdio", command: "modern-server" },
			{ transportFactory: async () => transport },
		);

		await callTool(
			connection,
			"echo",
			{ value: "hello" },
			{
				metadata: {
					"com.example/trace": "trace-1",
					"io.modelcontextprotocol/protocolVersion": "override-attempt",
					"io.modelcontextprotocol/clientCapabilities": { roots: {} },
					"io.modelcontextprotocol/clientInfo": { name: "override", version: "0" },
				},
			},
		);

		expect(requests[1]?.params).toEqual({
			name: "echo",
			arguments: { value: "hello" },
			_meta: {
				"com.example/trace": "trace-1",
				"io.modelcontextprotocol/protocolVersion": MCP_MODERN_PROTOCOL_VERSION,
				"io.modelcontextprotocol/clientCapabilities": {},
				"io.modelcontextprotocol/clientInfo": MCP_CLIENT_INFO,
			},
		});
	});

	it("validates modern HTTP x-mcp-header annotations and registers normalized extraction metadata", async () => {
		const registeredSnapshots: MCPToolHeaderMetadata[][] = [];
		const transport = createMockTransport(
			new Map([
				["server/discover", [modernDiscovery({ tools: {} })]],
				[
					"tools/list",
					[
						{
							resultType: "complete",
							ttlMs: 60_000,
							cacheScope: "public",
							tools: [
								{
									name: "valid-header",
									inputSchema: {
										type: "object",
										properties: {
											auth: {
												type: "object",
												properties: {
													region: { type: "string", "x-mcp-header": "Region" },
												},
											},
										},
									},
								},
								{
									name: "invalid-header",
									inputSchema: {
										type: "object",
										properties: {
											tenant: { type: "string", "x-mcp-header": "Bad Header" },
										},
									},
								},
							],
						},
					],
				],
			]),
		);
		transport.registerToolHeaderMetadata = metadata => {
			registeredSnapshots.push([...metadata]);
		};
		const connection = await connectToServer(
			"header-server",
			{ type: "http", url: "https://modern.example.test/mcp" },
			{ transportFactory: async () => transport },
		);

		const tools = await listTools(connection);

		expect(tools.map(tool => tool.name)).toEqual(["valid-header"]);
		expect(registeredSnapshots).toEqual([
			[
				{
					toolName: "valid-header",
					parameters: [{ path: ["auth", "region"], headerName: "Region", valueType: "string" }],
				},
			],
		]);
		const registered = registeredSnapshots[0]?.[0];
		if (!registered) throw new Error("Expected validated header metadata");
		expect(extractMCPToolHeaderValues(registered, { auth: { region: "é" } })).toEqual([
			{ name: "Mcp-Param-Region", value: "=?base64?w6k=?=", path: ["auth", "region"] },
		]);
	});

	it("preserves the legacy initialize and initialized lifecycle for explicit SSE", async () => {
		const requests: CapturedRequest[] = [];
		const notifications: string[] = [];
		const transport = createMockTransport(
			new Map([["initialize", [legacyInitialize()]]]),
			(method, params) => requests.push({ method, params }),
			method => notifications.push(method),
		);

		const connection = await connectToServer(
			"explicit-legacy",
			{ type: "sse", url: "https://legacy.example.test/sse" },
			{ transportFactory: async () => transport },
		);

		expect(requests).toEqual([
			{
				method: "initialize",
				params: {
					protocolVersion: "2025-03-26",
					capabilities: { roots: { listChanged: false } },
					clientInfo: MCP_CLIENT_INFO,
				},
			},
		]);
		expect(notifications).toEqual(["notifications/initialized"]);
		expect(connection.protocol?.era).toBe("legacy");
		expect(transport.onRequest).toBeDefined();
		expect(await transport.onRequest?.("ping", {})).toEqual({});
	});
	it("fails negotiation with MCPModernProtocolNegotiationError when server/discover omits the requested version from supportedVersions", async () => {
		const transport = createMockTransport(
			new Map([
				[
					"server/discover",
					[
						{
							resultType: "complete",
							supportedVersions: ["2025-03-26"],
							capabilities: {},
							ttlMs: 60_000,
							cacheScope: "public",
						},
					],
				],
			]),
		);

		await expect(
			connectToServer(
				"missing-version-server",
				{ type: "stdio", command: "server" },
				{ transportFactory: async () => transport },
			),
		).rejects.toThrow("supportedVersions");
	});

	it("retains legacy compatibility behavior and non-modern cache semantics for protocol-less externally constructed connections", async () => {
		const transport = createMockTransport(
			new Map([
				[
					"tools/list",
					[
						{
							tools: [{ name: "legacy-tool", inputSchema: { type: "object" } }],
						},
					],
				],
			]),
		);

		const connection = {
			name: "protocol-less-connection",
			config: { type: "stdio", command: "server" },
			transport,
			serverInfo: { name: "custom", version: "1.0.0" },
			capabilities: { tools: {} },
		} as unknown as Parameters<typeof listTools>[0];

		const tools = await listTools(connection);
		expect(tools.map(t => t.name)).toEqual(["legacy-tool"]);
	});
});
