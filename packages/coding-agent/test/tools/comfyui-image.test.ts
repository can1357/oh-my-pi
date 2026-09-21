import { afterAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { FetchImpl } from "@oh-my-pi/pi-ai";
import { MissingApiKeyError, ProviderHttpError } from "@oh-my-pi/pi-ai/error";
import type { ComfyUIConfig, ComfyUIWorkflowConfig } from "@oh-my-pi/pi-catalog/types";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { CustomToolContext, CustomToolResult } from "@oh-my-pi/pi-coding-agent/extensibility/custom-tools";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { type ComfyUIError, generateComfyUIImage } from "@oh-my-pi/pi-coding-agent/tools/comfyui-image";
import { imageGenTool } from "@oh-my-pi/pi-coding-agent/tools/image-gen";
import { removeWithRetries } from "@oh-my-pi/pi-utils";
import { createInMemoryAuthStorage } from "../helpers/agent-session-setup";

const PNG_RED = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC";
const PNG_BLUE = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==";
const PNG_RED_BYTES = Buffer.from(PNG_RED, "base64");
const PNG_BLUE_BYTES = Buffer.from(PNG_BLUE, "base64");

const tempDirs: string[] = [];
const generatedImagePaths: string[] = [];
const registries: ModelRegistry[] = [];

afterAll(async () => {
	for (const registry of registries) registry.authStorage.close();
	await Promise.all(generatedImagePaths.splice(0).map(imagePath => removeWithRetries(imagePath)));
	await Promise.all(tempDirs.splice(0).map(dir => removeWithRetries(dir)));
});

async function makeTempDir(): Promise<string> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "comfyui-image-"));
	tempDirs.push(dir);
	return dir;
}

function jsonResponse(value: unknown, status = 200): Response {
	return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
}

type ComfyNode = { class_type: string; inputs: Record<string, unknown> };

const KSamplerInputs = {
	seed: 42,
	steps: 20,
	cfg: 7,
	sampler_name: "euler",
	scheduler: "normal",
	denoise: 1,
	model: ["4", 0],
	positive: ["6", 0],
	negative: ["7", 0],
	latent_image: ["5", 0],
};

/** API-format graph (`class_type`/`inputs`), the shape a user's workflow file holds. */
function generationGraph(): Record<string, ComfyNode> {
	return {
		"3": { class_type: "KSampler", inputs: { ...KSamplerInputs } },
		"4": { class_type: "CheckpointLoaderSimple", inputs: { ckpt_name: "sd15.safetensors" } },
		"5": { class_type: "EmptyLatentImage", inputs: { width: 512, height: 512, batch_size: 1 } },
		"6": { class_type: "CLIPTextEncode", inputs: { text: "workflow default prompt", clip: ["4", 1] } },
		"7": { class_type: "CLIPTextEncode", inputs: { text: "", clip: ["4", 1] } },
		"9": { class_type: "SaveImage", inputs: { filename_prefix: "omp", images: ["3", 0] } },
		"77": { class_type: "PreviewImage", inputs: { images: ["3", 0] } },
	};
}

function editGraph(): Record<string, ComfyNode> {
	return {
		...generationGraph(),
		"10": { class_type: "LoadImage", inputs: { image: "placeholder.png" } },
		"11": { class_type: "LoadImage", inputs: { image: "placeholder.png" } },
	};
}

async function workflowFile(dir: string, name: string, graph: unknown): Promise<string> {
	const workflowPath = path.join(dir, name);
	await Bun.write(workflowPath, JSON.stringify(graph));
	return workflowPath;
}

const GENERATION_CONFIG = (workflowPath: string): ComfyUIWorkflowConfig => ({
	path: workflowPath,
	prompt: [{ nodeId: "6", input: "text" }],
	width: [{ nodeId: "5", input: "width" }],
	height: [{ nodeId: "5", input: "height" }],
	outputNode: "9",
});

