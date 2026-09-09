import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { SourceMeta } from "@oh-my-pi/pi-coding-agent/capability/types";
import type { MCPServerConfig } from "@oh-my-pi/pi-coding-agent/mcp/types";
import { collectMcpServerNames } from "@oh-my-pi/pi-coding-agent/modes/controllers/mcp-command-controller";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import { buildTuiBuiltinSlashCommands } from "@oh-my-pi/pi-coding-agent/slash-commands/builtin-registry";
import type { TuiSlashCommandRuntime } from "@oh-my-pi/pi-coding-agent/slash-commands/types";
import {
	getConfigRootDir,
	getMCPConfigPath,
	getProjectDir,
	removeWithRetries,
	setAgentDir,
	setProjectDir,
} from "@oh-my-pi/pi-utils";

const originalProjectDir = getProjectDir();
const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
const fallbackAgentDir = path.join(getConfigRootDir(), "agent");

function restoreAgentDir(): void {
	if (originalAgentDir) {
		setAgentDir(originalAgentDir);
		process.env.PI_CODING_AGENT_DIR = originalAgentDir;
		Bun.env.PI_CODING_AGENT_DIR = originalAgentDir;
		return;
	}
	setAgentDir(fallbackAgentDir);
	delete process.env.PI_CODING_AGENT_DIR;
	delete Bun.env.PI_CODING_AGENT_DIR;
}

async function writeConfig(
	scope: "user" | "project",
	cwd: string,
	servers: Record<string, MCPServerConfig>,
): Promise<void> {
	await Bun.write(getMCPConfigPath(scope, cwd), `${JSON.stringify({ mcpServers: servers }, null, 2)}\n`);
}

/** Fake ctx carrying only the mcpManager surface `collectMcpServerNames` reads. */
function createFakeCtx(discoveredNames: string[]) {
	const mcpManager = {
		getAllServerNames: vi.fn((): string[] => discoveredNames),
		getSource: vi.fn((): SourceMeta | undefined => undefined),
		getConnectionStatus: vi.fn(() => "connected" as const),
	};
	const ctx = { mcpManager } as never as InteractiveModeContext;
	return { ctx, mcpManager };
}

