import { Buffer } from "node:buffer";
import * as fs from "node:fs/promises";
import type { FetchImpl } from "../types";

const REQUEST_DEBUG_ENV = "PI_REQ_DEBUG";
const DEBUG_FETCH_MARKER = Symbol("omp.requestDebugFetch");
const textEncoder = new TextEncoder();
const utf8Decoder = new TextDecoder("utf-8", { fatal: true });

let nextSessionId = 1;

type DebugFetch = FetchImpl & { [DEBUG_FETCH_MARKER]?: true };
type RequestBodyInit = NonNullable<RequestInit["body"]>;

type RequestDebugBody = { body: unknown } | { bodyText: string } | { bodyBase64: string } | { bodyUnavailable: string };

export type RequestDebugHeaders = Headers | Record<string, string | string[] | number | undefined | null> | undefined;

export interface RequestDebugPayload {
	method: string;
	url: string;
	headers?: RequestDebugHeaders;
	body?: unknown;
	bodyText?: string;
	bodyBase64?: string;
	bodyUnavailable?: string;
	protocol?: string;
}

interface ReservedRequestDebugFile {
	id: number;
	requestPath: string;
	responsePath: string;
	handle: fs.FileHandle;
	overwrite: boolean;
}

export interface RequestDebugResponseLog {
	write(chunk: Uint8Array | string): void;
	close(): Promise<void>;
}

export interface RequestDebugSession {
	readonly id: number;
	readonly requestPath: string;
	readonly responsePath: string;
	openResponseLog(statusLine: string, headers?: RequestDebugHeaders): Promise<RequestDebugResponseLog>;
	wrapResponse(response: Response): Promise<Response>;
}

function isRequestDebugEnvEnabled(): boolean {
	return Bun.env[REQUEST_DEBUG_ENV] === "1";
}

export function isRequestDebugEnabled(): boolean {
	return isRequestDebugEnvEnabled();
}

export function wrapFetchForRequestDebug(fetchImpl: FetchImpl): FetchImpl {
	if (!isRequestDebugEnabled()) return fetchImpl;
	const maybeWrapped = fetchImpl as DebugFetch;
	if (maybeWrapped[DEBUG_FETCH_MARKER]) return fetchImpl;

	const wrapped = Object.assign(
		async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
			if (!isRequestDebugEnabled()) return fetchImpl(input, init);
			const session = await createFetchRequestDebugSession(input, init);
			const response = await fetchImpl(input, init);
			return session.wrapResponse(response);
		},
		fetchImpl.preconnect ? { preconnect: fetchImpl.preconnect } : {},
		{ [DEBUG_FETCH_MARKER]: true as const },
	);
	return wrapped;
}

export function withRequestDebugFetch<T extends { fetch?: FetchImpl } | undefined>(options: T): T {
	if (!isRequestDebugEnabled()) return options;
	const fetchImpl = options?.fetch ?? (globalThis.fetch as FetchImpl);
	const wrapped = wrapFetchForRequestDebug(fetchImpl);
	return { ...(options ?? {}), fetch: wrapped } as T;
}

export async function createRequestDebugSession(payload: RequestDebugPayload): Promise<RequestDebugSession> {
	const { id, requestPath, responsePath, handle, overwrite } = await reserveRequestDebugFile();
	const requestDump: Record<string, unknown> = {
		id,
		protocol: payload.protocol ?? "http",
		method: payload.method,
		url: payload.url,
	};
	const headers = headersToRecord(payload.headers);
	if (headers) requestDump.headers = headers;
	if (payload.body !== undefined) requestDump.body = payload.body;
	if (payload.bodyText !== undefined) requestDump.bodyText = payload.bodyText;
	if (payload.bodyBase64 !== undefined) requestDump.bodyBase64 = payload.bodyBase64;
	if (payload.bodyUnavailable !== undefined) requestDump.bodyUnavailable = payload.bodyUnavailable;

	try {
		await handle.writeFile(`${JSON.stringify(requestDump, null, 2)}\n`, "utf8");
	} finally {
		await handle.close();
	}

	return new FileRequestDebugSession(id, requestPath, responsePath, overwrite);
}