const EDIT_CONFIG = (workflowPath: string): ComfyUIWorkflowConfig => ({
	path: workflowPath,
	prompt: [{ nodeId: "6", input: "text" }],
	images: [
		{ nodeId: "10", input: "image" },
		{ nodeId: "11", input: "image" },
	],
	outputNode: "9",
});

/** Wire shape of `POST /prompt`, read from the parsed body at the stub boundary. */
interface CapturedPrompt {
	prompt: Record<string, ComfyNode>;
	prompt_id?: string;
}

interface ComfyStub {
	fetchImpl: FetchImpl;
	requests: Array<{ url: URL; headers: Headers }>;
	promptBodies: CapturedPrompt[];
}

/**
 * Scripted ComfyUI HTTP surface: `/upload/image`, one-shot `/prompt`, scripted
 * `/history/{id}` rounds, `/view` bytes. Anything else (notably `/interrupt`)
 * rejects the render, so an unexpected management call is a test failure.
 */
function createComfyStub(options: {
	/** One entry per `/history/{id}` round; the last entry repeats. */
	history: unknown[];
	view?: { bytes: Uint8Array; contentType: string };
	prompt?: (body: CapturedPrompt) => Response;
	uploads?: string[];
}): ComfyStub {
	const requests: ComfyStub["requests"] = [];
	const promptBodies: CapturedPrompt[] = [];
	let historyRound = 0;
	let uploadRound = 0;
	const fetchImpl: FetchImpl = async (input, init) => {
		const raw = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
		const url = new URL(raw);
		requests.push({ url, headers: new Headers(init?.headers) });
		if (url.pathname === "/prompt") {
			const body = JSON.parse(String(init?.body)) as CapturedPrompt;
			promptBodies.push(body);
			// Default: behave like ComfyUI, which answers with an id for the job.
			return options.prompt?.(body) ?? jsonResponse({ prompt_id: "prompt-1" });
		}
		if (url.pathname.startsWith("/history/")) {
			return jsonResponse(options.history[Math.min(historyRound++, options.history.length - 1)] ?? {});
		}
		if (url.pathname === "/upload/image") {
			return jsonResponse({
				name: options.uploads?.[uploadRound++] ?? "uploaded-1.png",
				subfolder: "",
				type: "input",
			});
		}
		if (url.pathname === "/view") {
			return new Response((options.view?.bytes ?? PNG_RED_BYTES).slice(), {
				status: 200,
				headers: { "content-type": options.view?.contentType ?? "image/png" },
			});
		}
		throw new Error(`Unexpected ComfyUI request: ${raw}`);
	};
	return { fetchImpl, requests, promptBodies };
}

function renderOptions(options: {
	config: ComfyUIConfig;
	stub: ComfyStub;
	prompt?: string;
	inputImages?: readonly { data: string; mimeType: string }[];
	size?: { width: number; height: number };
	resolveHeaders?: () => Promise<Record<string, string> | undefined>;
}) {
	return {
		baseUrl: "http://127.0.0.1:8188",
		config: options.config,
		prompt: options.prompt ?? "a local render",
		inputImages: options.inputImages ?? [],
		...(options.size ? { size: options.size } : {}),
		apiKey: "comfy-key",
		resolveHeaders: options.resolveHeaders ?? (async () => undefined),
		fetchImpl: options.stub.fetchImpl,
	};
}

type ComfyOutputs = Record<string, { images?: Array<{ filename: string; subfolder?: string; type?: string }> }>;

function successHistory(promptId: string, outputs: ComfyOutputs): Record<string, unknown> {
	return { [promptId]: { status: { status_str: "success", completed: true }, outputs } };
}

async function captureError(operation: () => Promise<unknown>): Promise<Error> {
	try {
		await operation();
	} catch (error) {
		return error instanceof Error ? error : new Error(String(error));
	}
	throw new Error("Expected the render to reject");
}

