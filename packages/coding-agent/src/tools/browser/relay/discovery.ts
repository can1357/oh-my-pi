/** Per-user discovery for terminal clients; sidebar chats never publish an endpoint. */
import * as fs from "node:fs";
import * as path from "node:path";
import { getBrowserRelayInstallRegistryFile } from "@oh-my-pi/pi-utils/dirs";

function discoveryDir(): string {
	return path.join(path.dirname(getBrowserRelayInstallRegistryFile()), "endpoints");
}

/** Publish an OS-assigned port for this host's lifetime. */
export async function publishRelayEndpoint(port: number): Promise<() => Promise<void>> {
	const file = path.join(discoveryDir(), `${process.pid}-${port}`);
	await Bun.write(file, "", { mode: 0o600 });
	return () => fs.promises.unlink(file).catch(() => {});
}

/** Discover live local relay hosts, preferring the most recently started. */
export function discoverRelayEndpoints(): string[] {
	const dir = discoveryDir();
	let names: string[];
	try {
		names = fs.readdirSync(dir);
	} catch {
		return [];
	}
	return names
		.flatMap(name => {
			const match = /^(\d+)-(\d+)$/.exec(name);
			if (!match) return [];
			const pid = Number(match[1]);
			const port = Number(match[2]);
			if (pid < 1 || port < 1 || port > 65535) return [];
			try {
				process.kill(pid, 0);
				return [{ port, started: fs.statSync(path.join(dir, name)).mtimeMs }];
			} catch {
				return [];
			}
		})
		.sort((a, b) => b.started - a.started)
		.map(({ port }) => `http://127.0.0.1:${port}`);
}

/** A relay URL without the whitespace and trailing slashes a setting or an `app` may carry. */
function trimRelayUrl(cdpUrl: string): string {
	return cdpUrl.trim().replace(/\/+$/, "");
}

/** Port of a loopback origin (`127.0.0.1`, `localhost`, `::1`), or null when `cdpUrl` is not one. */
function loopbackRelayPort(cdpUrl: string): number | null {
	try {
		const url = new URL(cdpUrl);
		const host = url.hostname;
		if (host !== "127.0.0.1" && host !== "localhost" && host !== "[::1]" && host !== "::1") return null;
		if (url.pathname !== "/" && url.pathname !== "") return null;
		const port = url.port !== "" ? Number(url.port) : url.protocol === "https:" ? 443 : 80;
		return port >= 1 && port <= 65535 ? port : null;
	} catch {
		return null;
	}
}

/**
 * Whether `cdpUrl` names a relay an open can pick by URL: the configured `browser.relayUrl`, or a live local host
 * (each Chrome profile running the omp extension serves one). `localhost` and `127.0.0.1` for the same port are the
 * same relay. Any other URL is a browser to attach to.
 */
export function isRelayEndpointUrl(cdpUrl: string, configuredUrl?: string): boolean {
	const url = trimRelayUrl(cdpUrl);
	if (!url) return false;
	const configured = configuredUrl?.trim();
	if (configured && trimRelayUrl(configured) === url) return true;
	const port = loopbackRelayPort(url);
	if (port === null) return false;
	return discoverRelayEndpoints().some(endpoint => loopbackRelayPort(endpoint) === port);
}

/**
 * The relays an open with `target` looks for the page in: the configured `browser.relayUrl` alone (it names one
 * relay), otherwise every live local host, `preferred` (the relay a new tab opens in) first.
 */
export function relayEndpointsToSearch(preferred: string, configuredUrl?: string): string[] {
	const configured = configuredUrl?.trim();
	if (configured) return [trimRelayUrl(configured)];
	const others = discoverRelayEndpoints().filter(endpoint => endpoint !== preferred);
	return preferred ? [preferred, ...others] : others;
}
