import { describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { MCPManager } from "@oh-my-pi/pi-coding-agent/mcp/manager";
import type { MCPServerConfig, MCPStdioServerConfig } from "@oh-my-pi/pi-coding-agent/mcp/types";

function expectStdio(config: MCPServerConfig): MCPStdioServerConfig {
	if (config.type === "http" || config.type === "sse") throw new Error("expected a stdio config");
	return config;
}

describe("stdio env value resolution policy", () => {
	it("keeps literal-policy env values byte-for-byte and never executes commands", async () => {
		const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-env-policy-"));
		const sentinel = path.join(tempDir, "pwned");
		try {
			const manager = new MCPManager(process.cwd());
			const env = {
				NAME_OF_AMBIENT: "HOME",
				EMPTY: "",
				BANG: `!touch ${sentinel}`,
			};
			const resolved = expectStdio(
				await manager.prepareConfig({
					type: "stdio",
					command: "server",
					envPolicy: "literal",
					env: { ...env },
				}),
			);
			// Agent Plugins §§4.1/9.2: values are opaque package data — no ambient
			// env lookup, no empty-value dropping, no `!command` resolution.
			expect(resolved.env).toEqual(env);
			// prepareConfig awaits any (buggy) resolution, so a shell `touch` would
			// have completed by now — the sentinel must not exist.
			expect(fs.existsSync(sentinel)).toBe(false);
		} finally {
			fs.rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("keeps legacy env-name expansion for servers without the literal policy", async () => {
		const manager = new MCPManager(process.cwd());
		const resolved = expectStdio(
			await manager.prepareConfig({
				type: "stdio",
				command: "server",
				env: { LOOKUP: "HOME", EMPTY: "" },
			}),
		);
		// Non-plugin servers keep the existing contract: a value naming an
		// ambient variable expands, and empty values are dropped.
		expect(resolved.env?.LOOKUP).toBe(process.env.HOME ?? "HOME");
		expect(resolved.env?.EMPTY).toBeUndefined();
	});
});
