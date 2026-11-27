import { afterAll, afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { clearCache as clearFsCache } from "@oh-my-pi/pi-coding-agent/capability/fs";
import { type SlashCommand, slashCommandCapability } from "@oh-my-pi/pi-coding-agent/capability/slash-command";
import { resetSettingsForTest } from "@oh-my-pi/pi-coding-agent/config/settings";
import { loadCapability } from "@oh-my-pi/pi-coding-agent/discovery";
import { loadSlashCommands } from "@oh-my-pi/pi-coding-agent/extensibility/slash-commands";
import {
	commandInspectorData,
	commandPreview,
} from "@oh-my-pi/pi-coding-agent/extensibility/inventory/inspector-model";
import { applyFilter } from "@oh-my-pi/pi-coding-agent/extensibility/inventory/state-manager";
import type { Extension } from "@oh-my-pi/pi-coding-agent/extensibility/inventory/types";
import { removeWithRetries } from "@oh-my-pi/pi-utils";
import { currentTheme, setCurrentTheme } from "@oh-my-pi/pi-tui/theme/runtime";

const restoreTheme = currentTheme();
afterAll(() => setCurrentTheme(restoreTheme));

const COMMAND_FILE = `---
description: Deploy a service
argument-hint: <service>
---

Deploy $ARGUMENTS
`;

function dashboardCommand(command: SlashCommand): Extension {
	const preserved = typeof command.description === "string" ? command.description.trim() : "";
	return {
		id: `slash-command:${command.name}`,
		kind: "slash-command",
		name: command.name,
		displayName: command.name,
		description: preserved || commandPreview(command.content).description,
		trigger: `/${command.name}`,
		path: command.path,
		source: {
			provider: command._source.provider,
			providerName: command._source.providerName,
			level: command.level,
		},
		state: "active",
		raw: command,
	};
}

describe("OpenCode and Claude slash-command frontmatter", () => {
	let root = "";
	let home = "";
	let project = "";
	let originalHome: string | undefined;

	beforeEach(async () => {
		clearFsCache();
		resetSettingsForTest();
		originalHome = process.env.HOME;
		root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-provider-commands-"));
		home = path.join(root, "home");
		project = path.join(root, "project");
		process.env.HOME = home;
		vi.spyOn(os, "homedir").mockReturnValue(home);
		await fs.mkdir(path.join(project, ".git"), { recursive: true });
	});

	afterEach(async () => {
		clearFsCache();
		resetSettingsForTest();
		vi.restoreAllMocks();
		if (originalHome === undefined) delete process.env.HOME;
		else process.env.HOME = originalHome;
		await removeWithRetries(root);
	});

	async function loadProviderCommands(provider: "opencode" | "claude"): Promise<SlashCommand[]> {
		const result = await loadCapability<SlashCommand>(slashCommandCapability.id, {
			cwd: project,
			providers: [provider],
		});
		return result.items;
	}

	test("OpenCode keeps parsed description and argument hint after stripping frontmatter from content", async () => {
		const file = path.join(project, ".opencode", "commands", "deploy.md");
		await fs.mkdir(path.dirname(file), { recursive: true });
		await fs.writeFile(file, COMMAND_FILE);

		const command = (await loadProviderCommands("opencode")).find(item => item.name === "deploy");
		expect(command).toBeDefined();
		expect(command?.content.trim()).toBe("Deploy $ARGUMENTS");
		expect(command?.description).toBe("Deploy a service");
		expect(command?.argumentHint).toBe("<service>");

		const ext = dashboardCommand(command!);
		const data = commandInspectorData(ext);
		expect(data.description).toBe("Deploy a service");
		expect(data.argumentHint).toBe("<service>");
		expect(data.usesArguments).toBe(true);

		expect(applyFilter([ext], "Deploy a service").map(item => item.name)).toEqual(["deploy"]);
	});

	test("Claude raw-frontmatter commands still resolve through commandPreview", async () => {
		const file = path.join(project, ".claude", "commands", "deploy.md");
		await fs.mkdir(path.dirname(file), { recursive: true });
		await fs.writeFile(file, COMMAND_FILE);

		const command = (await loadProviderCommands("claude")).find(item => item.name === "deploy");
		expect(command).toBeDefined();
		expect(command?.content).toContain("description: Deploy a service");
		expect(command?.content).toContain("Deploy $ARGUMENTS");

		const ext = dashboardCommand(command!);
		const data = commandInspectorData(ext);
		expect(data.description).toBe("Deploy a service");
		expect(data.argumentHint).toBe("<service>");
		expect(data.body).toContain("Deploy $ARGUMENTS");
		expect(data.body).not.toContain("description:");
		expect(data.usesArguments).toBe(true);

		expect(applyFilter([ext], "Deploy a service").map(item => item.name)).toEqual(["deploy"]);
	});

	test("OpenCode side: true commands load as side commands; quoted true does not", async () => {
		const sideFile = ["---", "description: Situation report", "side: true", "---", "Report status", ""].join("\n");
		const quotedFile = ["---", "description: Quoted flag", 'side: "true"', "---", "Body", ""].join("\n");
		const commandsDir = path.join(project, ".opencode", "commands");
		await fs.mkdir(commandsDir, { recursive: true });
		await fs.writeFile(path.join(commandsDir, "sitrep.md"), sideFile);
		await fs.writeFile(path.join(commandsDir, "quoted.md"), quotedFile);

		const commands = await loadSlashCommands({ cwd: project });
		const sitrep = commands.find(command => command.name === "sitrep");
		const quoted = commands.find(command => command.name === "quoted");
		expect(sitrep?.side).toBe(true);
		expect(sitrep?.content.trim()).toBe("Report status");
		expect(quoted).toBeDefined();
		expect(quoted?.side).toBeUndefined();
	});

	test("frontmatter-only command preview keeps an empty body", () => {
		const preview = commandPreview(`---
description: Deploy a service
argument-hint: $ARGUMENTS
---
`);
		expect(preview.description).toBe("Deploy a service");
		expect(preview.argumentHint).toBe("$ARGUMENTS");
		expect(preview.body).toBe("");
		expect(preview.body).not.toContain("description:");
		expect(preview.usesArguments).toBe(false);
	});
});
