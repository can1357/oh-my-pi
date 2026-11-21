import { afterEach, beforeEach, describe, expect, it, type Mock, spyOn } from "bun:test";
import * as os from "node:os";
import * as path from "node:path";
import { AuthStorage } from "@oh-my-pi/pi-ai";
import { closeModelCache } from "@oh-my-pi/pi-catalog/model-cache";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { clearCache as clearFsCache } from "@oh-my-pi/pi-coding-agent/capability/fs";
import { parseArgs } from "@oh-my-pi/pi-coding-agent/cli/args";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { buildSessionOptions } from "@oh-my-pi/pi-coding-agent/main";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import {
	type BuildSystemPromptOptions,
	buildSystemPrompt,
	discoverSystemPromptOverride,
	resolvePromptInput,
} from "@oh-my-pi/pi-coding-agent/system-prompt";
import {
	__resetDirsFromEnvForTests,
	CONFIG_DIR_NAME,
	getAgentDir,
	getProjectDir,
	setProjectDir,
	TempDir,
} from "@oh-my-pi/pi-utils";
import { restoreEnvValue } from "./helpers/settings-test-state";

// Issue #17261: `@path` imports in APPEND_SYSTEM.md and SYSTEM.md were inserted verbatim.
describe("system prompt file @-imports", () => {
	let tempDir: TempDir;
	let home: string;
	let cwd: string;
	let homedirSpy: Mock<typeof os.homedir>;
	let previousHome: string | undefined;
	let previousUserProfile: string | undefined;
	let previousAgentDirEnv: string | undefined;

	beforeEach(async () => {
		tempDir = TempDir.createSync("@omp-system-prompt-at-imports-");
		home = tempDir.join("home");
		cwd = tempDir.join("project");
		previousHome = process.env.HOME;
		previousUserProfile = process.env.USERPROFILE;
		previousAgentDirEnv = process.env.PI_CODING_AGENT_DIR;
		homedirSpy = spyOn(os, "homedir").mockReturnValue(home);
		process.env.HOME = home;
		process.env.USERPROFILE = home;
		restoreEnvValue("PI_CODING_AGENT_DIR", undefined);
		__resetDirsFromEnvForTests();
		clearFsCache();
		await Bun.write(path.join(home, "shared", "style.md"), "Shared style rule.");
		await Bun.write(path.join(cwd, "docs", "testing.md"), "Project testing rule.");
	});

	afterEach(() => {
		homedirSpy.mockRestore();
		if (previousHome === undefined) delete process.env.HOME;
		else process.env.HOME = previousHome;
		if (previousUserProfile === undefined) delete process.env.USERPROFILE;
		else process.env.USERPROFILE = previousUserProfile;
		restoreEnvValue("PI_CODING_AGENT_DIR", previousAgentDirEnv);
		__resetDirsFromEnvForTests();
		clearFsCache();
		tempDir.removeSync();
	});

	function options(overrides: Partial<BuildSystemPromptOptions> = {}): BuildSystemPromptOptions {
		return {
			cwd,
			contextFiles: [],
			skills: [],
			rules: [],
			toolNames: [],
			workspaceTree: { rootPath: cwd, rendered: "", truncated: false, totalLines: 0, agentsMdFiles: [] },
			...overrides,
		};
	}

	it("expands imports in an APPEND_SYSTEM.md file", async () => {
		const appendPath = path.join(cwd, CONFIG_DIR_NAME, "APPEND_SYSTEM.md");
		await Bun.write(appendPath, "@~/shared/style.md\n@../docs/testing.md\n");

		const resolved = await resolvePromptInput(appendPath, "append system prompt", { expandAtImports: true });
		expect(resolved).toBe("Shared style rule.\nProject testing rule.\n");

		const text = (await buildSystemPrompt(options({ appendSystemPrompt: appendPath }))).systemPrompt.join("\n\n");
		expect(text).toContain("Shared style rule.");
		expect(text).toContain("Project testing rule.");
		expect(text).not.toContain("@~/shared/style.md");
	});

	it("expands imports in a discovered APPEND_SYSTEM.md on the CLI session path", async () => {
		await Bun.write(path.join(cwd, CONFIG_DIR_NAME, "APPEND_SYSTEM.md"), "@~/shared/style.md\n@../docs/testing.md\n");
		const originalProjectDir = getProjectDir();
		const authStorage = await AuthStorage.create(tempDir.join("auth.db"));
		authStorage.keys.setRuntime("openai", "test-key");
		const modelRegistry = new ModelRegistry(authStorage, tempDir.join("models.yml"));
		const settings = Settings.isolated({
			"async.enabled": false,
			"task.isolation.enabled": false,
			"task.enableLsp": false,
			"advisor.enabled": false,
			"compaction.enabled": false,
			"retry.enabled": false,
		});
		// APPEND_SYSTEM.md discovery reads the process project dir, not `--cwd`.
		setProjectDir(cwd);
		try {
			const args = parseArgs(["--cwd", cwd]);
			const sessionOptions = await buildSessionOptions(
				args,
				[],
				SessionManager.inMemory(cwd),
				modelRegistry,
				settings,
			);
			expect(sessionOptions.appendSystemPrompt).toBe("Shared style rule.\nProject testing rule.\n");

			const { session } = await createAgentSession({
				...sessionOptions,
				agentDir: getAgentDir(),
				modelRegistry,
				settings,
				model: getBundledModel("openai", "gpt-4o-mini"),
				enableLsp: false,
				skipPythonPreflight: true,
			});
			try {
				const prompt = session.systemPrompt.join("\n");
				expect(prompt).toContain("Shared style rule.");
				expect(prompt).toContain("Project testing rule.");
				expect(prompt).not.toContain("@~/shared/style.md");
			} finally {
				await session.dispose();
			}
		} finally {
			setProjectDir(originalProjectDir);
			authStorage.close();
			closeModelCache();
		}
	}, 60_000);

	it("leaves a literal append prompt untouched", async () => {
		const literal = "Follow @~/shared/style.md\nand @docs/testing.md";
		expect(await resolvePromptInput(literal, "append system prompt", { expandAtImports: true })).toBe(literal);
		expect(await resolvePromptInput("@~/shared/style.md", "append system prompt", { expandAtImports: true })).toBe(
			"@~/shared/style.md",
		);
	});

	it("expands imports in a SYSTEM.md file", async () => {
		const systemPath = path.join(cwd, CONFIG_DIR_NAME, "SYSTEM.md");
		await Bun.write(systemPath, "Custom prompt.\n@~/shared/style.md\n");

		const override = await discoverSystemPromptOverride(cwd);
		expect(override).toEqual({ kind: "text", path: systemPath, content: "Custom prompt.\nShared style rule.\n" });

		const text = (await buildSystemPrompt(options())).systemPrompt.join("\n\n");
		expect(text).toContain("Shared style rule.");
		expect(text).not.toContain("@~/shared/style.md");
	});
});
