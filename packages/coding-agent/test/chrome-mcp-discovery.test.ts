import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { getConfigRootDir, getMCPConfigPath, setAgentDir } from "@oh-my-pi/pi-utils";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import {
	CHROME_MCP_PROBE_TIMEOUT_MS,
	CHROME_MCP_SERVER_NAME,
	discoverChromeMcp,
	probeChromeMcp,
} from "@oh-my-pi/pi-coding-agent/mcp/auto-chrome-mcp";
import { loadAllMCPConfigs } from "@oh-my-pi/pi-coding-agent/mcp/config";
import { createBrowserPreludeDefinition } from "@oh-my-pi/pi-coding-agent/tools/browser/prelude-definition";
import { cfgBrowserChromeMcp } from "@oh-my-pi/pi-coding-agent/tools/browser/settings";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/sdk";

const TOOLS = [
	{ name: "chrome_navigate", description: "Navigate a tab", inputSchema: { type: "object" } },
	{ name: "chrome_get_web_content", description: "Read a page", inputSchema: { type: "object" } },
];

interface RecordedRequest {
	method: string;
	origin: string | null;
	sessionId: string | null;
}

let server: Bun.Server<undefined> | null = null;
const tempDirs: string[] = [];
const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
const fallbackAgentDir = path.join(getConfigRootDir(), "agent");

beforeEach(async () => {
	// User-level mcp.json (disabledServers) must not leak into the real profile.
	const agentDir = await mkdtemp(path.join(tmpdir(), "chrome-mcp-agent-"));
	tempDirs.push(agentDir);
	setAgentDir(agentDir);
});

afterEach(async () => {
	setAgentDir(originalAgentDir ?? fallbackAgentDir);
	server?.stop(true);
	server = null;
	await Promise.all(tempDirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })));
});

function startBridge(options: { respond?: boolean; tools?: typeof TOOLS } = {}): {
	url: string;
	requests: RecordedRequest[];
} {
	const requests: RecordedRequest[] = [];
	server = Bun.serve({
		port: 0,
		async fetch(req) {
			if (options.respond === false) {
				// Accept the request and never answer it: only the probe's own deadline ends the wait.
				return await new Promise<Response>(() => {});
			}
			if (req.method !== "POST") return new Response(null, { status: 405 });
			const body = (await req.json()) as { id: string | number; method: string };
			requests.push({
				method: body.method,
				origin: req.headers.get("origin"),
				sessionId: req.headers.get("mcp-session-id"),
			});
			if (body.method === "initialize") {
				return new Response(
					`event: message\ndata: ${JSON.stringify({
						jsonrpc: "2.0",
						id: body.id,
						result: {
							protocolVersion: "2025-06-18",
							capabilities: { tools: {} },
							serverInfo: { name: "ChromeMcpServer", version: "2.8.5" },
						},
					})}\n\n`,
					{ headers: { "Content-Type": "text/event-stream", "Mcp-Session-Id": "bridge-session" } },
				);
			}
			if (body.method === "tools/list") {
				return new Response(
					`event: message\ndata: ${JSON.stringify({
						jsonrpc: "2.0",
						id: body.id,
						result: { tools: options.tools ?? TOOLS },
					})}\n\n`,
					{ headers: { "Content-Type": "text/event-stream" } },
				);
			}
			return new Response(null, { status: 202 });
		},
	});
	return { url: `http://127.0.0.1:${server.port}/mcp`, requests };
}

async function tempCwd(): Promise<string> {
	const dir = await mkdtemp(path.join(tmpdir(), "chrome-mcp-test-"));
	tempDirs.push(dir);
	return dir;
}

async function writeMCPConfig(scope: "user" | "project", cwd: string, config: unknown): Promise<void> {
	const configPath = getMCPConfigPath(scope, cwd);
	await mkdir(path.dirname(configPath), { recursive: true });
	await Bun.write(configPath, `${JSON.stringify(config)}\n`);
}

describe("chrome-mcp bridge probe", () => {
	it("initializes, lists tools through the session id, and stamps the bridge origin", async () => {
		const bridge = startBridge();
		const result = await probeChromeMcp({ url: bridge.url });

		expect(result?.serverInfo).toEqual({ name: "ChromeMcpServer", version: "2.8.5" });
		expect(result?.tools.map(tool => tool.name)).toEqual(["chrome_navigate", "chrome_get_web_content"]);
		expect(bridge.requests.map(request => request.method)).toEqual(["initialize", "tools/list"]);
		expect(bridge.requests[0]?.origin).toBe(new URL(bridge.url).origin);
		expect(bridge.requests[0]?.sessionId).toBeNull();
		expect(bridge.requests[1]?.sessionId).toBe("bridge-session");
	});

	it("silently skips a bridge that does not answer within the probe deadline", async () => {
		const bridge = startBridge({ respond: false });
		const started = Date.now();
		const result = await probeChromeMcp({ url: bridge.url, timeoutMs: 100 });
		expect(result).toBeNull();
		expect(Date.now() - started).toBeLessThan(CHROME_MCP_PROBE_TIMEOUT_MS);
	});

	it("silently skips a closed port", async () => {
		expect(await probeChromeMcp({ url: "http://127.0.0.1:1/mcp" })).toBeNull();
	});

	it("refuses a non-loopback host without sending a request", async () => {
		const started = Date.now();
		expect(await probeChromeMcp({ url: "http://192.0.2.10:12306/mcp", timeoutMs: 5_000 })).toBeNull();
		expect(Date.now() - started).toBeLessThan(1_000);
	});

	it("refuses a hostname alias such as localhost, accepting IP literals only", async () => {
		const bridge = startBridge();
		const aliasUrl = bridge.url.replace("127.0.0.1", "localhost");
		expect(await probeChromeMcp({ url: aliasUrl })).toBeNull();
		expect(bridge.requests).toHaveLength(0);
	});

	it("builds a streamable-http config and source for the live bridge", async () => {
		const bridge = startBridge();
		const discovered = await discoverChromeMcp({ url: bridge.url });
		expect(discovered?.name).toBe("chrome");
		expect(discovered?.config).toEqual(
			expect.objectContaining({
				type: "streamable-http",
				url: bridge.url,
				headers: { Origin: new URL(bridge.url).origin },
			}),
		);
		expect(discovered?.source).toMatchObject({ provider: "chrome-mcp", level: "native", path: bridge.url });
	});
});

