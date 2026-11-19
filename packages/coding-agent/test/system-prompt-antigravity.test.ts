import { describe, expect, it, spyOn } from "bun:test";
import * as os from "node:os";
import * as path from "node:path";
import { __resetDirsFromEnvForTests, CONFIG_DIR_NAME, TempDir } from "@oh-my-pi/pi-utils";
import {
	ANTIGRAVITY_CLI_SYSTEM_PROMPT,
	buildSystemPrompt,
	type BuildSystemPromptOptions,
} from "@oh-my-pi/pi-coding-agent/system-prompt";
import { restoreEnvValue } from "./helpers/settings-test-state";

const EMPTY_TREE = {
	rootPath: "",
	rendered: "",
	truncated: false,
	totalLines: 0,
	agentsMdFiles: [],
};

interface DiscoveryPaths {
	cwd: string;
	projectConfig: string;
}

/** Isolates prompt discovery to a throwaway home so the developer's SYSTEM.md never leaks in. */
async function withDiscoveryHome<T>(fn: (paths: DiscoveryPaths) => Promise<T>): Promise<T> {
	using tempDir = TempDir.createSync("@omp-antigravity-prompt-");
	const home = tempDir.join("home");
	const homedirSpy = spyOn(os, "homedir").mockReturnValue(home);
	const previousHome = process.env.HOME;
	const previousUserProfile = process.env.USERPROFILE;
	const previousAgentDirEnv = process.env.PI_CODING_AGENT_DIR;
	process.env.HOME = home;
	process.env.USERPROFILE = home;
	restoreEnvValue("PI_CODING_AGENT_DIR", undefined);
	__resetDirsFromEnvForTests();
	try {
		return await fn({
			cwd: tempDir.join("project"),
			projectConfig: tempDir.join("project", CONFIG_DIR_NAME),
		});
	} finally {
		homedirSpy.mockRestore();
		if (previousHome === undefined) delete process.env.HOME;
		else process.env.HOME = previousHome;
		if (previousUserProfile === undefined) delete process.env.USERPROFILE;
		else process.env.USERPROFILE = previousUserProfile;
		restoreEnvValue("PI_CODING_AGENT_DIR", previousAgentDirEnv);
		__resetDirsFromEnvForTests();
	}
}

function options(cwd: string, overrides: Partial<BuildSystemPromptOptions> = {}): BuildSystemPromptOptions {
	return {
		cwd,
		contextFiles: [],
		skills: [],
		rules: [],
		toolNames: ["read", "write", "edit", "bash", "grep", "glob"],
		workspaceTree: { ...EMPTY_TREE, rootPath: cwd },
		...overrides,
	};
}

async function render(
	cwd: string,
	overrides: Partial<BuildSystemPromptOptions> = {},
): Promise<{ blocks: string[]; text: string }> {
	const result = await buildSystemPrompt(options(cwd, overrides));
	return { blocks: result.systemPrompt, text: result.systemPrompt.join("\n\n") };
}

describe("antigravity-cli prompt profile", () => {
	it("replaces omp's default instruction block and drops every tool-route section", async () => {
		await withDiscoveryHome(async ({ cwd }) => {
			const { blocks, text } = await render(cwd, {
				antigravityCli: true,
				nativeTools: true,
				inlineToolDescriptors: false,
				xdevTools: [{ name: "fetch", summary: "Fetches URLs." }],
				xdevDocs: "Mounted fetch documentation.",
				evalPreludes: [{ name: "commit", guidance: "COMMIT_PRELUDE_GUIDANCE" }],
			});
			expect(blocks[0]?.trim()).toBe(ANTIGRAVITY_CLI_SYSTEM_PROMPT);
			expect(text).not.toContain("You are omp's trusted coding assistant.");
			expect(text).not.toContain("# Internal URLs");
			expect(text).not.toContain("# Tool Inventory");
			expect(text).not.toContain("# xd:// Tool Devices");
			expect(text).not.toContain("Mounted fetch documentation.");
			expect(text).not.toContain("COMMIT_PRELUDE_GUIDANCE");
			// The session still carries its working-directory footer.
			expect(text).toContain("<project-context>");
		});
	});

	it("keeps the default prompt and its tool docs for every other provider", async () => {
		await withDiscoveryHome(async ({ cwd }) => {
			const { blocks, text } = await render(cwd, {
				antigravityCli: false,
				evalPreludes: [{ name: "commit", guidance: "COMMIT_PRELUDE_GUIDANCE" }],
			});
			expect(blocks[0]).toContain("You are omp's trusted coding assistant.");
			expect(text).toContain("# Internal URLs");
			expect(text).toContain("COMMIT_PRELUDE_GUIDANCE");
		});
	});

	it("lets an explicit custom prompt or template win", async () => {
		await withDiscoveryHome(async ({ cwd }) => {
			const custom = await render(cwd, { antigravityCli: true, customPrompt: "explicit custom prompt" });
			expect(custom.text).toContain("explicit custom prompt");
			expect(custom.text).not.toContain(ANTIGRAVITY_CLI_SYSTEM_PROMPT);

			const template = await render(cwd, {
				antigravityCli: true,
				systemPromptTemplate: "explicit template for {{cwd}}",
			});
			expect(template.blocks[0]).toContain("explicit template for ");
			expect(template.text).not.toContain(ANTIGRAVITY_CLI_SYSTEM_PROMPT);
		});
	});

	it("lets a discovered SYSTEM.md win", async () => {
		await withDiscoveryHome(async ({ cwd, projectConfig }) => {
			await Bun.write(path.join(projectConfig, "SYSTEM.md"), "project literal prompt");
			const { text } = await render(cwd, { antigravityCli: true });
			expect(text).toContain("project literal prompt");
			expect(text).not.toContain(ANTIGRAVITY_CLI_SYSTEM_PROMPT);
		});
	});

	it("keeps a --no-tools session tool- and skill-free without falling back to the default prompt", async () => {
		await withDiscoveryHome(async ({ cwd }) => {
			const { blocks, text } = await render(cwd, {
				antigravityCli: true,
				toolNames: [],
				skills: [
					{
						name: "unreadable-skill",
						description: "Needs a skill reader",
						filePath: path.join(cwd, "SKILL.md"),
						baseDir: cwd,
						source: "test",
					},
				],
			});
			expect(blocks[0]?.trim()).toBe(ANTIGRAVITY_CLI_SYSTEM_PROMPT);
			expect(text).not.toContain("<skills>");
			expect(text).not.toContain("# Tool Inventory");
		});
	});

	it("keeps the user's append text", async () => {
		await withDiscoveryHome(async ({ cwd }) => {
			const { text } = await render(cwd, {
				antigravityCli: true,
				resolvedAppendSystemPrompt: "USER_APPEND_SENTINEL",
			});
			expect(text).toContain("USER_APPEND_SENTINEL");
		});
	});
});
