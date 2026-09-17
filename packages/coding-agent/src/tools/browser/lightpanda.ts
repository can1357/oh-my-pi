import * as net from "node:net";
import { $which, logger } from "@oh-my-pi/pi-utils";
import type { Browser } from "puppeteer-core";
import { ToolError } from "../tool-errors";
import { BROWSER_PROTOCOL_TIMEOUT_MS, loadPuppeteer } from "./launch";

export type BrowserEngineKind = "chromium" | "lightpanda";

export function resolveBrowserEngine(requested?: string): BrowserEngineKind {
	const envEngine = process.env.OMP_BROWSER_ENGINE?.toLowerCase().trim();
	if (requested === "lightpanda" || envEngine === "lightpanda") {
		return "lightpanda";
	}
	return "chromium";
}

export async function findLightpandaExecutable(): Promise<string | undefined> {
	if (process.env.LIGHTPANDA_PATH) {
		return process.env.LIGHTPANDA_PATH;
	}
	const inPath = await $which("lightpanda");
	if (inPath) return inPath;
	return undefined;
}

export interface LightpandaLaunchResult {
	browser: Browser;
	wsEndpoint: string;
	close(): Promise<void>;
}

async function getFreePort(): Promise<number> {
	const server = net.createServer();
	const { promise, resolve, reject } = Promise.withResolvers<number>();
	server.listen(0, "127.0.0.1", () => {
		const address = server.address();
		const port = typeof address === "object" && address !== null ? address.port : 9222;
		server.close(() => resolve(port));
	});
	server.on("error", reject);
	return promise;
}

export async function launchLightpandaBrowser(): Promise<LightpandaLaunchResult> {
	const lightpandaPath = await findLightpandaExecutable();
	if (!lightpandaPath) {
		throw new ToolError(
			"Lightpanda browser binary not found. Set LIGHTPANDA_PATH or install lightpanda into PATH.",
		);
	}

	const port = await getFreePort();
	const host = "127.0.0.1";
	const wsEndpoint = `ws://${host}:${port}`;

	logger.info("Spawning Lightpanda browser instance", { lightpandaPath, wsEndpoint });

	const proc = Bun.spawn({
		cmd: [lightpandaPath, "--host", host, "--port", String(port)],
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
	});

	const puppeteer = await loadPuppeteer();

	// Wait briefly for Lightpanda CDP server to listen
	let connectedBrowser: Browser | undefined;
	const deadline = Date.now() + 5_000;

	while (Date.now() < deadline) {
		if (proc.exitCode !== null) {
			const stderrText = await new Response(proc.stderr).text();
			throw new ToolError(`Lightpanda process exited unexpectedly (code ${proc.exitCode}): ${stderrText}`);
		}
		try {
			connectedBrowser = await puppeteer.connect({
				browserWSEndpoint: wsEndpoint,
				protocolTimeout: BROWSER_PROTOCOL_TIMEOUT_MS,
			});
			break;
		} catch {
			await Bun.sleep(50);
		}
	}

	if (!connectedBrowser) {
		proc.kill("SIGKILL");
		throw new ToolError(`Failed to connect to Lightpanda CDP WebSocket at ${wsEndpoint} within 5s`);
	}

	return {
		browser: connectedBrowser,
		wsEndpoint,
		async close() {
			try {
				await connectedBrowser?.disconnect();
			} catch {}
			try {
				proc.kill("SIGKILL");
			} catch {}
		},
	};
}
