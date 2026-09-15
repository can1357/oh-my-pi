import { afterEach, describe, expect, test } from "bun:test";

import type { TuiSlashCommandRuntime } from "@oh-my-pi/pi-coding-agent/slash-commands/types";
import {
	buildTuiBuiltinSlashCommands,
	type TuiBuiltinSlashCommand,
} from "@oh-my-pi/pi-coding-agent/slash-commands/builtin-registry";
import {
	buildAvailableSlashCommands,
	type AvailableCommandsSession,
	type InternalAvailableSlashCommand,
} from "@oh-my-pi/pi-coding-agent/slash-commands/available-commands";
import {
	clearAll as clearUiStrings,
	registerUiStrings,
} from "@oh-my-pi/pi-coding-agent/extensibility/extensions/ui-strings";

/** Minimal TUI runtime: materialization only reads `runtime` for truthiness + completions. */
const runtime = { ctx: {} } as unknown as TuiSlashCommandRuntime;

function register(strings: Record<string, string>): void {
	registerUiStrings({ strings }, "test://command-ui-strings");
}

function availableSession(): AvailableCommandsSession {
	return {
		skills: [],
		skillsSettings: { enableSkillCommands: true },
		customCommands: [],
		setSlashCommands: () => {},
		sessionManager: { getCwd: () => "/tmp" },
	};
}

function materializedByName(): Record<string, TuiBuiltinSlashCommand> {
	const commands = buildTuiBuiltinSlashCommands(runtime);
	return Object.fromEntries(commands.map(cmd => [cmd.name, cmd])) as Record<string, TuiBuiltinSlashCommand>;
}

function availableByName(commands: InternalAvailableSlashCommand[]): Record<string, InternalAvailableSlashCommand> {
	return Object.fromEntries(commands.map(cmd => [cmd.name, cmd])) as Record<string, InternalAvailableSlashCommand>;
}

afterEach(() => {
	clearUiStrings();
});

describe("slash-command ui-strings (command.* key convention)", () => {
	test("no plugin registered: materialized copy stays at the built-in English fallback", () => {
		const byName = materializedByName();
		expect(byName.goal?.description).toBe("Toggle goal mode (persistent autonomous objective for this session)");
		expect(byName.usage?.description).toBe("Show provider usage and limits");
		expect(byName.git?.getInlineHint?.("")).toBe("[revision]");
		// Subcommand descriptions stay at the built-in text.
		expect(byName.goal?.subcommands?.find(sub => sub.name === "set")?.description).toBe("Set or replace the goal");
	});

	test("registered command copy: materialized commands resolve the overridden description and hint", () => {
		register({
			"command.goal.description": "Show current goal state",
			"command.usage.description": "Show provider usage",
			"command.queue.hint": "Type a message...",
		});
		const byName = materializedByName();
		expect(byName.goal?.description).toBe("Show current goal state");
		expect(byName.usage?.description).toBe("Show provider usage");
		// Inline hints resolve via command.<name>.hint; unregistered commands keep the built-in.
		expect(byName.queue?.getInlineHint?.("")).toBe("Type a message...");
		expect(byName.git?.getInlineHint?.("")).toBe("[revision]");
	});

	test("registered subcommand copy: materialized subcommands resolve the overridden descriptions", async () => {
		register({
			"command.goal.description": "Show current goal state",
			"command.goal.subcommand.set.description": "Replace the current goal",
		});
		const byName = materializedByName();
		expect(byName.goal?.subcommands?.find(sub => sub.name === "set")?.description).toBe("Replace the current goal");
		// Argument completions consume the same resolved subcommand descriptions.
		const items = await Promise.resolve(byName.goal?.getArgumentCompletions?.("set"));
		expect(items?.find(item => item.label === "set")?.description).toBe("Replace the current goal");
	});

	test("no plugin registered: available commands keep the built-in English fallback", async () => {
		const commands = await buildAvailableSlashCommands(availableSession());
		const byName = availableByName(commands);
		// The ACP path only includes handled commands; descriptions resolve via acpDescription ?? description.
		expect(byName.usage?.description).toBe("Show token usage");
		expect(byName.advisor?.description).toBe("Toggle advisor");
		expect(byName.usage?.input?.hint).toBe("[show|reset [account|active]]");
		expect(byName.usage?.subcommands?.find(sub => sub.name === "show")).toEqual({
			name: "show",
			description: "Show provider usage and limits",
		});
		expect(byName.usage?.subcommands?.find(sub => sub.name === "reset")).toEqual({
			name: "reset",
			description: "Spend a saved Codex rate-limit reset",
			usage: "[account|active]",
		});
	});

	test("registered command copy: available commands resolve the overridden description, hint, and subcommands", async () => {
		register({
			"command.usage.description": "Show provider usage",
			"command.advisor.description": "Show advisor status",
			"command.usage.hint": "[show|reset]",
			"command.usage.subcommand.show.description": "Show provider usage",
			"command.advisor.subcommand.dump.description": "Dump the advisor transcript",
		});
		const commands = await buildAvailableSlashCommands(availableSession());
		const byName = availableByName(commands);
		expect(byName.usage?.description).toBe("Show provider usage");
		expect(byName.advisor?.description).toBe("Show advisor status");
		// The ACP input hint resolves via command.<name>.hint (acpInputHint ?? inlineHint).
		expect(byName.usage?.input?.hint).toBe("[show|reset]");
		expect(byName.usage?.subcommands?.find(sub => sub.name === "show")?.description).toBe("Show provider usage");
		expect(byName.advisor?.subcommands?.find(sub => sub.name === "dump")?.description).toBe("Dump the advisor transcript");
		// Unregistered commands keep the built-in fallback.
		expect(byName.security?.description).toBe("Plan, run, inspect, import, and compare OMP-native security scans");
	});
});