async function createFetchRequestDebugSession(
	input: string | URL | Request,
	init: RequestInit | undefined,
): Promise<RequestDebugSession> {
	const headers = resolveRequestHeaders(input, init);
	const body = await snapshotRequestBody(input, init, headers.get("content-type"));
	return createRequestDebugSession({
		method: resolveRequestMethod(input, init),
		url: resolveRequestUrl(input),
		headers,
		...body,
	});
}

class FileRequestDebugSession implements RequestDebugSession {
	readonly id: number;
	readonly requestPath: string;
	readonly responsePath: string;
	readonly #overwriteResponseLog: boolean;

	constructor(id: number, requestPath: string, responsePath: string, overwriteResponseLog: boolean) {
		this.id = id;
		this.requestPath = requestPath;
		this.responsePath = responsePath;
		this.#overwriteResponseLog = overwriteResponseLog;
	}

	async openResponseLog(statusLine: string, headers?: RequestDebugHeaders): Promise<RequestDebugResponseLog> {
		const handle = await fs.open(this.responsePath, this.#overwriteResponseLog ? "w" : "wx");
		const headerBlock = formatResponseHeaderBlock(statusLine, headers);
		await handle.write(textEncoder.encode(headerBlock));
		return new FileRequestDebugResponseLog(handle);
	}

	async wrapResponse(response: Response): Promise<Response> {
		const log = await this.openResponseLog(`HTTP ${response.status} ${response.statusText}`.trim(), response.headers);
		if (!response.body) {
			await log.close();
			return response;
		}

		const reader = response.body.getReader();
		const teed = new ReadableStream<Uint8Array>({
			async pull(controller) {
				try {
					const { done, value } = await reader.read();
					if (done) {
						await log.close();
						controller.close();
						return;
					}
					log.write(value);
					controller.enqueue(value);
				} catch (error) {
					await log.close().catch(() => undefined);
					controller.error(error);
				}
			},
			async cancel(reason) {
				try {
					await reader.cancel(reason);
				} finally {
					await log.close();
				}
			},
		});

		const wrapped = new Response(teed, {
			status: response.status,
			statusText: response.statusText,
			headers: response.headers,
		});
		copyResponseMetadata(wrapped, response);
		return wrapped;
	}
}

class FileRequestDebugResponseLog implements RequestDebugResponseLog {
	#handle: fs.FileHandle | undefined;
	#pending: Promise<void> = Promise.resolve();
	#closed: Promise<void> | undefined;

	constructor(handle: fs.FileHandle) {
		this.#handle = handle;
	}

	write(chunk: Uint8Array | string): void {
		const handle = this.#handle;
		if (!handle) return;
		const bytes = typeof chunk === "string" ? textEncoder.encode(chunk) : chunk.slice();
		this.#pending = this.#pending.then(async () => {
			await handle.write(bytes);
		});
	}

	close(): Promise<void> {
		if (this.#closed) return this.#closed;
		const handle = this.#handle;
		if (!handle) return Promise.resolve();
		this.#handle = undefined;
		this.#closed = (async () => {
			try {
				await this.#pending;
			} finally {
				await handle.close();
			}
		})();
		return this.#closed;
	}
}

function copyResponseMetadata(target: Response, source: Response): void {
	const sourceUrl = source.url;
	if (!sourceUrl) return;
	try {
		Object.defineProperty(target, "url", { value: sourceUrl, configurable: true });
	} catch {
		// Some runtimes may expose Response.url as non-configurable. The body
		// capture remains correct; callers that need url already tolerate the
		// platform default on other response wrappers in this package.
	}
}

async function reserveRequestDebugFile(): Promise<ReservedRequestDebugFile> {
	for (;;) {
		const id = nextSessionId++;
		const requestPath = `rr-session-${id}.json`;
		try {
			const handle = await fs.open(requestPath, "wx");
			return { id, requestPath, responsePath: `rr-session-${id}.res.log`, handle, overwrite: false };
		} catch (error) {
			if (isFileExistsError(error)) continue;
			throw error;
		}
	}
}