function onlySubmission(stub: ComfyStub): CapturedPrompt {
	const [submission] = stub.promptBodies;
	if (!submission) throw new Error("Expected exactly one ComfyUI prompt submission");
	return submission;
}

function pathsOf(stub: ComfyStub): string[] {
	return stub.requests.map(request => request.url.pathname);
}

describe("generateComfyUIImage", () => {
	it("waits for the accepted prompt, writes bound inputs, and returns the output node image", async () => {
		const dir = await makeTempDir();
		const workflowPath = await workflowFile(dir, "generation.json", generationGraph());
		const stub = createComfyStub({
			history: [
				{},
				successHistory("prompt-1", {
					"9": { images: [{ filename: "omp_00001_.png", subfolder: "", type: "output" }] },
					"77": { images: [{ filename: "preview_00001_.png", type: "temp" }] },
				}),
			],
		});

		const images = await generateComfyUIImage(
			renderOptions({
				config: { generation: GENERATION_CONFIG(workflowPath) },
				stub,
				prompt: "a copper kettle on a windowsill",
				size: { width: 1024, height: 1024 },
				resolveHeaders: async () => ({ "x-comfy-gateway": "local" }),
			}),
		);

		expect(images).toEqual([{ data: PNG_RED, mimeType: "image/png" }]);

		const submitted = onlySubmission(stub).prompt;
		expect(submitted["6"]?.inputs.text).toBe("a copper kettle on a windowsill");
		expect(submitted["5"]?.inputs).toMatchObject({ width: 1024, height: 1024 });
		// Inputs the adapter was not asked to bind keep the workflow's defaults.
		expect(submitted["3"]?.inputs).toMatchObject({ seed: 42, steps: 20 });
		// The graph is cloned before mutation: the user's file is untouched.
		const onDisk = (await Bun.file(workflowPath).json()) as Record<string, ComfyNode>;
		expect(onDisk["6"]?.inputs.text).toBe("workflow default prompt");

		expect(pathsOf(stub).filter(p => p === "/prompt")).toHaveLength(1);
		expect(pathsOf(stub).filter(p => p.startsWith("/history/")).length).toBeGreaterThanOrEqual(2);
		// Only the configured output node is downloaded, not sibling outputs.
		const views = stub.requests.filter(request => request.url.pathname === "/view");
		expect(views).toHaveLength(1);
		expect(views[0]?.url.searchParams.get("filename")).toBe("omp_00001_.png");
		expect(views[0]?.url.searchParams.get("type")).toBe("output");
		expect(stub.requests.some(request => request.url.pathname.includes("interrupt"))).toBe(false);
		expect(stub.requests[0]?.headers.get("authorization")).toBe("Bearer comfy-key");
		expect(stub.requests[0]?.headers.get("x-comfy-gateway")).toBe("local");
	});

	it("uploads edit references in order and binds each to its configured image input", async () => {
		const dir = await makeTempDir();
		const workflowPath = await workflowFile(dir, "edit.json", editGraph());
		const uploadedBytes: string[] = [];
		const stub = createComfyStub({
			history: [successHistory("prompt-edit", { "9": { images: [{ filename: "omp_edit_.png", type: "output" }] } })],
			prompt: () => jsonResponse({ prompt_id: "prompt-edit" }),
			uploads: ["ref-1.png", "ref-2.png"],
			// Distinct from either uploaded reference: the result is the server's
			// output, not an echo of the request.
			view: { bytes: PNG_BLUE_BYTES, contentType: "image/png" },
		});
		const innerFetch = stub.fetchImpl;
		stub.fetchImpl = async (input, init) => {
			if (new URL(String(input)).pathname === "/upload/image" && init?.body instanceof FormData) {
				const field = init.body.get("image");
				if (field instanceof Blob) uploadedBytes.push(Buffer.from(await field.arrayBuffer()).toString("base64"));
			}
			return innerFetch(input, init);
		};

		const images = await generateComfyUIImage(
			renderOptions({
				config: { generation: GENERATION_CONFIG(workflowPath), edit: EDIT_CONFIG(workflowPath) },
				stub,
				prompt: "blend both references",
				inputImages: [
					{ data: PNG_RED, mimeType: "image/png" },
					{ data: PNG_BLUE, mimeType: "image/png" },
				],
			}),
		);

		expect(images).toEqual([{ data: PNG_BLUE, mimeType: "image/png" }]);
		expect(uploadedBytes).toEqual([PNG_RED, PNG_BLUE]);
		const submitted = onlySubmission(stub).prompt;
		expect(submitted["10"]?.inputs.image).toContain("ref-1.png");
		expect(submitted["11"]?.inputs.image).toContain("ref-2.png");
	});

	it("rejects an unbindable node and a reference mismatch before any request", async () => {
		const dir = await makeTempDir();
		const generationPath = await workflowFile(dir, "generation.json", generationGraph());
		const editPath = await workflowFile(dir, "edit.json", editGraph());

		// A prompt binding pointing at a node the graph does not have never reaches
		// the network, let alone an upload.
		const unbindable = createComfyStub({ history: [] });
		const unbindableError = (await captureError(() =>
			generateComfyUIImage(
				renderOptions({
					config: {
						generation: { ...GENERATION_CONFIG(generationPath), prompt: [{ nodeId: "99", input: "text" }] },
					},
					stub: unbindable,
				}),
			),
		)) as ComfyUIError;
		expect(unbindableError.stage).toBe("workflow");
		expect(unbindableError.message).toContain("99");
		expect(unbindable.requests).toHaveLength(0);

		// Fewer references than the configured edit bindings: rejected instead of
		// silently rendering with a preconfigured reference.
		const mismatch = createComfyStub({ history: [] });
		const mismatchError = (await captureError(() =>
			generateComfyUIImage(
				renderOptions({
					config: { generation: GENERATION_CONFIG(generationPath), edit: EDIT_CONFIG(editPath) },
					stub: mismatch,
					inputImages: [{ data: PNG_RED, mimeType: "image/png" }],
				}),
			),
		)) as ComfyUIError;
		expect(mismatchError.stage).toBe("workflow");
		expect(mismatchError.message).toContain("received 1");
		expect(mismatch.requests).toHaveLength(0);
	});

	it("separates a rejected submission from an accepted render that then fails", async () => {
		const dir = await makeTempDir();
		const workflowPath = await workflowFile(dir, "generation.json", generationGraph());

		// Nothing rendered: an ordinary HTTP failure, still eligible for the
		// existing candidate-fallback path.
		const rejected = createComfyStub({
			history: [],
			prompt: () => jsonResponse({ error: { message: "Prompt outputs failed validation" }, node_errors: {} }, 400),
		});
		const rejectedError = await captureError(() =>
			generateComfyUIImage(
				renderOptions({ config: { generation: GENERATION_CONFIG(workflowPath) }, stub: rejected }),
			),
		);
		expect(rejectedError).toBeInstanceOf(ProviderHttpError);
		expect((rejectedError as ProviderHttpError).status).toBe(400);
		expect(rejectedError.message).toContain("Prompt outputs failed validation");
		expect(pathsOf(rejected)).toEqual(["/prompt"]);

		// The prompt was accepted and then failed on the server: a non-HTTP error
		// that names the job, so no second candidate duplicates the work.
		const failing = createComfyStub({
			history: [
				{
					"prompt-boom": {
						status: {
							status_str: "error",
							completed: false,
							messages: [
								["execution_start", { prompt_id: "prompt-boom" }],
								[
									"execution_error",
									{
										prompt_id: "prompt-boom",
										node_id: "3",
										node_type: "KSampler",
										exception_message: "CUDA out of memory",
										exception_type: "torch.OutOfMemoryError",
									},
								],
							],
						},
					},
				},
			],
			prompt: () => jsonResponse({ prompt_id: "prompt-boom" }),
		});
		const failureError = await captureError(() =>
			generateComfyUIImage(
				renderOptions({ config: { generation: GENERATION_CONFIG(workflowPath) }, stub: failing }),
			),
		);
		const failure = failureError as ComfyUIError;
		expect(failureError).not.toBeInstanceOf(ProviderHttpError);
		expect(failure.promptId).toBe("prompt-boom");
		expect(failure.message).toContain("CUDA out of memory");
		expect(pathsOf(failing)).toEqual(["/prompt", "/history/prompt-boom"]);
	});

	it("reports an indeterminate submission without replaying the prompt", async () => {
		const dir = await makeTempDir();
		const workflowPath = await workflowFile(dir, "generation.json", generationGraph());
		const stub = createComfyStub({ history: [] });
		const innerFetch = stub.fetchImpl;
		let submissions = 0;
		let submittedBody: string | undefined;
		stub.fetchImpl = async (input, init) => {
			if (new URL(String(input)).pathname === "/prompt") {
				submissions++;
				submittedBody = String(init?.body);
				throw new TypeError("socket closed");
			}
			return innerFetch(input, init);
		};

		const error = await captureError(() =>
			generateComfyUIImage(renderOptions({ config: { generation: GENERATION_CONFIG(workflowPath) }, stub })),
		);

		const failure = error as ComfyUIError;
		expect(failure.stage).toBe("submit");
		const promptId = failure.promptId;
		if (promptId === undefined) throw new Error("Expected the indeterminate submission to report a prompt id");
		expect(failure.message).toContain(promptId);
		expect(submissions).toBe(1);
		// A server that adopts client IDs can recover this indeterminate dispatch.
		expect((JSON.parse(String(submittedBody)) as CapturedPrompt).prompt_id).toBe(promptId);
		// The throwing wrapper handled /prompt; no other endpoint was contacted.
		expect(pathsOf(stub)).toEqual([]);

		const unavailable = createComfyStub({
			history: [],
			prompt: () => jsonResponse({ error: "Upstream response lost after enqueue" }, 503),
		});
		const serverError = await captureError(() =>
			generateComfyUIImage(
				renderOptions({ config: { generation: GENERATION_CONFIG(workflowPath) }, stub: unavailable }),
			),
		);
		expect(serverError).not.toBeInstanceOf(ProviderHttpError);
		expect(pathsOf(unavailable)).toEqual(["/prompt"]);
		expect(serverError.message).toContain(onlySubmission(unavailable).prompt_id!);
	});

	it("does not downgrade a missing credential to an anonymous request", async () => {
		const dir = await makeTempDir();
		const workflowPath = await workflowFile(dir, "generation.json", generationGraph());
		const stub = createComfyStub({ history: [] });
		const error = await captureError(() =>
			generateComfyUIImage({
				...renderOptions({ config: { generation: GENERATION_CONFIG(workflowPath) }, stub }),
				apiKey: () => undefined,
			}),
		);
		expect(error).toBeInstanceOf(MissingApiKeyError);
		expect(stub.requests).toHaveLength(0);
	});
});

