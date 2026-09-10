import { BlockList, isIP } from "node:net";

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

const privateAddresses = new BlockList();
for (const [address, prefix] of [
	["0.0.0.0", 8],
	["10.0.0.0", 8],
	["100.64.0.0", 10],
	["127.0.0.0", 8],
	["169.254.0.0", 16],
	["172.16.0.0", 12],
	["192.168.0.0", 16],
	["224.0.0.0", 4],
	["240.0.0.0", 4],
] as const)
	privateAddresses.addSubnet(address, prefix, "ipv4");
privateAddresses.addAddress("::", "ipv6");
privateAddresses.addAddress("::1", "ipv6");
privateAddresses.addSubnet("fc00::", 7, "ipv6");
privateAddresses.addSubnet("fe80::", 10, "ipv6");
privateAddresses.addSubnet("ff00::", 8, "ipv6");

/**
 * Fetch a model-list URL with address pinning and size guards.
 * The returned array is unvalidated.
 */
export async function safeDiscoverModels(url: string, opts?: SafeDiscoveryOptions): Promise<readonly unknown[]> {
	const parsed = parseDiscoveryUrl(url);
	assertUrlAllowed(parsed, opts);

	const maxBytes = opts?.maxBytes ?? DEFAULT_MAX_BYTES;
	const maxModels = opts?.maxModels ?? DEFAULT_MAX_MODELS;

	const init: BunFetchRequestInit = {
		method: "GET",
		redirect: "error",
	};
	if (opts?.timeoutMs !== undefined) {
		init.signal = AbortSignal.timeout(opts.timeoutMs);
	}
	if (opts?.allowPrivate !== true) {
		const hostname = parsed.hostname.replace(/^\[|\]$/g, "");
		if (isIP(hostname) === 0) {
			const answers = await Bun.dns.lookup(hostname);
			if (answers.length === 0) throw new SafeDiscoveryError("discovery hostname has no addresses");
			if (answers.some(answer => isPrivateHostname(answer.address))) {
				throw new SafeDiscoveryError("private discovery DNS address is not allowed");
			}
			const address = answers[0].address;
			init.headers = { Host: parsed.host };
			init.tls = { serverName: hostname };
			parsed.hostname = isIP(address) === 6 ? `[${address}]` : address;
		}
	}

	let response: Response;
	try {
		response = await fetch(parsed.href, init);
	} catch (err) {
		throw wrapDiscoveryError(err, "discovery fetch failed");
	}

	if (!response.ok) {
		await cancelBody(response);
		throw new SafeDiscoveryError(`discovery returned HTTP ${response.status}`);
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
	if (host === "localhost" || host.endsWith(".localhost")) return true;
	const family = isIP(host);
	return family !== 0 && privateAddresses.check(host, family === 6 ? "ipv6" : "ipv4");
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