describe("MCP server-name autocomplete", () => {
	let projectDir = "";
	let agentDir = "";

	beforeEach(async () => {
		projectDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-mcp-autocomplete-project-"));
		agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-mcp-autocomplete-agent-"));
		setProjectDir(projectDir);
		setAgentDir(agentDir);
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		setProjectDir(originalProjectDir);
		restoreAgentDir();
		await removeWithRetries(projectDir);
		await removeWithRetries(agentDir);
	});

	test("collectMcpServerNames returns the deduplicated union of config and discovered names, including disabled ones", async () => {
		await writeConfig("user", projectDir, {
			"user-enabled": { type: "stdio", command: "user-one" },
			"user-disabled": { type: "stdio", command: "user-two", enabled: false },
		});
		await writeConfig("project", projectDir, {
			"project-server": { type: "stdio", command: "project-one" },
		});
		// "project-server" is discovered too (already in config), "runtime-discovered" is new.
		const { ctx } = createFakeCtx(["project-server", "runtime-discovered"]);

		const names = await collectMcpServerNames(ctx);

		expect(names).toEqual(["project-server", "runtime-discovered", "user-disabled", "user-enabled"]);
	});

	test("collectMcpServerNames includes a discovered server disabled via disabledServers, even once dropped from mcpManager", async () => {
		// A third-party-discovered server that was `/mcp disable`d: recorded in the user
		// config's top-level `disabledServers` list, absent from `mcpServers`, and no
		// longer reported by the manager (loadAllMCPConfigs filters disabled sources out).
		await Bun.write(
			getMCPConfigPath("user", projectDir),
			`${JSON.stringify({ mcpServers: {}, disabledServers: ["discovered-disabled"] }, null, 2)}\n`,
		);
		await writeConfig("project", projectDir, {});
		const { ctx } = createFakeCtx([]);

		const names = await collectMcpServerNames(ctx);

		expect(names).toEqual(["discovered-disabled"]);
	});

	test("collectMcpServerNames accepts preloaded configs and skips re-reading them from disk", async () => {
		await writeConfig("user", projectDir, { "user-server": { type: "stdio", command: "one" } });
		await writeConfig("project", projectDir, { "project-server": { type: "stdio", command: "two" } });
		const { ctx } = createFakeCtx(["runtime-discovered"]);

		const names = await collectMcpServerNames(ctx, {
			userConfig: { mcpServers: { "override-server": { type: "stdio", command: "override" } } },
			projectConfig: { mcpServers: {} },
		});

		// Reflects the preloaded configs, not what's actually on disk for "user"/"project".
		expect(names).toEqual(["override-server", "runtime-discovered"]);
	});

	test("/mcp getArgumentCompletions resolves known server names after a server-name subcommand, filtered by prefix", async () => {
		await writeConfig("user", projectDir, {
			"my-server": { type: "stdio", command: "one" },
			"my-other": { type: "stdio", command: "two" },
			"other-server": { type: "stdio", command: "three" },
		});
		const { ctx } = createFakeCtx([]);
		const runtime: TuiSlashCommandRuntime = { ctx };
		const mcp = buildTuiBuiltinSlashCommands(runtime).find(c => c.name === "mcp");
		if (!mcp?.getArgumentCompletions) throw new Error("expected /mcp command with getArgumentCompletions");

		const unfiltered = await mcp.getArgumentCompletions("enable ");
		expect(unfiltered?.map(item => item.label).sort()).toEqual(["my-other", "my-server", "other-server"]);

		const filtered = await mcp.getArgumentCompletions("enable my-s");
		expect(filtered?.map(item => item.label)).toEqual(["my-server"]);
		expect(filtered?.[0]?.value).toBe("enable my-server ");
	});

	test("/mcp getArgumentCompletions offers a disabled-only discovered name for enable/disable but not test/reconnect/reauth/unauth", async () => {
		// "discovered-disabled" is a third-party server that was /mcp disable'd:
		// present only in userConfig.disabledServers, absent from mcpServers, and
		// no longer reported by the manager (loadAllMCPConfigs drops disabled
		// sources). #resolveServerForAuth/reconnectServer can't resolve it, so
		// test/reconnect/reauth/unauth must not suggest it.
		await Bun.write(
			getMCPConfigPath("user", projectDir),
			`${JSON.stringify({ mcpServers: {}, disabledServers: ["discovered-disabled"] }, null, 2)}\n`,
		);
		await writeConfig("project", projectDir, {});
		const { ctx } = createFakeCtx([]);
		const runtime: TuiSlashCommandRuntime = { ctx };
		const mcp = buildTuiBuiltinSlashCommands(runtime).find(c => c.name === "mcp");
		if (!mcp?.getArgumentCompletions) throw new Error("expected /mcp command with getArgumentCompletions");

		expect((await mcp.getArgumentCompletions("enable "))?.map(item => item.label)).toEqual(["discovered-disabled"]);
		expect((await mcp.getArgumentCompletions("disable "))?.map(item => item.label)).toEqual(["discovered-disabled"]);
		expect(await mcp.getArgumentCompletions("test ")).toBeNull();
		expect(await mcp.getArgumentCompletions("reconnect ")).toBeNull();
		expect(await mcp.getArgumentCompletions("reauth ")).toBeNull();
		expect(await mcp.getArgumentCompletions("unauth ")).toBeNull();
	});

	test("/mcp only offers disabled configured servers to subcommands that can accept them", async () => {
		await writeConfig("user", projectDir, {
			disabled: { type: "stdio", command: "disabled", enabled: false },
		});
		const { ctx } = createFakeCtx([]);
		const runtime: TuiSlashCommandRuntime = { ctx };
		const mcp = buildTuiBuiltinSlashCommands(runtime).find(c => c.name === "mcp");
		if (!mcp?.getArgumentCompletions) throw new Error("expected /mcp command with getArgumentCompletions");

		expect((await mcp.getArgumentCompletions("enable "))?.map(item => item.label)).toEqual(["disabled"]);
		expect((await mcp.getArgumentCompletions("disable "))?.map(item => item.label)).toEqual(["disabled"]);
		expect((await mcp.getArgumentCompletions("unauth "))?.map(item => item.label)).toEqual(["disabled"]);
		expect(await mcp.getArgumentCompletions("test ")).toBeNull();
		expect(await mcp.getArgumentCompletions("reconnect ")).toBeNull();
		expect(await mcp.getArgumentCompletions("reauth ")).toBeNull();
	});

	test("/mcp getArgumentCompletions returns null for subcommands that don't take a server name", async () => {
		await writeConfig("user", projectDir, { "my-server": { type: "stdio", command: "one" } });
		const { ctx } = createFakeCtx([]);
		const runtime: TuiSlashCommandRuntime = { ctx };
		const mcp = buildTuiBuiltinSlashCommands(runtime).find(c => c.name === "mcp");
		if (!mcp?.getArgumentCompletions) throw new Error("expected /mcp command with getArgumentCompletions");

		expect(await mcp.getArgumentCompletions("add ")).toBeNull();
	});

	test("/mcp getArgumentCompletions still completes subcommand names while the subcommand is being typed", async () => {
		const { ctx } = createFakeCtx([]);
		const runtime: TuiSlashCommandRuntime = { ctx };
		const mcp = buildTuiBuiltinSlashCommands(runtime).find(c => c.name === "mcp");
		if (!mcp?.getArgumentCompletions) throw new Error("expected /mcp command with getArgumentCompletions");

		const matches = await mcp.getArgumentCompletions("en");
		expect(matches?.map(item => item.label)).toEqual(["enable"]);
	});

	test("/mcp getArgumentCompletions returns null instead of throwing when a config file is malformed", async () => {
		// Malformed JSON makes readMCPConfigFile's JSON.parse throw (ENOENT is the only
		// error it swallows), which must not escape the autocomplete provider.
		await Bun.write(getMCPConfigPath("user", projectDir), "{ not valid json");
		const { ctx } = createFakeCtx([]);
		const runtime: TuiSlashCommandRuntime = { ctx };
		const mcp = buildTuiBuiltinSlashCommands(runtime).find(c => c.name === "mcp");
		if (!mcp?.getArgumentCompletions) throw new Error("expected /mcp command with getArgumentCompletions");

		await expect(mcp.getArgumentCompletions("enable ")).resolves.toBeNull();
	});

	test("/mcp getArgumentCompletions for remove only offers config-file names, tagging user-only ones with --scope user", async () => {
		await writeConfig("user", projectDir, { "user-only": { type: "stdio", command: "one" } });
		await writeConfig("project", projectDir, { "project-only": { type: "stdio", command: "two" } });
		// A purely runtime-discovered server (no config entry in either scope) has
		// nothing for /mcp remove to delete and must not be offered.
		const { ctx } = createFakeCtx(["discovered-only"]);
		const runtime: TuiSlashCommandRuntime = { ctx };
		const mcp = buildTuiBuiltinSlashCommands(runtime).find(c => c.name === "mcp");
		if (!mcp?.getArgumentCompletions) throw new Error("expected /mcp command with getArgumentCompletions");

		const matches = await mcp.getArgumentCompletions("remove ");
		expect(matches?.map(item => item.label)).toEqual(["project-only", "user-only (user)"]);

		const projectMatch = matches?.find(item => item.label === "project-only");
		expect(projectMatch?.value).toBe("remove project-only ");

		const userMatch = matches?.find(item => item.label === "user-only (user)");
		expect(userMatch?.value).toBe("remove user-only --scope user ");
	});
});
