/**
 * MCP policy seams for tests.
 *
 * The test runner (`scripts/ci-test-ts.ts`) exports `PI_NO_MCP=1` so no test
 * starts the developer's MCP servers, and omp then refuses every MCP server
 * start and skips discovery of configured servers.
 *
 * - {@link allowMCPInTests}: the test starts stub servers it builds itself.
 *   Only server starts are allowed; discovery stays off, so nothing the
 *   developer configured can be found and started.
 * - {@link allowMCPDiscoveryInTests}: the test exercises discovered servers.
 *   Discovery runs too: HOME, the agent dir and the project dir must be inside
 *   the OS temp dir, and every server discovery returns must come from a file
 *   there, or the test fails before any server starts.
 * - {@link setNoMcpEnvForTest}: a test of the disabled state, holding with or
 *   without the runner.
 *
 * Spawned omp processes are covered by none of these: give them
 * `PI_NO_MCP: ""` in their environment instead.
 */
import { beforeEach, onTestFinished, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as mcpConfig from "@oh-my-pi/pi-coding-agent/mcp/config";
import type { LoadMCPConfigsResult } from "@oh-my-pi/pi-coding-agent/mcp/config";
import * as mcpPolicy from "@oh-my-pi/pi-coding-agent/mcp/policy";
import { getAgentDir, getProjectDir, setAgentDir, setProjectDir } from "@oh-my-pi/pi-utils";
import { setNoMcpEnvForTest } from "./no-mcp-env";

/** Environment variables that move a discovery provider's configuration root. */
const CONFIG_ROOT_ENV = ["CLAUDE_CONFIG_DIR", "CODEX_HOME", "COPILOT_HOME", "XDG_CONFIG_HOME"] as const;

function realOrResolved(target: string): string {
	try {
		return fs.realpathSync(target);
	} catch {
		return path.resolve(target);
	}
}

/** Throw unless every root MCP discovery reads lies inside the OS temp dir. */
function assertIsolatedMcpRoots(extra: Array<[string, string]> = []): void {
	const roots: Array<[string, string]> = [
		["HOME", os.homedir()],
		["agent dir", getAgentDir()],
		["project dir", getProjectDir()],
		...extra,
	];
	for (const name of CONFIG_ROOT_ENV) {
		const value = process.env[name];
		if (value) roots.push([name, value]);
	}
	const outside = roots.filter(([, root]) => !insideTemp(root));
	if (outside.length > 0) {
		throw new Error(
			`allowMCPDiscoveryInTests: MCP discovery would read ${outside
				.map(([name, root]) => `${name}=${root}`)
				.join(", ")}, outside ${os.tmpdir()}. Point them at a temp dir so the test cannot start your own servers.`,
		);
	}
}

function insideTemp(target: string): boolean {
	const temp = realOrResolved(os.tmpdir());
	const resolved = realOrResolved(target);
	return resolved === temp || resolved.startsWith(`${temp}${path.sep}`);
}

/**
 * Throw unless every server discovery found comes from a file inside the OS
 * temp dir. Checked on the result, so it holds however discovery found the
 * file: a relative or invocation-scoped extension root, a root from settings,
 * a provider's own search path.
 */
function assertIsolatedDiscovery(result: LoadMCPConfigsResult): void {
	const outside = Object.keys(result.configs).filter(name => {
		const source = result.sources[name];
		return !source || !insideTemp(source.path);
	});
	if (outside.length > 0) {
		throw new Error(
			`allowMCPDiscoveryInTests: MCP discovery found ${outside
				.map(name => `"${name}" in ${result.sources[name]?.path ?? "an unknown source"}`)
				.join(", ")}, outside ${os.tmpdir()}. A test may discover only servers it configured in a temp dir.`,
		);
	}
}

/** Let every test in the enclosing scope start MCP servers it builds itself; discovery stays off. */
export function allowMCPInTests(): void {
	beforeEach(() => {
		const spy = vi.spyOn(mcpPolicy, "refusesMCPServerStarts").mockReturnValue(false);
		// After the test's own afterEach hooks, which may still close servers.
		onTestFinished(() => spy.mockRestore());
	});
}

/**
 * Let every test in the enclosing scope discover and start MCP servers. Each
 * test gets its own temp HOME, agent dir and project dir, and the variables that move a
 * provider's root are cleared; a test may point them at its own temp dirs.
 * Whenever omp consults the policy, every root must still be in the temp dir.
 */
export function allowMCPDiscoveryInTests(): void {
	beforeEach(() => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "omp-mcp-discovery-test-"));
		const home = path.join(root, "home");
		fs.mkdirSync(home, { recursive: true });
		const savedEnv = new Map<string, string | undefined>(
			[...CONFIG_ROOT_ENV, "PI_CODING_AGENT_DIR"].map(name => [name, process.env[name]]),
		);
		const savedAgentDir = getAgentDir();
		const savedProjectDir = getProjectDir();
		for (const name of CONFIG_ROOT_ENV) delete process.env[name];
		setAgentDir(path.join(home, ".omp", "agent"));
		const project = path.join(root, "project");
		fs.mkdirSync(project, { recursive: true });
		setProjectDir(project);
		const allowWhenIsolated = (): boolean => {
			assertIsolatedMcpRoots();
			return false;
		};
		const loadAllMCPConfigs = mcpConfig.loadAllMCPConfigs;
		const spies = [
			vi.spyOn(os, "homedir").mockReturnValue(home),
			// No discovered server may come from outside the temp dir, wherever discovery looked.
			vi.spyOn(mcpConfig, "loadAllMCPConfigs").mockImplementation(async (cwd, options) => {
				assertIsolatedMcpRoots([["discovery cwd", cwd]]);
				const result = await loadAllMCPConfigs(cwd, options);
				assertIsolatedDiscovery(result);
				return result;
			}),
			vi.spyOn(mcpPolicy, "isMCPDisabled").mockImplementation(allowWhenIsolated),
			vi.spyOn(mcpPolicy, "refusesMCPServerStarts").mockImplementation(allowWhenIsolated),
		];
		// After the test's own afterEach hooks, so a hook that restores what it changed lands first.
		onTestFinished(() => {
			for (const spy of spies) spy.mockRestore();
			setAgentDir(savedAgentDir);
			setProjectDir(savedProjectDir);
			for (const [name, value] of savedEnv) {
				if (value === undefined) delete process.env[name];
				else process.env[name] = value;
			}
			fs.rmSync(root, { recursive: true, force: true });
		});
	});
}

export { setNoMcpEnvForTest };
