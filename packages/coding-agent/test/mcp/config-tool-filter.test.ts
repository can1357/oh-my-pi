/**
 * `enabledTools` / `disabledTools` must survive the documented config path,
 * and must not be lost to (or collapse in) connection-equivalence deduplication.
 *
 * The filters are only useful if a value written in config actually reaches
 * the reception filter in `listTools`: discovery parses config into the
 * canonical `MCPServer` shape and `convertToLegacyConfig()` turns that back
 * into the `MCPServerConfig` the client reads. A field missing from either
 * step silently re-enables every tool — the opposite of the allowlist intent.
 *
 * Both OMP-native loaders are covered: `.omp/mcp.json` (native provider) and
 * a standalone project-root `.mcp.json` (mcp-json provider).
 *
 * Separately, `isSameMCPConnection` deduplicates same-endpoint aliases.
 * Different filter members mean different contributed tool sets, so aliases
 * differing only in filters must both survive; identical (order/duplicate-
 * insensitive) filter sets must still collapse to one.
 */
import { afterEach, beforeEach, expect, test, vi } from "bun:test";
import * as os from "node:os";
import * as path from "node:path";
import * as fs from "node:fs/promises";
import { clearCache as clearFsCache } from "@oh-my-pi/pi-coding-agent/capability/fs";
import { loadAllMCPConfigs } from "@oh-my-pi/pi-coding-agent/mcp/config";
import { getConfigRootDir, removeWithRetries, setAgentDir } from "@oh-my-pi/pi-utils";

const originalAgentDirEnv = process.env.PI_CODING_AGENT_DIR;
const fallbackAgentDir = path.join(getConfigRootDir(), "agent");

let tempAgentDir = "";
let tempCwd = "";
let tempHome = "";
let originalHome: string | undefined;

beforeEach(async () => {
	originalHome = process.env.HOME;
	tempHome = await fs.mkdtemp(path.join(os.tmpdir(), "omp-mcp-toolfilter-home-"));
	tempAgentDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-mcp-toolfilter-agent-"));
	tempCwd = await fs.mkdtemp(path.join(os.tmpdir(), "omp-mcp-toolfilter-cwd-"));
	process.env.HOME = tempHome;
	vi.spyOn(os, "homedir").mockReturnValue(tempHome);
	setAgentDir(tempAgentDir);
	clearFsCache();
});

afterEach(async () => {
	vi.restoreAllMocks();
	if (originalAgentDirEnv) {
		setAgentDir(originalAgentDirEnv);
	} else {
		setAgentDir(fallbackAgentDir);
		delete process.env.PI_CODING_AGENT_DIR;
	}
	if (originalHome === undefined) delete process.env.HOME;
	else process.env.HOME = originalHome;
	clearFsCache();
	await removeWithRetries(tempHome);
	await removeWithRetries(tempAgentDir);
	await removeWithRetries(tempCwd);
});

async function loadFrom(file: string, mcpServers: Record<string, unknown>) {
	await Bun.write(path.join(tempCwd, file), JSON.stringify({ mcpServers }));
	clearFsCache();
	const { configs } = await loadAllMCPConfigs(tempCwd);
	return configs;
}

test("enabledTools/disabledTools from .omp/mcp.json reach the transport config", async () => {
	const configs = await loadFrom(path.join(".omp", "mcp.json"), {
		slack: {
			type: "http",
			url: "https://mcp.slack.com/mcp",
			enabledTools: ["search", "channel_*"],
			disabledTools: ["{create,delete}_*"],
		},
		plain: { type: "stdio", command: "/bin/echo" },
	});

	expect(configs.slack?.enabledTools).toEqual(["search", "channel_*"]);
	// Comma globs must survive intact — strings are not CSV-split.
	expect(configs.slack?.disabledTools).toEqual(["{create,delete}_*"]);
	expect(configs.plain?.enabledTools).toBeUndefined();
	expect(configs.plain?.disabledTools).toBeUndefined();
});

test("enabledTools/disabledTools from a standalone .mcp.json reach the transport config", async () => {
	const configs = await loadFrom(".mcp.json", {
		slack: { type: "http", url: "https://mcp.slack.com/mcp", enabledTools: ["read_*"] },
	});

	expect(configs.slack?.enabledTools).toEqual(["read_*"]);
});

test("a non-array filter value is dropped rather than passed through", async () => {
	const configs = await loadFrom(path.join(".omp", "mcp.json"), {
		bogus: { type: "stdio", command: "/bin/echo", enabledTools: "read, write" },
	});

	expect(configs.bogus).toBeDefined();
	expect(configs.bogus?.enabledTools).toBeUndefined();
});

test("differing filter members prevent equivalence dedup from collapsing two aliases", async () => {
	const configs = await loadFrom(path.join(".omp", "mcp.json"), {
		"slack-allow-search": { type: "http", url: "https://mcp.slack.com/mcp", enabledTools: ["search"] },
		"slack-allow-read": { type: "http", url: "https://mcp.slack.com/mcp", enabledTools: ["read_*"] },
	});

	// Same endpoint would previously make these equivalent, so the second
	// entry would shadow the first and its filter would vanish. Both must
	// survive — assert key presence directly, since optional chaining on a
	// shadowed (absent) key would otherwise make this pass vacuously.
	expect(Object.keys(configs).sort()).toEqual(["slack-allow-read", "slack-allow-search"]);
	expect(configs["slack-allow-search"]?.enabledTools).toEqual(["search"]);
	expect(configs["slack-allow-read"]?.enabledTools).toEqual(["read_*"]);
});

test("identical filter sets (reordered, duplicated) still dedup to one connection", async () => {
	const configs = await loadFrom(path.join(".omp", "mcp.json"), {
		"slack-a": { type: "http", url: "https://mcp.slack.com/mcp", enabledTools: ["search", "read"] },
		"slack-b": { type: "http", url: "https://mcp.slack.com/mcp", enabledTools: ["read", "search", "search"] },
	});

	// Normalized (unique, sorted) members are equal, so both entries name the
	// same connection and only one survives.
	expect(Object.keys(configs)).toHaveLength(1);
});