function createToolContext(options: {
	registry: ModelRegistry;
	settings: Settings;
	fetch: FetchImpl;
}): CustomToolContext {
	return {
		fetch: options.fetch,
		sessionManager: SessionManager.inMemory("/tmp"),
		modelRegistry: options.registry,
		model: undefined,
		settings: options.settings,
		isIdle: () => true,
		hasQueuedMessages: () => false,
		abort: () => {},
	};
}

function collectPaths(result: CustomToolResult<{ imagePaths: string[] }>): void {
	generatedImagePaths.push(...(result.details?.imagePaths ?? []));
}

async function comfyuiRegistry(dir: string, yaml: string, fetchImpl: FetchImpl): Promise<ModelRegistry> {
	const modelsPath = path.join(dir, "models.yml");
	await Bun.write(modelsPath, yaml);
	const registry = new ModelRegistry(createInMemoryAuthStorage(), modelsPath, {
		settings: Settings.isolated(),
		fetch: fetchImpl,
	});
	registries.push(registry);
	return registry;
}

/** Keyless provider on loopback with relative workflow paths: the local-image fixture. */
const COMFY_MODELS_YML = (options: { generationPath: string; editPath: string }) => `providers:
  local-comfy:
    baseUrl: http://127.0.0.1:8188
    api: comfyui
    auth: none
    models:
      - id: local-flux
        kind: image
        api: comfyui
        input: [text, image]
        comfyui:
          timeoutMs: 30000
          generation:
            path: ${options.generationPath}
            prompt: [{ nodeId: "6", input: text }]
            width: [{ nodeId: "5", input: width }]
            height: [{ nodeId: "5", input: height }]
            outputNode: "9"
          edit:
            path: ${options.editPath}
            prompt: [{ nodeId: "6", input: text }]
            images: [{ nodeId: "10", input: image }, { nodeId: "11", input: image }]
            outputNode: "9"
`;

