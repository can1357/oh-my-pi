import * as net from "node:net";
import * as tls from "node:tls";
import * as logger from "@oh-my-pi/pi-utils/logger";
import { AbortError } from "../error/abort";
import { StreamTimeoutError, ValidationError } from "../error/validation";
import type { FetchImpl } from "../types";

/**
 * Host:port of a proxy URL for logging. Proxy URLs can carry basic-auth
 * credentials, so never log the raw value.
 */
function proxyLogTarget(proxyUrl: string): string {
	try {
		return new URL(proxyUrl).host;
	} catch {
		return "<unparseable>";
	}
}

/**
 * Checks if a host is local or cloud metadata, which should always bypass the proxy
 * (e.g. localhost, 127/8, ::1, 169.254.169.254, metadata.google.internal).
 */
export function isLocalOrMetadataHost(host: string): boolean {
	const lowerHost = host.toLowerCase();

	// Hostnames: localhost and the cloud metadata service.
	if (lowerHost === "localhost" || lowerHost.endsWith(".localhost") || lowerHost === "metadata.google.internal") {
		return true;
	}

	// Strip IPv6 brackets before numeric checks.
	const ip = lowerHost.replace(/^\[|\]$/g, "");

	// IPv4 loopback (127/8), unspecified (0/8), RFC1918 private (10/8, 172.16/12,
	// 192.168/16) and link-local (169.254/16 — covers IMDS 169.254.169.254 and
	// ECS credentials 169.254.170.2). None are reachable through a remote egress
	// proxy, and credential/metadata probes must never leak to one.
	const v4 = ip.match(/^(\d{1,3})\.(\d{1,3})\.\d{1,3}\.\d{1,3}$/);
	if (v4) {
		const a = Number(v4[1]);
		const b = Number(v4[2]);
		if (a === 127 || a === 10 || a === 0) return true;
		if (a === 169 && b === 254) return true;
		if (a === 192 && b === 168) return true;
		if (a === 172 && b >= 16 && b <= 31) return true;
		return false;
	}

	// IPv6 loopback (::1), unspecified (::), link-local (fe80::/10) and
	// unique-local (fc00::/7 — covers EC2 IPv6 IMDS fd00:ec2::254).
	if (ip === "::1" || ip === "::") return true;
	if (/^fe[89ab][0-9a-f]:/.test(ip)) return true;
	if (/^f[cd][0-9a-f]{2}:/.test(ip)) return true;

	return false;
}

/**
 * Check if the url should bypass the proxy due to hard-coded localhost/metadata checks
 * or custom NO_PROXY/no_proxy environment variables rules.
 */
export function shouldBypassProxy(urlObj: URL): boolean {
	if (isLocalOrMetadataHost(urlObj.hostname)) {
		return true;
	}

	const noProxyVal = Bun.env.NO_PROXY || Bun.env.no_proxy;
	if (!noProxyVal) {
		return false;
	}

	const rules = noProxyVal
		.split(/[,\s]+/)
		.map(r => r.trim())
		.filter(Boolean);
	const targetHost = urlObj.hostname.toLowerCase();
	const targetPort = urlObj.port || (urlObj.protocol === "https:" || urlObj.protocol === "wss:" ? "443" : "80");

	for (const rule of rules) {
		if (rule === "*") {
			return true;
		}

		let ruleHost = rule.toLowerCase();
		let rulePort: string | undefined;

		if (ruleHost.includes("]:")) {
			const lastColon = ruleHost.lastIndexOf(":");
			rulePort = ruleHost.slice(lastColon + 1);
			ruleHost = ruleHost.slice(0, lastColon);
		} else if (!ruleHost.includes("]") && ruleHost.includes(":")) {
			const lastColon = ruleHost.lastIndexOf(":");
			rulePort = ruleHost.slice(lastColon + 1);
			ruleHost = ruleHost.slice(0, lastColon);
		}

		// Strip IPv6 brackets
		ruleHost = ruleHost.replace(/^\[|\]$/g, "");

		if (rulePort && rulePort !== targetPort) {
			continue;
		}

		// Match host part
		if (ruleHost.startsWith(".")) {
			const suffix = ruleHost;
			const cleanRule = ruleHost.slice(1);
			if (targetHost === cleanRule || targetHost.endsWith(suffix)) {
				return true;
			}
		} else {
			if (targetHost === ruleHost || targetHost.endsWith(`.${ruleHost}`)) {
				return true;
			}
		}
	}

	return false;
}

