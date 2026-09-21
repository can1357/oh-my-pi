/**
 * Runs user-owned API-format workflows through ComfyUI. Only configured input
 * bindings change; only the selected output node is downloaded.
 *
 * An accepted or indeterminate submission is never replayed or sent to a
 * fallback provider. Cancellation stops local waiting, not the shared server.
 * Client-supplied prompt IDs aid recovery on ComfyUI 0.37+; a returned ID is
 * authoritative. Redirects are refused to keep payloads and credentials on the
 * configured endpoint.
 */

import { randomUUID } from "node:crypto";
import * as path from "node:path";
import { type ApiKey, type FetchImpl, NO_AUTH_SENTINEL, withAuth } from "@oh-my-pi/pi-ai";
import { ProviderHttpError } from "@oh-my-pi/pi-ai/error";
import type { ComfyUIConfig, ComfyUIInputBinding, ComfyUIWorkflowConfig } from "@oh-my-pi/pi-catalog/types";
import { asRecord, parseImageMetadata, ptree, sleepLong, truncate, USER_AGENT } from "@oh-my-pi/pi-utils";

const JSON_CONTENT_TYPE = "application/json";
const POLL_INTERVAL_MS = 500;
const REFERENCE_FILE_STEM = "omp-reference";
const RESPONSE_TEXT_LIMIT = 400;
const IMAGE_MIME_SUBTYPE = /^[a-z0-9]+$/;

/** Where a {@link ComfyUIError} originated, so callers can separate configuration defects from transport faults. */
export type ComfyUIStage = "workflow" | "upload" | "submit" | "poll" | "fetch";

/** A failure that must not trigger another provider or replay a submitted job. */
export class ComfyUIError extends Error {
	readonly stage: ComfyUIStage;
	/**
	 * Job id for this failure: the id the submit response echoed when one
	 * arrived, otherwise the client-minted id sent in the submit body.
	 */
	readonly promptId: string | undefined;

	constructor(message: string, options: { stage: ComfyUIStage; promptId?: string; cause?: unknown }) {
		super(message, options.cause === undefined ? undefined : { cause: options.cause });
		this.name = "ComfyUIError";
		this.stage = options.stage;
		this.promptId = options.promptId;
	}
}

/** Decoded image bytes handed back to the caller's existing image pipeline. */
export interface ComfyUIImage {
	data: string;
	mimeType: string;
}

export interface GenerateComfyUIImageOptions {
	/** ComfyUI server base URL; a loopback host or a reverse-proxied path prefix both work. */
	baseUrl: string;
	/** Workflow binding configuration for this model. */
	config: ComfyUIConfig;
	/** Assembled prompt text, written into every configured prompt binding. */
	prompt: string;
	/** Reference images in caller order; a non-empty list selects the configured `edit` workflow. */
	inputImages: readonly ComfyUIImage[];
	/** Requested output dimensions, already scaled by the caller. */
	size?: { width: number; height: number };
	/** Credential for the endpoint; keyless providers resolve it to {@link NO_AUTH_SENTINEL}. */
	apiKey: ApiKey;
	/** Resolves the configured request headers for the current attempt. */
	resolveHeaders: () => Promise<Record<string, string> | undefined>;
	/**
	 * Called after acceptance with the server-confirmed prompt ID, so the caller
	 * can retain it when its own abort wrapper wins the cancellation race.
	 */
	onQueued?: (promptId: string) => void;
	fetchImpl: FetchImpl;
	signal?: AbortSignal;
}

/**
 * Generate images from a configured ComfyUI workflow, uploading any reference
 * images first and fetching only the workflow's selected output node images.
 */
