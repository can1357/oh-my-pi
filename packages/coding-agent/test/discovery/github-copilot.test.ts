/**
 * Regression for the GitHub Copilot user-global discovery gaps:
 *   - #1913: ~/.copilot/copilot-instructions.md (user-global instructions)
 *   - #1915: COPILOT_HOME relocation + COPILOT_CUSTOM_INSTRUCTIONS_DIRS
 *   - #1916: *.prompt.md in .github/prompts/ and ~/.copilot/prompts/
 *
 * The `github` provider previously only scanned the project `.github/` tree. These
 * tests pin the user-global surface, driven through COPILOT_HOME so they never touch
 * the developer's real ~/.copilot directory.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { loadCapability, setDisabledProviders } from "@oh-my-pi/pi-coding-agent/capability";
import type { ContextFile } from "@oh-my-pi/pi-coding-agent/capability/context-file";
import { clearCache } from "@oh-my-pi/pi-coding-agent/capability/fs";
import type { Instruction } from "@oh-my-pi/pi-coding-agent/capability/instruction";
import type { Prompt } from "@oh-my-pi/pi-coding-agent/capability/prompt";
import { type Rule, resetActiveRulesForTests, setActiveRules } from "@oh-my-pi/pi-coding-agent/capability/rule";
import { RuleProtocolHandler } from "@oh-my-pi/pi-coding-agent/internal-urls/rule-protocol";
import { removeSyncWithRetries } from "@oh-my-pi/pi-utils";
import "@oh-my-pi/pi-coding-agent/capability/context-file";
import "@oh-my-pi/pi-coding-agent/capability/instruction";
import "@oh-my-pi/pi-coding-agent/capability/prompt";
import "@oh-my-pi/pi-coding-agent/capability/rule";
import "@oh-my-pi/pi-coding-agent/discovery/github";

const ENV_KEYS = ["COPILOT_HOME", "COPILOT_CUSTOM_INSTRUCTIONS_DIRS"] as const;

function write(file: string, content: string): void {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, content);
}

describe("github discovery — Copilot user-global surface", () => {
	let tempDir!: string;
	let cwd!: string;
	let copilotHome!: string;
	const savedEnv: Record<string, string | undefined> = {};

	beforeEach(() => {
		clearCache();
		for (const key of ENV_KEYS) savedEnv[key] = process.env[key];
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-github-copilot-"));
		cwd = path.join(tempDir, "project");
		copilotHome = path.join(tempDir, "copilot-home");
		fs.mkdirSync(cwd, { recursive: true });
		process.env.COPILOT_HOME = copilotHome;
		delete process.env.COPILOT_CUSTOM_INSTRUCTIONS_DIRS;
	});

	afterEach(() => {
		clearCache();
		resetActiveRulesForTests();
		setDisabledProviders([]);
		for (const key of ENV_KEYS) {
			if (savedEnv[key] === undefined) delete process.env[key];
			else process.env[key] = savedEnv[key];
		}
		if (tempDir) removeSyncWithRetries(tempDir);
	});

	test("loads user-global ~/.copilot/copilot-instructions.md via COPILOT_HOME (#1913)", async () => {
		write(path.join(copilotHome, "copilot-instructions.md"), "user-global guidance");

		const result = await loadCapability<ContextFile>("context-files", { cwd, providers: ["github"] });

		const found = result.all.find(f => f.path === path.join(copilotHome, "copilot-instructions.md"));
		expect(found).toBeDefined();
		expect(found?.content).toBe("user-global guidance");
		expect(found?.level).toBe("user");
		expect(found?._source.provider).toBe("github");
	});

	test("still loads project .github/copilot-instructions.md alongside user-global", async () => {
		write(path.join(cwd, ".github", "copilot-instructions.md"), "project guidance");
		write(path.join(copilotHome, "copilot-instructions.md"), "user guidance");

		const result = await loadCapability<ContextFile>("context-files", { cwd, providers: ["github"] });

		const project = result.all.find(f => f.level === "project");
		const user = result.all.find(f => f.level === "user");
		expect(project?.content).toBe("project guidance");
		expect(user?.content).toBe("user guidance");
	});

	test("loads AGENTS.md from COPILOT_CUSTOM_INSTRUCTIONS_DIRS (#1915)", async () => {
		const extraA = path.join(tempDir, "extra-a");
		const extraB = path.join(tempDir, "extra-b");
		write(path.join(extraA, "AGENTS.md"), "extra A agents");
		write(path.join(extraB, "AGENTS.md"), "extra B agents");
		// copilot-instructions.md in a custom dir is NOT part of the spec and must be ignored.
		write(path.join(extraA, "copilot-instructions.md"), "should be ignored");
		process.env.COPILOT_CUSTOM_INSTRUCTIONS_DIRS = `${extraA}, ${extraB}`;

		const result = await loadCapability<ContextFile>("context-files", { cwd, providers: ["github"] });

		const contents = result.all.filter(f => f.level === "user").map(f => f.content);
		expect(contents).toContain("extra A agents");
		expect(contents).toContain("extra B agents");
		expect(contents).not.toContain("should be ignored");
	});

	test("loads <dir>/.github/instructions/**/*.instructions.md from custom dirs (#1915)", async () => {
		const extra = path.join(tempDir, "extra");
		// Recursive, under <dir>/.github/instructions — not top-level <dir>/*.instructions.md.
		write(
			path.join(extra, ".github", "instructions", "nested", "style.instructions.md"),
			"---\napplyTo: '**/*.ts'\n---\nStyle rules",
		);
		// A top-level instructions file in the custom dir must NOT be picked up.
		write(path.join(extra, "toplevel.instructions.md"), "---\napplyTo: '**'\n---\nIgnored");
		process.env.COPILOT_CUSTOM_INSTRUCTIONS_DIRS = extra;

		const result = await loadCapability<Instruction>("instructions", { cwd, providers: ["github"] });

		const found = result.all.find(i => i.name === "style");
		expect(found).toBeDefined();
		expect(found?.applyTo).toBe("**/*.ts");
		expect(found?.content.trim()).toBe("Style rules");
		expect(found?._source.level).toBe("user");
		expect(result.all.find(i => i.name === "toplevel")).toBeUndefined();
	});

	test("discovers *.prompt.md from .github/prompts/ (#1916)", async () => {
		write(
			path.join(cwd, ".github", "prompts", "review.prompt.md"),
			"---\ndescription: Review helper\n---\nReview the diff.",
		);
		// Plain markdown that is not a prompt file must be ignored.
		write(path.join(cwd, ".github", "prompts", "notes.md"), "not a prompt");

		const result = await loadCapability<Prompt>("prompts", { cwd, providers: ["github"] });

		const review = result.all.find(p => p.name === "review");
		expect(review).toBeDefined();
		expect(review?.content.trim()).toBe("Review the diff.");
		expect(review?._source.level).toBe("project");
		expect(result.all.find(p => p.name === "notes")).toBeUndefined();
	});

	test("loads project .github/instructions/*.instructions.md as Copilot-scoped rules (#2731)", async () => {
		write(
			path.join(cwd, ".github", "instructions", "always.instructions.md"),
			"---\napplyTo: '**'\ndescription: Always guidance\n---\nAlways body\n",
		);
		write(
			path.join(cwd, ".github", "instructions", "cs.instructions.md"),
			"---\napplyTo: '**/*.cs'\ndescription: C# guidance\n---\nC# body\n",
		);

		const result = await loadCapability<Rule>("rules", { cwd, providers: ["github"] });

		const always = result.items.find(rule => rule.name === "always");
		expect(always?.alwaysApply).toBe(true);
		expect(always?.globs).toBeUndefined();
		expect(always?.content.trim()).toBe("Always body");

		const scoped = result.items.find(rule => rule.name === "cs");
		expect(scoped?.alwaysApply).toBe(false);
		expect(scoped?.globs).toEqual(["**/*.cs"]);
		expect(scoped?.description).toBe("C# guidance");
		setActiveRules(result.items);
		const resource = await new RuleProtocolHandler().resolve(Object.assign(new URL("rule://cs"), { rawHost: "cs" }));
		expect(resource.content.trim()).toBe("C# body");
	});

	test("splits comma-separated applyTo globs and treats **/* as always-apply (#2731)", async () => {
		write(
			path.join(cwd, ".github", "instructions", "ts.instructions.md"),
			"---\napplyTo: '**/*.ts,**/*.tsx'\n---\nTS body\n",
		);
		write(path.join(cwd, ".github", "instructions", "all.instructions.md"), "---\napplyTo: '**/*'\n---\nAll body\n");

		const result = await loadCapability<Rule>("rules", { cwd, providers: ["github"] });

		const ts = result.items.find(rule => rule.name === "ts");
		expect(ts?.alwaysApply).toBe(false);
		expect(ts?.globs).toEqual(["**/*.ts", "**/*.tsx"]);

		const all = result.items.find(rule => rule.name === "all");
		expect(all?.alwaysApply).toBe(true);
		expect(all?.globs).toBeUndefined();
	});

	test("disabled github provider suppresses copilot instructions and instruction-file rules (#2731)", async () => {
		write(path.join(cwd, ".github", "copilot-instructions.md"), "project guidance");
		write(
			path.join(cwd, ".github", "instructions", "always.instructions.md"),
			"---\napplyTo: '**'\n---\nAlways body\n",
		);
		setDisabledProviders(["github"]);

		const contextFiles = await loadCapability<ContextFile>("context-files", { cwd, providers: ["github"] });
		const instructions = await loadCapability<Instruction>("instructions", { cwd, providers: ["github"] });
		const rules = await loadCapability<Rule>("rules", { cwd, providers: ["github"] });

		expect(contextFiles.all).toHaveLength(0);
		expect(instructions.all).toHaveLength(0);
		expect(rules.all).toHaveLength(0);
	});
});
