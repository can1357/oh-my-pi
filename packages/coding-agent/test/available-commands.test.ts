import { describe, expect, test } from "bun:test";
import {
	buildAvailableSlashCommands,
	buildRpcAvailableSlashCommands,
} from "@oh-my-pi/pi-coding-agent/slash-commands/available-commands";

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
});

describe("RPC-only goal command precedence", () => {
	test("does not expose TUI-only goal operations through RPC or ACP", async () => {
		const session = {
			customCommands: [],
			skills: [],
			sessionManager: { getCwd: () => "/tmp" },
			setSlashCommands: () => {},
		};
		const acp = await buildAvailableSlashCommands(session, async () => []);
		const rpc = await buildRpcAvailableSlashCommands(session, async () => []);
		expect(acp.map(command => command.name)).not.toContain("goal");
		expect(acp.map(command => command.name)).not.toContain("guided-goal");
		expect(rpc.map(command => command.name)).toContain("guided-goal");
		expect(rpc.find(command => command.name === "goal")?.subcommands?.map(subcommand => subcommand.name)).toEqual([
			"budget",
		]);
	});

	test("preserves file commands named after RPC goal builtins", async () => {
		const names = ["goal", "guided-goal"];
		const commands = await buildRpcAvailableSlashCommands(
			{
				customCommands: [],
				skills: [],
				sessionManager: { getCwd: () => "/tmp" },
				setSlashCommands: () => {},
			},
			async () => names.map(name => ({ name, description: `User ${name}`, content: "body", source: "test" })),
		);
		for (const name of names) {
			const matches = commands.filter(command => command.name === name);
			expect(matches).toHaveLength(1);
			expect(matches[0]).toMatchObject({ source: "file", description: `User ${name}` });
		}
	});

	test("retains skill names and extension-before-custom-before-file precedence", async () => {
		const commands = await buildRpcAvailableSlashCommands(
			{
				extensionRunner: { getRegisteredCommands: () => [{ name: "goal", description: "Extension goal" }] },
				customCommands: [
					{ command: { name: "goal", description: "Custom goal" } },
					{ command: { name: "guided-goal", description: "Custom guided" } },
				],
				skills: [{ name: "goal", description: "Goal skill", filePath: "/tmp/goal/SKILL.md" }],
				skillsSettings: { enableSkillCommands: true },
				sessionManager: { getCwd: () => "/tmp" },
				setSlashCommands: () => {},
			} as never,
			async () =>
				["goal", "guided-goal"].map(name => ({
					name,
					description: `File ${name}`,
					content: "body",
					source: "test",
				})),
		);
		expect(commands.find(command => command.name === "goal")).toMatchObject({ source: "extension" });
		expect(commands.find(command => command.name === "guided-goal")).toMatchObject({ source: "custom" });
		expect(commands.find(command => command.name === "skill:goal")).toMatchObject({ source: "skill" });
	});
});
