import { describe, expect, test } from "bun:test";
import { buildAvailableSlashCommands } from "@oh-my-pi/pi-coding-agent/slash-commands/available-commands";

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
			description: "Spend a saved Codex rate-limit reset",
			usage: "[account|active]",
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
});
