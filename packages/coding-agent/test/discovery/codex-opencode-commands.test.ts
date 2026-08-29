import { afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { clearCache as clearFsCache } from "@oh-my-pi/pi-coding-agent/capability/fs";
import { type SlashCommand, slashCommandCapability } from "@oh-my-pi/pi-coding-agent/capability/slash-command";
import { resetSettingsForTest } from "@oh-my-pi/pi-coding-agent/config/settings";
import { loadCapability } from "@oh-my-pi/pi-coding-agent/discovery";
import {
	commandInspectorData,
	commandPreview,
} from "@oh-my-pi/pi-coding-agent/modes/components/extensions/inspector-model";
import { InspectorPanel } from "@oh-my-pi/pi-coding-agent/modes/components/extensions/inspector-panel";
import { applyFilter } from "@oh-my-pi/pi-coding-agent/modes/components/extensions/state-manager";
import type { Extension } from "@oh-my-pi/pi-coding-agent/modes/components/extensions/types";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import { removeWithRetries } from "@oh-my-pi/pi-utils";

const COMMAND_FILE = `---
description: Deploy a service
argument-hint: <service>
---

Deploy $ARGUMENTS
`;

beforeAll(async () => {
	await initTheme(false);
});

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

describe("Codex and OpenCode slash-command frontmatter", () => {
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

	async function loadProviderCommands(provider: "codex" | "opencode" | "claude"): Promise<SlashCommand[]> {
		const result = await loadCapability<SlashCommand>(slashCommandCapability.id, {
			cwd: project,
			providers: [provider],
		});
		return result.items;
	}

	test("Codex keeps parsed description and argument hint after stripping frontmatter from content", async () => {
		const file = path.join(project, ".codex", "commands", "deploy.md");
		await fs.mkdir(path.dirname(file), { recursive: true });
		await fs.writeFile(file, COMMAND_FILE);

		const command = (await loadProviderCommands("codex")).find(item => item.name === "deploy");
		expect(command).toBeDefined();
		expect(command?.content.trim()).toBe("Deploy $ARGUMENTS");
		expect(command?.content).not.toContain("description:");
		expect(command?.description).toBe("Deploy a service");
		expect(command?.argumentHint).toBe("<service>");

		const ext = dashboardCommand(command!);
		const data = commandInspectorData(ext);
		expect(data.description).toBe("Deploy a service");
		expect(data.argumentHint).toBe("<service>");
		expect(data.body).toContain("Deploy $ARGUMENTS");
		expect(data.body).not.toContain("description:");
		expect(data.usesArguments).toBe(true);

		const panel = new InspectorPanel();
		panel.setExtension(ext);
		const rendered = Bun.stripANSI(panel.render(72).join("\n"));
		expect(rendered).toContain("Deploy a service");
		expect(rendered).toContain("<service>");
		expect(rendered).toContain("accepts $ARGUMENTS");
		expect(rendered).not.toContain("description:");

		expect(applyFilter([ext], "Deploy a service").map(item => item.name)).toEqual(["deploy"]);
	});

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

		const panel = new InspectorPanel();
		panel.setExtension(ext);
		const rendered = Bun.stripANSI(panel.render(72).join("\n"));
		expect(rendered).toContain("Deploy a service");
		expect(rendered).toContain("<service>");

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
