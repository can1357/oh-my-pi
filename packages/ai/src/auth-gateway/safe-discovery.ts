import * as net from "node:net";
import { untilAborted } from "@oh-my-pi/pi-utils";

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
 * and resolved-address checks pin the request to a validated IP. The returned array is unvalidated.
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
	const target = new URL(parsed.href);
	if (opts?.allowPrivate !== true) {
		const host = parsed.hostname.replace(/^\[|\]$/g, "");
		if (net.isIP(host) === 0) {
			let addresses: Bun.DNSLookup[];
			try {
				addresses = await untilAborted(init.signal, Bun.dns.lookup(host));
			} catch (error) {
				throw wrapDiscoveryError(error, "discovery DNS lookup failed");
			}
			if (
				addresses.length === 0 ||
				addresses.some(row => net.isIP(row.address) === 0 || isPrivateHostname(row.address))
			) {
				throw new SafeDiscoveryError("discovery hostname resolves to a private or invalid address");
			}
			const address = addresses[0]!.address;
			target.hostname = net.isIP(address) === 6 ? `[${address}]` : address;
			init.headers = { Host: parsed.host };
			if (parsed.protocol === "https:") init.tls = { serverName: host };
		}
	}

	let response: Response;
	try {
		response = await fetch(target.href, init);
	} catch (err) {
		throw wrapDiscoveryError(err, "discovery fetch failed");
	}

	if (!response.ok) {
		await cancelBody(response);
		throw new SafeDiscoveryError(`discovery endpoint returned HTTP ${response.status}`);
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

const privateAddresses = new net.BlockList();
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
for (const [address, prefix] of [
	["::", 128],
	["::1", 128],
	["fc00::", 7],
	["fe80::", 10],
	["ff00::", 8],
] as const) {
	privateAddresses.addSubnet(address, prefix, "ipv6");
}

function isPrivateHostname(hostname: string): boolean {
	const host = hostname
		.toLowerCase()
		.replace(/^\[|\]$/g, "")
		.replace(/\.+$/, "");
	if (host === "localhost" || host.endsWith(".localhost")) return true;
	// IPv4-mapped IPv6 literals (`::ffff:a00:1`) are not in the IPv4 BlockList —
	// unwrap them or the private-range check silently misses.
	const mapped = ipv4FromMappedIpv6(host);
	if (mapped !== undefined) return privateAddresses.check(mapped, "ipv4");
	const family = net.isIP(host);
	return family !== 0 && privateAddresses.check(host, family === 4 ? "ipv4" : "ipv6");
}

/** Expand an IPv6 literal to 8 hextets, or return undefined when invalid. */
function expandIpv6(host: string): number[] | undefined {
	if (net.isIPv6(host) !== true) return undefined;
	const halves = host.split("::");
	if (halves.length > 2) return undefined;
	const head = (halves[0] ?? "").split(":").filter(s => s.length > 0);
	const tail = halves.length === 2 ? halves[1]!.split(":").filter(s => s.length > 0) : [];
	// A mapped/compatible literal may carry a dotted IPv4 tail — convert it to
	// the two hextets it encodes (`::ffff:10.0.0.1` → hextets a00, 1).
	const last = tail[tail.length - 1] ?? head[head.length - 1];
	const v4hextets: string[] = [];
	if (last !== undefined && last.includes(".")) {
		if (net.isIPv4(last) !== true) return undefined;
		const octets = last.split(".").map(Number);
		v4hextets.push(((octets[0]! << 8) | octets[1]!).toString(16), ((octets[2]! << 8) | octets[3]!).toString(16));
		if (tail.length > 0) tail.pop();
		else head.pop();
	}
	const hextets = [...head, ...Array(8 - head.length - tail.length - v4hextets.length).fill("0"), ...tail, ...v4hextets];
	if (hextets.length !== 8) return undefined;
	const parsed = hextets.map(h => parseInt(h, 16));
	return parsed.some(n => Number.isNaN(n) || n < 0 || n > 0xffff) ? undefined : parsed;
}

/** `::ffff:10.0.0.1` / `0:0:0:0:0:ffff:a00:1` → `10.0.0.1`, else undefined. */
function ipv4FromMappedIpv6(host: string): string | undefined {
	const hextets = expandIpv6(host);
	if (hextets === undefined) return undefined;
	if (hextets.slice(0, 5).some(h => h !== 0) || hextets[5] !== 0xffff) return undefined;
	const hi = hextets[6]!;
	const lo = hextets[7]!;
	return `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;
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
