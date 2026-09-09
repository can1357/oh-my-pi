/**
 * Regression: user-level MCP discovery must follow the active profile.
 *
 * A named profile relocates the agent directory to ~/.omp/profiles/<name>/agent.
 * The native config provider used to read user-scope mcp.json from the literal
 * home (~/.omp/agent/mcp.json) via `ctx.home`, so a profile never saw its own
 * user-level servers while the default profile's servers leaked into every
 * profile. Discovery now resolves the user scope through getAgentDir(), matching
 * the /mcp config writer and getMCPConfigPath("user").
 *
 * `os.homedir()` is mocked so the *old* code path (ctx.home + ".omp/agent")
 * points at the tempdir decoy below; without the fix the profile case fails
 * because it would load the decoy default server instead of the profile server.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { clearCache as clearFsCache } from "@oh-my-pi/pi-coding-agent/capability/fs";
import { type MCPServer, mcpCapability } from "@oh-my-pi/pi-coding-agent/capability/mcp";
import { loadCapability } from "@oh-my-pi/pi-coding-agent/discovery";
import { getConfigRootDir, removeWithRetries, setAgentDir } from "@oh-my-pi/pi-utils";

const originalAgentDirEnv = process.env.PI_CODING_AGENT_DIR;
const fallbackAgentDir = path.join(getConfigRootDir(), "agent");

async function writeMcpJson(dir: string, servers: Record<string, unknown>): Promise<void> {
	await fs.mkdir(dir, { recursive: true });
	await fs.writeFile(path.join(dir, "mcp.json"), JSON.stringify({ mcpServers: servers }, null, 2));
}

async function loadNativeUserServers(cwd: string): Promise<MCPServer[]> {
	clearFsCache();
	const result = await loadCapability<MCPServer>(mcpCapability.id, { cwd, providers: ["native"] });
	return result.items;
}

describe("native user-level MCP discovery follows the active profile", () => {
	let tempHome = "";
	let projectDir = "";
	let originalHome: string | undefined;

	beforeEach(async () => {
		originalHome = process.env.HOME;
		tempHome = await fs.mkdtemp(path.join(os.tmpdir(), "omp-mcp-profile-home-"));
		projectDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-mcp-profile-project-"));
		process.env.HOME = tempHome;
		vi.spyOn(os, "homedir").mockReturnValue(tempHome);
		clearFsCache();
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		clearFsCache();
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
	});

	test("active profile loads its own user server, not the default profile's", async () => {
		// Active profile's agent dir (stand-in for ~/.omp/profiles/<name>/agent).
		const profileAgentDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-mcp-profile-agent-"));
		setAgentDir(profileAgentDir);

		// Decoy: the default profile's user file at the literal-home path the old
		// (buggy) loader read. It must NOT leak into the active profile.
		await writeMcpJson(path.join(tempHome, ".omp", "agent"), {
			"default-only": { command: "default-cmd" },
		});
		await writeMcpJson(profileAgentDir, {
			"profile-only": { command: "profile-cmd" },
		});

		const servers = await loadNativeUserServers(projectDir);
		const names = servers.map(s => s.name);

		expect(names).toContain("profile-only");
		expect(names).not.toContain("default-only");

		const profileServer = servers.find(s => s.name === "profile-only");
		expect(profileServer?.command).toBe("profile-cmd");
		expect(profileServer?._source.level).toBe("user");
		expect(profileServer?._source.path).toBe(path.join(profileAgentDir, "mcp.json"));

		await removeWithRetries(profileAgentDir);
	});

	test("default profile loads the user server from ~/.omp/agent", async () => {
		const defaultAgentDir = path.join(tempHome, ".omp", "agent");
		setAgentDir(defaultAgentDir);
		await writeMcpJson(defaultAgentDir, {
			"default-only": { command: "default-cmd" },
		});

		const servers = await loadNativeUserServers(projectDir);

		const found = servers.find(s => s.name === "default-only");
		expect(found).toBeDefined();
		expect(found?.command).toBe("default-cmd");
		expect(found?._source.level).toBe("user");
		expect(found?._source.path).toBe(path.join(defaultAgentDir, "mcp.json"));
	});
});
