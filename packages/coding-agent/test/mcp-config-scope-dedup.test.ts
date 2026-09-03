/**
 * Regression: project-scope filtering must run BEFORE MCP connection-equivalence
 * deduplication. The native provider orders project entries before user entries,
 * so a project server can shadow a differently-named but connection-equivalent
 * user server during dedup. When `enableProjectConfig` is false the project entry
 * is then removed, and without pre-dedup scope filtering no server would survive.
 *
 * Disabled servers are different: a disabled entry must still OWN its name at
 * key-level dedupe (a disabled project `foo` keeps a same-named user `foo`
 * disabled) while never equivalence-shadowing a differently-named enabled
 * server. That is the `suppress` path in loadAllMCPConfigs.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { clearCache as clearFsCache } from "@oh-my-pi/pi-coding-agent/capability/fs";
import { loadAllMCPConfigs } from "@oh-my-pi/pi-coding-agent/mcp/config";
import { getConfigRootDir, removeWithRetries, setAgentDir } from "@oh-my-pi/pi-utils";
import "@oh-my-pi/pi-coding-agent/discovery";

const originalAgentDirEnv = process.env.PI_CODING_AGENT_DIR;
const fallbackAgentDir = path.join(getConfigRootDir(), "agent");
const CONNECTION = { type: "http", url: "https://mcp.example/mcp" } as const;

async function writeMcpJson(dir: string, servers: Record<string, unknown>): Promise<void> {
	await fs.mkdir(dir, { recursive: true });
	await fs.writeFile(path.join(dir, "mcp.json"), JSON.stringify({ mcpServers: servers }, null, 2));
}

describe("MCP scope filtering precedes connection-equivalence deduplication", () => {
	let tempHome = "";
	let projectDir = "";
	let userAgentDir = "";
	let originalHome: string | undefined;

	beforeEach(async () => {
		originalHome = process.env.HOME;
		tempHome = await fs.mkdtemp(path.join(os.tmpdir(), "omp-mcp-scope-home-"));
		projectDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-mcp-scope-project-"));
		userAgentDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-mcp-scope-agent-"));
		process.env.HOME = tempHome;
		vi.spyOn(os, "homedir").mockReturnValue(tempHome);
		setAgentDir(userAgentDir);
		clearFsCache();
		// Same connection identity under two distinct names, one per scope.
		await writeMcpJson(path.join(projectDir, ".omp"), { projcontext: CONNECTION });
		await writeMcpJson(userAgentDir, { usercontext: CONNECTION });
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
		await removeWithRetries(userAgentDir);
	});

	test("keeps the user server when project config is disabled", async () => {
		const result = await loadAllMCPConfigs(projectDir, { enableProjectConfig: false, filterExa: false });
		expect(Object.keys(result.configs)).toEqual(["usercontext"]);
		expect(result.sources.usercontext?.level).toBe("user");
	});

	test("collapses the equivalent alias to the higher-priority project name when enabled", async () => {
		const result = await loadAllMCPConfigs(projectDir, { enableProjectConfig: true, filterExa: false });
		expect(Object.keys(result.configs)).toEqual(["projcontext"]);
		expect(result.sources.projcontext?.level).toBe("project");
	});

	test("keeps the enabled alias when an equivalent higher-priority server is disabled", async () => {
		// Higher-priority project server disabled via `enabled: false`; a differently
		// named but connection-equivalent user server stays enabled and must survive.
		await writeMcpJson(path.join(projectDir, ".omp"), { projcontext: { ...CONNECTION, enabled: false } });
		const result = await loadAllMCPConfigs(projectDir, { enableProjectConfig: true, filterExa: false });
		expect(Object.keys(result.configs)).toEqual(["usercontext"]);
		expect(result.sources.usercontext?.level).toBe("user");
	});

	test("project-disabled server keeps a same-named enabled user server disabled", async () => {
		// Same name in both scopes: the higher-priority project entry owns the
		// key even while disabled, so the enabled user entry must NOT survive
		// and connect. An equivalent user server under a DIFFERENT name is not
		// starved by the disabled owner and still survives.
		await writeMcpJson(path.join(projectDir, ".omp"), { shared: { ...CONNECTION, enabled: false } });
		await writeMcpJson(userAgentDir, { shared: CONNECTION, usercontext: CONNECTION });
		const result = await loadAllMCPConfigs(projectDir, { enableProjectConfig: true, filterExa: false });
		expect(Object.keys(result.configs)).toEqual(["usercontext"]);
		expect(result.sources.usercontext?.level).toBe("user");
	});

	test("same-named user server survives when project config is scope-disabled", async () => {
		// Scope exclusion removes the project entry entirely — unlike a disabled
		// entry, it must not claim the key and shadow the user server.
		await writeMcpJson(path.join(projectDir, ".omp"), { shared: { ...CONNECTION, enabled: false } });
		await writeMcpJson(userAgentDir, { shared: CONNECTION });
		const result = await loadAllMCPConfigs(projectDir, { enableProjectConfig: false, filterExa: false });
		expect(Object.keys(result.configs)).toEqual(["shared"]);
		expect(result.sources.shared?.level).toBe("user");
	});

	test("effective extension roots survive scopeless MCP rediscovery", async () => {
		const extensionDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-mcp-extension-"));
		try {
			await fs.writeFile(
				path.join(extensionDir, ".mcp.json"),
				JSON.stringify({ mcpServers: { extensionserver: { command: "extension-mcp" } } }),
			);

			const withEffectiveRoots = await loadAllMCPConfigs(projectDir, {
				filterExa: false,
				extensionRoots: { explicit: [extensionDir], mode: "merge", configured: [], configuredLevel: "user" },
			});
			expect(withEffectiveRoots.configs.extensionserver).toMatchObject({ command: "extension-mcp" });

			const diskOnly = await loadAllMCPConfigs(projectDir, { filterExa: false });
			expect(diskOnly.configs.extensionserver).toBeUndefined();
		} finally {
			await removeWithRetries(extensionDir);
		}
	});
});