const proxyCache = new Map<string, string | undefined>();

/** Test seam: clears the provider proxy cache. */
export function __resetProxyCache(): void {
	proxyCache.clear();
}

/**
 * Normalizes provider id (e.g. github-copilot -> PI_PROXY_GITHUB_COPILOT) and looks it up.
 * If not found, falls back to PI_PROXY. Results are memoized because env values are static
 * for the lifetime of the process and this function is called for every outgoing request.
 */
export function getProxyForProvider(provider: string): string | undefined {
	if (proxyCache.has(provider)) {
		return proxyCache.get(provider);
	}

	const normalized = provider.toUpperCase().replace(/[^A-Z0-9]/g, "_");
	const envKey = `PI_PROXY_${normalized}`;
	const value = Bun.env[envKey] || Bun.env.PI_PROXY;
	proxyCache.set(provider, value);
	// Once per provider per process: a silently unproxied provider request is
	// otherwise indistinguishable from a proxied one until the region block
	// answers 403.
	logger.debug("provider proxy resolved", {
		provider,
		source: Bun.env[envKey] ? envKey : value ? "PI_PROXY" : "none",
		proxy: value ? proxyLogTarget(value) : undefined,
	});
	return value;
}

/** Resolves provider-specific and standard proxy variables for a target URL, honoring NO_PROXY. */
export function getProxyForUrl(provider: string, url: URL): string | undefined {
	if (shouldBypassProxy(url)) return undefined;
	const protocolProxy =
		url.protocol === "https:" || url.protocol === "wss:"
			? Bun.env.HTTPS_PROXY || Bun.env.https_proxy
			: Bun.env.HTTP_PROXY || Bun.env.http_proxy;
	return getProxyForProvider(provider) || protocolProxy || Bun.env.ALL_PROXY || Bun.env.all_proxy || undefined;
}

/**
 * Return `init` with `proxy: proxyUrl` set when the request should tunnel.
 * A caller-supplied `init.proxy` always wins (the innermost, most specific
 * decision); local/metadata hosts, NO_PROXY matches, and unparseable URLs
 * pass through unchanged.
 */
export function withProxyInit(
	input: string | URL | Request,
	init: RequestInit | undefined,
	proxyUrl: string,
): RequestInit | undefined {
	if ((init as { proxy?: unknown } | undefined)?.proxy) return init;
	const urlStr = input instanceof Request ? input.url : input.toString();
	let urlObj: URL;
	try {
		urlObj = new URL(urlStr);
	} catch {
		return init;
	}

	if (shouldBypassProxy(urlObj)) {
		// A NO_PROXY rule silencing a configured proxy is otherwise invisible
		// until the unproxied egress is refused; local hosts are routine.
		if (!isLocalOrMetadataHost(urlObj.hostname)) {
			logger.debug("proxy bypassed by NO_PROXY", {
				host: urlObj.host,
				noProxy: Bun.env.NO_PROXY || Bun.env.no_proxy,
			});
		}
		return init;
	}

	const proxied: RequestInit & { proxy: string } = { ...init, proxy: proxyUrl };
	return proxied;
}

/** Wraps `fetchImpl` so non-local requests tunnel through `proxyUrl`; see {@link withProxyInit}. */
function wrapFetchWithProxyUrl(fetchImpl: FetchImpl, proxyUrl: string | undefined): FetchImpl {
	if (!proxyUrl) {
		return fetchImpl;
	}

	const wrapped = (input: string | URL | Request, init?: RequestInit): Promise<Response> =>
		fetchImpl(input, withProxyInit(input, init, proxyUrl));

	if (fetchImpl.preconnect) {
		wrapped.preconnect = fetchImpl.preconnect;
	}
	return wrapped;
}

/**
 * Wraps a fetch implementation to inject proxy options for non-local hosts.
 */
export function wrapFetchForProxy(fetchImpl: FetchImpl, provider: string): FetchImpl {
	return wrapFetchWithProxyUrl(fetchImpl, getProxyForProvider(provider));
}

let globalProxyFetchInstalled = false;

/** Test seam: re-arms {@link installGlobalProxyFetch}. */
export function __resetGlobalProxyFetch(): void {
	globalProxyFetchInstalled = false;
}

