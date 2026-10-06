import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { type } from "@oh-my-pi/omptype";
import type { AgentTool, AgentToolContext } from "@oh-my-pi/pi-agent-core";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { ExtensionRunner } from "@oh-my-pi/pi-coding-agent/extensibility/extensions";
import { ExtensionToolWrapper } from "@oh-my-pi/pi-coding-agent/extensibility/extensions";
import { cfgHideThinkingBlock } from "@oh-my-pi/pi-coding-agent/session/settings";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { cfgToolsApproval, cfgToolsApprovalMode } from "@oh-my-pi/pi-coding-agent/tools/settings";
import { WriteTool } from "@oh-my-pi/pi-coding-agent/tools/write";
import { resolveXdevTool, type XdevState } from "@oh-my-pi/pi-coding-agent/tools/xdev";
import type { WriteToolDetails } from "@oh-my-pi/pi-tui/tools/write";
import { getProjectAgentDir, TempDir } from "@oh-my-pi/pi-utils";
import { YAML } from "bun";
import { beginSettingsTest, restoreSettingsTestState, type SettingsTestState } from "./helpers/settings-test-state";

function policy(value: "allow" | "deny", approvalMode: "yolo" | "always-ask" = "yolo") {
	return { tools: { approvalMode, approval: { direct_danger: value, mcp__slack_send_message: value } } };
}

function approvalTools(settings: Settings, cwd: string) {
	let directExecutions = 0;
	let mountedExecutions = 0;
	const runner = {
		sessionSettings: settings,
		consumeToolCallEmitted: () => false,
		hasHandlers: () => false,
		runScoped: <T>(fn: () => T): T => fn(),
	} as unknown as ExtensionRunner;
	const directTool: AgentTool = {
		name: "direct_danger",
		label: "Direct danger",
		description: "",
		parameters: type({}),
		approval: "exec",
		async execute() {
			directExecutions += 1;
			return { content: [{ type: "text", text: "direct" }] };
		},
	};
	const innerTool: AgentTool = {
		name: "mcp__slack_send_message",
		label: "Send message",
		description: "",
		parameters: type({}),
		approval: "exec",
		async execute() {
			mountedExecutions += 1;
			return { content: [{ type: "text", text: "mounted" }] };
		},
	};
	const inner = new ExtensionToolWrapper(innerTool, runner);
	const xdev: XdevState = {
		tools: new Map([[inner.name, inner]]),
		mountedNames: new Set([inner.name]),
		builtInNames: new Set(),
		isActive: () => false,
		resolve: name => resolveXdevTool(xdev, name),
	};
	const toolSession: ToolSession = {
		cwd,
		hasUI: false,
		settings,
		xdev,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
	};
	const direct = new ExtensionToolWrapper(directTool, runner);
	const write = new WriteTool(toolSession);
	const mounted = new ExtensionToolWrapper<typeof write.parameters, WriteToolDetails>(write, runner);
	const context = { settings } as AgentToolContext;
	return {
		runner,
		direct,
		execute: (kind: "direct" | "mounted", id: string) =>
			kind === "direct"
				? direct.execute(id, {}, undefined, undefined, context)
				: mounted.execute(
						id,
						{ path: "xd://mcp__slack_send_message", content: "{}" },
						undefined,
						undefined,
						context,
					),
		executions: () => [directExecutions, mountedExecutions],
	};
}

