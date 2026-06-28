import * as net from "node:net";
import * as tls from "node:tls";
import * as AIError from "../error";
import type { FetchImpl } from "../types";

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
	const targetPort = urlObj.port || (urlObj.protocol === "https:" ? "443" : "80");

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
	return value;
}

/**
 * Wraps a fetch implementation to inject proxy options for non-local hosts.
 */
export function wrapFetchForProxy(fetchImpl: FetchImpl, provider: string): FetchImpl {
	const proxyUrl = getProxyForProvider(provider);
	if (!proxyUrl) {
		return fetchImpl;
	}

	const wrapped = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
		const urlStr = input instanceof Request ? input.url : input.toString();
		let urlObj: URL;
		try {
			urlObj = new URL(urlStr);
		} catch {
			// Fallback to calling fetch unmodified if URL is unparseable
			return fetchImpl(input, init);
		}

		if (shouldBypassProxy(urlObj)) {
			return fetchImpl(input, init);
		}

		const mergedInit = { ...(init ?? {}), proxy: proxyUrl };
		return fetchImpl(input, mergedInit);
	};

	if (fetchImpl.preconnect) {
		wrapped.preconnect = fetchImpl.preconnect;
	}
	return wrapped;
}

/**
 * Tunnel a socket connection through an HTTP CONNECT proxy.
 * This is used specifically to wrap Node's `http2.connect(baseUrl, { createConnection })` for Cursor.
 */
export async function connectProxiedSocket(proxyUrlStr: string, targetUrlStr: string): Promise<tls.TLSSocket> {
	const proxyUrl = new URL(proxyUrlStr);
	const targetUrl = new URL(targetUrlStr);

	const useProxySsl = proxyUrl.protocol === "https:";
	const proxyPort = proxyUrl.port ? parseInt(proxyUrl.port, 10) : useProxySsl ? 443 : 80;
	const proxyHost = proxyUrl.hostname;

	const targetPort = targetUrl.port ? parseInt(targetUrl.port, 10) : 443;
	const targetHost = targetUrl.hostname;

	const { promise, resolve, reject } = Promise.withResolvers<tls.TLSSocket>();

	let rawSocket: net.Socket;
	if (useProxySsl) {
		rawSocket = tls.connect({
			host: proxyHost,
			port: proxyPort,
		});
	} else {
		rawSocket = net.connect({
			host: proxyHost,
			port: proxyPort,
		});
	}

	rawSocket.once("error", reject);

	const readyEvent = useProxySsl ? "secureConnect" : "connect";
	rawSocket.once(readyEvent, () => {
		let connectReq = `CONNECT ${targetHost}:${targetPort} HTTP/1.1\r\n` + `Host: ${targetHost}:${targetPort}\r\n`;

		if (proxyUrl.username || proxyUrl.password) {
			const creds = Buffer.from(
				`${decodeURIComponent(proxyUrl.username)}:${decodeURIComponent(proxyUrl.password)}`,
			).toString("base64");
			connectReq += `Proxy-Authorization: Basic ${creds}\r\n`;
		}
		connectReq += "\r\n";

		rawSocket.write(connectReq);

		let responseData = "";
		const onData = (chunk: Buffer) => {
			responseData += chunk.toString("binary");
			if (responseData.includes("\r\n\r\n")) {
				rawSocket.off("data", onData);
				rawSocket.off("error", reject);

				const firstLine = responseData.split("\r\n")[0];
				if (firstLine.includes(" 200 ")) {
					const tlsSocket = tls.connect({
						socket: rawSocket,
						servername: targetHost,
						ALPNProtocols: ["h2"],
					});

					tlsSocket.once("secureConnect", () => {
						resolve(tlsSocket);
					});
					tlsSocket.once("error", reject);
				} else {
					rawSocket.destroy();
					reject(new AIError.ValidationError(`Proxy tunnel failed: ${firstLine}`));
				}
			}
		};
		rawSocket.on("data", onData);
	});

	return promise;
}
