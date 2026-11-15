/**
 * A stdio MCP server whose command exits before it answers `initialize` —
 * a credential wrapper that refuses to release a secret, a missing runtime —
 * must fail alone and say why. The user reads the reason the command printed
 * on stderr (a refusal names what to run instead), not only an exit code,
 * the command is not relaunched behind their back, and every other server
 * still connects.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { removeWithRetries } from "@oh-my-pi/pi-utils";
import { MCPManager } from "../src/mcp/manager";
import type { McpConnectionStatusEvent } from "../src/mcp/startup-events";

const peer = path.join(import.meta.dir, "fixtures/rpc-mcp-server.ts");
const REFUSAL = "secrets: refused: this key needs a person; run: secret-run DEMO_KEY -- <command>";

describe("MCP stdio server that exits before responding", () => {
	let root: string;
	let manager: MCPManager | undefined;

	beforeEach(async () => {
		root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-mcp-early-exit-"));
	});

	afterEach(async () => {
		await manager?.disconnectAll();
		manager = undefined;
		await removeWithRetries(root);
	});

	it("reports the command's stderr for that server only and leaves the other servers connected", async () => {
		const launches = path.join(root, "refused-launches.log");
		const audit = path.join(root, "healthy.jsonl");
		await Bun.write(audit, "");
		// Exit code 77 with a reason on stderr: what a refusing secrets wrapper does.
		const refusingScript = [
			`require("node:fs").appendFileSync(${JSON.stringify(launches)}, "launch\\n");`,
			`console.error(${JSON.stringify(REFUSAL)});`,
			"process.exit(77);",
		].join(" ");
		const events: McpConnectionStatusEvent[] = [];
		// What each server ended as. Startup returns after its discovery window while
		// slow connections continue, so wait for both outcomes rather than the window.
		const outcomes = new Map<string, McpConnectionStatusEvent>();
		const bothSettled = Promise.withResolvers<void>();
		manager = new MCPManager(root);
		const result = await manager.connectServers(
			{
				refused: { type: "stdio", command: process.execPath, args: ["-e", refusingScript] },
				healthy: { type: "stdio", command: process.execPath, args: [peer, audit] },
			},
			{},
			event => {
				events.push(event);
				if (event.type !== "failed" && event.type !== "connected") return;
				if (!outcomes.has(event.serverName)) outcomes.set(event.serverName, event);
				if (outcomes.has("refused") && outcomes.has("healthy")) bothSettled.resolve();
			},
		);
		await bothSettled.promise;

		// The failure the user sees for that server names the exit code and the refusal.
		const failure = outcomes.get("refused");
		expect(failure).toMatchObject({ type: "failed", serverName: "refused" });
		const error = failure?.type === "failed" ? failure.error : "";
		expect(error).toContain("77");
		expect(error).toContain(REFUSAL);
		expect(error).toContain("secret-run DEMO_KEY");

		expect(outcomes.get("healthy")).toMatchObject({ type: "connected", serverName: "healthy" });
		expect(events).not.toContainEqual(expect.objectContaining({ type: "failed", serverName: "healthy" }));
		expect(result.errors.has("healthy")).toBe(false);
		expect(manager.getConnectionStatus("healthy")).toBe("connected");
		expect(manager.getTools().some(tool => tool.mcpServerName === "healthy")).toBe(true);

		// No automatic relaunch: each launch would ask for the secret again. A retry
		// would be a pending reconnection, so drain every in-flight attempt first.
		await manager.waitForPendingConnections();
		expect((await Bun.file(launches).text()).trim().split("\n")).toEqual(["launch"]);
		// Each server spawns a Bun child; on a loaded host their startup alone can take seconds.
	}, 60_000);
});
