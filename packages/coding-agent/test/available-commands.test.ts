import { describe, expect, test } from "bun:test";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { cfgCommandsHidden } from "@oh-my-pi/pi-coding-agent/extensibility/settings";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import { executeAcpBuiltinSlashCommand } from "@oh-my-pi/pi-coding-agent/slash-commands/acp-builtins";
import { buildAvailableSlashCommands } from "@oh-my-pi/pi-coding-agent/slash-commands/available-commands";
import {
	buildTuiBuiltinSlashCommands,
	executeBuiltinSlashCommand,
} from "@oh-my-pi/pi-coding-agent/slash-commands/builtin-registry";
import type { SlashCommandRuntime } from "@oh-my-pi/pi-coding-agent/slash-commands/types";

describe("buildAvailableSlashCommands", () => {
	test("returns RPC-safe command metadata with stable sources", async () => {
		const fileCommands = [{ name: "notes", description: "Open notes", content: "body", source: "test" }];
		const mcpPrompt = {
			path: "mcp:server/prompt",
			resolvedPath: "mcp:server/prompt",
			source: "project",
			command: { name: "server:prompt", description: "MCP prompt" },
		};
		const session = {
			settings: Settings.isolated(),
			extensionRunner: {
				getRegisteredCommands: () => [{ name: "ext:hello", description: "Extension hello" }],
			},
			customCommands: [
				mcpPrompt,
				{
					path: "custom.ts",
					resolvedPath: "custom.ts",
					source: "project",
					command: { name: "custom:hello", description: "Custom hello" },
				},
			],
			mcpPromptCommands: [mcpPrompt],
			skills: [{ name: "reviewer", description: "Review code", filePath: "/tmp/reviewer/SKILL.md" }],
			skillsSettings: { enableSkillCommands: true },
			sessionManager: { getCwd: () => process.cwd() },
			setSlashCommands(commands: typeof fileCommands) {
				expect(commands).toEqual(fileCommands);
			},
		};

		const commands = await buildAvailableSlashCommands(session as never, async () => fileCommands);
		const byName = Object.fromEntries(commands.map(command => [command.name, command]));

		expect(byName.usage.subcommands).toContainEqual({
			name: "show",
			description: "Show provider usage and limits",
		});
		expect(byName.usage.subcommands).toContainEqual({
			name: "reset",
			description: "Spend a saved provider rate-limit reset",
			usage: "[provider/credential-id|provider/active]",
		});
		expect(byName["reset-usage"]).toBeUndefined();

		expect(byName.fast.description).toBe("Toggle fast mode");
		expect(byName["extended-context"].description).toBe("Toggle extended context");
		expect(byName["ext:hello"].description).toBe("Extension hello");
		expect(byName["custom:hello"].description).toBe("Custom hello");
		expect(byName["server:prompt"].description).toBe("MCP prompt");
		expect(byName.notes.description).toBe("Open notes");
		expect(byName["skill:reviewer"].description).toBe("Review code");

		expect(byName.model.source).toBe("builtin");
		expect(byName["skill:reviewer"].source).toBe("skill");
		expect(byName["ext:hello"].source).toBe("extension");
		expect(byName["server:prompt"].source).toBe("mcp_prompt");
		expect(byName["custom:hello"].source).toBe("custom");
		expect(byName.notes.source).toBe("file");
	});

	test("loads file commands into the session before advertising them", async () => {
		const fileCommands = [{ name: "notes", description: "Open notes", content: "body", source: "test" }];
		let loadedCommands: typeof fileCommands | undefined;

		const commands = await buildAvailableSlashCommands(
			{
				settings: Settings.isolated(),
				customCommands: [],
				skills: [],
				sessionManager: { getCwd: () => process.cwd() },
				setSlashCommands(commands: typeof fileCommands) {
					loadedCommands = commands;
				},
			} as never,
			async () => fileCommands,
		);

		expect(loadedCommands).toEqual(fileCommands);
		expect(commands.find(command => command.name === "notes")?.source).toBe("file");
	});

	test("forwards file-command argumentHint as ACP input hint", async () => {
		const fileCommands = [
			{
				name: "git-sync",
				description: "Rebase branch",
				content: "body",
				source: "test",
				argumentHint: "[base-branch]",
			},
			{ name: "notes", description: "Open notes", content: "body", source: "test" },
		];

		const commands = await buildAvailableSlashCommands(
			{
				settings: Settings.isolated(),
				customCommands: [],
				skills: [],
				sessionManager: { getCwd: () => process.cwd() },
				setSlashCommands() {},
			} as never,
			async () => fileCommands,
		);
		const byName = Object.fromEntries(commands.map(command => [command.name, command]));

		expect(byName["git-sync"].input).toEqual({ hint: "[base-branch]" });
		expect(byName.notes.input).toBeUndefined();
	});

	test("classifies MCP prompts by path and bundled custom commands as custom", async () => {
		const commands = await buildAvailableSlashCommands(
			{
				settings: Settings.isolated(),
				customCommands: [
					{
						path: "mcp:server/prompt",
						resolvedPath: "mcp:server/prompt",
						source: "project",
						command: { name: "server:prompt", description: "MCP prompt" },
					},
					{
						path: "green.md",
						resolvedPath: "green.md",
						source: "bundled",
						command: { name: "green", description: "Bundled custom command" },
					},
				],
				skills: [],
				sessionManager: { getCwd: () => process.cwd() },
				setSlashCommands() {},
			} as never,
			async () => [],
		);

		const byName = Object.fromEntries(commands.map(command => [command.name, command]));
		expect(byName["server:prompt"].source).toBe("mcp_prompt");
		expect(byName.green.source).toBe("custom");
	});

	test("keeps legacy custom command fixtures without a path classified as custom", async () => {
		const commands = await buildAvailableSlashCommands(
			{
				settings: Settings.isolated(),
				customCommands: [{ command: { name: "legacy", description: "Legacy fixture" } }],
				skills: [],
				sessionManager: { getCwd: () => process.cwd() },
				setSlashCommands() {},
			} as never,
			async () => [],
		);

		expect(commands.find(command => command.name === "legacy")?.source).toBe("custom");
	});

	test("does not advertise custom or file commands shadowed by a builtin alias", async () => {
		// ACP resolves builtin aliases before `session.prompt()` runs custom/file
		// commands, so advertising `/plugin` or `/models` here would show the user a
		// command that silently executes the builtin instead of their handler.
		const fileCommands = [{ name: "models", description: "My models note", content: "body", source: "test" }];
		const commands = await buildAvailableSlashCommands(
			{
				settings: Settings.isolated(),
				customCommands: [{ command: { name: "plugin", description: "My plugin helper" } }],
				skills: [],
				sessionManager: { getCwd: () => "/tmp" },
				setSlashCommands: () => {},
			} as never,
			async () => fileCommands,
		);

		const byName = Object.fromEntries(commands.map(command => [command.name, command]));
		expect(byName.plugin).toBeUndefined();
		expect(byName.models).toBeUndefined();
		expect(byName.plugins.source).toBe("builtin");
		expect(byName.plugins.aliases).toEqual(["plugin"]);
	});

	test("hides commands.hidden builtins while keeping their names reserved", async () => {
		const commands = await buildAvailableSlashCommands(
			{
				settings: Settings.isolated({ "commands.hidden": ["security", "plugins", "models", "ext:hello"] }),
				extensionRunner: { getRegisteredCommands: () => [{ name: "ext:hello" }] },
				customCommands: [{ command: { name: "security" } }, { command: { name: "plugin" } }],
				skills: [],
				sessionManager: { getCwd: () => process.cwd() },
				setSlashCommands() {},
			} as never,
			async () => [{ name: "models", description: "Shadowed alias", content: "body", source: "test" }],
		);
		const byName = Object.fromEntries(commands.map(command => [command.name, command]));

		// Typed `/security`, `/plugin`, `/models` still resolve to the builtin, so no shadow may appear.
		expect(byName.security).toBeUndefined();
		expect(byName.plugins).toBeUndefined();
		expect(byName.plugin).toBeUndefined();
		expect(byName.models).toBeUndefined();
		expect(byName.model.aliases).toEqual([]);
		// Only builtins are hideable.
		expect(byName["ext:hello"].source).toBe("extension");
	});
});

