/**
 * A configured MCP server URL may carry a credential: a password in its
 * userinfo (`http://user:password@host/…`) or a key in its query. When the
 * server fails, the URL travels into error text, and that text reaches every
 * place a failure is reported.
 *
 * Contract defended here: a credential planted in a configured URL is absent
 * from each place a person, the model or another machine reads a failure:
 * - the tool result the model receives, and the session transcript that stores it;
 * - the startup status line and the `errors` of the startup result;
 * - the log file and the log sinks (the OTLP exporter is one), including a
 *   runtime error's own fields (Bun's fetch errors carry the full URL in `path`)
 *   and contexts JSON cannot serialize.
 * It holds for every spelling the URL parser accepts: a `'` or a second `@` in
 * the password, a percent-encoded parameter name, a `password` parameter, a
 * fragment token, and a credential-bearing URL nested in a parameter value.
 */
import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { MCPManager } from "@oh-my-pi/pi-coding-agent/mcp/manager";
import {
	formatMCPConnectionStatusMessage,
	type McpConnectionFailure,
	type McpConnectionStatusEvent,
} from "@oh-my-pi/pi-coding-agent/mcp/startup-events";
import type { MCPTool } from "@oh-my-pi/pi-coding-agent/mcp/tool-bridge";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { logger, removeWithRetries } from "@oh-my-pi/pi-utils";

const GUARD_MS = 5_000;
const noCtx = {} as Parameters<MCPTool["execute"]>[3];

/**
 * Streamable HTTP MCP server. `/loop` always redirects to itself; `/mcp`
 * answers with one `ping` tool until `state.looping`, then redirects too.
 */
function startServer() {
	const state = { looping: false };
	const server = Bun.serve({
		port: 0,
		hostname: "127.0.0.1",
		async fetch(request) {
			const url = new URL(request.url);
			if (url.pathname === "/loop" || state.looping) {
				return new Response(null, { status: 307, headers: { Location: url.pathname + url.search } });
			}
			if (request.method === "GET") return new Response(null, { status: 405 });
			if (request.method === "DELETE") return new Response(null, { status: 200 });
			const message = (await request.json()) as { id?: number | string; method: string };
			if (message.id === undefined) return new Response(null, { status: 202 });
			let result: unknown = {};
			if (message.method === "initialize") {
				result = {
					protocolVersion: "2025-11-25",
					capabilities: { tools: {} },
					serverInfo: { name: "redirecting", version: "1" },
				};
			} else if (message.method === "tools/list") {
				result = {
					tools: [{ name: "ping", description: "Answers pong", inputSchema: { type: "object", properties: {} } }],
				};
			}
			return Response.json({ jsonrpc: "2.0", id: message.id, result }, { headers: { "Mcp-Session-Id": "s1" } });
		},
	});
	return { port: server.port, state, stop: () => server.stop(true) };
}