async function localComfyFixture(dir: string, stub: ComfyStub, extraYaml = "") {
	await workflowFile(dir, "generation.json", generationGraph());
	await workflowFile(dir, "edit.json", editGraph());
	const registry = await comfyuiRegistry(
		dir,
		`${COMFY_MODELS_YML({ generationPath: "generation.json", editPath: "edit.json" })}${extraYaml}`,
		stub.fetchImpl,
	);
	const settings = Settings.isolated({ modelRoles: { image: "local-comfy/local-flux" } });
	return { registry, settings };
}

describe("imageGenTool -> ComfyUI models.yml routing", () => {
	it("renders a models.yml comfyui model with workflow-relative paths and workflow defaults", async () => {
		const dir = await makeTempDir();
		const stub = createComfyStub({
			history: [successHistory("prompt-tool", { "9": { images: [{ filename: "omp_tool_.png", type: "output" }] } })],
			prompt: () => jsonResponse({ prompt_id: "prompt-tool" }),
		});
		const { registry, settings } = await localComfyFixture(dir, stub);
		const ctx = createToolContext({ registry, settings, fetch: stub.fetchImpl });

		const result = await imageGenTool.execute("generate", { subject: "a local render" }, undefined, ctx);
		collectPaths(result);

		expect(result.details?.provider).toBe("local-comfy");
		expect(result.details?.model).toBe("local-flux");
		expect(result.details?.imageCount).toBe(1);
		const imagePath = result.details?.imagePaths[0];
		if (imagePath === undefined) throw new Error("Expected the tool to report a saved image path");
		expect(Buffer.from(await Bun.file(imagePath).arrayBuffer())).toEqual(PNG_RED_BYTES);

		// No requested size: the workflow's own 512x512 survives, and a keyless
		// provider never wears the `N/A` sentinel as a bearer token.
		expect(onlySubmission(stub).prompt["5"]?.inputs).toMatchObject({ width: 512, height: 512 });
		expect(pathsOf(stub).filter(p => p === "/prompt")).toHaveLength(1);
		for (const request of stub.requests) expect(request.headers.get("authorization")).toBeNull();
	});

	it("does not contact a fallback candidate after the ComfyUI prompt was accepted", async () => {
		const dir = await makeTempDir();
		const hostedUrls: string[] = [];
		const stub = createComfyStub({
			history: [
				{
					"prompt-uncertain": {
						status: {
							status_str: "error",
							completed: false,
							messages: [
								[
									"execution_error",
									{ prompt_id: "prompt-uncertain", node_id: "3", exception_message: "runtime exploded" },
								],
							],
						},
					},
				},
			],
			prompt: () => jsonResponse({ prompt_id: "prompt-uncertain" }),
		});
		const fetchImpl: FetchImpl = async (input, init) => {
			const url = String(input);
			if (url.startsWith("http://127.0.0.1:8188")) return stub.fetchImpl(input, init);
			hostedUrls.push(url);
			return jsonResponse({ data: [{ b64_json: PNG_BLUE, media_type: "image/png" }] });
		};
		const { registry } = await localComfyFixture(
			dir,
			stub,
			`  hosted-images:
    baseUrl: https://hosted.example/v1
    api: openai-images
    auth: none
    models:
      - id: hosted-image
        kind: image
        api: openai-images
        input: [text]
`,
		);
		const settings = Settings.isolated({
			modelRoles: { image: "local-comfy/local-flux" },
			"retry.fallbackChains": { image: ["hosted-images/hosted-image"] },
		});

		const ctx = createToolContext({ registry, settings, fetch: fetchImpl });
		const error = await captureError(() =>
			imageGenTool.execute("accepted-failure", { subject: "a local render" }, undefined, ctx),
		);

		const failure = error as ComfyUIError;
		expect(failure.promptId).toBe("prompt-uncertain");
		expect(failure.message).toContain("runtime exploded");
		expect(pathsOf(stub)).toEqual(["/prompt", "/history/prompt-uncertain"]);
		expect(hostedUrls).toEqual([]);
	});

	it("keeps the accepted prompt id when the caller aborts a running render", async () => {
		const dir = await makeTempDir();
		const stub = createComfyStub({ history: [{}], prompt: () => jsonResponse({ prompt_id: "prompt-tool-abort" }) });
		const { registry, settings } = await localComfyFixture(dir, stub);
		const controller = new AbortController();
		const innerFetch = stub.fetchImpl;
		stub.fetchImpl = async (input, init) => {
			const response = await innerFetch(input, init);
			if (new URL(String(input)).pathname.startsWith("/history/")) controller.abort();
			return response;
		};

		const ctx = createToolContext({ registry, settings, fetch: stub.fetchImpl });
		const error = await captureError(() =>
			imageGenTool.execute("caller-abort", { subject: "a local render" }, undefined, ctx, controller.signal),
		);

		// The accepted job may still be running remotely, so the caller keeps its
		// id and nothing on the server is cancelled or resubmitted.
		expect(error.message).toContain("prompt-tool-abort");
		expect(pathsOf(stub)).toEqual(["/prompt", "/history/prompt-tool-abort"]);
	});

	it("generates through a keyless localhost openai-images provider without sending Bearer N/A", async () => {
		const requests: Array<{ url: string; authorization: string | null }> = [];
		const server = Bun.serve({
			port: 0,
			fetch: request => {
				requests.push({ url: new URL(request.url).pathname, authorization: request.headers.get("authorization") });
				return jsonResponse({ data: [{ b64_json: PNG_RED, media_type: "image/png" }] });
			},
		});
		try {
			const dir = await makeTempDir();
			const registry = await comfyuiRegistry(
				dir,
				`providers:
  local-openai:
    baseUrl: http://127.0.0.1:${server.port}/v1
    api: openai-images
    auth: none
    models:
      - id: local-image
        kind: image
        api: openai-images
        input: [text]
`,
				fetch,
			);
			const settings = Settings.isolated({ modelRoles: { image: "local-openai/local-image" } });
			const ctx = createToolContext({ registry, settings, fetch });

			const result = await imageGenTool.execute("keyless", { subject: "a keyless local render" }, undefined, ctx);
			collectPaths(result);

			expect(result.details?.model).toBe("local-image");
			expect(requests).toEqual([{ url: "/v1/images/generations", authorization: null }]);
			const imagePath = result.details?.imagePaths[0];
			if (imagePath === undefined) throw new Error("Expected the tool to report a saved image path");
			expect(Buffer.from(await Bun.file(imagePath).arrayBuffer())).toEqual(PNG_RED_BYTES);
		} finally {
			await server.stop(true);
		}
	});
});