/**
 * Routes the process-wide `globalThis.fetch` through `PI_PROXY`.
 *
 * Bun's native fetch resolves `HTTPS_PROXY` / `HTTP_PROXY` / `ALL_PROXY` by
 * itself but knows nothing about `PI_PROXY`. Provider *streams* get their proxy
 * from {@link wrapFetchForProxy}; every other provider-bound request — OAuth
 * token refresh and login, usage probes, model discovery — goes out through the
 * bare global `fetch` and would silently ignore `PI_PROXY`. That asymmetry is
 * fatal wherever a provider geo-blocks its token endpoint: the stream is
 * proxied, the refresh is not, and the credential dies with a 403.
 *
 * A per-request `proxy` (including `PI_PROXY_<PROVIDER>` injected by
 * {@link wrapFetchForProxy}) still wins, and loopback / private-range /
 * `NO_PROXY` targets bypass, so local model servers and MCP hosts are
 * untouched. Idempotent; a no-op when `PI_PROXY` is unset.
 */
export function installGlobalProxyFetch(): void {
	if (globalProxyFetchInstalled) return;
	const proxyUrl = Bun.env.PI_PROXY?.trim();
	// One line naming every proxy-relevant variable this process can see: a
	// missing PI_PROXY and a NO_PROXY rule that silences it are otherwise
	// indistinguishable from a working proxy that the peer rejected.
	const env = {
		PI_PROXY: proxyUrl ? proxyLogTarget(proxyUrl) : undefined,
		PI_PROXY_ANTHROPIC: Bun.env.PI_PROXY_ANTHROPIC ? proxyLogTarget(Bun.env.PI_PROXY_ANTHROPIC) : undefined,
		HTTPS_PROXY: Bun.env.HTTPS_PROXY || Bun.env.https_proxy ? "set" : undefined,
		ALL_PROXY: Bun.env.ALL_PROXY || Bun.env.all_proxy ? "set" : undefined,
		NO_PROXY: Bun.env.NO_PROXY || Bun.env.no_proxy,
	};
	if (!proxyUrl) {
		logger.debug("global proxy fetch not installed", {
			reason: "PI_PROXY unset",
			env,
		});
		return;
	}
	globalProxyFetchInstalled = true;
	globalThis.fetch = wrapFetchWithProxyUrl(globalThis.fetch, proxyUrl) as typeof globalThis.fetch;
	logger.debug("global proxy fetch installed", {
		proxy: proxyLogTarget(proxyUrl),
		env,
	});
}

export interface ConnectProxiedSocketOptions {
	/** Caller cancellation for the proxy TCP/TLS handshake and CONNECT tunnel. */
	signal?: AbortSignal;
	/** Maximum wall-clock time to establish the final TLS tunnel. Disabled when absent or non-positive. */
	timeoutMs?: number;
	/** Target TLS profile. Cursor defaults to HTTP/2 when this is absent. */
	tls?: tls.ConnectionOptions;
}

/**
 * Tunnel a socket connection through an HTTP CONNECT proxy.
 * This is used specifically to wrap Node's `http2.connect(baseUrl, { createConnection })` for Cursor.
 */