describe("credentials in a configured MCP server URL", () => {
	const cleanups: Array<() => Promise<void> | void> = [];
	afterEach(async () => {
		for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
	});

	it("never reach the tool result, the status line, the log file or a log sink", async () => {
		// Obviously fake, generated per run.
		const planted = `FAKE${Math.random().toString(36).slice(2, 10)}`;
		const logDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-mcp-url-redaction-"));
		cleanups.push(() => removeWithRetries(logDir));
		logger.setTransports({ file: logDir });
		cleanups.push(() => logger.setTransports({ file: true }));
		const sunk: string[] = [];
		cleanups.push(logger.registerLogSink(event => sunk.push(JSON.stringify(event))));

		const server = startServer();
		cleanups.push(server.stop);
		const base = `http://user:${planted}@127.0.0.1:${server.port}`;
		const manager = new MCPManager(logDir, null, undefined, {
			ladderMs: [10],
			retryBaseMs: 60_000,
			retryMaxMs: 60_000,
		});
		cleanups.push(() => manager.disconnectAll());
		const failures: McpConnectionFailure[] = [];
		manager.addConnectionStatusListener((event: McpConnectionStatusEvent) => {
			if (event.type === "failed") failures.push(event);
		});

		const result = await manager.connectServers(
			{
				startup: {
					type: "http",
					url: `${base}/loop?apiKey=${planted}`,
					headerPolicy: "origin-locked",
					timeout: 2_000,
				},
				live: { type: "http", url: `${base}/mcp?apiKey=${planted}`, headerPolicy: "origin-locked", timeout: 2_000 },
			},
			{},
		);
		await manager.waitForStartup(GUARD_MS);
		const ping = manager.getTools().find(tool => tool.mcpServerName === "live");
		if (!ping) throw new Error("ping tool not registered");

		server.state.looping = true;
		const toolResult = await ping.execute("call-1", {}, () => {}, noCtx);
		const toolText = JSON.stringify(toolResult.content);

		const statusLine = formatMCPConnectionStatusMessage({
			pendingServers: [],
			connectedServers: [],
			failedServers: failures,
		});
		const startupErrors = JSON.stringify([...result.errors]);

		// A runtime error that names the URL in its own fields, logged as context.
		const fetchError = await fetch(`http://user:${planted}@127.0.0.1:1/mcp?apiKey=${planted}`).catch(
			(error: unknown) => error,
		);
		logger.warn("MCP fetch failed", { error: fetchError });
		logger.flush();
		const logText = (
			await Promise.all((await fs.readdir(logDir)).map(name => Bun.file(path.join(logDir, name)).text()))
		).join("\n");
		const sinkText = sunk.join("\n");

		// Each destination reported the failure, with the URL, so the absence below is not vacuous.
		expect(toolResult.isError).toBe(true);
		expect(toolText).toContain("Too many redirects");
		expect(statusLine).toContain("startup");
		expect(statusLine).toContain("Too many redirects");
		expect(startupErrors).toContain("Too many redirects");
		expect(logText).toContain("MCP fetch failed");
		expect(logText).toContain("127.0.0.1:1/mcp");
		expect(sinkText).toContain("127.0.0.1:1/mcp");

		expect({
			toolResult: toolText.includes(planted),
			statusLine: statusLine.includes(planted),
			startupErrors: startupErrors.includes(planted),
			logFile: logText.includes(planted),
			logSink: sinkText.includes(planted),
		}).toEqual({ toolResult: false, statusLine: false, startupErrors: false, logFile: false, logSink: false });
	});

	it("hide every URL spelling the parser accepts, from every destination", async () => {
		// One obviously fake value per shape, generated per run, so a leak names its shape.
		const run = Math.random().toString(36).slice(2, 8);
		const shapes = {
			userinfo: (p: string) => `http://user:${p}@upstream.test/mcp`,
			apostrophe: (p: string) => `http://user:x'${p}@upstream.test/mcp`,
			multipleAt: (p: string) => `http://user:x@${p}@upstream.test/mcp`,
			encodedName: (p: string) => `http://upstream.test/mcp?%74oken=${p}`,
			password: (p: string) => `http://upstream.test/mcp?page=1&password=${p}`,
			fragment: (p: string) => `http://upstream.test/cb#access_token=${p}&state=s`,
			nested: (p: string) => `http://upstream.test/r?next=${encodeURIComponent(`http://u:${p}@inner.test/`)}`,
		} as const;
		type Shape = keyof typeof shapes;
		const names = Object.keys(shapes) as Shape[];
		const planted = Object.fromEntries(names.map((name, i) => [name, `FAKE${i}${run}`])) as Record<Shape, string>;
		const url = (name: Shape) => shapes[name](planted[name]);

		const workDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-mcp-url-shapes-"));
		cleanups.push(() => removeWithRetries(workDir));
		const logDir = path.join(workDir, "logs");
		logger.setTransports({ file: logDir });
		cleanups.push(() => logger.setTransports({ file: true }));
		const sunk: logger.LogEvent[] = [];
		cleanups.push(logger.registerLogSink(event => sunk.push(event)));

		const fixture = path.join(import.meta.dir, "fixtures", "url-echo-mcp.ts");
		const manager = new MCPManager(workDir, null, undefined, {
			ladderMs: [10],
			retryBaseMs: 60_000,
			retryMaxMs: 60_000,
		});
		cleanups.push(() => manager.disconnectAll());
		const failures: McpConnectionFailure[] = [];
		manager.addConnectionStatusListener((event: McpConnectionStatusEvent) => {
			if (event.type === "failed") failures.push(event);
		});
		const stdio = (name: Shape, failInit: boolean) => ({
			type: "stdio" as const,
			command: process.execPath,
			args: [fixture],
			env: { OMP_TEST_ECHO_URL: url(name), OMP_TEST_FAIL_INIT: failInit ? "1" : "0" },
			timeout: GUARD_MS,
		});
		const result = await manager.connectServers(
			Object.fromEntries(
				names.flatMap(name => [
					[`init_${name}`, stdio(name, true)],
					[`call_${name}`, stdio(name, false)],
				]),
			),
			{},
		);
		await manager.waitForStartup(GUARD_MS);

		const sessions = SessionManager.create(workDir, path.join(workDir, "sessions"));
		cleanups.push(() => sessions.close());
		sessions.appendMessage({
			role: "user",
			content: [{ type: "text", text: "call every server" }],
			timestamp: Date.now(),
		});
		const toolText: Partial<Record<Shape, string>> = {};
		for (const name of names) {
			const tool = manager.getTools().find(candidate => candidate.mcpServerName === `call_${name}`);
			if (!tool) throw new Error(`call_${name} registered no tool`);
			const toolResult = await tool.execute(`call-${name}`, {}, () => {}, noCtx);
			expect(toolResult.isError).toBe(true);
			toolText[name] = JSON.stringify(toolResult.content);
			sessions.appendMessage({
				role: "toolResult",
				toolCallId: `call-${name}`,
				toolName: tool.name,
				content: toolResult.content,
				isError: true,
				timestamp: Date.now(),
			});

			// The logger, with the URL in the message, a field, an error's cause, and contexts
			// JSON cannot serialize (a bigint, a cycle), which sinks such as OTLP still read field by field.
			const cycle: Record<string, unknown> = { url: url(name) };
			cycle.self = cycle;
			logger.warn(`upstream ${url(name)} failed`, {
				url: url(name),
				error: new Error("outer", { cause: new Error(`inner ${url(name)}`) }),
			});
			logger.warn("bigint context", { url: url(name), counter: 1n });
			logger.warn("cycle context", cycle);
		}
		await sessions.ensureOnDisk();
		await sessions.flush();
		const sessionFile = sessions.getSessionFile();
		if (!sessionFile) throw new Error("no session file");
		const transcript = await Bun.file(sessionFile).text();
		logger.flush();
		const logText = (
			await Promise.all((await fs.readdir(logDir)).map(file => Bun.file(path.join(logDir, file)).text()))
		).join("\n");
		const statusLine = formatMCPConnectionStatusMessage({
			pendingServers: [],
			connectedServers: [],
			failedServers: failures,
		});
		const startupErrors = JSON.stringify([...result.errors]);
		// Bun.inspect renders every field a sink could read, causes, bigints and cycles included.
		const sinkText = sunk.map(event => Bun.inspect(event, { depth: 8 })).join("\n");

		// Each destination reported every shape's failure, so the absence below is not vacuous.
		for (const name of names) {
			expect(toolText[name]).toContain("upstream");
			expect(statusLine).toContain(`init_${name}`);
			expect(startupErrors).toContain(`init_${name}`);
		}
		expect(transcript).toContain("upstream");
		// The file drops a record JSON cannot serialize (as before); the sinks receive all three.
		expect(logText).toContain("upstream.test");
		expect(sinkText).toContain("bigint context");
		expect(sinkText).toContain("cycle context");

		const leaks = Object.fromEntries(
			names.map(name => {
				const p = planted[name];
				return [
					name,
					{
						toolResult: toolText[name]?.includes(p),
						transcript: transcript.includes(p),
						statusLine: statusLine.includes(p),
						startupErrors: startupErrors.includes(p),
						logFile: logText.includes(p),
						logSink: sinkText.includes(p),
					},
				];
			}),
		);
		const none = {
			toolResult: false,
			transcript: false,
			statusLine: false,
			startupErrors: false,
			logFile: false,
			logSink: false,
		};
		expect(leaks).toEqual(Object.fromEntries(names.map(name => [name, none])));
	}, 30_000);
});