describe("buildTuiBuiltinSlashCommands", () => {
	test("re-reads commands.hidden on every build", () => {
		const settings = Settings.isolated();
		const ctx = { settings } as InteractiveModeContext;
		const names = () => buildTuiBuiltinSlashCommands({ ctx }).flatMap(cmd => [cmd.name, ...(cmd.aliases ?? [])]);

		expect(names()).toEqual(expect.arrayContaining(["security", "goal", "models"]));
		cfgCommandsHidden.set(settings, ["security", "goal", "models", "not-a-command"]);
		const hidden = names();
		expect(hidden).not.toContain("security");
		expect(hidden).not.toContain("goal");
		expect(hidden).not.toContain("models");
		expect(hidden).toContain("model");
		cfgCommandsHidden.set(settings, []);
		expect(names()).toContain("security");
	});

	test("typed hidden commands still dispatch in TUI and ACP", async () => {
		const settings = Settings.isolated({ "commands.hidden": ["security"], "security.enabled": false });
		const output: string[] = [];
		const ctx = {
			settings,
			sessionManager: { getCwd: () => process.cwd() },
			showStatus: (text: string) => output.push(text),
			editor: { setText() {} },
		} as unknown as InteractiveModeContext;

		expect(await executeBuiltinSlashCommand("/security", { ctx })).toBe(true);
		expect(
			await executeAcpBuiltinSlashCommand("/security", {
				settings,
				output: (text: string) => output.push(text),
			} as unknown as SlashCommandRuntime),
		).toEqual({ consumed: true });
		expect(output).toHaveLength(2);
		expect(output.every(text => text.includes("Security is disabled"))).toBe(true);
	});
});