export async function generateComfyUIImage(options: GenerateComfyUIImageOptions): Promise<ComfyUIImage[]> {
	const baseUrl = resolveComfyBaseUrl(options.baseUrl);
	const referenceCount = options.inputImages.length;
	const useEdit = referenceCount > 0;
	const section = useEdit ? "edit" : "generation";
	const workflow = useEdit ? options.config.edit : options.config.generation;
	if (!workflow) {
		throw new ComfyUIError(
			`ComfyUI workflow "edit" is not configured: ${referenceCount} reference image(s) supplied`,
			{
				stage: "workflow",
			},
		);
	}

	const graph = await loadWorkflowGraph(workflow, section);
	const plan = planWorkflow(workflow, graph, section, referenceCount, options.size);
	const context: RenderContext = {
		baseUrl,
		fetchImpl: options.fetchImpl,
		signal: ptree.combineSignals(options.signal, options.config.timeoutMs),
		apiKey: options.apiKey,
		resolveHeaders: options.resolveHeaders,
	};

	applyPlan(plan, options.prompt);
	for (const [index, target] of plan.referenceTargets.entries()) {
		target.inputs[target.binding.input] = await uploadReferenceImage(context, options.inputImages[index], index);
	}

	const submitted = await submitWorkflow(context, graph);
	options.onQueued?.(submitted.prompt.promptId);
	const headers: RequestHeaders = {
		configured: await options.resolveHeaders(),
		authorization: submitted.authorization,
	};
	const entry = await waitForWorkflowEntry(context, headers, submitted.prompt);
	return fetchOutputImages(context, headers, plan.outputNode, submitted.prompt, entry);
}

// ── URL handling ────────────────────────────────────────────────────────────

function resolveComfyBaseUrl(raw: string): URL {
	const trimmed = raw.trim();
	if (trimmed === "") throw new ComfyUIError("ComfyUI base URL is empty", { stage: "workflow" });

	let url: URL;
	try {
		url = new URL(trimmed);
	} catch (error) {
		throw new ComfyUIError(`ComfyUI base URL "${raw}" is not a valid URL`, { stage: "workflow", cause: error });
	}
	if (url.protocol !== "http:" && url.protocol !== "https:") {
		throw new ComfyUIError(`ComfyUI base URL "${raw}" must use http or https`, { stage: "workflow" });
	}
	if (!url.pathname.endsWith("/")) url.pathname = `${url.pathname}/`;
	url.hash = "";
	return url;
}

/**
 * Resolves a request URL relative to the configured base URL, so the path prefix
 * of a reverse-proxied deployment is preserved and every request stays on the
 * configured origin — credentials and configured headers never travel elsewhere.
 */
function routeUrl(baseUrl: URL, ...segments: readonly string[]): URL {
	const url = new URL(segments.map(segment => encodeURIComponent(segment)).join("/"), baseUrl);
	// Path-relative resolution drops the base query; keep it for proxies that tokenize via `?`.
	url.search = baseUrl.search;
	return url;
}

// ── Workflow loading and binding validation ─────────────────────────────────

interface BoundTarget {
	readonly binding: ComfyUIInputBinding;
	readonly inputs: Record<string, unknown>;
}

interface WorkflowPlan {
	readonly promptTargets: readonly BoundTarget[];
	readonly referenceTargets: readonly BoundTarget[];
	readonly widthTargets: readonly BoundTarget[];
	readonly heightTargets: readonly BoundTarget[];
	/** Validated dimensions to write, or `undefined` to keep the workflow's own defaults. */
	readonly size: { width: number; height: number } | undefined;
	readonly outputNode: string;
}

