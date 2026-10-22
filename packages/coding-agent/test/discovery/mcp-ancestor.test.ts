/**
 * Both MCP project loaders must agree on nearest-ancestor discovery:
 * walk from cwd toward repoRoot (or the filesystem root), take the nearest
 * mcp.json / .omp/mcp.json, and do not merge stacked ancestor copies.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { clearCache as clearFsCache } from "@oh-my-pi/pi-coding-agent/capability/fs";
import { type MCPServer, mcpCapability } from "@oh-my-pi/pi-coding-agent/capability/mcp";
import { loadCapability } from "@oh-my-pi/pi-coding-agent/discovery";
import { getConfigRootDir, removeWithRetries, setAgentDir } from "@oh-my-pi/pi-utils";

const originalAgentDirEnv = process.env.PI_CODING_AGENT_DIR;
const fallbackAgentDir = path.join(getConfigRootDir(), "agent");

async function writeMcpJson(filePath: string, servers: Record<string, unknown>): Promise<void> {
	await fs.mkdir(path.dirname(filePath), { recursive: true });
	await fs.writeFile(filePath, JSON.stringify({ mcpServers: servers }, null, 2));
}

async function loadProjectServers(cwd: string, provider: "mcp-json" | "native"): Promise<MCPServer[]> {
	clearFsCache();
	const result = await loadCapability<MCPServer>(mcpCapability.id, { cwd, providers: [provider] });
	return result.items.filter(server => server._source.level === "project");
}

describe("MCP nearest-ancestor discovery", () => {
	let tempDir = "";
	let agentDir = "";

	beforeEach(async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-mcp-ancestor-"));
		agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-mcp-ancestor-agent-"));
		setAgentDir(agentDir);
		clearFsCache();
	});

	afterEach(async () => {
		clearFsCache();
		if (originalAgentDirEnv) {
			setAgentDir(originalAgentDirEnv);
		} else {
			setAgentDir(fallbackAgentDir);
			delete process.env.PI_CODING_AGENT_DIR;
		}
		await removeWithRetries(tempDir);
		await removeWithRetries(agentDir);
	});

	describe.each([
		{ provider: "mcp-json" as const, file: (dir: string) => path.join(dir, "mcp.json") },
		{ provider: "native" as const, file: (dir: string) => path.join(dir, ".omp", "mcp.json") },
	])("$provider", ({ provider, file }) => {
		test("uses the file in cwd when present", async () => {
			const cwd = path.join(tempDir, "repo", "pkg");
			await writeMcpJson(file(cwd), { leaf: { command: "leaf-cmd" } });
			await writeMcpJson(file(path.join(tempDir, "repo")), { root: { command: "root-cmd" } });
			await fs.mkdir(path.join(tempDir, "repo", ".git"));

			const names = (await loadProjectServers(cwd, provider)).map(server => server.name);
			expect(names).toEqual(["leaf"]);
		});

		test("walks to the nearest ancestor when cwd has no file", async () => {
			const repo = path.join(tempDir, "repo");
			const cwd = path.join(repo, "packages", "app");
			await fs.mkdir(cwd, { recursive: true });
			await writeMcpJson(file(repo), { root: { command: "root-cmd" } });
			await fs.mkdir(path.join(repo, ".git"));

			const servers = await loadProjectServers(cwd, provider);
			expect(servers.map(server => server.name)).toEqual(["root"]);
			expect(servers[0]?._source.path).toBe(file(repo));
		});

		test("returns no project servers when neither cwd nor an ancestor has a file", async () => {
			const repo = path.join(tempDir, "repo");
			const cwd = path.join(repo, "app");
			await fs.mkdir(cwd, { recursive: true });
			await fs.mkdir(path.join(repo, ".git"));

			expect(await loadProjectServers(cwd, provider)).toEqual([]);
		});

		test("does not merge stacked ancestor mcp.json files — nearest wins", async () => {
			const repo = path.join(tempDir, "repo");
			const mid = path.join(repo, "packages");
			const cwd = path.join(mid, "app");
			await fs.mkdir(cwd, { recursive: true });
			await writeMcpJson(file(repo), { root: { command: "root-cmd" } });
			await writeMcpJson(file(mid), { mid: { command: "mid-cmd" } });
			await fs.mkdir(path.join(repo, ".git"));

			const names = (await loadProjectServers(cwd, provider)).map(server => server.name);
			expect(names).toEqual(["mid"]);
			expect(names).not.toContain("root");
		});

		test("stops at the repository root and does not load a file outside it", async () => {
			const repo = path.join(tempDir, "repo");
			const cwd = path.join(repo, "app");
			await fs.mkdir(cwd, { recursive: true });
			await writeMcpJson(file(tempDir), { outside: { command: "outside-cmd" } });
			await fs.mkdir(path.join(repo, ".git"));

			expect(await loadProjectServers(cwd, provider)).toEqual([]);
		});
	});

	test("mcp-json still loads both filenames from the same nearest directory", async () => {
		const repo = path.join(tempDir, "repo");
		const cwd = path.join(repo, "app");
		await fs.mkdir(cwd, { recursive: true });
		await writeMcpJson(path.join(repo, "mcp.json"), { primary: { command: "primary-cmd" } });
		await writeMcpJson(path.join(repo, ".mcp.json"), { dotted: { command: "dotted-cmd" } });
		await fs.mkdir(path.join(repo, ".git"));

		const names = (await loadProjectServers(cwd, "mcp-json")).map(server => server.name);
		expect(names).toEqual(["primary", "dotted"]);
	});

	test("native still loads both project filenames from the same nearest directory", async () => {
		const repo = path.join(tempDir, "repo");
		const cwd = path.join(repo, "app");
		await fs.mkdir(cwd, { recursive: true });
		await writeMcpJson(path.join(repo, ".omp", "mcp.json"), { primary: { command: "primary-cmd" } });
		await writeMcpJson(path.join(repo, ".omp", ".mcp.json"), { dotted: { command: "dotted-cmd" } });
		await fs.mkdir(path.join(repo, ".git"));

		const names = (await loadProjectServers(cwd, "native")).map(server => server.name);
		expect(names).toEqual(["primary", "dotted"]);
	});
});
