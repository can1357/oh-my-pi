import { afterEach, beforeEach, expect, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { clearCache as clearFsCache } from "@oh-my-pi/pi-coding-agent/capability/fs";
import { loadAllMCPConfigs } from "@oh-my-pi/pi-coding-agent/mcp/config";
import { getConfigRootDir, removeWithRetries, setAgentDir } from "@oh-my-pi/pi-utils";

// Concatenation avoids the noTemplateCurlyInString lint on literal placeholder names.
const OMP_ROOT_VAR = "$" + "{OMP_PLUGIN_ROOT}";
const CLAUDE_ROOT_VAR = "$" + "{CLAUDE_PLUGIN_ROOT}";

const originalAgentDirEnv = process.env.PI_CODING_AGENT_DIR;
const fallbackAgentDir = path.join(getConfigRootDir(), "agent");

let root = "";
let home = "";
let projectDir = "";
let ext = "";
let tempAgentDir = "";
let originalHome: string | undefined;

beforeEach(async () => {
	clearFsCache();
	originalHome = process.env.HOME;
	root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-plugins-mcp-filter-"));
	home = path.join(root, "home");
	projectDir = path.join(root, "project");
	ext = path.join(root, "ext");
	tempAgentDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-plugins-mcp-filter-agent-"));
	process.env.HOME = home;
	vi.spyOn(os, "homedir").mockReturnValue(home);
	setAgentDir(tempAgentDir);
	await fs.mkdir(path.join(projectDir, ".git"), { recursive: true });
	await fs.mkdir(ext, { recursive: true });
});

afterEach(async () => {
	clearFsCache();
	vi.restoreAllMocks();
	if (originalAgentDirEnv) {
		setAgentDir(originalAgentDirEnv);
	} else {
		setAgentDir(fallbackAgentDir);
		delete process.env.PI_CODING_AGENT_DIR;
	}
	if (originalHome === undefined) delete process.env.HOME;
	else process.env.HOME = originalHome;
	await removeWithRetries(root);
	await removeWithRetries(tempAgentDir);
});

test("omp-plugins resolves plugin-root scalars but keeps filter entries literal", async () => {
	await fs.writeFile(
		path.join(ext, ".mcp.json"),
		JSON.stringify({
			mcpServers: {
				stdio: {
					command: `${OMP_ROOT_VAR}/bin/srv`,
					args: [`${OMP_ROOT_VAR}/a`],
					env: { T: OMP_ROOT_VAR },
					cwd: OMP_ROOT_VAR,
					enabledTools: [OMP_ROOT_VAR, "plain_*"],
					disabledTools: [CLAUDE_ROOT_VAR],
				},
				http: {
					type: "http",
					url: "https://mcp.example.test/mcp",
					headers: { Authorization: `Bearer ${OMP_ROOT_VAR}` },
				},
			},
		}),
	);

	const result = await loadAllMCPConfigs(projectDir, {
		filterExa: false,
		extensionRoots: { explicit: [ext], mode: "merge", configured: [], configuredLevel: "user" },
	});
	expect(result.sources.stdio?.provider).toBe("omp-plugins");
	expect(result.sources.http?.provider).toBe("omp-plugins");
	const stdio = result.configs.stdio as
		| {
				command?: string;
				args?: string[];
				env?: Record<string, string>;
				cwd?: string;
				enabledTools?: string[];
				disabledTools?: string[];
		  }
		| undefined;
	expect(stdio).toBeDefined();
	expect(stdio?.command).toBe(path.join(ext, "bin", "srv"));
	expect(stdio?.args).toEqual([path.join(ext, "a")]);
	expect(stdio?.env).toMatchObject({ T: ext });
	expect(stdio?.cwd).toBe(ext);
	expect(stdio?.enabledTools).toEqual([OMP_ROOT_VAR, "plain_*"]);
	expect(stdio?.disabledTools).toEqual([CLAUDE_ROOT_VAR]);
	const http = result.configs.http as { headers?: Record<string, string> } | undefined;
	expect(http?.headers).toMatchObject({ Authorization: `Bearer ${ext}` });
});
