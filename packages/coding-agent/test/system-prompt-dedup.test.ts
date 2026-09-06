import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	buildSystemPrompt,
	loadProjectContextFiles,
	loadSystemPromptFiles,
	type SystemPromptToolMetadata,
} from "@oh-my-pi/pi-coding-agent/system-prompt";
import { cleanupTempHome } from "./helpers/temp-home-cleanup";

function escapeRegExp(text: string): string {
	return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const READ_TOOL = new Map<string, SystemPromptToolMetadata>([
	[
		"read",
		{
			label: "Read",
			description: "Reads files from disk.",
			parameters: { type: "object", properties: { path: { type: "string" } } },
		},
	],
]);

describe("SYSTEM.md prompt assembly", () => {
	let tempDir = "";
	let tempHomeDir = "";
	let originalHome: string | undefined;

	beforeEach(() => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-system-prompt-"));
		tempHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-system-home-"));
		originalHome = process.env.HOME;
		process.env.HOME = tempHomeDir;
	});

	afterEach(cleanupTempHome(() => ({ tempDir, tempHomeDir, originalHome })));

	it("keeps per-request date/cwd out of the system prompt footer", async () => {
		// The date/cwd line was moved out of the system prompt and onto the first
		// user turn (#7404): any byte that changes per request at the tail of the
		// system block invalidates the tool-schema prefix cache on open-weight
		// providers. The footer must not interpolate the cwd or the date.
		const projectDir = path.join(os.homedir(), "project");
		const { systemPrompt } = await buildSystemPrompt({
			cwd: projectDir,
			contextFiles: [],
			skills: [],
			rules: [],
			toolNames: [],
			activeRepoContext: null,
			workspaceTree: {
				rootPath: projectDir,
				rendered: "",
				truncated: false,
				totalLines: 0,
				agentsMdFiles: [],
			},
		});

		const promptText = systemPrompt.join("\n\n");
		const normalizedProjectDir = projectDir.replace(/\\/g, "/");
		expect(promptText).not.toContain(normalizedProjectDir);
		expect(promptText).not.toContain("Today");
		expect(promptText).not.toContain("current working directory");
	});

	it("renders SYSTEM.md exactly once when it is used as the custom base prompt", async () => {
		const projectDir = path.join(tempDir, "project");
		const systemDir = path.join(projectDir, ".omp");
		const systemPrompt = "You are the project SYSTEM prompt.";
		fs.mkdirSync(systemDir, { recursive: true });
		fs.writeFileSync(path.join(systemDir, "SYSTEM.md"), systemPrompt);

		const { systemPrompt: renderedPrompt } = await buildSystemPrompt({
			cwd: projectDir,
			customPrompt: systemPrompt,
			contextFiles: [],
			skills: [
				{
					name: "focused-work",
					description: "Focused work instructions",
					filePath: "skills/focused-work/SKILL.md",
					baseDir: "skills/focused-work",
					source: "test",
				},
			],
			rules: [],
			toolNames: ["read"],
			tools: READ_TOOL,
			workspaceTree: {
				rootPath: projectDir,
				rendered: "",
				truncated: false,
				totalLines: 0,
				agentsMdFiles: [],
			},
		});

		const promptText = renderedPrompt.join("\n\n");
		const matches = promptText.match(new RegExp(escapeRegExp(systemPrompt), "g")) ?? [];
		expect(matches).toHaveLength(1);
		expect(promptText).toContain('<skill name="focused-work">');
	});

	it("does not resolve already-loaded prompt text as a path", async () => {
		const projectDir = path.join(tempDir, "project");
		const readablePromptText = path.join(projectDir, "README.md");
		fs.mkdirSync(projectDir, { recursive: true });
		fs.writeFileSync(readablePromptText, "File content that must not replace the prompt.");

		const { systemPrompt } = await buildSystemPrompt({
			cwd: projectDir,
			resolvedCustomPrompt: readablePromptText,
			resolvedAppendSystemPrompt: readablePromptText,
			contextFiles: [],
			skills: [],
			rules: [],
			toolNames: ["read"],
			tools: READ_TOOL,
			workspaceTree: {
				rootPath: projectDir,
				rendered: "",
				truncated: false,
				totalLines: 0,
				agentsMdFiles: [],
			},
		});

		const promptText = systemPrompt.join("\n\n");
		expect(promptText).toContain(readablePromptText);
		expect(promptText).not.toContain("File content that must not replace the prompt.");
	});

	it("suppresses discovered SYSTEM.md while preserving the project footer", async () => {
		const projectDir = path.join(tempDir, "project");
		const appendPrompt = "Extra append instructions";
		fs.mkdirSync(path.join(projectDir, ".omp"), { recursive: true });
		fs.writeFileSync(path.join(projectDir, ".omp", "SYSTEM.md"), "Discovered project SYSTEM prompt");

		const { systemPrompt } = await buildSystemPrompt({
			cwd: projectDir,
			resolvedCustomPrompt: "CLI custom prompt",
			resolvedAppendSystemPrompt: appendPrompt,
			contextFiles: [],
			skills: [],
			rules: [],
			toolNames: ["read"],
			tools: READ_TOOL,
			includeWorkspaceTree: true,
			workspaceTree: {
				rootPath: projectDir,
				rendered: ".\n  - nested/",
				truncated: false,
				totalLines: 2,
				agentsMdFiles: ["nested/AGENTS.md"],
			},
		});

		const promptText = systemPrompt.join("\n\n");
		const appendMatches = promptText.match(new RegExp(escapeRegExp(appendPrompt), "g")) ?? [];
		expect(systemPrompt).toHaveLength(2);
		expect(promptText).toContain("CLI custom prompt");
		expect(promptText).toContain("<workspace-tree>");
		expect(promptText).toContain("<dir-context>");
		// The project/environment footer survives even though the date/cwd line was
		// relocated out of it; <workstation> is rendered only by that footer.
		expect(promptText).toContain("<workstation>");
		expect(appendMatches).toHaveLength(1);
		expect(promptText).not.toContain("Discovered project SYSTEM prompt");
	});

	it("renders active child repo context in the main system prompt", async () => {
		const parentDir = path.join(tempDir, "parent-cwd");
		fs.mkdirSync(path.join(parentDir, "active-project", ".git"), { recursive: true });

		const { systemPrompt } = await buildSystemPrompt({
			cwd: parentDir,
			contextFiles: [],
			skills: [],
			rules: [],
			toolNames: [],
			workspaceTree: {
				rootPath: parentDir,
				rendered: "",
				truncated: false,
				totalLines: 0,
				agentsMdFiles: [],
			},
		});

		const promptText = systemPrompt.join("\n\n");
		expect(promptText).toContain("<active-repo-context>");
		expect(promptText).toContain("`active-project`");
		expect(promptText).toContain("`active-project/`");
	});

	it("prefers project SYSTEM.md over user SYSTEM.md", async () => {
		const projectDir = path.join(tempDir, "project");
		fs.mkdirSync(path.join(projectDir, ".omp"), { recursive: true });
		fs.mkdirSync(path.join(tempHomeDir, ".omp", "agent"), { recursive: true });
		fs.writeFileSync(path.join(tempHomeDir, ".omp", "agent", "SYSTEM.md"), "User SYSTEM prompt");
		fs.writeFileSync(path.join(projectDir, ".omp", "SYSTEM.md"), "Project SYSTEM prompt");

		await expect(loadSystemPromptFiles({ cwd: projectDir })).resolves.toBe("Project SYSTEM prompt");
	});
	it("drops identical explicit context entries even when file names differ", async () => {
		const farPath = path.join(tempDir, "far", "AGENTS.md");
		const nearPath = path.join(tempDir, "near", "CLAUDE.md");
		const sharedContent = "Shared context instructions";

		const { systemPrompt } = await buildSystemPrompt({
			cwd: tempDir,
			customPrompt: "Base prompt",
			contextFiles: [
				{ path: farPath, content: sharedContent, depth: 2 },
				{ path: nearPath, content: sharedContent, depth: 0 },
			],
			skills: [],
			rules: [],
			toolNames: [],
		});

		const promptText = systemPrompt.join("\n\n");
		const matches = promptText.match(new RegExp(escapeRegExp(sharedContent), "g")) ?? [];
		expect(matches).toHaveLength(1);
		expect(promptText).not.toContain(`<file path="${farPath}">`);
		expect(promptText).toContain(`<file path="${nearPath}">`);
	});

	it("drops identical discovered context entries and keeps the closest copy", async () => {
		const projectDir = path.join(tempDir, "project");
		const appDir = path.join(projectDir, "packages", "app");
		const sharedContent = "Shared context instructions";

		fs.mkdirSync(appDir, { recursive: true });
		fs.writeFileSync(path.join(projectDir, "AGENTS.md"), sharedContent);
		fs.writeFileSync(path.join(appDir, "AGENTS.md"), sharedContent);

		const contextFiles = await loadProjectContextFiles({ cwd: appDir });
		const discoveredFiles = contextFiles.filter(file => file.path.startsWith(projectDir));

		expect(discoveredFiles).toHaveLength(1);
		expect(discoveredFiles[0]?.path).toBe(path.join(appDir, "AGENTS.md"));
	});

	it("keeps distinct context entries when their contents differ", async () => {
		const farPath = path.join(tempDir, "far", "AGENTS.md");
		const nearPath = path.join(tempDir, "near", "CLAUDE.md");

		const { systemPrompt } = await buildSystemPrompt({
			cwd: tempDir,
			customPrompt: "Base prompt",
			contextFiles: [
				{ path: farPath, content: "Root context instructions", depth: 2 },
				{ path: nearPath, content: "Near context instructions", depth: 0 },
			],
			skills: [],
			rules: [],
			toolNames: [],
		});
		const promptText = systemPrompt.join("\n\n");

		expect(promptText).toContain("Root context instructions");
		expect(promptText).toContain("Near context instructions");
	});

	it("drops always-apply rule content already present through expanded context imports", async () => {
		const projectDir = path.join(tempDir, "project");
		const instructionPath = path.join(projectDir, ".github", "instructions", "shared.instructions.md");
		const sharedContent = "Shared imported guidance";
		fs.mkdirSync(path.dirname(instructionPath), { recursive: true });
		fs.writeFileSync(path.join(projectDir, "AGENTS.md"), "Use @.github/instructions/shared.instructions.md\n");
		fs.writeFileSync(instructionPath, `---\napplyTo: '**'\n---\n\n${sharedContent}\n`);

		const contextFiles = await loadProjectContextFiles({ cwd: projectDir });
		const { systemPrompt } = await buildSystemPrompt({
			cwd: projectDir,
			customPrompt: "Base prompt",
			contextFiles,
			skills: [],
			rules: [],
			alwaysApplyRules: [{ name: "shared", path: instructionPath, content: sharedContent }],
			toolNames: [],
		});

		const promptText = systemPrompt.join("\n\n");
		const matches = promptText.match(new RegExp(escapeRegExp(sharedContent), "g")) ?? [];
		expect(matches).toHaveLength(1);
	});
});
