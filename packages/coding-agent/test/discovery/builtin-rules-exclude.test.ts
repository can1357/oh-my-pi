/**
 * Regression tests for issue #20322.
 *
 * Rule files in `.omp/rules/` that git tracks must still be discovered when an
 * ignore file (`.git/info/exclude`, `.gitignore`) matches them. Ignore rules
 * hide untracked working-tree files, not files the repository deliberately
 * ships; a tracked rule hidden by an exclude entry silently drops it from the
 * main worktree (linked worktrees skipped the exclude file entirely because
 * their `.git` is a file, so the two worktrees disagreed).
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { getCapability } from "@oh-my-pi/pi-coding-agent/capability";
import { clearCache } from "@oh-my-pi/pi-coding-agent/capability/fs";
import { type Rule, ruleCapability } from "@oh-my-pi/pi-coding-agent/capability/rule";
import type { LoadContext } from "@oh-my-pi/pi-coding-agent/capability/types";
// Importing discovery registers all providers as a side effect.
import { loadCapability } from "@oh-my-pi/pi-coding-agent/discovery";
import { getConfigRootDir, removeSyncWithRetries, setAgentDir } from "@oh-my-pi/pi-utils";

let tempDir: string;
let home: string;
let project: string;

const originalAgentDirEnv = process.env.PI_CODING_AGENT_DIR;
const fallbackAgentDir = path.join(getConfigRootDir(), "agent");

function git(cwd: string, ...args: string[]): void {
	execFileSync("git", args, { cwd });
}

function writeRule(relPath: string, body: string): void {
	fs.mkdirSync(path.dirname(path.join(project, relPath)), { recursive: true });
	fs.writeFileSync(path.join(project, relPath), body);
}

function trackedRuleBody(relPath: string): string {
	return `---\ndescription: ${relPath}\ncondition: "zzz"\n---\nrule body\n`;
}

async function loadRules(ctx: LoadContext): Promise<Rule[]> {
	// Force provider registration (builtin.ts is imported lazily by loadCapability).
	await loadCapability(ruleCapability.id, { cwd: ctx.cwd, providers: ["native"] });
	const cap = getCapability(ruleCapability.id);
	if (!cap) throw new Error("rules capability missing");
	const native = cap.providers.find(p => p.id === "native");
	if (!native) throw new Error("native rules provider missing");
	const result = await (native.load as (ctx: LoadContext) => Promise<{ items: Rule[] }>)(ctx);
	return result.items;
}

beforeEach(() => {
	clearCache();
	tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-rules-exclude-"));
	home = path.join(tempDir, "home");
	project = path.join(tempDir, "project");
	fs.mkdirSync(home, { recursive: true });
	fs.mkdirSync(project, { recursive: true });
	setAgentDir(path.join(home, ".omp", "agent"));
});

afterEach(() => {
	clearCache();
	removeSyncWithRetries(tempDir);
	if (originalAgentDirEnv) {
		setAgentDir(originalAgentDirEnv);
	} else {
		setAgentDir(fallbackAgentDir);
		delete process.env.PI_CODING_AGENT_DIR;
	}
});

test("tracked rule in .omp/rules loads despite a .git/info/exclude entry matching it", async () => {
	writeRule(".omp/rules/demo.md", trackedRuleBody(".omp/rules/demo.md"));
	git(project, "init", "-q");
	git(project, "add", ".");
	git(project, "-c", "user.name=t", "-c", "user.email=t@example.invalid", "commit", "-qm", "x");
	fs.writeFileSync(path.join(project, ".git", "info", "exclude"), "/.omp/rules/demo.md\n");

	const rules = await loadRules({ cwd: project, home, repoRoot: project });

	expect(rules.some(r => r.name.startsWith("demo@") || r.name === "demo")).toBe(true);
});

test("tracked rule in .omp/rules loads despite a matching .gitignore entry", async () => {
	writeRule(".omp/rules/demo.md", trackedRuleBody(".omp/rules/demo.md"));
	git(project, "init", "-q");
	git(project, "add", ".");
	git(project, "-c", "user.name=t", "-c", "user.email=t@example.invalid", "commit", "-qm", "x");
	fs.writeFileSync(path.join(project, ".gitignore"), ".omp/rules/demo.md\n");

	const rules = await loadRules({ cwd: project, home, repoRoot: project });

	expect(rules.some(r => r.name.startsWith("demo@") || r.name === "demo")).toBe(true);
});

test("untracked rule excluded via .git/info/exclude is still hidden", async () => {
	writeRule(".omp/rules/demo.md", trackedRuleBody(".omp/rules/demo.md"));
	git(project, "init", "-q");
	git(project, "add", ".");
	git(project, "-c", "user.name=t", "-c", "user.email=t@example.invalid", "commit", "-qm", "x");
	writeRule(".omp/rules/symlink-only.md", trackedRuleBody(".omp/rules/symlink-only.md"));
	fs.writeFileSync(path.join(project, ".git", "info", "exclude"), "/.omp/rules/symlink-only.md\n");

	const rules = await loadRules({ cwd: project, home, repoRoot: project });

	expect(rules.some(r => r.name.startsWith("symlink-only"))).toBe(false);
});