async function loadWorkflowGraph(workflow: ComfyUIWorkflowConfig, section: string): Promise<Record<string, unknown>> {
	const file = workflow.path;
	if (!path.isAbsolute(file)) {
		throw new ComfyUIError(
			`ComfyUI workflow ${section}: path "${workflow.path}" must be absolute; resolve it against the models.yml directory when the model is loaded`,
			{ stage: "workflow" },
		);
	}

	let text: string;
	try {
		text = await Bun.file(file).text();
	} catch (error) {
		throw new ComfyUIError(`ComfyUI workflow ${section}: could not read ${file}: ${errorText(error)}`, {
			stage: "workflow",
			cause: error,
		});
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch (error) {
		throw new ComfyUIError(`ComfyUI workflow ${section}: ${file} is not valid JSON`, {
			stage: "workflow",
			cause: error,
		});
	}
	const graph = asRecord(parsed);
	if (!graph) {
		throw new ComfyUIError(`ComfyUI workflow ${section}: ${file} must contain a ComfyUI API-format prompt object`, {
			stage: "workflow",
		});
	}
	return graph;
}

/**
 * Resolves every configured binding against the freshly parsed graph. All node,
 * input, output-node, dimension, and reference-count problems surface here,
 * before any request is made.
 */
function planWorkflow(
	workflow: ComfyUIWorkflowConfig,
	graph: Record<string, unknown>,
	section: string,
	referenceCount: number,
	size: { width: number; height: number } | undefined,
): WorkflowPlan {
	if (workflow.prompt.length === 0) {
		throw new ComfyUIError(`ComfyUI workflow ${section}: prompt bindings are empty`, { stage: "workflow" });
	}
	if (!Object.hasOwn(graph, workflow.outputNode)) {
		throw new ComfyUIError(
			`ComfyUI workflow ${section}: output node "${workflow.outputNode}" is missing from the graph`,
			{ stage: "workflow" },
		);
	}

	const referenceBindings = workflow.images ?? [];
	if (referenceBindings.length !== referenceCount) {
		throw new ComfyUIError(
			`ComfyUI workflow ${section}: expected ${referenceBindings.length} reference image(s) but received ${referenceCount}`,
			{ stage: "workflow" },
		);
	}

	const widthBindings = workflow.width ?? [];
	const heightBindings = workflow.height ?? [];
	const hasWidth = widthBindings.length > 0;
	if (hasWidth !== heightBindings.length > 0) {
		throw new ComfyUIError(
			`ComfyUI workflow ${section}: width and height bindings must be both set or both omitted`,
			{ stage: "workflow" },
		);
	}
	if (size !== undefined && !hasWidth) {
		throw new ComfyUIError(
			`ComfyUI workflow ${section}: size ${size.width}x${size.height} was supplied but the workflow declares no width/height bindings`,
			{ stage: "workflow" },
		);
	}
	if (
		size !== undefined &&
		(!Number.isInteger(size.width) || size.width <= 0 || !Number.isInteger(size.height) || size.height <= 0)
	) {
		throw new ComfyUIError(
			`ComfyUI workflow ${section}: size ${size.width}x${size.height} must be positive integers`,
			{ stage: "workflow" },
		);
	}

	return {
		promptTargets: workflow.prompt.map(binding => resolveBindingTarget(graph, section, binding, "prompt")),
		referenceTargets: referenceBindings.map(binding =>
			resolveBindingTarget(graph, section, binding, "reference image"),
		),
		widthTargets: widthBindings.map(binding => resolveBindingTarget(graph, section, binding, "width")),
		heightTargets: heightBindings.map(binding => resolveBindingTarget(graph, section, binding, "height")),
		size: size !== undefined && hasWidth ? size : undefined,
		outputNode: workflow.outputNode,
	};
}

function resolveBindingTarget(
	graph: Record<string, unknown>,
	section: string,
	binding: ComfyUIInputBinding,
	role: string,
): BoundTarget {
	if (binding.nodeId === "" || binding.input === "") {
		throw new ComfyUIError(`ComfyUI workflow ${section}: ${role} binding must declare a nodeId and input`, {
			stage: "workflow",
		});
	}
	const node = asRecord(graph[binding.nodeId]);
	if (!node) {
		throw new ComfyUIError(
			`ComfyUI workflow ${section}: node "${binding.nodeId}" for ${role} is missing from the graph`,
			{ stage: "workflow" },
		);
	}
	if (typeof node.class_type !== "string") {
		throw new ComfyUIError(
			`ComfyUI workflow ${section}: node "${binding.nodeId}" is not an API-format node (missing class_type)`,
			{ stage: "workflow" },
		);
	}
	const inputs = asRecord(node.inputs);
	if (!inputs || !Object.hasOwn(inputs, binding.input)) {
		throw new ComfyUIError(
			`ComfyUI workflow ${section}: node "${binding.nodeId}" has no input "${binding.input}" for ${role}`,
			{ stage: "workflow" },
		);
	}
	return { binding, inputs };
}

function applyPlan(plan: WorkflowPlan, prompt: string): void {
	for (const target of plan.promptTargets) target.inputs[target.binding.input] = prompt;
	const size = plan.size;
	if (size === undefined) return;
	for (const target of plan.widthTargets) target.inputs[target.binding.input] = size.width;
	for (const target of plan.heightTargets) target.inputs[target.binding.input] = size.height;
}

// ── Requests ────────────────────────────────────────────────────────────────

interface RenderContext {
	readonly baseUrl: URL;
	readonly fetchImpl: FetchImpl;
	readonly signal: AbortSignal | undefined;
	readonly apiKey: ApiKey;
	readonly resolveHeaders: () => Promise<Record<string, string> | undefined>;
}

interface RequestHeaders {
	readonly configured: Record<string, string> | undefined;
	readonly authorization: string | undefined;
}

/**
 * Local handle for a submitted job. `confirmed` is false only when the submit
 * response never carried an id, leaving the client mint as the sole handle: a
 * server that ignores client-supplied ids may have queued the job under an id
 * of its own.
 */
interface SubmittedPrompt {
	readonly promptId: string;
	readonly confirmed: boolean;
}

/** Names a prompt id in diagnostics without claiming confirmation it never got. */
function promptLabel(prompt: SubmittedPrompt): string {
	return prompt.confirmed
		? `prompt_id=${prompt.promptId}`
		: `client prompt_id=${prompt.promptId} (unconfirmed: the submit response carried no id)`;
}

/** Credential to send, or `undefined` for keyless endpoints (never the `N/A` sentinel itself). */
function authorizationHeader(key: string): string | undefined {
	const trimmed = key.trim();
	return trimmed === "" || trimmed === NO_AUTH_SENTINEL ? undefined : trimmed;
}

/**
 * Only a credential the endpoint itself rejected may rotate and retry. The
 * submit path reports an unknown outcome for 5xx and lost responses — including
 * the server's own text in the message — and such a failure must never replay
 * the workflow, so the classifier is pinned here instead of being inferred from
 * status-looking text by the default policy.
 */
function isComfyAuthError(error: unknown): boolean {
	return error instanceof ProviderHttpError && (error.status === 401 || error.status === 403);
}

/**
 * Runs one request through the shared auth-retry policy. Keyless endpoints (no
 * credential, or the `N/A` sentinel) issue a single unauthenticated attempt
 * instead of rotating a credential they do not have.
 */
async function requestAuthorization<T>(
	apiKey: ApiKey,
	signal: AbortSignal | undefined,
	attempt: (authorization: string | undefined) => Promise<T>,
): Promise<T> {
	return withAuth(apiKey, key => attempt(authorizationHeader(key)), { signal, isAuthError: isComfyAuthError });
}

function buildHeaders(headers: RequestHeaders, bodyType: "json" | "multipart" | "none"): Headers {
	const built = new Headers(headers.configured);
	if (bodyType === "json") built.set("Content-Type", JSON_CONTENT_TYPE);
	// Multipart bodies must keep the runtime-generated boundary.
	else if (bodyType === "multipart") built.delete("Content-Type");
	if (headers.authorization !== undefined && !built.has("Authorization")) {
		built.set("Authorization", `Bearer ${headers.authorization}`);
	}
	built.set("User-Agent", USER_AGENT);
	return built;
}

function decodeReferenceImage(image: ComfyUIImage, index: number): { bytes: Uint8Array; mimeType: string } {
	const label = `ComfyUI reference image ${index + 1}`;
	if (image.data.length === 0) throw new ComfyUIError(`${label}: image data is empty`, { stage: "upload" });

	const bytes = Buffer.from(image.data, "base64");
	const metadata = parseImageMetadata(bytes);
	if (!metadata) {
		throw new ComfyUIError(`${label}: data is not a PNG, JPEG, WebP, or GIF image`, { stage: "upload" });
	}
	return { bytes, mimeType: metadata.mimeType };
}

function referenceFileName(index: number, mimeType: string): string {
	const subtype = mimeType.startsWith("image/") ? mimeType.slice("image/".length) : "";
	const extension = IMAGE_MIME_SUBTYPE.test(subtype) ? (subtype === "jpeg" ? "jpg" : subtype) : "png";
	return `${REFERENCE_FILE_STEM}-${randomUUID()}-${index + 1}.${extension}`;
}

/** Uploads one reference image and returns the workflow value addressed by its binding. */
async function uploadReferenceImage(context: RenderContext, image: ComfyUIImage, index: number): Promise<string> {
	const { bytes, mimeType } = decodeReferenceImage(image, index);

	return requestAuthorization(context.apiKey, context.signal, async authorization => {
		const headers = buildHeaders({ configured: await context.resolveHeaders(), authorization }, "multipart");
		const form = new FormData();
		form.append("image", new Blob([bytes], { type: mimeType }), referenceFileName(index, mimeType));
		form.append("type", "input");

		let response: Response;
		try {
			response = await context.fetchImpl(routeUrl(context.baseUrl, "upload", "image"), {
				method: "POST",
				headers,
				body: form,
				redirect: "error",
				signal: context.signal,
			});
		} catch (error) {
			if (isAbortError(error) || context.signal?.aborted) {
				throw cancellationError(undefined, "upload", error);
			}
			throw new ComfyUIError(
				`ComfyUI reference image ${index + 1} upload failed before submission: ${errorText(error)}`,
				{ stage: "upload", cause: error },
			);
		}

		const text = await safeResponseText(response);
		if (!response.ok) {
			throw new ProviderHttpError(
				`ComfyUI reference image upload failed (${response.status}): ${clip(text)}`,
				response.status,
				{ headers: response.headers },
			);
		}

		const record = parseJsonRecord(text);
		const name = typeof record?.name === "string" && record.name.length > 0 ? record.name : undefined;
		if (name === undefined) {
			throw new ComfyUIError(
				`ComfyUI reference image ${index + 1}: upload response contained no file name (${clip(text)})`,
				{ stage: "upload" },
			);
		}
		const subfolder = typeof record?.subfolder === "string" ? record.subfolder : "";
		const type = typeof record?.type === "string" && record.type.length > 0 ? record.type : "input";
		// ComfyUI resolves `"<subfolder/>name [type]"` against the matching input directory.
		return `${subfolder === "" ? "" : `${subfolder}/`}${name} [${type}]`;
	});
}

/**
 * Submits the graph exactly once. The response's `prompt_id` is authoritative;
 * the client-minted id (sent in the body, which ComfyUI 0.37 validates and
 * adopts) only covers a dispatch whose response never arrived — and then only
 * best effort, since a server that ignores the field queues its own id. A
 * dispatch whose outcome cannot be determined reports that id rather than being
 * replayed.
 */
async function submitWorkflow(
	context: RenderContext,
	graph: Record<string, unknown>,
): Promise<{ prompt: SubmittedPrompt; authorization: string | undefined }> {
	const promptId = randomUUID();
	const clientId = randomUUID();
	const clientPrompt: SubmittedPrompt = { promptId, confirmed: false };

	return requestAuthorization(context.apiKey, context.signal, async authorization => {
		const headers = buildHeaders({ configured: await context.resolveHeaders(), authorization }, "json");

		let response: Response;
		try {
			response = await context.fetchImpl(routeUrl(context.baseUrl, "prompt"), {
				method: "POST",
				headers,
				body: JSON.stringify({ prompt: graph, client_id: clientId, prompt_id: promptId }),
				redirect: "error",
				signal: context.signal,
			});
		} catch (error) {
			throw new ComfyUIError(
				`ComfyUI prompt submission outcome is unknown (${promptLabel(clientPrompt)}): ${errorText(error)}. The workflow was not resubmitted; the server may still run this job, but this id only addresses it on a server that adopts a client-supplied prompt_id (ComfyUI 0.37+), so check the server's queue or history before retrying.`,
				{ stage: "submit", promptId, cause: error },
			);
		}

		const text = await safeResponseText(response);
		// A 5xx can arrive after the job was queued, so the outcome is unknown: a plain
		// ComfyUI error, never a fallback-eligible ProviderHttpError, and never retried
		// (which would also make it auth-replayable). ComfyUI rejects an unacceptable
		// submission itself with 4xx while the job is still unqueued — validation and
		// prompt-id errors as 400, an unreachable endpoint as 404, missing credentials
		// as 401/403 — so those stay known rejections below.
		if (response.status >= 500) {
			throw new ComfyUIError(
				`ComfyUI prompt submission outcome is unknown (HTTP ${response.status}, ${promptLabel(clientPrompt)}): ${clip(text)}. A server error can arrive after the job was queued, so the submission was neither retried nor replayed; check the server's queue or history before retrying.`,
				{ stage: "submit", promptId },
			);
		}
		if (!response.ok) {
			throw new ProviderHttpError(
				`ComfyUI prompt submission failed (${response.status}): ${clip(text)}`,
				response.status,
				{ headers: response.headers },
			);
		}

		// HTTP 200 without an id cannot address the queued job: treat it as unknown
		// rather than polling an id the server never confirmed.
		const serverPromptId = parseJsonRecord(text)?.prompt_id;
		if (typeof serverPromptId !== "string" || serverPromptId.length === 0) {
			throw new ComfyUIError(
				`ComfyUI prompt submission outcome is unknown (${promptLabel(clientPrompt)}): the server answered HTTP ${response.status} without a prompt_id (${clip(text)}). The workflow was not resubmitted; the server may still run this job.`,
				{ stage: "submit", promptId },
			);
		}
		return { prompt: { promptId: serverPromptId, confirmed: true }, authorization };
	});
}

async function waitForWorkflowEntry(
	context: RenderContext,
	headers: RequestHeaders,
	prompt: SubmittedPrompt,
): Promise<Record<string, unknown>> {
	for (;;) {
		if (context.signal?.aborted) throw cancellationError(prompt, "poll", context.signal.reason);

		const entry = await readHistoryEntry(context, headers, prompt);
		if (entry) {
			const status = asRecord(entry.status);
			if (status) {
				if (status.status_str === "error") throw workflowFailureError(status, prompt);
				if (status.status_str === "success" && status.completed === true) return entry;
			}
		}

		try {
			await sleepLong(POLL_INTERVAL_MS, context.signal);
		} catch (error) {
			throw cancellationError(prompt, "poll", error);
		}
	}
}

/** Reads `GET /history/{id}`; an absent entry means the prompt is still queued or running. */
async function readHistoryEntry(
	context: RenderContext,
	headers: RequestHeaders,
	prompt: SubmittedPrompt,
): Promise<Record<string, unknown> | undefined> {
	const response = await fetchPostSubmit(
		context,
		headers,
		routeUrl(context.baseUrl, "history", prompt.promptId),
		"poll",
		prompt,
		"history request",
	);
	const text = await safeResponseText(response);
	if (!response.ok) {
		throw new ComfyUIError(
			`ComfyUI history request failed (HTTP ${response.status}) for ${promptLabel(prompt)}: ${clip(text)}`,
			{ stage: "poll", promptId: prompt.promptId },
		);
	}
	const history = parseJsonRecord(text);
	if (!history) {
		throw new ComfyUIError(
			`ComfyUI history response was not a JSON object for ${promptLabel(prompt)}: ${clip(text)}`,
			{ stage: "poll", promptId: prompt.promptId },
		);
	}
	return asRecord(history[prompt.promptId]) ?? undefined;
}

function workflowFailureError(status: Record<string, unknown>, prompt: SubmittedPrompt): ComfyUIError {
	return new ComfyUIError(`ComfyUI workflow failed (${promptLabel(prompt)}): ${describeFailure(status.messages)}`, {
		stage: "poll",
		promptId: prompt.promptId,
	});
}

function describeFailure(messages: unknown): string {
	if (Array.isArray(messages)) {
		for (const message of messages) {
			if (!Array.isArray(message)) continue;
			const entry: unknown[] = message;
			const messageType = entry[0];
			if (messageType === "execution_interrupted") {
				return "execution was interrupted before the workflow finished";
			}
			if (messageType !== "execution_error") continue;

			const record = asRecord(entry[1]);
			const exceptionType =
				typeof record?.exception_type === "string" && record.exception_type.length > 0
					? record.exception_type
					: "ExecutionError";
			const exceptionMessage =
				typeof record?.exception_message === "string" && record.exception_message.length > 0
					? record.exception_message
					: "unknown error";
			const nodeId =
				typeof record?.node_id === "string" || typeof record?.node_id === "number"
					? String(record.node_id)
					: undefined;
			return nodeId === undefined
				? `${exceptionType}: ${exceptionMessage}`
				: `${exceptionType}: ${exceptionMessage} (node "${nodeId}")`;
		}
	}
	return 'the server reported status_str="error" without a detailed message';
}

interface SelectedOutputImage {
	readonly filename: string;
	readonly subfolder: string;
	readonly type: string | undefined;
}

/** Fetches only the selected output node's images, from `GET /view`. */
async function fetchOutputImages(
	context: RenderContext,
	headers: RequestHeaders,
	outputNode: string,
	prompt: SubmittedPrompt,
	entry: Record<string, unknown>,
): Promise<ComfyUIImage[]> {
	const selected = selectOutputImages(entry, outputNode, prompt);
	const images: ComfyUIImage[] = [];

	for (const image of selected) {
		const url = routeUrl(context.baseUrl, "view");
		url.searchParams.set("filename", image.filename);
		if (image.subfolder !== "") url.searchParams.set("subfolder", image.subfolder);
		if (image.type !== undefined) url.searchParams.set("type", image.type);

		const response = await fetchPostSubmit(
			context,
			headers,
			url,
			"fetch",
			prompt,
			`view request for "${image.filename}"`,
		);
		if (!response.ok) {
			throw new ComfyUIError(
				`ComfyUI view request failed (HTTP ${response.status}) for "${image.filename}" (${promptLabel(prompt)})`,
				{ stage: "fetch", promptId: prompt.promptId },
			);
		}

		let bytes: Uint8Array;
		try {
			bytes = new Uint8Array(await response.arrayBuffer());
		} catch (error) {
			throw new ComfyUIError(
				`ComfyUI output image "${image.filename}" could not be read (${promptLabel(prompt)}): ${errorText(error)}`,
				{ stage: "fetch", promptId: prompt.promptId, cause: error },
			);
		}
		// The bytes are authoritative: an HTML or JSON error page never passes for an image.
		const metadata = parseImageMetadata(bytes);
		if (!metadata) {
			throw new ComfyUIError(
				`ComfyUI output image "${image.filename}" is not a decodable image (${promptLabel(prompt)})`,
				{ stage: "fetch", promptId: prompt.promptId },
			);
		}
		images.push({ data: bytes.toBase64(), mimeType: metadata.mimeType });
	}
	return images;
}

function selectOutputImages(
	entry: Record<string, unknown>,
	outputNode: string,
	prompt: SubmittedPrompt,
): SelectedOutputImage[] {
	const outputs = asRecord(entry.outputs);
	const nodeOutput = asRecord(outputs?.[outputNode]);
	const images = nodeOutput?.images;
	if (!Array.isArray(images) || images.length === 0) {
		throw new ComfyUIError(
			`ComfyUI workflow finished (${promptLabel(prompt)}) but output node "${outputNode}" produced no images; check the configured outputNode`,
			{ stage: "fetch", promptId: prompt.promptId },
		);
	}

	const selected: SelectedOutputImage[] = [];
	for (const raw of images) {
		const record = asRecord(raw);
		const filename = typeof record?.filename === "string" && record.filename.length > 0 ? record.filename : undefined;
		if (filename === undefined) {
			throw new ComfyUIError(
				`ComfyUI workflow finished (${promptLabel(prompt)}) but output node "${outputNode}" contains an image entry without a filename`,
				{ stage: "fetch", promptId: prompt.promptId },
			);
		}
		selected.push({
			filename,
			subfolder: typeof record?.subfolder === "string" ? record.subfolder : "",
			type: typeof record?.type === "string" && record.type.length > 0 ? record.type : undefined,
		});
	}
	return selected;
}

/** Post-submission request: never retried, never replayed, and reported with the prompt id. */
async function fetchPostSubmit(
	context: RenderContext,
	headers: RequestHeaders,
	url: URL,
	stage: "poll" | "fetch",
	prompt: SubmittedPrompt,
	label: string,
): Promise<Response> {
	try {
		return await context.fetchImpl(url, {
			headers: buildHeaders(headers, "none"),
			redirect: "error",
			signal: context.signal,
		});
	} catch (error) {
		if (isAbortError(error) || context.signal?.aborted) throw cancellationError(prompt, stage, error);
		throw new ComfyUIError(`ComfyUI ${label} failed for ${promptLabel(prompt)}: ${errorText(error)}`, {
			stage,
			promptId: prompt.promptId,
			cause: error,
		});
	}
}

// ── Failure and helper utilities ────────────────────────────────────────────

function cancellationError(prompt: SubmittedPrompt | undefined, stage: ComfyUIStage, cause: unknown): ComfyUIError {
	const message =
		prompt === undefined
			? "ComfyUI render cancelled before submission; no workflow was submitted."
			: `ComfyUI render cancelled (${promptLabel(prompt)}): the job may still be running on the server; no interrupt was sent.`;
	return new ComfyUIError(message, { stage, promptId: prompt?.promptId, cause });
}

async function safeResponseText(response: Response): Promise<string> {
	try {
		return await response.text();
	} catch {
		return "";
	}
}

function parseJsonRecord(text: string): Record<string, unknown> | undefined {
	if (text.trim() === "") return undefined;
	try {
		return asRecord(JSON.parse(text)) ?? undefined;
	} catch {
		return undefined;
	}
}

function clip(text: string): string {
	const trimmed = text.trim();
	return trimmed === "" ? "(empty response body)" : truncate(trimmed, RESPONSE_TEXT_LIMIT);
}

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function isAbortError(error: unknown): boolean {
	if (typeof error !== "object" || error === null || !("name" in error)) return false;
	const name = error.name;
	return name === "AbortError" || name === "TimeoutError";
}
