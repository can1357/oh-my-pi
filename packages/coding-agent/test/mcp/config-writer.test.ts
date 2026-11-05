import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { getAgentDir, setAgentDir } from "@oh-my-pi/pi-utils/dirs";
import { readFile as readFileCapability } from "../../src/capability/fs";
import {
	addMCPServer,
	readDisabledServers,
	readMCPConfigFile,
	setServerDisabled,
	validateServerName,
} from "../../src/mcp/config-writer";

describe("validateServerName", () => {
	it("accepts human display labels with spaces (#11731)", () => {
		expect(validateServerName("MaaS Slack")).toBeUndefined();
	});

	it("still accepts namespaced colon names and rejects unsupported characters", () => {
		expect(validateServerName("cloudflare:cloudflare-api")).toBeUndefined();
		expect(validateServerName("bad/name")).toBeDefined();
		expect(validateServerName("")).toBeDefined();
		expect(validateServerName(" ")).toBeDefined();
		expect(validateServerName(" MaaS Slack")).toBeDefined();
		expect(validateServerName("MaaS Slack ")).toBeDefined();
		expect(validateServerName("MaaS  Slack")).toBeDefined();
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

// The write lands on the link's target, so it clears the target's cache key.
// Readers ask for the path they were given — the link — and would keep the
// bytes from before the write unless that key is cleared too.
describe("a linked MCP config", () => {
	it("is readable through the link straight after a write", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-mcp-link-"));
		const previousAgentDir = getAgentDir();
		setAgentDir(root);
		try {
			const target = path.join(root, "mcp.json");
			const link = path.join(root, "profile-mcp.json");
			await fs.writeFile(target, JSON.stringify({ mcpServers: { old: { command: "old" } } }));
			await fs.symlink(target, link);
			// Populate the reader's cache under the link's own key.
			await readFileCapability(link);

			await addMCPServer(link, "fresh", { command: "fresh" });

			expect((await fs.lstat(link)).isSymbolicLink()).toBe(true);
			const seen = JSON.parse((await readFileCapability(link)) ?? "{}") as { mcpServers: Record<string, unknown> };
			expect(Object.keys(seen.mcpServers).sort()).toEqual(["fresh", "old"]);
		} finally {
			setAgentDir(previousAgentDir);
			await fs.rm(root, { recursive: true, force: true });
		}
	});
});
