export interface SafeDiscoveryOptions {
	allowPrivate?: boolean;
	allowHttp?: boolean;
	maxBytes?: number;
	maxModels?: number;
	timeoutMs?: number;
}

export class SafeDiscoveryError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "SafeDiscoveryError";
	}
}

const DEFAULT_MAX_BYTES = 1_000_000;
const DEFAULT_MAX_MODELS = 10_000;

/**
 * Fetch a model-list URL with SSRF and size guards. Hostname private-range
 * checks only — no DNS pinning. The returned array is unvalidated.
 */
export async function safeDiscoverModels(url: string, opts?: SafeDiscoveryOptions): Promise<readonly unknown[]> {
	const parsed = parseDiscoveryUrl(url);
	assertUrlAllowed(parsed, opts);

	const maxBytes = opts?.maxBytes ?? DEFAULT_MAX_BYTES;
	const maxModels = opts?.maxModels ?? DEFAULT_MAX_MODELS;

	const init: RequestInit = {
		method: "GET",
		redirect: "error",
	};
	if (opts?.timeoutMs !== undefined) {
		init.signal = AbortSignal.timeout(opts.timeoutMs);
	}

	let response: Response;
	try {
		response = await fetch(parsed.href, init);
	} catch (err) {
		throw wrapDiscoveryError(err, "discovery fetch failed");
	}

	const text = await readLimitedBody(response, maxBytes);

	let parsedJson: unknown;
	try {
		parsedJson = JSON.parse(text) as unknown;
	} catch (err) {
		throw wrapDiscoveryError(err, "discovery response is not JSON");
	}

	const models = extractModelArray(parsedJson);
	if (models.length > maxModels) {
		throw new SafeDiscoveryError(`model list exceeds maxModels (${maxModels})`);
	}
	return models;
}

function parseDiscoveryUrl(url: string): URL {
	try {
		return new URL(url);
	} catch (err) {
		throw wrapDiscoveryError(err, "invalid discovery URL");
	}
}

function assertUrlAllowed(parsed: URL, opts: SafeDiscoveryOptions | undefined): void {
	const protocol = parsed.protocol;
	if (protocol !== "http:" && protocol !== "https:") {
		throw new SafeDiscoveryError(`unsupported discovery URL protocol: ${protocol}`);
	}
	if (protocol === "http:" && opts?.allowHttp !== true) {
		throw new SafeDiscoveryError("http discovery URLs require allowHttp");
	}
	const hostname = parsed.hostname;
	if (hostname === "") {
		throw new SafeDiscoveryError("discovery URL is missing a hostname");
	}
	if (opts?.allowPrivate !== true && isPrivateHostname(hostname)) {
		throw new SafeDiscoveryError(`private discovery hostname is not allowed: ${hostname}`);
	}
}

function isPrivateHostname(hostname: string): boolean {
	let host = hostname.toLowerCase();
	if (host.startsWith("[") && host.endsWith("]")) {
		host = host.slice(1, -1);
	}
	while (host.endsWith(".")) {
		host = host.slice(0, -1);
	}
	if (host === "localhost" || host === "::1" || host === "0.0.0.0") {
		return true;
	}
	const v4 = parseIPv4(host);
	if (v4 === undefined) {
		return false;
	}
	const a = v4[0];
	const b = v4[1];
	if (a === 127) return true;
	if (a === 10) return true;
	if (a === 192 && b === 168) return true;
	if (a === 169 && b === 254) return true;
	return false;
}

function parseIPv4(hostname: string): readonly [number, number, number, number] | undefined {
	const parts = hostname.split(".");
	if (parts.length !== 4) return undefined;
	const a = parseOctet(parts[0]);
	const b = parseOctet(parts[1]);
	const c = parseOctet(parts[2]);
	const d = parseOctet(parts[3]);
	if (a === undefined || b === undefined || c === undefined || d === undefined) {
		return undefined;
	}
	return [a, b, c, d];
}

function parseOctet(part: string | undefined): number | undefined {
	if (part === undefined || !/^(?:0|[1-9]\d{0,2})$/.test(part)) return undefined;
	const n = Number(part);
	if (n > 255) return undefined;
	return n;
}

async function readLimitedBody(response: Response, maxBytes: number): Promise<string> {
	const declared = parseContentLength(response.headers.get("content-length"));
	if (declared !== undefined && declared > maxBytes) {
		await cancelBody(response);
		throw new SafeDiscoveryError(`response exceeds maxBytes (${maxBytes})`);
	}

	const body = response.body;
	if (body === null) {
		return "";
	}

	const reader = body.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		if (value === undefined) continue;
		total += value.byteLength;
		if (total > maxBytes) {
			await reader.cancel();
			throw new SafeDiscoveryError(`response exceeds maxBytes (${maxBytes})`);
		}
		chunks.push(value);
	}
	if (total === 0) return "";
	return new TextDecoder().decode(concatBytes(chunks, total));
}

function parseContentLength(header: string | null): number | undefined {
	if (header === null) return undefined;
	const trimmed = header.trim();
	if (trimmed === "" || !/^\d+$/.test(trimmed)) return undefined;
	const n = Number(trimmed);
	if (!Number.isSafeInteger(n)) return undefined;
	return n;
}

async function cancelBody(response: Response): Promise<void> {
	const body = response.body;
	if (body === null) return;
	try {
		await body.cancel();
	} catch {
		// Body may already be locked or closed.
	}
}

function concatBytes(chunks: readonly Uint8Array[], total: number): Uint8Array {
	if (chunks.length === 1) {
		const only = chunks[0];
		if (only !== undefined) return only;
	}
	const out = new Uint8Array(total);
	let offset = 0;
	for (const chunk of chunks) {
		out.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return out;
}

function extractModelArray(parsed: unknown): unknown[] {
	if (Array.isArray(parsed)) return parsed;
	if (parsed !== null && typeof parsed === "object" && "data" in parsed && Array.isArray(parsed.data)) {
		return parsed.data;
	}
	throw new SafeDiscoveryError("discovery response is not a model list");
}

function wrapDiscoveryError(err: unknown, fallback: string): SafeDiscoveryError {
	if (err instanceof SafeDiscoveryError) return err;
	if (err instanceof Error && err.message !== "") {
		return new SafeDiscoveryError(err.message);
	}
	return new SafeDiscoveryError(fallback);
}