describe("chrome-mcp config registration", () => {
	it("registers the live bridge as the chrome server when enabled", async () => {
		const bridge = startBridge();
		const { configs, sources } = await loadAllMCPConfigs(await tempCwd(), {
			chromeMcp: true,
			chromeMcpUrl: bridge.url,
			filterExa: false,
			filterBrowser: false,
		});

		expect(configs[CHROME_MCP_SERVER_NAME]).toMatchObject({ type: "streamable-http", url: bridge.url });
		expect(sources[CHROME_MCP_SERVER_NAME]?.provider).toBe("chrome-mcp");
		expect(bridge.requests.map(request => request.method)).toEqual(["initialize", "tools/list"]);
	});

	it("does not probe or overwrite a user-configured chrome server", async () => {
		const bridge = startBridge();
		const cwd = await tempCwd();
		await writeMCPConfig("project", cwd, {
			mcpServers: { chrome: { type: "http", url: "http://127.0.0.1:9999/custom" } },
		});

		const { configs, sources } = await loadAllMCPConfigs(cwd, {
			chromeMcp: true,
			chromeMcpUrl: bridge.url,
			filterExa: false,
			filterBrowser: false,
		});

		expect(configs[CHROME_MCP_SERVER_NAME]).toMatchObject({
			type: "http",
			url: "http://127.0.0.1:9999/custom",
		});
		expect(sources[CHROME_MCP_SERVER_NAME]?.provider).not.toBe("chrome-mcp");
		expect(bridge.requests).toHaveLength(0);
	});

	it("honors a user-level disabled chrome entry and skips probing", async () => {
		const bridge = startBridge();
		const cwd = await tempCwd();
		await writeMCPConfig("user", cwd, { mcpServers: {}, disabledServers: ["chrome"] });

		const { configs, sources } = await loadAllMCPConfigs(cwd, {
			chromeMcp: true,
			chromeMcpUrl: bridge.url,
			filterExa: false,
			filterBrowser: false,
		});

		expect(configs[CHROME_MCP_SERVER_NAME]).toBeUndefined();
		expect(sources[CHROME_MCP_SERVER_NAME]).toBeUndefined();
		expect(bridge.requests).toHaveLength(0);
	});

	it("does not probe or register when the setting is off", async () => {
		const bridge = startBridge();
		const { configs, sources } = await loadAllMCPConfigs(await tempCwd(), {
			chromeMcp: false,
			chromeMcpUrl: bridge.url,
			filterExa: false,
			filterBrowser: false,
		});

		expect(bridge.requests).toHaveLength(0);
		expect(configs[CHROME_MCP_SERVER_NAME]).toBeUndefined();
		expect(sources[CHROME_MCP_SERVER_NAME]).toBeUndefined();
	});

	it("silently skips a dead bridge", async () => {
		const { configs } = await loadAllMCPConfigs(await tempCwd(), {
			chromeMcp: true,
			chromeMcpUrl: "http://127.0.0.1:1/mcp",
			filterExa: false,
			filterBrowser: false,
		});
		expect(configs[CHROME_MCP_SERVER_NAME]).toBeUndefined();
	});

	it("defaults the browser.chromeMcp setting to on", () => {
		expect(cfgBrowserChromeMcp.get(Settings.isolated({}))).toBe(true);
	});
});

describe("browser prelude chrome-mcp notice", () => {
	function sessionWithChrome(connected: () => boolean): ToolSession {
		return {
			settings: Settings.isolated({}),
			mcpManager: { getConnectedServers: () => (connected() ? [CHROME_MCP_SERVER_NAME] : []) },
		} as unknown as ToolSession;
	}

	it("advertises chrome-mcp as the base browser only while the chrome server is connected", () => {
		let connected = false;
		const definition = createBrowserPreludeDefinition(
			sessionWithChrome(() => connected),
			{
				invoke: async () => ({ content: [], details: {} }),
				status: () => undefined,
			},
		);

		expect(definition.guidance).toBeUndefined();
		connected = true;
		expect(definition.guidance).toContain("chrome_*");
		expect(definition.guidance).toContain("isolated Chrome for Testing");
		expect(definition.guidance).toContain("user's real Chrome");
	});
});
