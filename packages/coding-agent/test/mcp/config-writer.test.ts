import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	addMCPServer,
	readDisabledServers,
	readMCPConfigFile,
	setServerDisabled,
	validateServerName,
} from "../../src/mcp/config-writer";
import { createMCPToolName } from "../../src/mcp/tool-bridge";

describe("validateServerName", () => {
	it("accepts human display labels with spaces (#11731)", () => {
		expect(validateServerName("MaaS Slack")).toBeUndefined();
	});

	it("still accepts namespaced colon names and rejects unsupported characters", () => {
		expect(validateServerName("cloudflare:cloudflare-api")).toBeUndefined();
		expect(validateServerName("bad/name")).toBeDefined();
		expect(validateServerName("")).toBeDefined();
	});

	it("sanitizes a spaced server name into a valid tool identifier", () => {
		// Ownership uses the raw name; tool names are lossy-sanitized, so a space
		// never yields an invalid tool identifier.
		expect(createMCPToolName("MaaS Slack", "send")).toMatch(/^[a-zA-Z0-9_-]+$/);
	});
});

describe("config-writer concurrent mutations", () => {
	let dir: string;
	let filePath: string;

	beforeEach(async () => {
		dir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-mcp-config-"));
		filePath = path.join(dir, "mcp.json");
	});

	afterEach(async () => {
		await fs.rm(dir, { recursive: true, force: true });
	});

	it("preserves both servers when two adds race the same file", async () => {
		await Promise.all([
			addMCPServer(filePath, "alpha", { type: "stdio", command: "a" }),
			addMCPServer(filePath, "bravo", { type: "stdio", command: "b" }),
		]);

		const config = await readMCPConfigFile(filePath);
		expect(Object.keys(config.mcpServers ?? {}).sort()).toEqual(["alpha", "bravo"]);
	});

	it("persists a server name containing spaces (#11731)", async () => {
		await addMCPServer(filePath, "MaaS Slack", { type: "stdio", command: "s" });
		const config = await readMCPConfigFile(filePath);
		expect(Object.keys(config.mcpServers ?? {})).toContain("MaaS Slack");
	});

	it("preserves both denylist edits when disable calls race", async () => {
		await Promise.all([setServerDisabled(filePath, "alpha", true), setServerDisabled(filePath, "bravo", true)]);

		expect((await readDisabledServers(filePath)).sort()).toEqual(["alpha", "bravo"]);
	});

	it("writes into a directory that does not exist yet", async () => {
		const nestedPath = path.join(dir, "nested", "deep", "mcp.json");
		await addMCPServer(nestedPath, "alpha", { type: "stdio", command: "a" });

		const config = await readMCPConfigFile(nestedPath);
		expect(Object.keys(config.mcpServers ?? {})).toEqual(["alpha"]);
	});
});