function resolveRequestMethod(input: string | URL | Request, init: RequestInit | undefined): string {
	return (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
}

function resolveRequestUrl(input: string | URL | Request): string {
	return input instanceof Request ? input.url : input.toString();
}

function resolveRequestHeaders(input: string | URL | Request, init: RequestInit | undefined): Headers {
	if (init?.headers) return new Headers(init.headers);
	return input instanceof Request ? new Headers(input.headers) : new Headers();
}

async function snapshotRequestBody(
	input: string | URL | Request,
	init: RequestInit | undefined,
	contentType: string | null,
): Promise<RequestDebugBody | undefined> {
	if (init?.body !== undefined && init.body !== null) return snapshotBodyInit(init.body, contentType);
	if (input instanceof Request && input.body) {
		return snapshotBytes(new Uint8Array(await input.clone().arrayBuffer()), contentType);
	}
	return undefined;
}

async function snapshotBodyInit(body: RequestBodyInit, contentType: string | null): Promise<RequestDebugBody> {
	if (typeof body === "string") return snapshotText(body, contentType);
	if (body instanceof URLSearchParams) return { bodyText: body.toString() };
	if (body instanceof FormData) return { bodyUnavailable: "FormData" };
	if (body instanceof Blob) return snapshotBytes(new Uint8Array(await body.arrayBuffer()), body.type || contentType);
	if (body instanceof ArrayBuffer) return snapshotBytes(new Uint8Array(body), contentType);
	if (ArrayBuffer.isView(body)) {
		return snapshotBytes(new Uint8Array(body.buffer, body.byteOffset, body.byteLength), contentType);
	}
	if (body instanceof ReadableStream) return { bodyUnavailable: "ReadableStream" };
	return { bodyText: String(body) };
}

function snapshotBytes(bytes: Uint8Array, contentType: string | null): RequestDebugBody {
	try {
		return snapshotText(utf8Decoder.decode(bytes), contentType);
	} catch {
		return { bodyBase64: Buffer.from(bytes).toString("base64") };
	}
}

function snapshotText(text: string, contentType: string | null): RequestDebugBody {
	if (isJsonContentType(contentType) || looksLikeJson(text)) {
		try {
			return { body: JSON.parse(text) };
		} catch {
			// Fall through to bodyText: malformed JSON is still useful as raw text.
		}
	}
	return { bodyText: text };
}

function isJsonContentType(contentType: string | null): boolean {
	if (!contentType) return false;
	const lower = contentType.toLowerCase();
	return lower.includes("application/json") || lower.includes("+json");
}

function looksLikeJson(text: string): boolean {
	const trimmed = text.trimStart();
	return trimmed.startsWith("{") || trimmed.startsWith("[");
}

function formatResponseHeaderBlock(statusLine: string, headers?: RequestDebugHeaders): string {
	const lines = [statusLine];
	const record = headersToRecord(headers);
	if (record) {
		for (const name in record) {
			const value = record[name];
			if (Array.isArray(value)) {
				for (const item of value) lines.push(`${name}: ${item}`);
			} else {
				lines.push(`${name}: ${value}`);
			}
		}
	}
	return `${lines.join("\r\n")}\r\n\r\n`;
}

function headersToRecord(headers: RequestDebugHeaders): Record<string, string | string[]> | undefined {
	if (!headers) return undefined;
	const record: Record<string, string | string[]> = {};
	let hasHeaders = false;
	if (headers instanceof Headers) {
		headers.forEach((value, key) => {
			hasHeaders = true;
			record[key] = value;
		});
	} else {
		for (const key in headers) {
			const value = headers[key];
			if (value === undefined || value === null) continue;
			hasHeaders = true;
			record[key] = Array.isArray(value) ? value.map(String) : String(value);
		}
	}
	return hasHeaders ? record : undefined;
}

function isFileExistsError(error: unknown): boolean {
	return typeof error === "object" && error !== null && (error as { code?: unknown }).code === "EEXIST";
}
