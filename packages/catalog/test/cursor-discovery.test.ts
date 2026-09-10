import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as http2 from "node:http2";
import type * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { buildModel } from "../src/build";
// Import from source, not the package specifier: the workspace `node_modules`
// copy resolves to the primary checkout, not this worktree.
import { fetchCursorUsableModels } from "../src/discovery/cursor";
import {
	type AvailableModelsRequest,
	AvailableModelsRequestSchema,
	AvailableModelsResponse_ModelDetailsSchema,
	AvailableModelsResponse_ModelVariantConfigSchema,
	AvailableModelsResponseSchema,
	GetDefaultModelForCliResponseSchema,
	GetUsableModelsResponseSchema,
	ModelDetailsSchema,
	ModelParameterDefinition_BooleanParameterDefinition_BooleanParameterValueSchema,
	ModelParameterDefinition_BooleanParameterDefinitionSchema,
	ModelParameterDefinition_EnumParameterDefinition_EnumParameterValueSchema,
	ModelParameterDefinition_EnumParameterDefinitionSchema,
	ModelParameterDefinition_ModelParameterTypeSchema,
	ModelParameterDefinitionSchema,
	ModelParameterValueSchema,
	ModelVendorId,
} from "../src/discovery/cursor-proto";
import { create, fromBinary, toBinary } from "../src/discovery/protobuf";
import { collapseBuiltVariants } from "../src/compat/collapse";
import { resolveProviderModels } from "../src/model-manager";
import { cursorModelManagerOptions } from "../src/provider-models/special";
import type { ModelSpec } from "../src/types";

const FIXTURE_MODEL_IDS = [
	// Reference-less ids from families whose native catalogs are multimodal.
	"claude-opus-4-8-99999999",
	"gpt-5.5-codex-20991231",
	"gemini-4-pro-exp",
	// Cursor-only families verified to accept direct image attachments.
	"kimi-k3-high",
	"kimi-k3-low",
	"kimi-k3-max",
	"cursor-grok-4.5",
	"cursor-grok-4.5-fast",
	"cursor-grok-4.6",
	"cursor-grok-4.6-fast",
	"composer-2.5",
	"composer-2.5-fast",
	// Similar but unverified ids must not inherit image routing.
	"composer-3",
	"composer-2.50",
	"cursor-grok-5",
	"grok-code-fast-2",
	"k3-256k",
	// Versioned Cursor Grok siblings: the id marks them reasoning.
	"cursor-grok-4.5-high",
	"cursor-grok-4.6-xhigh",
	// Bundled-reference ids: the reference stays authoritative.
	"claude-4.5-opus-high",
	"claude-4.6-opus-high",
	"composer-1",
];

let server: http2.Http2Server;
let baseUrl: string;

beforeAll(async () => {
	const response = create(GetUsableModelsResponseSchema, {
		models: FIXTURE_MODEL_IDS.map(modelId => create(ModelDetailsSchema, { modelId })),
	});
	const payload = Buffer.from(toBinary(GetUsableModelsResponseSchema, response));

	server = http2.createServer();
	server.on("stream", (stream: http2.ServerHttp2Stream, headers: http2.IncomingHttpHeaders) => {
		stream.on("data", () => {});
		stream.on("end", () => {
			if (headers[":path"] !== "/agent.v1.AgentService/GetUsableModels") {
				stream.respond({ ":status": 404 });
				stream.end();
				return;
			}
			stream.respond({ ":status": 200, "content-type": "application/proto" });
			stream.end(payload);
		});
	});
	await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	if (!address || typeof address === "string") {
		throw new Error("expected http2 fixture server to bind a tcp port");
	}
	baseUrl = `http://127.0.0.1:${address.port}`;
});

afterAll(() => {
	server?.close();
});

async function discover(): Promise<Map<string, ModelSpec<"cursor-agent">>> {
	const models = await fetchCursorUsableModels({ apiKey: "test-key", baseUrl });
	expect(models).not.toBeNull();
	return new Map((models ?? []).map(model => [model.id, model]));
}

