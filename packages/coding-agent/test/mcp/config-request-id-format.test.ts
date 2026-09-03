/**
 * `requestIdFormat` must survive the documented config path, and must not be lost
 * to connection-equivalence deduplication.
 *
 * The option is only useful if a value written in config actually reaches the
 * transport: discovery parses config into the canonical `MCPServer` shape and
 * `convertToLegacyConfig()` turns that back into the `MCPServerConfig` the
 * transports read. A field missing from either step silently degrades to the
 * snowflake-string default, which is the hang the option exists to avoid.
 *
 * Both OMP-native loaders are covered: `.omp/mcp.json` (native provider) and a
 * standalone project-root `.mcp.json` (mcp-json provider).
 *
 * Separately, `isSameMCPConnection` treats two differently-named entries with the
 * same command/args/env/cwd as aliases of one connection, keeping only the
 * higher-priority one. `requestIdFormat` changes the bytes sent on the wire, so it
 * must be part of that comparison — otherwise a discovered alias lacking the field
 * could shadow a `.mcp.json` entry that set it, silently reverting to string ids.
 */
import { afterEach, beforeEach, expect, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
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
	tempHome = await fs.mkdtemp(path.join(os.tmpdir(), "omp-mcp-reqid-home-"));
	tempAgentDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-mcp-reqid-agent-"));
	tempCwd = await fs.mkdtemp(path.join(os.tmpdir(), "omp-mcp-reqid-cwd-"));
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

test("requestIdFormat from .omp/mcp.json reaches the transport config", async () => {
	const configs = await loadFrom(path.join(".omp", "mcp.json"), {
		xcode: { type: "stdio", command: "/usr/bin/xcrun", args: ["mcpbridge"], requestIdFormat: "number" },
		plain: { type: "stdio", command: "/bin/echo" },
	});

	expect(configs.xcode?.requestIdFormat).toBe("number");
	// Unset stays unset so the allocator keeps its integer default.
	expect(configs.plain?.requestIdFormat).toBeUndefined();
});

test("requestIdFormat from a standalone .mcp.json reaches the transport config", async () => {
	const configs = await loadFrom(".mcp.json", {
		xcode: { type: "stdio", command: "/usr/bin/xcrun", args: ["mcpbridge"], requestIdFormat: "number" },
	});

	expect(configs.xcode?.requestIdFormat).toBe("number");
});

test("an unrecognized requestIdFormat is dropped rather than passed through", async () => {
	const configs = await loadFrom(path.join(".omp", "mcp.json"), {
		bogus: { type: "stdio", command: "/bin/echo", requestIdFormat: "integer" },
	});

	expect(configs.bogus).toBeDefined();
	expect(configs.bogus?.requestIdFormat).toBeUndefined();
});

test("differing requestIdFormat prevents equivalence dedup from collapsing two aliases", async () => {
	const configs = await loadFrom(path.join(".omp", "mcp.json"), {
		"xcode-string": { type: "stdio", command: "/usr/bin/xcrun", args: ["mcpbridge"], requestIdFormat: "string" },
		"xcode-default": { type: "stdio", command: "/usr/bin/xcrun", args: ["mcpbridge"] },
	});

	// Same command/args would previously make these equivalent, so the second
	// entry (whichever loads later) would shadow the first and its distinct
	// requestIdFormat setting would vanish. Both must survive as separate
	// servers — assert key presence directly, since optional chaining on a
	// shadowed (absent) key would otherwise make this pass vacuously.
	expect(Object.keys(configs).sort()).toEqual(["xcode-default", "xcode-string"]);
	expect(configs["xcode-string"]?.requestIdFormat).toBe("string");
	expect(configs["xcode-default"]?.requestIdFormat).toBeUndefined();
});

test('an explicit "number" is the default, so dedup collapses it with an unset alias', async () => {
	const configs = await loadFrom(path.join(".omp", "mcp.json"), {
		"xcode-numeric": { type: "stdio", command: "/usr/bin/xcrun", args: ["mcpbridge"], requestIdFormat: "number" },
		"xcode-default": { type: "stdio", command: "/usr/bin/xcrun", args: ["mcpbridge"] },
	});

	// Explicit "number" matches the allocator default, so both entries name the
	// same connection and only one survives.
	expect(Object.keys(configs)).toHaveLength(1);
});
