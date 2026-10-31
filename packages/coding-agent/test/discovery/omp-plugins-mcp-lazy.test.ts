/**
 * Regression test for the `omp-plugins` MCP discovery path (PR #9793).
 *
 * `src/discovery/omp-plugins.ts` previously dropped `lazy` when mapping a
 * plugin-declared `.mcp.json`/`mcp.json` server, silently turning a
 * plugin-declared lazy server eager, and forwarded `enabled` uncoerced so a
 * string value (including one produced by environment expansion) never became
 * a boolean. Both fields now go through `parseMcpBooleanField`, matching the
 * builtin and standalone mcp.json providers.
 *
 * The provider is invoked directly so the `LoadContext` uses a tempdir as
 * `home` instead of `os.homedir()`.
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { getCapability } from "@oh-my-pi/pi-coding-agent/capability";
import { clearCache } from "@oh-my-pi/pi-coding-agent/capability/fs";
import { mcpCapability } from "@oh-my-pi/pi-coding-agent/capability/mcp";
import type { LoadContext, Provider } from "@oh-my-pi/pi-coding-agent/capability/types";
// Register all discovery providers as a side effect.
import "@oh-my-pi/pi-coding-agent/discovery";
import { clearOmpExtensionCliRoots } from "@oh-my-pi/pi-coding-agent/discovery/omp-extension-roots";
import { getConfigRootDir, removeSyncWithRetries, setAgentDir } from "@oh-my-pi/pi-utils";

const PROVIDER_ID = "omp-plugins";

let tempDir: string;
let home: string;
let project: string;
let ext: string;

const originalAgentDirEnv = process.env.PI_CODING_AGENT_DIR;
const fallbackAgentDir = path.join(getConfigRootDir(), "agent");

async function writeFile(filePath: string, content: string): Promise<void> {
	await Bun.write(filePath, content);
}

function pluginProvider(capabilityId: string): Provider<unknown> {
	const cap = getCapability(capabilityId);
	if (!cap) throw new Error(`capability ${capabilityId} missing`);
	const provider = cap.providers.find(p => p.id === PROVIDER_ID);
	if (!provider) throw new Error(`provider ${PROVIDER_ID} not registered for ${capabilityId}`);
	return provider as Provider<unknown>;
}

async function loadFromPlugin<T>(capabilityId: string, ctx: LoadContext): Promise<T[]> {
	const result = await pluginProvider(capabilityId).load(ctx);
	return result.items as T[];
}

function ctx(): LoadContext {
	return { cwd: project, home, repoRoot: project };
}

beforeEach(async () => {
	clearCache();
	clearOmpExtensionCliRoots();
	tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-plugins-mcp-lazy-"));
	home = path.join(tempDir, "home");
	project = path.join(tempDir, "project");
	ext = path.join(tempDir, "my-extension");
	fs.mkdirSync(home, { recursive: true });
	fs.mkdirSync(path.join(project, ".git"), { recursive: true });
	await Promise.all([
		writeFile(
			path.join(ext, "package.json"),
			JSON.stringify({ name: path.basename(ext), omp: { extensions: ["./src/main.ts"] } }),
		),
		writeFile(path.join(ext, "src", "main.ts"), "export default function (_pi) {}\n"),
	]);
	setAgentDir(path.join(home, ".omp", "agent"));
});

afterEach(() => {
	clearCache();
	clearOmpExtensionCliRoots();
	if (originalAgentDirEnv) {
		setAgentDir(originalAgentDirEnv);
	} else {
		setAgentDir(fallbackAgentDir);
		delete process.env.PI_CODING_AGENT_DIR;
	}
	removeSyncWithRetries(tempDir);
});

test("regression: .mcp.json forwards lazy through plugin discovery", async () => {
	await writeFile(
		path.join(ext, ".mcp.json"),
		JSON.stringify({
			mcpServers: {
				deferred: { command: "lazy-server", lazy: true },
				immediate: { command: "eager-server" },
				stringForm: { command: "string-lazy-server", lazy: "true", enabled: "false" },
			},
		}),
	);
	await writeFile(path.join(project, ".omp", "settings.json"), JSON.stringify({ extensions: [ext] }));

	const servers = await loadFromPlugin<{ name: string; lazy?: boolean; enabled?: boolean }>(mcpCapability.id, ctx());
	expect(servers.find(s => s.name === "deferred")?.lazy).toBe(true);
	expect(servers.find(s => s.name === "immediate")?.lazy).toBeUndefined();
	expect(servers.find(s => s.name === "stringForm")?.lazy).toBe(true);
	expect(servers.find(s => s.name === "stringForm")?.enabled).toBe(false);
});