describe("cursor discovery input modalities (issue #4726)", () => {
	it("classifies reference-less multimodal-family models as text+image", async () => {
		const byId = await discover();
		expect(byId.get("claude-opus-4-8-99999999")?.input).toEqual(["text", "image"]);
		expect(byId.get("gpt-5.5-codex-20991231")?.input).toEqual(["text", "image"]);
		expect(byId.get("gemini-4-pro-exp")?.input).toEqual(["text", "image"]);
	});

	it("keeps unverified Cursor-only families text-only", async () => {
		const byId = await discover();
		expect(byId.get("composer-3")?.input).toEqual(["text"]);
		expect(byId.get("composer-2.50")?.input).toEqual(["text"]);
		expect(byId.get("cursor-grok-5")?.input).toEqual(["text"]);
		expect(byId.get("grok-code-fast-2")?.input).toEqual(["text"]);
		expect(byId.get("k3-256k")?.input).toEqual(["text"]);
	});

	it("recognizes reference-less Kimi K3 effort variants as reasoning models", async () => {
		const byId = await discover();
		expect(byId.get("kimi-k3-high")?.reasoning).toBe(true);
		expect(byId.get("kimi-k3-low")?.reasoning).toBe(true);
		expect(byId.get("kimi-k3-max")?.reasoning).toBe(true);
	});

	it("routes verified Cursor-only model variants as text+image", async () => {
		const byId = await discover();
		const verifiedIds = [
			"kimi-k3-high",
			"kimi-k3-low",
			"kimi-k3-max",
			"cursor-grok-4.5",
			"cursor-grok-4.5-fast",
			"cursor-grok-4.6",
			"cursor-grok-4.6-fast",
			"composer-2.5",
			"composer-2.5-fast",
		];
		for (const id of verifiedIds) {
			const spec = byId.get(id);
			expect(spec).toBeDefined();
			if (spec) expect(buildModel(spec).input).toEqual(["text", "image"]);
		}
	});

	it("marks versioned Cursor Grok ids as reasoning despite reasoning:false references (issue #8803)", async () => {
		const byId = await discover();
		expect(byId.get("cursor-grok-4.5-high")?.reasoning).toBe(true);
		expect(byId.get("cursor-grok-4.6-xhigh")?.reasoning).toBe(true);
		// grok-code-* coding models lack the version digit and stay non-reasoning.
		expect(byId.get("grok-code-fast-2")?.reasoning).toBe(false);
	});

	it("preserves fallback defaults for reference-less models", async () => {
		const byId = await discover();
		const spec = byId.get("claude-opus-4-8-99999999");
		expect(spec?.provider).toBe("cursor");
		expect(spec?.api).toBe("cursor-agent");
		expect(spec?.contextWindow).toBe(200_000);
		expect(spec?.maxTokens).toBe(64_000);
		expect(spec?.cost).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
	});
});

const servers = new Set<http2.Http2Server>();
const tempDirs = new Set<string>();

afterEach(async () => {
	await Promise.all(
		[...servers].map(srv => {
			const { promise, resolve, reject } = Promise.withResolvers<void>();
			srv.close(error => {
				if (error) {
					reject(error);
					return;
				}
				resolve();
			});
			return promise;
		}),
	);
	await Promise.all([...tempDirs].map(dir => fs.rm(dir, { recursive: true, force: true })));
	servers.clear();
	tempDirs.clear();
});

function requireTcpAddress(address: string | net.AddressInfo | null): net.AddressInfo {
	if (!address || typeof address === "string") {
		throw new Error("HTTP/2 test server did not bind to a TCP address");
	}
	return address;
}

function startCursorDiscoveryServer(body: Uint8Array): Promise<string> {
	const { promise, resolve, reject } = Promise.withResolvers<string>();
	const srv = http2.createServer();
	servers.add(srv);
	srv.once("error", reject);
	srv.on("stream", (stream: http2.ServerHttp2Stream) => {
		stream.respond({ ":status": 200, "content-type": "application/proto" });
		stream.end(Buffer.from(body));
	});
	srv.listen(0, "127.0.0.1", () => {
		resolve(`http://127.0.0.1:${requireTcpAddress(srv.address()).port}`);
	});
	return promise;
}

function startCursorDiscoveryRpcServer(responses: Readonly<Record<string, Uint8Array>>): Promise<string> {
	const { promise, resolve, reject } = Promise.withResolvers<string>();
	const srv = http2.createServer();
	servers.add(srv);
	srv.once("error", reject);
	srv.on("stream", (stream: http2.ServerHttp2Stream, headers: http2.IncomingHttpHeaders) => {
		stream.on("data", () => {});
		stream.on("end", () => {
			const body = responses[String(headers[":path"])];
			if (!body) {
				stream.respond({ ":status": 404 });
				stream.end();
				return;
			}
			stream.respond({ ":status": 200, "content-type": "application/proto" });
			stream.end(Buffer.from(body));
		});
	});
	srv.listen(0, "127.0.0.1", () => {
		resolve(`http://127.0.0.1:${requireTcpAddress(srv.address()).port}`);
	});
	return promise;
}

