import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as http2 from "node:http2";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { buildModel } from "../src/build";
// Import from source, not the package specifier: the workspace `node_modules`
// copy resolves to the primary checkout, not this worktree.
import { fetchCursorUsableModels } from "../src/discovery/cursor";
import {
	type AvailableModelsRequest,
	type AvailableModelsResponse_ModelDetails,
	AvailableModelsRequestSchema,
	AvailableModelsResponse_ModelDetailsSchema,
	AvailableModelsResponse_TooltipDataSchema,
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
import { collapseBuiltVariants, getVariantAliasSources, resolveVariantSelector } from "../src/compat/collapse";
import { resolveProviderModels } from "../src/model-manager";
import { cursorModelManagerOptions } from "../src/provider-models/special";
import { getModelPricingStatus } from "../src/models";
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
	"k3",
	"cursor/k3",
	"CURSOR/K3",
	"cursor-grok-4.5",
	"cursor-grok-4.5-fast",
	"cursor-grok-4.6",
	"cursor-grok-4.6-fast",
	"composer-2.5",
	"composer-2.5-fast",
	// Similar but unverified ids must not inherit image routing.
	"K3",
	"composer-3",
	"composer-2.50",
	"cursor-grok-5",
	"grok-code-fast-2",
	"k3-256k",
	"cursor/k3-256k",
	"K3-256K",
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

	it("preserves verified K3 aliases without inflating unverified K3 selector capabilities", async () => {
		const byId = await discover();
		for (const id of ["kimi-k3-high", "kimi-k3-low", "kimi-k3-max", "k3", "cursor/k3", "CURSOR/K3"]) {
			const spec = byId.get(id);
			expect(spec).toBeDefined();
			if (spec) {
				expect(buildModel(spec).input).toEqual(["text", "image"]);
				expect(buildModel(spec).contextWindow).toBe(1_000_000);
			}
		}
		for (const id of ["K3", "k3-256k", "cursor/k3-256k", "K3-256K"]) {
			const spec = byId.get(id);
			expect(spec).toBeDefined();
			if (spec) {
				expect(buildModel(spec).input).toEqual(["text"]);
				expect(buildModel(spec).contextWindow).toBe(200_000);
			}
		}
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
					// Cursor's IDE tooltip markup, as AvailableModels serves it.
					tooltipData: create(AvailableModelsResponse_TooltipDataSchema, {
						markdownContent:
							'**Claude Opus 4.6**<br />Anthropic\'s earlier flagship model, great for difficult tasks.<br /><br />200k context window<br /><br /><span style="color:var(--vscode-editorWarning-foreground);">Special data retention</span>',
					}),
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

		const models = await fetchCursorUsableModels({
			apiKey: "account-token",
			baseUrl: richBaseUrl,
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
				// The prose sentence only: no HTML, bold title, or context line.
				description: "Anthropic's earlier flagship model, great for difficult tasks.",
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
	});

	it("prices rich lanes from the KDL rate card and leaves uncovered lanes unpriced", async () => {
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
			models: [
				"composer-2.5-fast",
				"composer-2.5",
				"claude-opus-4-8-high",
				"claude-opus-4-8-high-fast",
				"gpt-5.1",
			].map(modelId => create(ModelDetailsSchema, { modelId })),
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
					legacySlugs: ["claude-opus-4-8-high", "claude-opus-4-8-high-fast"],
					parameterDefinitions: [fastDefinition],
					variants: [fastVariant("claude-opus-4-8-high", false), fastVariant("claude-opus-4-8-high-fast", true)],
				}),
				create(AvailableModelsResponse_ModelDetailsSchema, {
					name: "gpt-5.1",
					clientDisplayName: "GPT-5.1",
					supportsAgent: true,
				}),
			],
		});
		const pricingBaseUrl = await startCursorDiscoveryRpcServer({
			"/agent.v1.AgentService/GetUsableModels": toBinary(GetUsableModelsResponseSchema, usable),
			"/aiserver.v1.AiService/AvailableModels": toBinary(AvailableModelsResponseSchema, available),
		});

		const models = await fetchCursorUsableModels({
			apiKey: "account-token",
			baseUrl: pricingBaseUrl,
			timeoutMs: 1_000,
		});
		const byId = new Map((models ?? []).map(model => [model.id, model]));
		// Discovery and `buildModel` resolve the same card, so building a lane
		// never moves its price.
		const built = (id: string) => {
			const spec = byId.get(id);
			if (!spec) throw new Error(`missing lane ${id}`);
			const model = buildModel(spec);
			expect(model.cost).toEqual(spec.cost);
			return model;
		};

		// The bare id is Standard even though Cursor lists the Fast variant first:
		// naming lanes by variant order sent `composer-2.5` to the Fast route.
		expect(byId.get("composer-2.5")?.cursorModelParameters).toEqual([{ id: "fast", value: "false" }]);
		expect(built("composer-2.5").cost).toEqual({ input: 0.5, output: 2.5, cacheRead: 0.2, cacheWrite: 0 });
		expect(built("composer-2.5-fast").cost).toEqual({ input: 3, output: 15, cacheRead: 0.5, cacheWrite: 0 });
		expect(built("claude-opus-4-8").cost).toEqual({ input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 });
		// An own-class `cost-patch` is final: the reviewed fast card, not the
		// base card times the declared 2x.
		expect(built("claude-opus-4-8-fast").cost).toEqual({ input: 10, output: 50, cacheRead: 1, cacheWrite: 12.5 });
		// Not on the card: left unpriced rather than borrowing another
		// provider's card, so it reads as pricing unknown instead of a guess.
		const uncovered = built("gpt-5.1");
		expect(uncovered.cost).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
		expect(getModelPricingStatus(uncovered)).toBe("unknown");
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

	it("raises documented Cursor context-window floors at buildModel time", async () => {
		// Discovered models that match bundled references receive the
		// reference's contextWindow (256k Grok, 262k Kimi, 272k GPT-5.6).
		// Unbundled preview ids stay on the 200k discovery fallback, then
		// `providers/cursor.kdl` context-window-floor applies once the spec
		// is built. A labeled gpt-5.6 row stays at 1M.
		const response = create(GetUsableModelsResponseSchema, {
			models: [
				create(ModelDetailsSchema, { modelId: "cursor-grok-4.6" }),
				create(ModelDetailsSchema, { modelId: "cursor-grok-4.5" }),
				create(ModelDetailsSchema, { modelId: "default" }),
				create(ModelDetailsSchema, { modelId: "kimi-k2.7-code" }),
				create(ModelDetailsSchema, { modelId: "gpt-5.6-sol-fast" }),
				create(ModelDetailsSchema, { modelId: "claude-opus-5-preview" }),
				create(ModelDetailsSchema, { modelId: "claude-fable-5-preview" }),
				create(ModelDetailsSchema, { modelId: "gpt-5.6-sol-medium", displayName: "GPT-5.6 Sol 1M" }),
			],
		});
		const floorBaseUrl = await startCursorDiscoveryServer(toBinary(GetUsableModelsResponseSchema, response));

		const models = await fetchCursorUsableModels({ apiKey: "test-token", baseUrl: floorBaseUrl, timeoutMs: 1_000 });

		expect(models).toEqual([
			expect.objectContaining({ id: "claude-fable-5-preview", contextWindow: 200_000 }),
			expect.objectContaining({ id: "claude-opus-5-preview", contextWindow: 200_000 }),
			expect.objectContaining({ id: "cursor-grok-4.5", contextWindow: 256_000 }),
			expect.objectContaining({ id: "cursor-grok-4.6", contextWindow: 256_000 }),
			expect.objectContaining({ id: "default", contextWindow: 256_000 }),
			expect.objectContaining({ id: "gpt-5.6-sol-fast", contextWindow: 272_000 }),
			expect.objectContaining({ id: "gpt-5.6-sol-medium", contextWindow: 1_000_000 }),
			expect.objectContaining({ id: "kimi-k2.7-code", contextWindow: 262_000 }),
		]);

		const built = models?.map(model => buildModel(model));
		expect(built).toEqual([
			expect.objectContaining({ id: "claude-fable-5-preview", contextWindow: 300_000 }),
			expect.objectContaining({ id: "claude-opus-5-preview", contextWindow: 300_000 }),
			expect.objectContaining({ id: "cursor-grok-4.5", contextWindow: 256_000 }),
			expect.objectContaining({ id: "cursor-grok-4.6", contextWindow: 256_000 }),
			expect.objectContaining({ id: "default", contextWindow: 256_000 }),
			expect.objectContaining({ id: "gpt-5.6-sol-fast", contextWindow: 272_000 }),
			expect.objectContaining({ id: "gpt-5.6-sol-medium", contextWindow: 1_000_000 }),
			expect.objectContaining({ id: "kimi-k2.7-code", contextWindow: 262_000 }),
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

/** HTTP/1 Cursor stub answering each RPC path with a fixed status and body. */
function serveCursorRpcStatuses(routes: Readonly<Record<string, { status: number; body?: Uint8Array }>>) {
	return Bun.serve({
		port: 0,
		fetch(request) {
			const route = routes[new URL(request.url).pathname];
			if (!route) return new Response(null, { status: 404 });
			return new Response(route.body ? Buffer.from(route.body) : null, { status: route.status });
		},
	});
}

const booleanParameter = (id: string, tooltip?: string) =>
	create(ModelParameterDefinitionSchema, {
		id,
		name: id,
		markdownTooltip: tooltip,
		parameterType: create(ModelParameterDefinition_ModelParameterTypeSchema, {
			booleanParameter: create(ModelParameterDefinition_BooleanParameterDefinitionSchema, {
				values: [
					create(ModelParameterDefinition_BooleanParameterDefinition_BooleanParameterValueSchema, {
						value: "false",
					}),
					create(ModelParameterDefinition_BooleanParameterDefinition_BooleanParameterValueSchema, {
						value: "true",
						increasesModelCost: tooltip !== undefined,
					}),
				],
			}),
		}),
	});

const richVariant = (
	legacySlug: string,
	parameters: Record<string, string>,
	flags: { isDefaultNonMaxConfig?: boolean } = {},
) =>
	create(AvailableModelsResponse_ModelVariantConfigSchema, {
		legacySlug,
		...flags,
		parameterValues: Object.entries(parameters).map(([id, value]) =>
			create(ModelParameterValueSchema, { id, value }),
		),
	});

/** Discovers only `AvailableModels` (no usable filter). */
async function discoverAvailable(
	models: AvailableModelsResponse_ModelDetails[],
): Promise<Map<string, ModelSpec<"cursor-agent">>> {
	const available = create(AvailableModelsResponseSchema, { models });
	const rpcBaseUrl = await startCursorDiscoveryRpcServer({
		"/aiserver.v1.AiService/AvailableModels": toBinary(AvailableModelsResponseSchema, available),
	});
	const specs = await fetchCursorUsableModels({ apiKey: "account-token", baseUrl: rpcBaseUrl, timeoutMs: 1_000 });
	return new Map((specs ?? []).map(spec => [spec.id, spec]));
}

describe("cursor rich discovery review regressions", () => {
	it("returns null when both model-list RPCs fail even though the default RPC succeeds", async () => {
		const providerDefault = toBinary(
			GetDefaultModelForCliResponseSchema,
			create(GetDefaultModelForCliResponseSchema, { model: create(ModelDetailsSchema, { modelId: "default" }) }),
		);
		const failing = serveCursorRpcStatuses({
			"/agent.v1.AgentService/GetUsableModels": { status: 503 },
			"/aiserver.v1.AiService/AvailableModels": { status: 503 },
			"/agent.v1.AgentService/GetDefaultModelForCli": { status: 200, body: providerDefault },
		});
		// An empty 200 body is a decoded (empty) GetUsableModels message.
		const empty = serveCursorRpcStatuses({
			"/agent.v1.AgentService/GetUsableModels": { status: 200, body: new Uint8Array() },
			"/aiserver.v1.AiService/AvailableModels": { status: 503 },
			"/agent.v1.AgentService/GetDefaultModelForCli": { status: 200, body: providerDefault },
		});
		try {
			expect(
				await fetchCursorUsableModels({ apiKey: "t", baseUrl: failing.url.toString(), timeoutMs: 1_000 }),
			).toBeNull();
			expect(
				await fetchCursorUsableModels({ apiKey: "t", baseUrl: empty.url.toString(), timeoutMs: 1_000 }),
			).toEqual([]);
		} finally {
			failing.stop(true);
			empty.stop(true);
		}
	});

	it("bounds an unresponsive endpoint by one timeout instead of retrying over HTTP/2", async () => {
		const sockets = new Set<net.Socket>();
		const hanging = net.createServer(socket => sockets.add(socket));
		const { promise, resolve } = Promise.withResolvers<void>();
		hanging.listen(0, "127.0.0.1", () => resolve());
		await promise;
		const timeoutMs = 400;
		try {
			const started = performance.now();
			const models = await fetchCursorUsableModels({
				apiKey: "t",
				baseUrl: `http://127.0.0.1:${requireTcpAddress(hanging.address()).port}`,
				timeoutMs,
			});
			const elapsed = performance.now() - started;
			expect(models).toBeNull();
			expect(elapsed).toBeLessThan(timeoutMs * 1.5);
		} finally {
			for (const socket of sockets) socket.destroy();
			hanging.close();
		}
	});

	it("prices rich lanes from the KDL rate card by member slug and lane id", async () => {
		const fast = booleanParameter("fast", "2x more expensive, but significantly faster.");
		// The card outranks bundled references, so every price here is the card's.
		const specs = await discoverAvailable([
			// Own-slug `cost-patch` rows are final, fast ones included: Grok 4.5
			// Fast bills $4/$18, not the base card doubled.
			create(AvailableModelsResponse_ModelDetailsSchema, {
				name: "grok-4.5",
				supportsAgent: true,
				parameterDefinitions: [fast],
				variants: [
					richVariant("cursor-grok-4.5-high", { fast: "false" }),
					richVariant("cursor-grok-4.5-high-fast", { fast: "true" }),
				],
			}),
			// A `cost-fallback` row is the base card: the declared multiplier applies.
			create(AvailableModelsResponse_ModelDetailsSchema, {
				name: "gpt-5.2",
				supportsAgent: true,
				parameterDefinitions: [fast],
				variants: [
					richVariant("gpt-5.2-high", { fast: "false" }),
					richVariant("gpt-5.2-high-fast", { fast: "true" }),
				],
			}),
			// No member slug is on the card, but the `gpt-5.4-fast` lane id carries
			// a reviewed `cost-patch` ($5/$30) that `buildModel` applies by lane id.
			// Discovery must price it the same, not as the base card times 3.
			create(AvailableModelsResponse_ModelDetailsSchema, {
				name: "gpt-5.4",
				supportsAgent: true,
				parameterDefinitions: [booleanParameter("fast", "3x more expensive")],
				variants: [
					richVariant("gpt-5.4-high", { fast: "false" }),
					richVariant("gpt-5.4-high-fast", { fast: "true" }),
				],
			}),
		]);
		const cost = (id: string) => {
			const spec = specs.get(id);
			if (!spec) throw new Error(`missing lane ${id}`);
			const built = buildModel(spec).cost;
			expect(built).toEqual(spec.cost);
			return built;
		};
		expect(cost("cursor-grok-4.5")).toEqual({ input: 2, output: 6, cacheRead: 0.5, cacheWrite: 0 });
		expect(cost("cursor-grok-4.5-fast")).toEqual({ input: 4, output: 18, cacheRead: 1, cacheWrite: 0 });
		expect(cost("gpt-5.2")).toEqual({ input: 1.75, output: 14, cacheRead: 0.175, cacheWrite: 0 });
		expect(cost("gpt-5.2-fast")).toEqual({ input: 3.5, output: 28, cacheRead: 0.35, cacheWrite: 0 });
		expect(cost("gpt-5.4")).toEqual({ input: 2.5, output: 15, cacheRead: 0.25, cacheWrite: 0 });
		expect(cost("gpt-5.4-fast")).toEqual({ input: 5, output: 30, cacheRead: 0.5, cacheWrite: 0 });
	});

	it.each(["2x more expensive", "2× more expensive"])("reads the declared multiplier from %p", async tooltip => {
		const specs = await discoverAvailable([
			create(AvailableModelsResponse_ModelDetailsSchema, {
				name: "claude-opus-5-5",
				supportsAgent: true,
				parameterDefinitions: [booleanParameter("fast", tooltip)],
				variants: [
					richVariant("claude-opus-5-5-high", { fast: "false" }),
					richVariant("claude-opus-5-5-high-fast", { fast: "true" }),
				],
			}),
		]);
		expect(specs.get("claude-opus-5-5-fast")?.cost.input).toBe(8);
	});

	it("names enum lanes after the flagged default variant regardless of variant order", async () => {
		const context = create(ModelParameterDefinitionSchema, {
			id: "context",
			name: "Context",
			parameterType: create(ModelParameterDefinition_ModelParameterTypeSchema, {
				enumParameter: create(ModelParameterDefinition_EnumParameterDefinitionSchema, {
					values: ["300k", "1m"].map(value =>
						create(ModelParameterDefinition_EnumParameterDefinition_EnumParameterValueSchema, { value }),
					),
				}),
			}),
		});
		const long = richVariant("claude-opus-4-8-high", { context: "1m" });
		const standard = richVariant("claude-opus-4-8-high", { context: "300k" }, { isDefaultNonMaxConfig: true });
		for (const variants of [
			[long, standard],
			[standard, long],
		]) {
			const specs = await discoverAvailable([
				create(AvailableModelsResponse_ModelDetailsSchema, {
					name: "claude-opus-4-8",
					supportsAgent: true,
					parameterDefinitions: [context],
					variants,
				}),
			]);
			expect([...specs.keys()].sort()).toEqual(["claude-opus-4-8", "claude-opus-4-8-1m"]);
			expect(specs.get("claude-opus-4-8")?.cursorModelParameters).toEqual([{ id: "context", value: "300k" }]);
			expect(specs.get("claude-opus-4-8-1m")?.cursorModelParameters).toEqual([{ id: "context", value: "1m" }]);
		}
	});

	it("routes every supported effort of a thinking on/off toggle to the thinking variant", async () => {
		const specs = await discoverAvailable([
			create(AvailableModelsResponse_ModelDetailsSchema, {
				name: "claude-sonnet-4-5",
				supportsAgent: true,
				supportsThinking: true,
				parameterDefinitions: [booleanParameter("thinking")],
				variants: [
					richVariant("claude-4.5-sonnet", { thinking: "false" }),
					richVariant("claude-4.5-sonnet-thinking", { thinking: "true" }, { isDefaultNonMaxConfig: true }),
				],
			}),
		]);
		const spec = specs.get("claude-sonnet-4-5");
		if (!spec) throw new Error("missing claude-sonnet-4-5 lane");
		const model = buildModel(spec);
		expect(model.reasoning).toBe(true);
		expect(model.thinking?.effortRouting?.off).toBe("claude-4.5-sonnet");
		expect(model.thinking?.efforts.length).toBeGreaterThan(0);
		for (const effort of model.thinking?.efforts ?? []) {
			expect(model.thinking?.effortRouting?.[effort]).toBe("claude-4.5-sonnet-thinking");
		}
	});

	it("keeps Cursor Grok logical ids stable whether or not AvailableModels answers (#14164)", async () => {
		const efforts = ["low", "medium", "high", "xhigh"];
		const slugs = efforts.flatMap(effort => [`cursor-grok-4.6-${effort}`, `cursor-grok-4.6-${effort}-fast`]);
		const usable = toBinary(
			GetUsableModelsResponseSchema,
			create(GetUsableModelsResponseSchema, {
				models: slugs.map(modelId => create(ModelDetailsSchema, { modelId })),
			}),
		);
		// AvailableModels names the model `grok-4.6`; only its slugs carry `cursor-`.
		const available = toBinary(
			AvailableModelsResponseSchema,
			create(AvailableModelsResponseSchema, {
				models: [
					create(AvailableModelsResponse_ModelDetailsSchema, {
						name: "grok-4.6",
						clientDisplayName: "Grok 4.6",
						supportsAgent: true,
						legacySlugs: slugs,
						parameterDefinitions: [booleanParameter("fast", "2x more expensive")],
						variants: efforts.flatMap(effort => [
							richVariant(
								`cursor-grok-4.6-${effort}`,
								{ reasoning: effort, fast: "false" },
								{ isDefaultNonMaxConfig: effort === "medium" },
							),
							richVariant(`cursor-grok-4.6-${effort}-fast`, { reasoning: effort, fast: "true" }),
						]),
					}),
				],
			}),
		);
		const discoverIds = async (availableStatus: number): Promise<string[]> => {
			const server = serveCursorRpcStatuses({
				"/agent.v1.AgentService/GetUsableModels": { status: 200, body: usable },
				"/aiserver.v1.AiService/AvailableModels": { status: availableStatus, body: available },
			});
			try {
				const result = await resolveProviderModels(
					{
						...cursorModelManagerOptions({ apiKey: "t", baseUrl: server.url.toString() }),
						cacheDbPath: await createTempCachePath(),
						staticModels: [],
					},
					"online",
				);
				return result.models.map(model => model.id).sort();
			} finally {
				server.stop(true);
			}
		};

		const expected = ["cursor-grok-4.6", "cursor-grok-4.6-fast"];
		expect(await discoverIds(200)).toEqual(expected);
		expect(await discoverIds(503)).toEqual(expected);
	});

	it("migrates selectors and overrides keyed by the retired unprefixed rich Grok lane ids (#14164)", () => {
		for (const [retired, stable] of [
			["grok-4.5", "cursor-grok-4.5"],
			["grok-4.5-fast", "cursor-grok-4.5-fast"],
			["grok-4.6", "cursor-grok-4.6"],
			["grok-4.6-fast", "cursor-grok-4.6-fast"],
		] as const) {
			expect(resolveVariantSelector("cursor", retired)).toBe(stable);
			// models.yml `modelOverrides` re-key through the reverse index.
			expect(getVariantAliasSources("cursor", stable)).toContain(retired);
		}
		// Grok 4.7 lanes were always unprefixed; they must not be re-keyed.
		expect(resolveVariantSelector("cursor", "grok-4.7")).toBeUndefined();
		expect(getVariantAliasSources("cursor", "cursor-grok-4.7")).not.toContain("grok-4.7");
	});
});
