/**
 * Built-in MCP transforms: `loadAllMCPConfigs` leaves a recognized server
 * unconnected while the session's own tools do its job, reports what it dropped
 * (so `/mcp list` can say why a configured server is not running), and never
 * overrides an explicit enable.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { clearCache as clearFsCache } from "@oh-my-pi/pi-coding-agent/capability/fs";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { cfgEvalJs } from "@oh-my-pi/pi-coding-agent/eval/settings";
import { loadAllMCPConfigs } from "@oh-my-pi/pi-coding-agent/mcp/config";
import { cfgMcpBuiltinTransforms } from "@oh-my-pi/pi-coding-agent/mcp/settings";
import { resolveMCPTransformContext } from "@oh-my-pi/pi-coding-agent/mcp/transforms";
import { getConfigRootDir, removeWithRetries, setAgentDir } from "@oh-my-pi/pi-utils";
import "@oh-my-pi/pi-coding-agent/discovery";

const originalAgentDirEnv = process.env.PI_CODING_AGENT_DIR;
const fallbackAgentDir = path.join(getConfigRootDir(), "agent");

/** Codex Desktop's entries as it writes them on macOS and Windows, plus a server that only shares the name. */
const CODEX_CONFIG = `
[mcp_servers.codex_js]
command = "/Applications/ChatGPT.app/Contents/Resources/cua_node/bin/node_repl"

[mcp_servers.codex_win]
command = 'C:\\Program Files\\Codex\\resources\\cua_node\\2fb562745e6d66f0\\bin\\node_repl.exe'

[mcp_servers.node_repl]
command = "my-own-repl"
`;

describe("built-in MCP transforms", () => {
	let tempHome = "";
	let projectDir = "";
	let userAgentDir = "";
	let originalHome: string | undefined;

	async function writeJson(file: string, value: unknown): Promise<void> {
		clearFsCache();
		await Bun.write(file, JSON.stringify(value, null, 2));
	}

	async function load(evalJs: boolean | undefined) {
		const result = await loadAllMCPConfigs(projectDir, {
			filterExa: false,
			...(evalJs !== undefined && { builtinTransforms: { evalJs } }),
		});
		return {
			connected: Object.keys(result.configs).sort(),
			dropped: result.dropped ? Object.keys(result.dropped).sort() : undefined,
			result,
		};
	}

	beforeEach(async () => {
		originalHome = process.env.HOME;
		tempHome = await fs.mkdtemp(path.join(os.tmpdir(), "omp-mcp-transform-home-"));
		projectDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-mcp-transform-project-"));
		userAgentDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-mcp-transform-agent-"));
		process.env.HOME = tempHome;
		vi.spyOn(os, "homedir").mockReturnValue(tempHome);
		setAgentDir(userAgentDir);
		clearFsCache();
		await Bun.write(path.join(projectDir, ".codex", "config.toml"), CODEX_CONFIG);
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

	test("drops Codex's bundled REPL by its binary, not its name, while eval runs JavaScript", async () => {
		const { connected, dropped, result } = await load(true);

		expect(connected).toEqual(["node_repl"]);
		expect(dropped).toEqual(["codex_js", "codex_win"]);
		// The report names the file the server was inherited from.
		expect(result.dropped?.codex_js?.source.path).toBe(path.join(projectDir, ".codex", "config.toml"));
	});

	test("keeps it when eval cannot run JavaScript, and when no session context is given", async () => {
		const all = ["codex_js", "codex_win", "node_repl"];

		expect(await load(false)).toMatchObject({ connected: all, dropped: undefined });
		expect(await load(undefined)).toMatchObject({ connected: all, dropped: undefined });
	});

	test("an explicit enable outranks the drop", async () => {
		// `/mcp enable` on another tool's server lands in the user allowlist; on
		// an omp-owned entry it writes `enabled: true`.
		await writeJson(path.join(userAgentDir, "mcp.json"), { mcpServers: {}, enabledServers: ["codex_js"] });
		await writeJson(path.join(projectDir, ".omp", "mcp.json"), {
			mcpServers: {
				kept_repl: { command: "/opt/a/node_repl", enabled: true },
				bare_repl: { command: "/opt/b/node_repl" },
			},
		});

		const { connected, dropped } = await load(true);

		expect(connected).toEqual(["codex_js", "kept_repl", "node_repl"]);
		expect(dropped).toEqual(["bare_repl", "codex_win"]);
	});

	test("does not report a match under a name a higher-priority server owns", async () => {
		// The omp-owned `codex_js` is the one that connects; Codex's same-named
		// entry was shadowed already, so listing it as replaced would be wrong.
		await writeJson(path.join(projectDir, ".omp", "mcp.json"), { mcpServers: { codex_js: { command: "mine" } } });

		const { dropped, result } = await load(true);

		expect(result.configs.codex_js).toMatchObject({ command: "mine" });
		expect(dropped).toEqual(["codex_win"]);
	});

	test("the session context follows mcp.builtinTransforms and eval.js", () => {
		const settings = Settings.isolated();
		expect(resolveMCPTransformContext(settings, { evalActive: true })).toEqual({ evalJs: true });
		expect(resolveMCPTransformContext(settings, { evalActive: false })).toEqual({ evalJs: false });

		cfgEvalJs.set(settings, false);
		expect(resolveMCPTransformContext(settings, { evalActive: true })).toEqual({ evalJs: false });

		cfgMcpBuiltinTransforms.set(settings, false);
		expect(resolveMCPTransformContext(settings, { evalActive: true })).toBeUndefined();
	});
});
