import { beforeAll, describe, expect, test } from "bun:test";
import * as os from "node:os";
import { ExtensionList } from "@oh-my-pi/pi-coding-agent/modes/components/extensions/extension-list";
import {
	liveToolsForExtension,
	parseToolFileHeader,
	projectListHint,
	toolParamsFromSchema,
} from "@oh-my-pi/pi-coding-agent/modes/components/extensions/inspector-model";
import { InspectorPanel } from "@oh-my-pi/pi-coding-agent/modes/components/extensions/inspector-panel";
import type { Extension } from "@oh-my-pi/pi-coding-agent/modes/components/extensions/types";
import { initTheme, theme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import { shortenPath } from "@oh-my-pi/pi-coding-agent/tools/render-utils";

beforeAll(async () => {
	await initTheme(false);
});

function userSource(): Extension["source"] {
	return { provider: "native", providerName: "OMP (User)", level: "user" };
}

function projectSource(name = "personal"): Extension["source"] {
	return { provider: "native", providerName: `OMP (${name})`, level: "project" };
}

function systemdExtension(): Extension {
	return {
		id: "tool:systemd",
		kind: "tool",
		name: "systemd",
		displayName: "systemd",
		description: "systemd custom tool",
		path: "/home/sf/.omp/agent/tools/systemd.ts",
		source: userSource(),
		state: "active",
		raw: {
			name: "systemd",
			description: "systemd custom tool",
			path: "/home/sf/.omp/agent/tools/systemd.ts",
		},
	};
}

function systemdFactory(sourcePath = "/home/sf/.omp/agent/tools/systemd.ts") {
	return [
		{
			name: "systemd_inspect",
			sourcePath,
			label: "systemd inspect",
			description: "Read systemd state. Inspect first.",
			parameters: {
				type: "object",
				required: ["action"],
				properties: { action: { type: "string" } },
			},
			loadMode: "discoverable" as const,
		},
		{
			name: "systemd_control",
			sourcePath,
			label: "systemd control",
			description: "Mutate running or enablement state of write-prefix units.",
			parameters: {
				type: "object",
				required: ["action"],
				properties: { action: { type: "string" } },
			},
		},
		{
			name: "systemd_author",
			sourcePath,
			label: "systemd author",
			description: "Create, update, or retire MCP-managed definitions.",
			parameters: {
				type: "object",
				required: ["action"],
				properties: { action: { type: "string" } },
			},
		},
	];
}

function systemdSource(sourcePath?: string) {
	const tools = systemdFactory(sourcePath);
	return {
		getLiveTool: (name: string) => tools.find(tool => tool.name === name),
		listLiveTools: () => tools,
	};
}

function toolExtension(): Extension {
	return {
		id: "tool:gmail_send",
		kind: "tool",
		name: "gmail_send",
		displayName: "gmail_send",
		description: "gmail_send custom tool",
		path: "/home/sf/worlds/personal/.omp/tools/gmail_send.ts",
		source: projectSource(),
		state: "active",
		raw: {
			name: "gmail_send",
			description: "gmail_send custom tool",
			path: "/home/sf/worlds/personal/.omp/tools/gmail_send.ts",
		},
	};
}

function ruleExtension(): Extension {
	return {
		id: "rule:orchestration",
		kind: "rule",
		name: "orchestration",
		displayName: "orchestration",
		description: undefined,
		trigger: "always",
		path: "/home/sf/worlds/base/rules/orchestration.md",
		source: projectSource("base"),
		state: "active",
		raw: {
			name: "orchestration",
			alwaysApply: true,
			content: "# asynchronous coordination\n\nnever block a reasoning turn merely waiting for another agent.",
		},
	};
}

function commandExtension(): Extension {
	return {
		id: "slash-command:triage",
		kind: "slash-command",
		name: "triage",
		displayName: "triage",
		trigger: "/triage",
		path: "/home/sf/worlds/_template/.omp/commands/triage.md",
		source: userSource(),
		state: "active",
		raw: {
			name: "triage",
			content:
				'---\ndescription: "Triage current world; smallest next actions."\n---\n\nInspect the current state relevant to: $ARGUMENTS\n',
		},
	};
}

function skillExtension(): Extension {
	return {
		id: "skill:hcom",
		kind: "skill",
		name: "hcom",
		displayName: "hcom",
		description: "Named agent sessions that mail, wake, and resume across processes.",
		path: "/home/sf/.omp/agent/skills/hcom/SKILL.md",
		source: userSource(),
		state: "active",
		raw: {
			name: "hcom",
			content: "# hcom\n\na 4-letter name is a session you can come back to.",
			frontmatter: {
				name: "hcom",
				description: "Named agent sessions that mail, wake, and resume across processes.",
				hide: true,
			},
		},
	};
}

function listedSkillExtension(): Extension {
	return {
		id: "skill:fresh-drive",
		kind: "skill",
		name: "fresh-drive",
		displayName: "fresh-drive",
		description: "Drive Fresh terminal IDE via CLI.",
		path: "/home/sf/.omp/agent/skills/fresh-drive/SKILL.md",
		source: userSource(),
		state: "active",
		raw: {
			name: "fresh-drive",
			content: "# fresh-drive\n\nshared surface.",
			frontmatter: {
				name: "fresh-drive",
				description: "Drive Fresh terminal IDE via CLI.",
			},
		},
	};
}

function render(panel: InspectorPanel): string {
	return Bun.stripANSI(panel.render(72).join("\n"));
}

describe("shared inspector chrome", () => {
	test("puts enablement before origin and drops Type:", () => {
		const panel = new InspectorPanel();
		panel.setExtension(ruleExtension());
		const text = render(panel);
		expect(text).toContain("orchestration");
		expect(text).toContain("Active");
		expect(text).toContain("Origin:");
		expect(text.indexOf("Active")).toBeLessThan(text.indexOf("Origin:"));
		expect(text).not.toContain("Type:");
		expect(text).not.toMatch(/Status:\s+/);
	});

	test("dims the origin path like the pre-overhaul inspector", () => {
		const panel = new InspectorPanel();
		panel.setExtension(ruleExtension());
		const raw = panel.render(72).join("\n");
		expect(raw).toContain(theme.fg("dim", shortenPath(ruleExtension().path, os.homedir())));
	});
});

describe("tool inspector", () => {
	test("joins live schema and description instead of the discovery placeholder", () => {
		const panel = new InspectorPanel();
		panel.setToolSource({
			getLiveTool: () => ({
				name: "gmail_send",
				label: "Gmail Send",
				description: "Send an email via gog for an authorized personal Gmail account.",
				parameters: {
					type: "object",
					required: ["to", "subject", "body"],
					properties: {
						to: { type: "string", description: "Recipients, comma-separated" },
						subject: { type: "string" },
						body: { type: "string" },
						dry_run: { type: "boolean", description: "If true, only print intended send" },
					},
				},
				hidden: true,
			}),
		});
		panel.setExtension(toolExtension());
		const text = render(panel);
		expect(text).toContain("gmail_send");
		expect(text).toContain("Gmail Send");
		expect(text).toContain("Send an email via gog");
		expect(text).toContain("Arguments");
		expect(text).toContain("to");
		expect(text).toContain("Required");
		expect(text).toContain("dry_run");
		expect(text).toContain("Optional");
		expect(text).not.toContain("gmail_send custom tool");
		expect(text.indexOf("Active")).toBeLessThan(text.indexOf("Arguments"));
	});

	test("strips OSC/BEL/tabs from live tool labels and schema before theming", () => {
		const panel = new InspectorPanel();
		panel.setToolSource({
			getLiveTool: () => ({
				name: "gmail_send",
				label: "Gmail\x1b]8;;https://evil.test\x07 Send",
				description: "Send\tvia gog",
				parameters: {
					type: "object",
					required: ["to"],
					properties: {
						to: {
							type: "string\x1b]8;;https://evil.test\x07",
							description: "Recipients\x07, comma-separated",
						},
						from: {
							type: "string",
							default: "\x07nobody",
						},
					},
				},
			}),
		});
		panel.setExtension(toolExtension());
		const raw = panel.render(72).join("\n");
		expect(raw).not.toContain("\x1b]8;");
		expect(raw).not.toContain("\x07");
		expect(raw).not.toContain("\t");
		const text = Bun.stripANSI(raw);
		expect(text).toContain("Gmail Send");
		expect(text).toContain("Send   via gog");
		expect(text).toContain("Recipients, comma-separated");
		expect(text).toContain("string");
		expect(text).toContain("Default: nobody");
	});

	test("collapses newlines in schema defaults and types to one physical row", () => {
		const params = toolParamsFromSchema({
			type: "object",
			properties: {
				note: { type: "string\ninjected", default: "alpha\nbeta" },
			},
		});
		expect(params).toHaveLength(1);
		expect(params[0]?.type).toBe("string injected");
		expect(params[0]?.type).not.toContain("\n");
		expect(params[0]?.flag).toBe("Default: alpha beta");
		expect(params[0]?.flag).not.toContain("\n");

		const panel = new InspectorPanel();
		panel.setToolSource({
			getLiveTool: () => ({
				name: "gmail_send",
				description: "Send via gog",
				parameters: {
					type: "object",
					properties: {
						note: { type: "string\ninjected", default: "alpha\nbeta" },
					},
				},
			}),
		});
		panel.setExtension(toolExtension());
		const lines = panel.render(72).map(line => Bun.stripANSI(line));
		const joined = lines.join("\n");
		expect(joined).toContain("Default: alpha beta");
		expect(joined).toContain("string injected");
		expect(lines.some(line => line.trim() === "beta")).toBe(false);
		expect(lines.some(line => line.trim() === "injected")).toBe(false);
		expect(lines.filter(line => line.includes("alpha")).length).toBe(1);
	});

	test("collapses newlines in factory names and labels to one physical row", () => {
		const panel = new InspectorPanel();
		panel.setToolSource({
			getLiveTool: () => undefined,
			listLiveTools: () => [
				{
					name: "systemd_inspect\ninjected",
					sourcePath: "/home/sf/.omp/agent/tools/systemd.ts",
					label: "inspect\nlabel",
					description: "Read systemd state.",
					parameters: { type: "object", properties: {} },
				},
				{
					name: "systemd_control",
					sourcePath: "/home/sf/.omp/agent/tools/systemd.ts",
					description: "Mutate units.",
					parameters: { type: "object", properties: {} },
				},
			],
		});
		panel.setExtension(systemdExtension());
		const lines = panel.render(72).map(line => Bun.stripANSI(line));
		const joined = lines.join("\n");
		expect(joined).toContain("systemd_inspect injected");
		expect(joined).toContain("inspect label");
		expect(lines.some(line => line.trim() === "injected")).toBe(false);
		expect(lines.some(line => line.trim() === "label")).toBe(false);
		expect(lines.filter(line => line.includes("systemd_inspect")).length).toBe(1);
	});

	test("strips control sequences from list hints and origin paths", () => {
		const list = new ExtensionList([
			{
				...ruleExtension(),
				trigger: "*.ts\x1b]8;;https://evil.test\x07",
			},
		]);
		const listRaw = list.render(80).join("\n");
		expect(listRaw).not.toContain("\x1b]8;");
		expect(listRaw).not.toContain("\x07");

		const panel = new InspectorPanel();
		panel.setExtension({
			...ruleExtension(),
			path: "/tmp/evil\x1b]8;;https://evil.test\x07/rule.md",
		});
		const inspectorRaw = panel.render(72).join("\n");
		expect(inspectorRaw).not.toContain("\x1b]8;");
		expect(inspectorRaw).not.toContain("\x07");
		expect(Bun.stripANSI(inspectorRaw)).toContain("/tmp/evil/rule.md");
	});

	test("list hint uses live hidden over a placeholder trigger", () => {
		const list = new ExtensionList([toolExtension()], {
			toolSource: {
				getLiveTool: () => ({
					name: "gmail_send",
					hidden: true,
					parameters: { type: "object", properties: { to: { type: "string" } } },
				}),
			},
		});
		list.setFocused(true);
		const text = Bun.stripANSI(list.render(80).join("\n"));
		expect(text).toContain("gmail_send");
		expect(text).toContain("hidden · personal");
		expect(text).not.toContain("discoverable");
		expect(text).not.toContain("9 args");
	});

	test("project list hints work for Windows .omp paths", () => {
		expect(
			projectListHint({
				...toolExtension(),
				path: "C:\\repo\\.omp\\tools\\x.ts",
			}),
		).toBe("repo");
	});

	test("project list hints work for Windows .omp paths with forward slashes", () => {
		expect(
			projectListHint({
				...toolExtension(),
				path: "C:/repo/.omp/tools/x.ts",
			}),
		).toBe("repo");
	});

	test("project-only tools show the project name instead of an arg count", () => {
		const list = new ExtensionList([toolExtension()], {
			toolSource: {
				getLiveTool: () => ({
					name: "gmail_send",
					parameters: {
						type: "object",
						properties: { to: { type: "string" }, subject: { type: "string" } },
					},
				}),
			},
		});
		list.setFocused(true);
		const text = Bun.stripANSI(list.render(80).join("\n"));
		expect(text).toContain("personal");
		expect(text).not.toContain("args");
	});

	test("joins a multi-export factory by originating source file", () => {
		const panel = new InspectorPanel();
		panel.setToolSource(systemdSource());
		panel.setExtension(systemdExtension());
		const collapsed = render(panel);
		expect(collapsed).toContain("systemd_inspect");
		expect(collapsed).toContain("systemd_control");
		expect(collapsed).toContain("systemd_author");
		expect(collapsed).toContain("Read systemd state");
		expect(collapsed).toMatch(/action\s+string/);
		expect(collapsed).toContain("Required");
		expect(collapsed).not.toContain("1 arg");
		expect(collapsed).not.toMatch(/args \(.* to expand\)/);
		expect(collapsed).not.toContain("systemd custom tool");
		expect(collapsed).not.toContain("(no arguments)");

		panel.toggleExpanded();
		const expanded = render(panel);
		expect(expanded).toContain("action");
		expect(expanded).toContain("Required");
		expect(expanded).not.toMatch(/args \(.* to expand\)/);

		const list = new ExtensionList(
			[
				{
					...systemdExtension(),
					path: "/home/sf/worlds/personal/.omp/tools/systemd.ts",
					source: projectSource(),
				},
			],
			{ toolSource: systemdSource("/home/sf/worlds/personal/.omp/tools/systemd.ts") },
		);
		list.setFocused(true);
		const text = Bun.stripANSI(list.render(80).join("\n"));
		expect(text).toContain("3 tools · personal");
		expect(text).not.toContain("args");
	});

	test("does not join a builtin exact-name collision that lacks a source path", () => {
		const ext: Extension = {
			id: "tool:read",
			kind: "tool",
			name: "read",
			displayName: "read",
			description: "read custom tool",
			path: "/tmp/read.ts",
			source: userSource(),
			state: "active",
			raw: { name: "read", description: "read custom tool", path: "/tmp/read.ts" },
		};
		const lives = liveToolsForExtension(ext, {
			getLiveTool: name =>
				name === "read"
					? {
							name: "read",
							description: "Read a file.",
							source: "builtin",
							parameters: { type: "object", properties: { path: { type: "string" } } },
						}
					: undefined,
			listLiveTools: () => [],
		});
		expect(lives).toEqual([]);

		const panel = new InspectorPanel();
		panel.setToolSource({
			getLiveTool: name =>
				name === "read"
					? {
							name: "read",
							description: "Read a file.",
							source: "builtin",
							parameters: { type: "object", properties: { path: { type: "string" } } },
						}
					: undefined,
			listLiveTools: () => [],
		});
		panel.setExtension(ext);
		const text = render(panel);
		expect(text).not.toContain("Read a file.");
		expect(text).not.toContain("Arguments");
	});

	test("keeps factory siblings when the exact export also exists", () => {
		const filePath = "/x/systemd.ts";
		const tools = [
			{
				name: "systemd",
				description: "systemd factory entry.",
				source: "extension" as const,
				sourcePath: filePath,
				parameters: { type: "object", properties: {} },
			},
			{
				name: "systemd_control",
				description: "Mutate write-prefix units.",
				source: "extension" as const,
				sourcePath: filePath,
				parameters: { type: "object", properties: { action: { type: "string" } } },
			},
		];
		const ext: Extension = {
			...systemdExtension(),
			path: filePath,
			raw: { name: "systemd", description: "systemd custom tool", path: filePath },
		};
		const lives = liveToolsForExtension(ext, {
			getLiveTool: name => tools.find(tool => tool.name === name),
			listLiveTools: () => tools,
		});
		expect(lives.map(tool => tool.name)).toEqual(["systemd", "systemd_control"]);

		const panel = new InspectorPanel();
		panel.setToolSource({
			getLiveTool: name => tools.find(tool => tool.name === name),
			listLiveTools: () => tools,
		});
		panel.setExtension(ext);
		const text = render(panel);
		expect(text).toContain("systemd");
		expect(text).toContain("systemd_control");
		expect(text).toContain("Mutate write-prefix units");
	});

	test("does not treat a separately-filed prefix-named tool as a factory sibling", () => {
		const gitPath = "/tmp/tools/git.ts";
		const commitPath = "/tmp/tools/git_commit.ts";
		const tools = [
			{
				name: "git",
				description: "git tool",
				source: "extension" as const,
				sourcePath: gitPath,
				parameters: { type: "object", properties: {} },
			},
			{
				name: "git_commit",
				description: "commit tool",
				source: "extension" as const,
				sourcePath: commitPath,
				parameters: { type: "object", properties: {} },
			},
		];
		const source = {
			getLiveTool: (name: string) => tools.find(tool => tool.name === name),
			listLiveTools: () => tools,
		};
		const gitExt: Extension = {
			id: "tool:git",
			kind: "tool",
			name: "git",
			displayName: "git",
			description: "git custom tool",
			path: gitPath,
			source: userSource(),
			state: "active",
			raw: { name: "git", description: "git custom tool", path: gitPath },
		};
		const commitExt: Extension = {
			...gitExt,
			id: "tool:git_commit",
			name: "git_commit",
			displayName: "git_commit",
			description: "git_commit custom tool",
			path: commitPath,
			raw: { name: "git_commit", description: "git_commit custom tool", path: commitPath },
		};
		expect(liveToolsForExtension(gitExt, source).map(tool => tool.name)).toEqual(["git"]);
		expect(liveToolsForExtension(commitExt, source).map(tool => tool.name)).toEqual(["git_commit"]);

		const panel = new InspectorPanel();
		panel.setToolSource(source);
		panel.setExtension(gitExt);
		const text = render(panel);
		expect(text).toContain("git");
		expect(text).not.toContain("git_commit");
		expect(text).not.toContain("commit tool");
	});

	test("does not prefix-group extension tools that lack a source file", () => {
		const tools = [
			{
				name: "git",
				description: "git tool",
				source: "extension" as const,
				parameters: { type: "object", properties: {} },
			},
			{
				name: "git_commit",
				description: "commit tool",
				source: "extension" as const,
				parameters: { type: "object", properties: {} },
			},
		];
		const gitExt: Extension = {
			id: "tool:git",
			kind: "tool",
			name: "git",
			displayName: "git",
			path: "/tmp/tools/git.ts",
			source: userSource(),
			state: "active",
			raw: { name: "git", path: "/tmp/tools/git.ts" },
		};
		expect(
			liveToolsForExtension(gitExt, {
				getLiveTool: name => tools.find(tool => tool.name === name),
				listLiveTools: () => tools,
			}).map(tool => tool.name),
		).toEqual(["git"]);
	});

	test("does not adopt builtin tools that only share a name prefix", () => {
		const panel = new InspectorPanel();
		panel.setToolSource({
			getLiveTool: () => undefined,
			listLiveTools: () => [
				{
					name: "web_search",
					description: "Search the web.",
					source: "builtin",
					parameters: { type: "object", properties: { query: { type: "string" } } },
				},
				{
					name: "web_fetch",
					description: "Fetch a URL.",
					source: "extension",
					sourcePath: "/tmp/web.ts",
					parameters: { type: "object", properties: { url: { type: "string" } } },
				},
			],
		});
		panel.setExtension({
			id: "tool:web",
			kind: "tool",
			name: "web",
			displayName: "web",
			description: "web custom tool",
			path: "/tmp/other.ts",
			source: userSource(),
			state: "active",
			raw: { name: "web", description: "web custom tool", path: "/tmp/other.ts" },
		});
		const text = render(panel);
		expect(text).not.toContain("web_search");
		expect(text).not.toContain("Search the web");
		expect(text).not.toContain("web_fetch");
	});

	test("does not join a shadowed custom-tool row against the winner's live schema", () => {
		const panel = new InspectorPanel();
		panel.setToolSource({
			getLiveTool: () => ({
				name: "gmail_send",
				label: "Gmail Send",
				description: "Send an email via gog for an authorized personal Gmail account.",
				source: "extension",
				sourcePath: "/home/sf/worlds/personal/.omp/tools/gmail_send.ts",
				parameters: { type: "object", properties: { to: { type: "string" } } },
			}),
		});
		panel.setExtension({
			...toolExtension(),
			state: "shadowed",
			shadowedBy: "gmail_send",
			path: "/home/sf/.omp/agent/tools/gmail_send.ts",
			raw: {
				name: "gmail_send",
				description: "gmail_send custom tool",
				path: "/home/sf/.omp/agent/tools/gmail_send.ts",
				_shadowed: true,
			},
		});
		const text = render(panel);
		expect(text).toContain("Shadowed");
		expect(text).not.toContain("Gmail Send");
		expect(text).not.toContain("Send an email via gog");
		expect(text).not.toContain("Arguments");
	});
});

describe("rule inspector", () => {
	test("shows apply-when then the rule body", () => {
		const panel = new InspectorPanel();
		panel.setExtension(ruleExtension());
		const text = render(panel);
		expect(text).toContain("Applies");
		expect(text).toContain("always");
		expect(text).toContain("Rule");
		expect(text).toContain("asynchronous coordination");
		expect(text.indexOf("Applies")).toBeLessThan(text.indexOf("asynchronous coordination"));
	});
});

describe("command inspector", () => {
	test("parses frontmatter description and keeps the template body", () => {
		const panel = new InspectorPanel();
		panel.setExtension(commandExtension());
		const text = render(panel);
		expect(text).toContain("Triage current world; smallest next actions.");
		expect(text).toContain("/triage");
		expect(text).toContain("accepts $ARGUMENTS");
		expect(text).toContain("Inspect the current state relevant to: $ARGUMENTS");
		expect(text).not.toContain("description:");
		expect(text.indexOf("Active")).toBeLessThan(text.indexOf("Template"));
	});
});

describe("skill inspector", () => {
	test("puts hidden discovery under Active and on the list row", () => {
		const panel = new InspectorPanel();
		panel.setExtension(skillExtension());
		const text = render(panel);
		expect(text).toContain("Named agent sessions");
		expect(text).toContain("hidden");
		expect(text).toContain("omitted from the system-prompt skill list");
		expect(text).toContain("Instruction");
		expect(text).toContain("4-letter name");
		expect(text).not.toContain("opt-in");
		expect(text).not.toContain("listed");
		expect(text.indexOf("Active")).toBeLessThan(text.indexOf("hidden"));
		expect(text.indexOf("hidden")).toBeLessThan(text.indexOf("Origin:"));

		const list = new ExtensionList([skillExtension()]);
		list.setFocused(true);
		expect(Bun.stripANSI(list.render(80).join("\n"))).toContain("hidden");
	});

	test("listed skills stay unmarked in the list and under Active", () => {
		const panel = new InspectorPanel();
		panel.setExtension(listedSkillExtension());
		const text = render(panel);
		expect(text).toContain("Active");
		expect(text).not.toContain("listed");
		expect(text).not.toContain("hidden");
		expect(text.indexOf("Active")).toBeLessThan(text.indexOf("Origin:"));

		const list = new ExtensionList([listedSkillExtension()]);
		list.setFocused(true);
		const row = Bun.stripANSI(list.render(80).join("\n"));
		expect(row).toContain("fresh-drive");
		expect(row).not.toContain("listed");
	});

	test("project-only skills show the project name in the list hint", () => {
		const list = new ExtensionList([
			{
				...listedSkillExtension(),
				path: "/home/sf/worlds/personal/.omp/skills/gog-google/SKILL.md",
				source: projectSource(),
			},
		]);
		list.setFocused(true);
		expect(Bun.stripANSI(list.render(80).join("\n"))).toContain("personal");
	});

	test("project-only context files do not invent a project name without .omp", () => {
		const list = new ExtensionList([
			{
				id: "context-file:project:AGENTS.md",
				kind: "context-file",
				name: "AGENTS.md",
				displayName: "AGENTS.md",
				description: "Project-level context",
				trigger: "project",
				path: "/home/sf/worlds/personal/AGENTS.md",
				source: projectSource(),
				state: "active",
				raw: { level: "project" },
			},
		]);
		list.setFocused(true);
		const text = Bun.stripANSI(list.render(80).join("\n"));
		expect(text).toContain("AGENTS.md");
		expect(text).not.toContain("project · personal");
		expect(text).not.toMatch(/AGENTS\.md\s+project\b/);
		expect(text).not.toMatch(/AGENTS\.md\s+personal\b/);
	});
});

describe("inspector wrap and fill", () => {
	test("wraps long rule lines instead of ellipsizing them", () => {
		const panel = new InspectorPanel();
		panel.setExtension({
			...ruleExtension(),
			path: "builtin-defaults:ts-redundant-clear-guard",
			raw: {
				name: "ts-redundant-clear-guard",
				alwaysApply: false,
				astCondition: ["if ($X) clearTimeout($X)", "if ($X) { clearTimeout($X) }", "if ($X) clearInterval($X)"],
				scope: "tool:edit(*.{ts,tsx,js,jsx}), tool:write(*.{ts,tsx,js,jsx})",
				interruptMode: "never",
				content:
					"**Do not guard `clearTimeout` / `clearInterval` / `clearImmediate` with truthiness or `null`/`undefined` checks.** Per WHATWG/Node timers spec, calls no-op for `null`.",
			},
		});
		const text = Bun.stripANSI(panel.render(42).join("\n"));
		expect(text.split("\n").some(line => line.includes("…") || line.endsWith("..."))).toBe(false);
		expect(text).toContain("clearTimeout");
		expect(text).toContain("interrupt");
		expect(text).toContain("never");
		expect(text).toContain("tool:edit");
		expect(text).toContain("tool:write");
		expect(text).toContain("builtin-defaults:");
		expect(text).toMatch(/clear-gua/);
		expect(text).toMatch(/Origin:[\s\S]*Applies/);
		const origin = text.slice(text.indexOf("Origin:"), text.indexOf("Applies"));
		expect(origin.split("\n").length).toBeGreaterThan(3);
	});

	test("compacts long apply lists so leftover viewport can show the rule body", () => {
		const panel = new InspectorPanel();
		panel.setHeight(28);
		panel.setExtension({
			...ruleExtension(),
			raw: {
				name: "ts-redundant-clear-guard",
				alwaysApply: false,
				astCondition: Array.from({ length: 30 }, (_, i) => `if ($X) clearTimeout($X) // ${i + 1}`),
				interruptMode: "never",
				content: "do not guard timers\nline 2\nline 3\nline 4",
			},
		});
		const collapsed = Bun.stripANSI(panel.render(42).join("\n"));
		expect(collapsed).toContain("30 patterns");
		expect(collapsed).toMatch(/more \(.* to expand\)/);
		expect(collapsed).toContain("Rule");
		expect(collapsed).toContain("do not guard timers");
		expect(collapsed).not.toContain("clearTimeout($X) // 30");
	});

	test("fills leftover viewport before advertising truncation", () => {
		const longBody = Array.from({ length: 40 }, (_, i) => `line ${i + 1}`).join("\n");
		const panel = new InspectorPanel();
		panel.setHeight(40);
		panel.setExtension({
			...commandExtension(),
			raw: {
				name: "triage",
				content: `---\ndescription: "long template"\n---\n\n${longBody}\n`,
			},
		});
		const collapsed = render(panel);
		const lines = collapsed.split("\n");
		expect(lines.length).toBeLessThanOrEqual(40);
		expect(collapsed).toContain("line 1");
		expect(collapsed).not.toContain("line 40");
		expect(collapsed).toMatch(/more \(.* to expand\)/);
	});
});

describe("tool file header", () => {
	test("parses the leading JSDoc and drops symlink footnotes", () => {
		const description = parseToolFileHeader(`/**
 * cloak — bind a leased Cloak browser and drive the leased tab.
 *
 * Hidden unless an agent tools: list (or --tools) names it.
 *
 * Symlink: ~/.omp/agent/tools/cloak.ts → this file.
 */
export default function cloakTool() {}
`);
		expect(description).toContain("cloak — bind a leased Cloak browser");
		expect(description).toContain("Hidden unless an agent tools");
		expect(description).not.toContain("Symlink:");
	});
});

describe("inspector expand", () => {
	test("truncated command templates advertise ctrl+o and expand in place", () => {
		const longBody = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`).join("\n");
		const panel = new InspectorPanel();
		panel.setExtension({
			...commandExtension(),
			raw: {
				name: "triage",
				content: `---\ndescription: "long template"\n---\n\n${longBody}\n`,
			},
		});
		const collapsed = render(panel);
		expect(collapsed).toContain("line 1");
		expect(collapsed).not.toContain("line 20");
		expect(collapsed).toMatch(/more \(.* to expand\)/);

		panel.toggleExpanded();
		const expanded = render(panel);
		expect(expanded).toContain("line 20");
		expect(expanded).not.toMatch(/more \(.* to expand\)/);
	});
});
