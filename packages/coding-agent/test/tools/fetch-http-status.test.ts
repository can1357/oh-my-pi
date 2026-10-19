import { afterEach, describe, expect, it } from "bun:test";
import * as path from "node:path";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { ReadTool } from "@oh-my-pi/pi-coding-agent/tools/read";

function makeSession(): ToolSession {
	const cwd = process.cwd();
	const artifactsDir = path.join(cwd, ".fetch-http-status-artifacts");
	return {
		cwd,
		hasUI: false,
		getSessionFile: () => path.join(cwd, "session.jsonl"),
		getArtifactsDir: () => artifactsDir,
		getSessionSpawns: () => null,
		allocateOutputArtifact: async toolType => ({ id: "test", path: path.join(artifactsDir, `test.${toolType}.log`) }),
		settings: Settings.isolated({ "fetch.enabled": true }),
	};
}

describe("read URL HTTP status without a body", () => {
	const servers: Bun.Server<undefined>[] = [];
	afterEach(() => {
		for (const server of servers) server.stop(true);
		servers.length = 0;
	});

	it("reports a bodyless 204 as a successful empty read, not a failed fetch", async () => {
		const server = Bun.serve({
			port: 0,
			fetch: () => new Response(null, { status: 204, headers: { "content-type": "text/html" } }),
		});
		servers.push(server);
		const result = await new ReadTool(makeSession()).execute("call", {
			path: `http://127.0.0.1:${server.port}/healthz`,
		});
		const text = result.content.find(block => block.type === "text")?.text;

		expect(result.details?.method).not.toBe("failed");
		expect(text).toContain("HTTP 204 No Content");
		expect(text).not.toContain("Failed to fetch URL");
	});

	it("reports a bodyless 503 as a failed fetch", async () => {
		const server = Bun.serve({ port: 0, fetch: () => new Response(null, { status: 503 }) });
		servers.push(server);
		const result = await new ReadTool(makeSession()).execute("call", {
			path: `http://127.0.0.1:${server.port}/healthz`,
		});
		const text = result.content.find(block => block.type === "text")?.text;

		expect(result.details?.method).toBe("failed");
		expect(text).toContain("Failed to fetch URL (HTTP 503)");
	});
});
