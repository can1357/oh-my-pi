import { describe, expect, it } from "bun:test";
import * as os from "node:os";
import {
	formatMCPConnectingMessage,
	formatMCPConnectionStatusMessage,
	isMcpConnectionStatusEvent,
	MCP_CONNECTION_STATUS_EVENT_CHANNEL,
} from "@oh-my-pi/pi-coding-agent/mcp/startup-events";

// Cross-module contract guard.
//
// The MCP status lifecycle spans two modules that never import each other:
//   - sdk.ts emits McpConnectionStatusEvent payloads on MCP_CONNECTION_STATUS_EVENT_CHANNEL.
//   - interactive-mode.ts subscribes to that channel and renders the aggregate
//     message via formatMCPConnectionStatusMessage.
//
// They agree only through this shared module. Drift in the channel, payload
// guard, or user-facing status text silently leaves the startup banner stale.
describe("mcp/startup-events — connection-status cross-module contract", () => {
	it("pins the wire channel string sdk(emit) and interactive-mode(subscribe) share", () => {
		expect(MCP_CONNECTION_STATUS_EVENT_CHANNEL).toBe("mcp:connection-status");
	});

	it("formats the initial connecting banner for a multi-server list", () => {
		expect(formatMCPConnectingMessage(["alpha", "beta", "gamma"])).toBe(
			"Connecting to MCP servers: alpha, beta, gamma…",
		);
	});

	it("formats a completion update when every server connects", () => {
		expect(
			formatMCPConnectionStatusMessage({
				pendingServers: [],
				connectedServers: ["alpha", "beta"],
				failedServers: [],
			}),
		).toBe("Connected to MCP servers: alpha, beta.");
	});

	it("formats failures with server names and errors", () => {
		expect(
			formatMCPConnectionStatusMessage({
				pendingServers: [],
				connectedServers: ["alpha"],
				failedServers: [{ serverName: "broken", error: "missing command" }],
			}),
		).toBe("MCP finished with failures. Connected: alpha. Failed: broken: missing command");
	});

	it("sanitizes failure errors before rendering them in status text", () => {
		const homePath = `${os.homedir()}/.omp/mcp.log`;
		const message = formatMCPConnectionStatusMessage({
			pendingServers: ["slow"],
			connectedServers: [],
			failedServers: [{ serverName: "broken", error: `failed at\t${homePath}\n${"x".repeat(120)}` }],
		});

		expect(message).not.toContain(os.homedir());
		expect(message).not.toContain("\n");
		expect(message).not.toContain("\t");
		expect(message).toContain("broken: failed at   ~/.omp/mcp.log");
	});

	it("keeps the config source and transport error visible under independent truncation", () => {
		const message = formatMCPConnectionStatusMessage({
			pendingServers: [],
			connectedServers: [],
			failedServers: [
				{
					serverName: "broken",
					error: `ENOENT ${"missing executable ".repeat(10)}`,
					sourcePath: `${os.homedir()}/.codex/config.toml`,
				},
			],
		});

		expect(message).not.toContain(os.homedir());
		expect(message).toContain("broken [config: ~/.codex/config.toml]: ENOENT");
		expect(message).toContain("…");
	});

	it("shortens config sources when the home directory contains spaces", () => {
		const homeDir = "/tmp/OMP User";
		const moduleUrl = new URL("../src/mcp/startup-events.ts", import.meta.url).href;
		const script = `
			import os from "node:os";
			import { formatMCPConnectionStatusMessage } from ${JSON.stringify(moduleUrl)};
			const sourcePath = os.homedir() + "/.codex/config.toml";
			process.stdout.write(formatMCPConnectionStatusMessage({
				pendingServers: [],
				connectedServers: [],
				failedServers: [{ serverName: "broken", error: "ENOENT", sourcePath }],
			}));
		`;
		const result = Bun.spawnSync({
			cmd: [process.execPath, "-e", script],
			env: { ...process.env, HOME: homeDir, USERPROFILE: homeDir },
		});
		const message = result.stdout.toString();

		expect(result.exitCode).toBe(0);
		expect(message).not.toContain(homeDir);
		expect(message).toContain("broken [config: ~/.codex/config.toml]: ENOENT");
	});

	it("sanitizes server names before rendering them in status text", () => {
		const homePath = `${os.homedir()}/.omp`;
		const message = formatMCPConnectionStatusMessage({
			pendingServers: [`${homePath}/pending\n${"p".repeat(80)}`],
			connectedServers: [`${homePath}/connected\tserver`],
			failedServers: [{ serverName: `${homePath}/broken\nserver`, error: "missing command" }],
		});

		expect(message).not.toContain(os.homedir());
		expect(message).not.toContain("\n");
		expect(message).not.toContain("\t");
		expect(message).toContain("Connected: ~/.omp/connected   server.");
		expect(message).toContain("Failed: ~/.omp/broken server: missing command.");
		expect(message).toContain("Still connecting: ~/.omp/pending");
	});

	it("keeps pending servers visible while other servers settle", () => {
		expect(
			formatMCPConnectionStatusMessage({
				pendingServers: ["slow"],
				connectedServers: ["alpha"],
				failedServers: [{ serverName: "broken", error: "missing command" }],
			}),
		).toBe("Connected: alpha. Failed: broken: missing command. Still connecting: slow…");
	});

	it("terminates active connecting messages with a single U+2026 ellipsis", () => {
		const msg = formatMCPConnectingMessage(["x"]);
		expect(msg.endsWith("\u2026")).toBe(true);
		expect(msg.endsWith("...")).toBe(false);
		expect(msg.at(-1)).toBe("\u2026");
	});

	it("accepts well-formed payloads and rejects malformed ones", () => {
		expect(isMcpConnectionStatusEvent({ type: "connecting", serverNames: ["a", "b"] })).toBe(true);
		expect(isMcpConnectionStatusEvent({ type: "connecting", serverNames: [] })).toBe(true);
		expect(isMcpConnectionStatusEvent({ type: "connected", serverName: "a" })).toBe(true);
		expect(isMcpConnectionStatusEvent({ type: "failed", serverName: "a", error: "boom" })).toBe(true);
		expect(
			isMcpConnectionStatusEvent({
				type: "failed",
				serverName: "a",
				error: "boom",
				sourcePath: "/tmp/config.toml",
			}),
		).toBe(true);

		expect(isMcpConnectionStatusEvent(null)).toBe(false);
		expect(isMcpConnectionStatusEvent(undefined)).toBe(false);
		expect(isMcpConnectionStatusEvent("mcp:connection-status")).toBe(false);
		expect(isMcpConnectionStatusEvent({})).toBe(false);
		expect(isMcpConnectionStatusEvent({ type: "connecting", serverNames: "alpha" })).toBe(false);
		expect(isMcpConnectionStatusEvent({ type: "connecting", serverNames: ["ok", 3] })).toBe(false);
		expect(isMcpConnectionStatusEvent({ type: "connected", serverName: 1 })).toBe(false);
		expect(isMcpConnectionStatusEvent({ type: "failed", serverName: "a" })).toBe(false);
		expect(
			isMcpConnectionStatusEvent({
				type: "failed",
				serverName: "a",
				error: "boom",
				sourcePath: 42,
			}),
		).toBe(false);
	});
});