export async function connectProxiedSocket(
	proxyUrlStr: string,
	targetUrlStr: string,
	options?: ConnectProxiedSocketOptions,
): Promise<tls.TLSSocket> {
	if (options?.signal?.aborted) {
		throw new AbortError("Proxy tunnel aborted");
	}

	const proxyUrl = new URL(proxyUrlStr);
	const targetUrl = new URL(targetUrlStr);

	const useProxySsl = proxyUrl.protocol === "https:";
	const proxyPort = proxyUrl.port ? parseInt(proxyUrl.port, 10) : useProxySsl ? 443 : 80;
	const proxyHost = proxyUrl.hostname;

	const targetPort = targetUrl.port ? parseInt(targetUrl.port, 10) : 443;
	const targetHost = targetUrl.hostname;

	const { promise, resolve, reject } = Promise.withResolvers<tls.TLSSocket>();

	const readyEvent = useProxySsl ? "secureConnect" : "connect";
	let tunnelSocket: tls.TLSSocket | undefined;
	let timeout: NodeJS.Timeout | undefined;
	let responseData = "";
	let settled = false;

	const cleanup = (): void => {
		if (timeout) {
			clearTimeout(timeout);
			timeout = undefined;
		}
		options?.signal?.removeEventListener("abort", onAbort);
		rawSocket?.off("error", onRawError);
		rawSocket?.off(readyEvent, onProxyReady);
		rawSocket?.off("data", onProxyData);
		tunnelSocket?.off("secureConnect", onTunnelReady);
		tunnelSocket?.off("error", onTunnelError);
	};
	const destroyInProgress = (): void => {
		tunnelSocket?.destroy();
		rawSocket?.destroy();
	};
	const rejectOnce = (error: Error): void => {
		if (settled) return;
		settled = true;
		cleanup();
		destroyInProgress();
		logger.debug("proxy tunnel failed", {
			proxy: `${proxyHost}:${proxyPort}`,
			target: `${targetHost}:${targetPort}`,
			error: String(error),
			code: "code" in error ? String(error.code) : undefined,
		});
		reject(error);
	};
	const resolveOnce = (socket: tls.TLSSocket): void => {
		if (settled) return;
		settled = true;
		cleanup();
		resolve(socket);
	};
	const onAbort = (): void => rejectOnce(new AbortError("Proxy tunnel aborted"));
	const onRawError = (error: Error): void => rejectOnce(error);
	const onTunnelError = (error: Error): void => rejectOnce(error);
	const onTunnelReady = (): void => {
		if (!tunnelSocket) return;
		logger.debug("proxy tunnel established", {
			proxy: `${proxyHost}:${proxyPort}`,
			target: `${targetHost}:${targetPort}`,
			peer: `${rawSocket?.remoteAddress ?? "?"}:${rawSocket?.remotePort ?? "?"}`,
			localPort: rawSocket?.localPort,
			alpn: tunnelSocket.alpnProtocol,
			authorized: tunnelSocket.authorized,
		});
		resolveOnce(tunnelSocket);
	};
	const onProxyData = (chunk: Buffer): void => {
		if (!rawSocket) return;
		responseData += chunk.toString("binary");
		if (!responseData.includes("\r\n\r\n")) return;

		rawSocket.off("data", onProxyData);
		rawSocket.off("error", onRawError);

		const firstLine = responseData.split("\r\n")[0];
		logger.debug("proxy tunnel CONNECT reply", {
			proxy: `${proxyHost}:${proxyPort}`,
			target: `${targetHost}:${targetPort}`,
			reply: firstLine,
		});
		if (!firstLine.includes(" 200 ")) {
			rejectOnce(new ValidationError(`Proxy tunnel failed: ${firstLine}`));
			return;
		}

		const tlsOptions = options?.tls;
		tunnelSocket = tls.connect({
			...tlsOptions,
			socket: rawSocket,
			servername: tlsOptions?.servername ?? targetHost,
			ALPNProtocols: tlsOptions?.ALPNProtocols ?? ["h2"],
		});
		tunnelSocket.once("secureConnect", onTunnelReady);
		tunnelSocket.once("error", onTunnelError);
	};
	const onProxyReady = (): void => {
		if (!rawSocket) return;
		let connectReq = `CONNECT ${targetHost}:${targetPort} HTTP/1.1\r\n` + `Host: ${targetHost}:${targetPort}\r\n`;

		if (proxyUrl.username || proxyUrl.password) {
			const creds = Buffer.from(
				`${decodeURIComponent(proxyUrl.username)}:${decodeURIComponent(proxyUrl.password)}`,
			).toString("base64");
			connectReq += `Proxy-Authorization: Basic ${creds}\r\n`;
		}
		connectReq += "\r\n";

		rawSocket.write(connectReq);
		rawSocket.on("data", onProxyData);
		logger.debug("proxy tunnel CONNECT sent", {
			proxy: `${proxyHost}:${proxyPort}`,
			target: `${targetHost}:${targetPort}`,
			peer: `${rawSocket.remoteAddress ?? "?"}:${rawSocket.remotePort ?? "?"}`,
		});
	};

	options?.signal?.addEventListener("abort", onAbort, { once: true });
	if (options?.timeoutMs !== undefined && Number.isFinite(options.timeoutMs) && options.timeoutMs > 0) {
		const timeoutMs = Math.trunc(options.timeoutMs);
		timeout = setTimeout(() => {
			rejectOnce(new StreamTimeoutError(`Proxy tunnel timed out after ${timeoutMs}ms`));
		}, timeoutMs);
		timeout.unref?.();
	}

	const rawSocket = useProxySsl
		? tls.connect({
				host: proxyHost,
				port: proxyPort,
			})
		: net.connect({
				host: proxyHost,
				port: proxyPort,
			});
	rawSocket.once("error", onRawError);
	rawSocket.once(readyEvent, onProxyReady);

	return promise;
}
