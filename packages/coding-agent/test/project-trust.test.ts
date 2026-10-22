/**
 * Project trust gate: an untrusted project's code-running config (here an MCP
 * server in `.omp/mcp.json`) must not load, must not shadow the user's own
 * equivalent server, and must still be listed for the trust prompt. Trust
 * persisted by `trustProject` lets it load.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { projectTrustRoot, resetCapabilityForTests, setProjectTrustCheck } from "@oh-my-pi/pi-coding-agent/capability";
import { clearCache as clearFsCache } from "@oh-my-pi/pi-coding-agent/capability/fs";
import {
	listProjectCodeSources,
	loadTrustedProjects,
	trustProject,
} from "@oh-my-pi/pi-coding-agent/config/project-trust";
import { loadAllMCPConfigs } from "@oh-my-pi/pi-coding-agent/mcp/config";
import { getConfigRootDir, removeWithRetries, setAgentDir } from "@oh-my-pi/pi-utils";
import "@oh-my-pi/pi-coding-agent/discovery";

const originalAgentDirEnv = process.env.PI_CODING_AGENT_DIR;
const fallbackAgentDir = path.join(getConfigRootDir(), "agent");
const CONNECTION = { type: "http", url: "https://mcp.example/mcp" } as const;

async function writeMcpJson(filePath: string, servers: Record<string, unknown>): Promise<void> {
	await Bun.write(filePath, JSON.stringify({ mcpServers: servers }, null, 2));
}

describe("project trust gate", () => {
	let tempHome = "";
	let projectDir = "";
	let userAgentDir = "";
	let originalHome: string | undefined;

	beforeEach(async () => {
		originalHome = process.env.HOME;
		tempHome = await fs.mkdtemp(path.join(os.tmpdir(), "omp-trust-home-"));
		projectDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-trust-project-"));
		userAgentDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-trust-agent-"));
		process.env.HOME = tempHome;
		vi.spyOn(os, "homedir").mockReturnValue(tempHome);
		setAgentDir(userAgentDir);
		clearFsCache();
		await writeMcpJson(path.join(projectDir, ".omp", "mcp.json"), { projcontext: CONNECTION });
		await writeMcpJson(path.join(userAgentDir, "mcp.json"), { usercontext: CONNECTION });
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		resetCapabilityForTests();
		if (originalAgentDirEnv) {
			setAgentDir(originalAgentDirEnv);
		} else {
			setAgentDir(fallbackAgentDir);
			delete process.env.PI_CODING_AGENT_DIR;
		}
		if (originalHome === undefined) delete process.env.HOME;
		else process.env.HOME = originalHome;
		await removeWithRetries(tempHome);
		await removeWithRetries(projectDir);
		await removeWithRetries(userAgentDir);
	});

	test("an untrusted project's MCP server is skipped but listed for the prompt", async () => {
		setProjectTrustCheck(() => false);

		const result = await loadAllMCPConfigs(projectDir, { filterExa: false });
		// The equivalent project alias would win dedupe if it were not dropped first.
		expect(Object.keys(result.configs)).toEqual(["usercontext"]);

		const sources = await listProjectCodeSources(projectDir);
		expect(sources).toContainEqual({ kind: "MCP Servers", path: path.join(projectDir, ".omp", "mcp.json") });
	});

	test("persisted trust loads the project's MCP server", async () => {
		const root = await projectTrustRoot(projectDir);
		await trustProject(root);
		const trusted = await loadTrustedProjects();
		setProjectTrustCheck(candidate => trusted.has(candidate));

		const result = await loadAllMCPConfigs(projectDir, { filterExa: false });
		expect(Object.keys(result.configs)).toEqual(["projcontext"]);
	});
});