describe("approval disk preflight", () => {
	let state: SettingsTestState;
	let tempDir: TempDir;
	let agentDir: string;
	let configPath: string;
	let settings: Settings | undefined;

	beforeEach(() => {
		state = beginSettingsTest();
		tempDir = TempDir.createSync("@pi-approval-refresh-");
		agentDir = tempDir.join("agent");
		configPath = path.join(agentDir, "config.yml");
	});

	afterEach(() => {
		settings?.cancelPendingSaves();
		vi.useRealTimers();
		restoreSettingsTestState(state);
		tempDir.removeSync();
	});

	it.each(["direct", "mounted"] as const)(
		"blocks the next %s executor before the watcher fires, retaining overrides, pending writes, and malformed-file denies",
		async kind => {
			await Bun.write(configPath, YAML.stringify(policy("allow")));
			const fixedTime = 1_700_000_000;
			await fs.utimes(configPath, fixedTime, fixedTime);
			settings = await Settings.init({ cwd: tempDir.path(), agentDir });
			const tools = approvalTools(settings, tempDir.path());
			await tools.execute(kind, "allowed");
			const executions = tools.executions();

			// Keep the watcher armed but prevent its 200 ms timer from running.
			vi.useFakeTimers();
			settings.startWatching();
			cfgToolsApprovalMode.override(settings, "yolo");
			cfgHideThinkingBlock.set(settings, true);
			await Bun.write(configPath, YAML.stringify(policy("deny", "always-ask")));
			await fs.utimes(configPath, fixedTime, fixedTime);
			expect(cfgToolsApproval.get(settings)).toMatchObject({
				[kind === "direct" ? "direct_danger" : "mcp__slack_send_message"]: "allow",
			});

			await expect(tools.execute(kind, "denied")).rejects.toThrow(/blocked by user policy/i);
			expect(tools.executions()).toEqual(executions);
			expect(cfgToolsApprovalMode.get(settings)).toBe("yolo");
			expect(cfgHideThinkingBlock.get(settings)).toBe(true);
			expect(YAML.parse(await Bun.file(configPath).text())).toMatchObject({ hideThinkingBlock: true });

			await Bun.write(configPath, "tools: [unclosed\n");
			await expect(tools.execute(kind, "malformed")).rejects.toThrow(/blocked by user policy/i);
			expect(tools.executions()).toEqual(executions);
		},
	);

	it.each(["project", "overlay", "symlink", "higher-priority"] as const)(
		"notices a deny in a changed %s source without waiting for a watcher",
		async source => {
			let changedPath = configPath;
			const configFiles: string[] = [];
			if (source === "project") changedPath = path.join(getProjectAgentDir(tempDir.path()), "config.yml");
			if (source === "overlay") {
				changedPath = tempDir.join("overlay.yml");
				configFiles.push(changedPath);
			}
			if (source === "symlink") {
				changedPath = tempDir.join("target.yml");
				await Bun.write(changedPath, YAML.stringify(policy("allow")));
				await fs.mkdir(agentDir, { recursive: true });
				await fs.symlink(changedPath, configPath);
			} else if (source === "higher-priority") {
				await Bun.write(path.join(agentDir, "config.yaml"), YAML.stringify(policy("allow")));
			} else {
				await Bun.write(configPath, YAML.stringify(policy("allow")));
				if (changedPath !== configPath) await Bun.write(changedPath, "{}\n");
			}
			settings = await Settings.loadIsolated({ cwd: tempDir.path(), agentDir, configFiles });
			const tools = approvalTools(settings, tempDir.path());
			await tools.execute("direct", "allowed");
			await Bun.write(changedPath, YAML.stringify(policy("deny")));
			const results = await Promise.allSettled([
				tools.execute("direct", "denied-one"),
				tools.execute("direct", "denied-two"),
			]);
			for (const result of results) {
				expect(result.status).toBe("rejected");
				if (result.status === "rejected") expect(String(result.reason)).toMatch(/blocked by user policy/i);
			}
			expect(tools.executions()).toEqual([1, 0]);
		},
	);

	it("rechecks a deny written while extension preflight is awaiting before the executor starts", async () => {
		await Bun.write(configPath, YAML.stringify(policy("allow")));
		settings = await Settings.loadIsolated({ cwd: tempDir.path(), agentDir });
		const tools = approvalTools(settings, tempDir.path());
		tools.runner.runToolCallPreflightBefore = async () => {
			await Bun.write(configPath, YAML.stringify(policy("deny")));
			return undefined;
		};
		await expect(tools.execute("direct", "changed-during-preflight")).rejects.toThrow(/blocked by user policy/i);
		expect(tools.executions()).toEqual([0, 0]);
	});
});