async function createTempCachePath(): Promise<string> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-cursor-cache-"));
	tempDirs.add(dir);
	return path.join(dir, "models.db");
}

function cursorModelSpec(id: string): ModelSpec<"cursor-agent"> {
	return {
		id,
		name: id,
		api: "cursor-agent",
		provider: "cursor",
		baseUrl: "https://api2.cursor.sh",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200_000,
		maxTokens: 64_000,
	};
}

describe("fetchCursorUsableModels", () => {
	it("joins rich model metadata, account defaults, routes, and ZDR eligibility", async () => {
		const effortValues = [
			create(ModelParameterDefinition_EnumParameterDefinition_EnumParameterValueSchema, { value: "low" }),
			create(ModelParameterDefinition_EnumParameterDefinition_EnumParameterValueSchema, { value: "high" }),
			create(ModelParameterDefinition_EnumParameterDefinition_EnumParameterValueSchema, { value: "medium" }),
			create(ModelParameterDefinition_EnumParameterDefinition_EnumParameterValueSchema, { value: "max" }),
			create(ModelParameterDefinition_EnumParameterDefinition_EnumParameterValueSchema, {
				value: "xhigh",
				blockedByAdminAllowlist: true,
			}),
		];
		const effortDefinition = create(ModelParameterDefinitionSchema, {
			id: "thinking_effort",
			name: "Thinking effort",
			parameterType: create(ModelParameterDefinition_ModelParameterTypeSchema, {
				enumParameter: create(ModelParameterDefinition_EnumParameterDefinitionSchema, {
					values: effortValues,
				}),
			}),
		});
		const variant = (
			id: string,
			effort: string,
			isMaxMode: boolean,
			isDefaultNonMaxConfig = false,
			thinking: boolean | undefined = undefined,
			context = "300k",
		) =>
			create(AvailableModelsResponse_ModelVariantConfigSchema, {
				legacySlug: id,
				displayName: effort,
				isMaxMode,
				isDefaultNonMaxConfig,
				parameterValues: [
					create(ModelParameterValueSchema, {
						id: "thinking_effort",
						value: effort,
					}),
					...(thinking === undefined
						? []
						: [
								create(ModelParameterValueSchema, {
									id: "thinking",
									value: String(thinking),
								}),
							]),
					create(ModelParameterValueSchema, {
						id: "context",
						value: context,
					}),
				],
			});
		const usable = create(GetUsableModelsResponseSchema, {
			models: [
				"claude-4.6-opus-low",
				"claude-4.6-opus-high",
				"claude-4.6-opus-max",
				"claude-4.6-opus-xhigh",
				"fable-retention",
				"legacy-only",
			].map(modelId => create(ModelDetailsSchema, { modelId })),
		});
		const available = create(AvailableModelsResponseSchema, {
			models: [
				create(AvailableModelsResponse_ModelDetailsSchema, {
					name: "claude-4.6-opus",
					defaultOn: true,
					supportsAgent: true,
					supportsThinking: true,
					supportsImages: true,
					supportsSandboxing: true,
					contextTokenLimit: 200_000,
					contextTokenLimitForMaxMode: 1_000_000,
					price: 2.5,
					requiresDataRetention: false,
					legacySlugs: [
						"claude-4.6-opus-low",
						"claude-4.6-opus-high",
						"claude-4.6-opus-max",
						"claude-4.6-opus-xhigh",
					],
					parameterDefinitions: [effortDefinition],
					variants: [
						variant("claude-4.6-opus-low", "low", false, true, false),
						variant("claude-4.6-opus-high", "high", false, false, true),
						variant("claude-4.6-opus-max", "max", true),
						variant("claude-4.6-opus-medium", "medium", false),
						variant("claude-4.6-opus-high", "max", true),
						variant("claude-4.6-opus-xhigh", "xhigh", false),
						variant("claude-4.6-opus-high", "high", true, false, true, "1m"),
					],
				}),
				create(AvailableModelsResponse_ModelDetailsSchema, {
					name: "fable",
					supportsAgent: true,
					requiresDataRetention: true,
					legacySlugs: ["fable-retention"],
				}),
			],
		});
		const providerDefault = create(GetDefaultModelForCliResponseSchema, {
			model: create(ModelDetailsSchema, { modelId: "claude-4.6-opus-low" }),
		});
		const richBaseUrl = await startCursorDiscoveryRpcServer({
			"/agent.v1.AgentService/GetUsableModels": toBinary(GetUsableModelsResponseSchema, usable),
			"/aiserver.v1.AiService/AvailableModels": toBinary(AvailableModelsResponseSchema, available),
			"/agent.v1.AgentService/GetDefaultModelForCli": toBinary(GetDefaultModelForCliResponseSchema, providerDefault),
		});

		const pricing = [
			"| Model | Provider | Input | Cache write | Cache read | Output | Notes |",
			"| --- | --- | --- | --- | --- | --- | --- |",
			"| Claude 4.6 Opus | Anthropic | $5 | $6.25 | $0.5 | $25 | - |",
		].join("\n");
		const models = await fetchCursorUsableModels({
			apiKey: "account-token",
			baseUrl: richBaseUrl,
			pricingUrl: `data:text/markdown,${encodeURIComponent(pricing)}`,
			timeoutMs: 1_000,
		});

		expect(models?.map(model => model.id)).toEqual([
			"claude-4.6-opus",
			"claude-4.6-opus-1m",
			"claude-4.6-opus-max-mode",
			"legacy-only",
		]);
		const lane = models?.find(model => model.id === "claude-4.6-opus");
		expect(lane).toEqual(
			expect.objectContaining({
				requestModelId: "claude-4.6-opus-low",
				reasoning: true,
				input: ["text", "image"],
				supportsTools: true,
				contextWindow: 300_000,
				cursorPrice: 2.5,
				cursorRequiresDataRetention: false,
				cursorSupportsSandboxing: true,
				isProviderDefault: true,
				thinking: {
					mode: "effort",
					efforts: ["high"],
					effortRouting: {
						off: "claude-4.6-opus-low",
						high: "claude-4.6-opus-high",
					},
				},
			}),
		);
		expect(lane?.cost).toEqual({ input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 });
		expect(lane?.cursorModelRoutes).toEqual({
			"claude-4.6-opus-low": {
				modelId: "claude-4.6-opus",
				parameters: [
					{ id: "thinking_effort", value: "low" },
					{ id: "thinking", value: "false" },
					{ id: "context", value: "300k" },
				],
				maxMode: false,
			},
			"claude-4.6-opus-high": {
				modelId: "claude-4.6-opus",
				parameters: [
					{ id: "thinking_effort", value: "high" },
					{ id: "thinking", value: "true" },
					{ id: "context", value: "300k" },
				],
				maxMode: false,
			},
		});
		const longContextLane = models?.find(model => model.id === "claude-4.6-opus-1m");
		expect(longContextLane).toEqual(
			expect.objectContaining({
				contextWindow: 1_000_000,
				thinking: expect.objectContaining({
					efforts: ["high"],
					requiresEffort: true,
					effortRouting: { high: "claude-4.6-opus-high" },
				}),
			}),
		);
		const maxLane = models?.find(model => model.id === "claude-4.6-opus-max-mode");
		expect(maxLane).toEqual(
			expect.objectContaining({
				contextWindow: 300_000,
				reasoning: true,
				thinking: expect.objectContaining({
					efforts: ["max"],
					requiresEffort: true,
					effortRouting: { max: "claude-4.6-opus-max" },
				}),
			}),
		);
		expect(models?.some(model => model.id === "claude-4.6-opus-medium")).toBe(false);
		expect(models?.some(model => model.id === "claude-4.6-opus-xhigh")).toBe(false);
		expect(models?.some(model => model.id === "fable-retention")).toBe(false);

		const collapsed = collapseBuiltVariants((models ?? []).map(model => buildModel(model)));
		const rebuiltLane = collapsed.find(model => model.id === "claude-4.6-opus");
		expect(rebuiltLane?.cursorPrice).toBe(2.5);
		expect(rebuiltLane?.input).toEqual(["text", "image"]);
		expect(rebuiltLane?.supportsTools).toBe(true);
		expect(rebuiltLane?.cursorModelRoutes).toEqual(lane?.cursorModelRoutes);
		expect(rebuiltLane?.thinking?.effortRouting).toEqual(lane?.thinking?.effortRouting);
		expect(rebuiltLane?.isProviderDefault).toBe(true);
	});

	it("prices rich variants from Cursor's live document and declared multipliers", async () => {
		const fastDefinition = create(ModelParameterDefinitionSchema, {
			id: "fast",
			name: "Fast",
			markdownTooltip: "2x more expensive, but significantly faster.",
			parameterType: create(ModelParameterDefinition_ModelParameterTypeSchema, {
				booleanParameter: create(ModelParameterDefinition_BooleanParameterDefinitionSchema, {
					values: [
						create(ModelParameterDefinition_BooleanParameterDefinition_BooleanParameterValueSchema, {
							value: "false",
						}),
						create(ModelParameterDefinition_BooleanParameterDefinition_BooleanParameterValueSchema, {
							value: "true",
							increasesModelCost: true,
						}),
					],
				}),
			}),
		});
		const fastVariant = (id: string, fast: boolean) =>
			create(AvailableModelsResponse_ModelVariantConfigSchema, {
				legacySlug: id,
				parameterValues: [create(ModelParameterValueSchema, { id: "fast", value: String(fast) })],
			});
		const usable = create(GetUsableModelsResponseSchema, {
			models: ["composer-2.5-fast", "composer-2.5", "claude-opus-4-8", "claude-opus-4-8-fast", "gpt-5.1"].map(
				modelId => create(ModelDetailsSchema, { modelId }),
			),
		});
		const available = create(AvailableModelsResponseSchema, {
			models: [
				create(AvailableModelsResponse_ModelDetailsSchema, {
					name: "composer-2.5",
					clientDisplayName: "Composer 2.5",
					supportsAgent: true,
					legacySlugs: ["composer-2.5-fast", "composer-2.5"],
					parameterDefinitions: [fastDefinition],
					variants: [fastVariant("composer-2.5-fast", true), fastVariant("composer-2.5", false)],
				}),
				create(AvailableModelsResponse_ModelDetailsSchema, {
					name: "claude-opus-4-8",
					clientDisplayName: "Claude Opus 4.8",
					supportsAgent: true,
					legacySlugs: ["claude-opus-4-8", "claude-opus-4-8-fast"],
					parameterDefinitions: [fastDefinition],
					variants: [fastVariant("claude-opus-4-8", false), fastVariant("claude-opus-4-8-fast", true)],
				}),
				create(AvailableModelsResponse_ModelDetailsSchema, {
					name: "gpt-5.1",
					clientDisplayName: "GPT-5.1",
					supportsAgent: true,
				}),
			],
		});
		const pricing = [
			"| Notes | Output | Provider | Cache read | Model | Cache write | Input |",
			"| --- | --- | --- | --- | --- | --- | --- |",
			"| - | $2.5 | Cursor | $0.2 | Composer 2.5 | - | $0.5 |",
			"| - | $15 | Cursor | $0.5 | Composer 2.5 (Fast) | - | $3 |",
			"| - | $25 | Anthropic | $0.5 | [Claude 4.8 Opus](https://cursor.example/opus) | $6.25 | $5 |",
		].join("\n");
		const pricingBaseUrl = await startCursorDiscoveryRpcServer({
			"/agent.v1.AgentService/GetUsableModels": toBinary(GetUsableModelsResponseSchema, usable),
			"/aiserver.v1.AiService/AvailableModels": toBinary(AvailableModelsResponseSchema, available),
		});

		const models = await fetchCursorUsableModels({
			apiKey: "account-token",
			baseUrl: pricingBaseUrl,
			pricingUrl: `data:text/markdown,${encodeURIComponent(pricing)}`,
			timeoutMs: 1_000,
		});
		const byId = new Map((models ?? []).map(model => [model.id, model]));

		expect(byId.get("composer-2.5")?.cost).toEqual({
			input: 3,
			output: 15,
			cacheRead: 0.5,
			cacheWrite: 0,
		});
		expect(byId.get("composer-2.5-standard")?.cost).toEqual({
			input: 0.5,
			output: 2.5,
			cacheRead: 0.2,
			cacheWrite: 0,
		});
		expect(byId.get("claude-opus-4-8")?.cost).toEqual({
			input: 5,
			output: 25,
			cacheRead: 0.5,
			cacheWrite: 6.25,
		});
		expect(byId.get("claude-opus-4-8-fast")?.cost).toEqual({
			input: 10,
			output: 50,
			cacheRead: 1,
			cacheWrite: 12.5,
		});
		expect(byId.get("gpt-5.1")?.cost).toEqual({
			input: 1.25,
			output: 10,
			cacheRead: 0.125,
			cacheWrite: 0,
		});
	});
	it("decodes Cursor's length-delimited vendor metadata", () => {
		const encoded = Uint8Array.from(Buffer.from("0a0766697874757265d202020801", "hex"));
		const details = fromBinary(AvailableModelsResponse_ModelDetailsSchema, encoded);
		expect(details.name).toBe("fixture");
		expect(details.vendor?.id).toBe(ModelVendorId.ANTHROPIC);
	});

	it("uses Cursor's HTTP/1 unary RPC shape for rich discovery", async () => {
		const usable = create(GetUsableModelsResponseSchema, {
			models: [create(ModelDetailsSchema, { modelId: "default" })],
		});
		const available = create(AvailableModelsResponseSchema, {
			models: [
				create(AvailableModelsResponse_ModelDetailsSchema, {
					name: "default",
					supportsAgent: true,
					supportsImages: true,
					contextTokenLimit: 123_456,
				}),
			],
		});
		const providerDefault = create(GetDefaultModelForCliResponseSchema, {
			model: create(ModelDetailsSchema, { modelId: "default" }),
		});
		const requests: {
			path: string;
			connectVersion: string | null;
			clientType: string | null;
			requestId: string | null;
		}[] = [];
		let decodedAvailableRequest: AvailableModelsRequest | undefined;
		const httpServer = Bun.serve({
			port: 0,
			async fetch(request) {
				const url = new URL(request.url);
				requests.push({
					path: url.pathname,
					connectVersion: request.headers.get("connect-protocol-version"),
					clientType: request.headers.get("x-cursor-client-type"),
					requestId: request.headers.get("x-request-id"),
				});
				const body = new Uint8Array(await request.arrayBuffer());
				if (url.pathname === "/agent.v1.AgentService/GetUsableModels") {
					return new Response(toBinary(GetUsableModelsResponseSchema, usable));
				}
				if (url.pathname === "/aiserver.v1.AiService/AvailableModels") {
					decodedAvailableRequest = fromBinary(AvailableModelsRequestSchema, body);
					return new Response(toBinary(AvailableModelsResponseSchema, available));
				}
				if (url.pathname === "/agent.v1.AgentService/GetDefaultModelForCli") {
					return new Response(toBinary(GetDefaultModelForCliResponseSchema, providerDefault));
				}
				return new Response(null, { status: 404 });
			},
		});

		try {
			const models = await fetchCursorUsableModels({
				apiKey: "account-token",
				baseUrl: httpServer.url.toString(),
				timeoutMs: 1_000,
			});
			expect(requests.map(request => request.path).sort()).toEqual(
				[
					"/agent.v1.AgentService/GetDefaultModelForCli",
					"/agent.v1.AgentService/GetUsableModels",
					"/aiserver.v1.AiService/AvailableModels",
				].sort(),
			);
			expect(requests.every(request => request.connectVersion === "1")).toBe(true);
			expect(requests.every(request => request.clientType === "cli")).toBe(true);
			expect(requests.every(request => Boolean(request.requestId))).toBe(true);
			expect(decodedAvailableRequest).toMatchObject({
				useModelParameters: true,
				doNotUseMarkdown: true,
			});
			expect(models).toEqual([
				expect.objectContaining({
					id: "default",
					contextWindow: 123_456,
					input: ["text", "image"],
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
					isProviderDefault: true,
				}),
			]);
		} finally {
			httpServer.stop(true);
		}
	});

	it("preserves Cursor max-mode metadata from GetUsableModels", async () => {
		const response = create(GetUsableModelsResponseSchema, {
			models: [
				create(ModelDetailsSchema, {
					modelId: "cursor-composer-max",
					displayName: "Cursor Composer Max",
					maxMode: true,
				}),
			],
		});
		const maxModeBaseUrl = await startCursorDiscoveryServer(toBinary(GetUsableModelsResponseSchema, response));

		const models = await fetchCursorUsableModels({ apiKey: "test-token", baseUrl: maxModeBaseUrl, timeoutMs: 1_000 });

		expect(models).toEqual([
			expect.objectContaining({
				id: "cursor-composer-max",
				name: "Cursor Composer Max",
				api: "cursor-agent",
				provider: "cursor",
				cursorMaxMode: true,
			}),
		]);
	});

	it("assigns the 1M window from display-name labels across families", async () => {
		const response = create(GetUsableModelsResponseSchema, {
			models: [
				create(ModelDetailsSchema, { modelId: "claude-opus-5-high", displayName: "Opus 5 1M" }),
				create(ModelDetailsSchema, { modelId: "gpt-5.5-high", displayName: "GPT-5.5 1M High" }),
				create(ModelDetailsSchema, { modelId: "gpt-5.6-sol-medium", displayName: "GPT-5.6 Sol 1M" }),
			],
		});
		const labeledBaseUrl = await startCursorDiscoveryServer(toBinary(GetUsableModelsResponseSchema, response));

		const models = await fetchCursorUsableModels({ apiKey: "test-token", baseUrl: labeledBaseUrl, timeoutMs: 1_000 });

		expect(models).toEqual([
			expect.objectContaining({ id: "claude-opus-5-high", contextWindow: 1_000_000 }),
			expect.objectContaining({ id: "gpt-5.5-high", contextWindow: 1_000_000 }),
			expect.objectContaining({ id: "gpt-5.6-sol-medium", contextWindow: 1_000_000 }),
		]);
	});

	it("assigns the 1M window to natively 1M families Cursor serves unlabeled", async () => {
		const response = create(GetUsableModelsResponseSchema, {
			models: [
				create(ModelDetailsSchema, { modelId: "kimi-k3-max", displayName: "Kimi K3" }),
				create(ModelDetailsSchema, { modelId: "moonshotai/kimi-k3", displayName: "Kimi K3" }),
				create(ModelDetailsSchema, { modelId: "k3", displayName: "K3" }),
				create(ModelDetailsSchema, { modelId: "kimi/k3", displayName: "K3" }),
				create(ModelDetailsSchema, { modelId: "glm-5.2-max", displayName: "GLM 5.2 Max" }),
				create(ModelDetailsSchema, { modelId: "glm-5.10-high", displayName: "GLM 5.10 High" }),
				create(ModelDetailsSchema, { modelId: "glm-6-max", displayName: "GLM 6 Max" }),
			],
		});
		const nativeBaseUrl = await startCursorDiscoveryServer(toBinary(GetUsableModelsResponseSchema, response));

		const models = await fetchCursorUsableModels({ apiKey: "test-token", baseUrl: nativeBaseUrl, timeoutMs: 1_000 });

		// The bare-`k3` spellings are rule-owned (`providers/cursor.kdl`
		// context-window-floor) and reach 1M once the spec is built.
		const built = models?.map(model => buildModel(model));
		expect(built).toEqual([
			expect.objectContaining({ id: "glm-5.10-high", contextWindow: 1_000_000 }),
			expect.objectContaining({ id: "glm-5.2-max", contextWindow: 1_000_000 }),
			expect.objectContaining({ id: "glm-6-max", contextWindow: 1_000_000 }),
			expect.objectContaining({ id: "k3", contextWindow: 1_000_000 }),
			expect.objectContaining({ id: "kimi-k3-max", contextWindow: 1_000_000 }),
			expect.objectContaining({ id: "kimi/k3", contextWindow: 1_000_000 }),
			expect.objectContaining({ id: "moonshotai/kimi-k3", contextWindow: 1_000_000 }),
		]);
	});

	it("keeps the default window below the GLM 5.2 floor and outside the coding variants", async () => {
		const response = create(GetUsableModelsResponseSchema, {
			models: [
				create(ModelDetailsSchema, { modelId: "glm-5.1-high", displayName: "GLM 5.1 High" }),
				create(ModelDetailsSchema, { modelId: "glm-5.2-flash", displayName: "GLM 5.2 Flash" }),
				create(ModelDetailsSchema, { modelId: "k3-256k", displayName: "K3-256k" }),
			],
		});
		const nativeBaseUrl = await startCursorDiscoveryServer(toBinary(GetUsableModelsResponseSchema, response));

		const models = await fetchCursorUsableModels({ apiKey: "test-token", baseUrl: nativeBaseUrl, timeoutMs: 1_000 });

		expect(models).toEqual([
			expect.objectContaining({ id: "glm-5.1-high", contextWindow: 200_000 }),
			expect.objectContaining({ id: "glm-5.2-flash", contextWindow: 200_000 }),
			expect.objectContaining({ id: "k3-256k", contextWindow: 200_000 }),
		]);
	});

	it("assigns the 1M window to unlabeled max-mode Claude models", async () => {
		const response = create(GetUsableModelsResponseSchema, {
			models: [
				create(ModelDetailsSchema, {
					modelId: "claude-opus-4-8-high-fast",
					displayName: "Opus 4.8 Fast",
					maxMode: true,
				}),
			],
		});
		const maxModeBaseUrl = await startCursorDiscoveryServer(toBinary(GetUsableModelsResponseSchema, response));

		const models = await fetchCursorUsableModels({ apiKey: "test-token", baseUrl: maxModeBaseUrl, timeoutMs: 1_000 });

		expect(models).toEqual([
			expect.objectContaining({ id: "claude-opus-4-8-high-fast", cursorMaxMode: true, contextWindow: 1_000_000 }),
		]);
	});

	it("keeps the default window for unlabeled non-max models and max-mode models outside 1M families", async () => {
		// Unbundled ids: the contract under test is "no 1M signal → fallback
		// preserved", so neither id may carry a bundled cursor reference whose
		// snapshot window would replace the 200k default fallback.
		const response = create(GetUsableModelsResponseSchema, {
			models: [
				create(ModelDetailsSchema, { modelId: "cursor-composer-max", maxMode: true }),
				create(ModelDetailsSchema, { modelId: "claude-opus-9-high", displayName: "Opus 9" }),
			],
		});
		const defaultBaseUrl = await startCursorDiscoveryServer(toBinary(GetUsableModelsResponseSchema, response));

		const models = await fetchCursorUsableModels({ apiKey: "test-token", baseUrl: defaultBaseUrl, timeoutMs: 1_000 });

		expect(models).toEqual([
			expect.objectContaining({ id: "claude-opus-9-high", cursorMaxMode: false, contextWindow: 200_000 }),
			expect.objectContaining({ id: "cursor-composer-max", cursorMaxMode: true, contextWindow: 200_000 }),
		]);
	});

	it("raises a bundled reference window when the reference id is served with a 1M label", async () => {
		// `claude-4.5-sonnet` is a bundled cursor reference with a 200k window;
		// served with a 1M display name it must expose the 1M ceiling.
		const response = create(GetUsableModelsResponseSchema, {
			models: [create(ModelDetailsSchema, { modelId: "claude-4.5-sonnet", displayName: "Sonnet 4.5 1M" })],
		});
		const referenceBaseUrl = await startCursorDiscoveryServer(toBinary(GetUsableModelsResponseSchema, response));

		const models = await fetchCursorUsableModels({
			apiKey: "test-token",
			baseUrl: referenceBaseUrl,
			timeoutMs: 1_000,
		});

		expect(models).toEqual([expect.objectContaining({ id: "claude-4.5-sonnet", contextWindow: 1_000_000 })]);
	});

	it("ignores Cursor cache rows written before 1M context windows were persisted", async () => {
		const cacheDbPath = await createTempCachePath();
		const staleSpec = { ...cursorModelSpec("claude-opus-4-8-high-fast"), cursorMaxMode: true };
		await resolveProviderModels(
			{
				providerId: "cursor",
				cacheProviderId: "cursor:max-mode-v2",
				cacheDbPath,
				staticModels: [],
				fetchDynamicModels: async () => [staleSpec],
				now: () => 1,
			},
			"online",
		);

		const response = create(GetUsableModelsResponseSchema, {
			models: [
				create(ModelDetailsSchema, {
					modelId: staleSpec.id,
					displayName: staleSpec.name,
					maxMode: true,
				}),
			],
		});
		const staleBaseUrl = await startCursorDiscoveryServer(toBinary(GetUsableModelsResponseSchema, response));
		const result = await resolveProviderModels(
			{
				...cursorModelManagerOptions({ apiKey: "test-token", baseUrl: staleBaseUrl }),
				cacheDbPath,
				staticModels: [],
				now: () => 2,
			},
			"online-if-uncached",
		);

		expect(result.models).toEqual([
			expect.objectContaining({
				id: staleSpec.id,
				cursorMaxMode: true,
				contextWindow: 1_000_000,
			}),
		]);
	});
});
