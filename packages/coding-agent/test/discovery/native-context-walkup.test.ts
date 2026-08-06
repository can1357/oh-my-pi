/**
 * Regression tests for the native AGENTS.md project walk-up and for
 * `loadCapability`'s cwd canonicalization.
 *
 * 1. The walk-up is file-specific: a nearer non-empty `.ompk/` that lacks a
 *    usable AGENTS.md must not stop the walk (docs: "the walk-up continues").
 *    Nearest-only still holds: once a usable file is found, farther native
 *    files are not also loaded.
 * 2. `loadCapability` canonicalizes `options.cwd` before deriving the repo
 *    root, so relative, mixed-separator, or trailing-`.` cwd forms must behave
 *    identically to the canonical absolute path — in particular the walk must
 *    stop at the repo root instead of leaking files planted above it.
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { getCapability, loadCapability } from "@pk-nerdsaver-ai/pi-coding-agent/capability";
import { type ContextFile, contextFileCapability } from "@pk-nerdsaver-ai/pi-coding-agent/capability/context-file";
import { clearCache } from "@pk-nerdsaver-ai/pi-coding-agent/capability/fs";
import type { LoadContext } from "@pk-nerdsaver-ai/pi-coding-agent/capability/types";
// Register all discovery providers as a side effect.
import "@pk-nerdsaver-ai/pi-coding-agent/discovery";
import { getConfigRootDir, removeSyncWithRetries, setAgentDir } from "@pk-nerdsaver-ai/pi-utils";

let tempDir: string;
let home: string;
let project: string;
let subPkg: string;

const originalAgentDirEnv = process.env.PI_CODING_AGENT_DIR;
const fallbackAgentDir = path.join(getConfigRootDir(), "agent");

function writeFile(filePath: string, content: string): void {
	fs.mkdirSync(path.dirname(filePath), { recursive: true });
	fs.writeFileSync(filePath, content);
}

async function loadNativeContextFiles(ctx: LoadContext): Promise<ContextFile[]> {
	const cap = getCapability(contextFileCapability.id);
	if (!cap) throw new Error("context-file capability missing");
	const native = cap.providers.find(p => p.id === "native");
	if (!native) throw new Error("native context-file provider missing");
	const result = await (native.load as (ctx: LoadContext) => Promise<{ items: ContextFile[] }>)(ctx);
	return result.items;
}

beforeEach(() => {
	clearCache();
	tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-ctx-walkup-"));
	home = path.join(tempDir, "home");
	project = path.join(tempDir, "project");
	subPkg = path.join(project, "packages", "app");
	fs.mkdirSync(home, { recursive: true });
	fs.mkdirSync(subPkg, { recursive: true });
	fs.mkdirSync(path.join(project, ".git"), { recursive: true });
	setAgentDir(path.join(home, ".ompk", "agent"));
});

afterEach(() => {
	clearCache();
	if (originalAgentDirEnv) {
		setAgentDir(originalAgentDirEnv);
	} else {
		setAgentDir(fallbackAgentDir);
		delete process.env.PI_CODING_AGENT_DIR;
	}
	removeSyncWithRetries(tempDir);
});

// --- file-specific walk-up ---------------------------------------------------

test("nearest .ompk/AGENTS.md wins and farther native files are not included", async () => {
	writeFile(path.join(subPkg, ".ompk", "AGENTS.md"), "# package agents\n");
	writeFile(path.join(project, ".ompk", "AGENTS.md"), "# root agents\n");

	const files = await loadNativeContextFiles({ cwd: subPkg, home, repoRoot: project });

	const projectFiles = files.filter(f => f.level === "project");
	expect(projectFiles).toHaveLength(1);
	expect(projectFiles[0]?.path).toBe(path.join(subPkg, ".ompk", "AGENTS.md"));
	expect(projectFiles[0]?.depth).toBe(0);
});

test("child .ompk without AGENTS.md falls through to parent AGENTS.md", async () => {
	// Non-empty child .ompk (config only) must not block the root context file.
	writeFile(path.join(subPkg, ".ompk", "config.yml"), "theme: dark\n");
	writeFile(path.join(project, ".ompk", "AGENTS.md"), "# root agents\n");

	const files = await loadNativeContextFiles({ cwd: subPkg, home, repoRoot: project });

	const projectFile = files.find(f => f.level === "project");
	expect(projectFile).toBeDefined();
	expect(projectFile?.path).toBe(path.join(project, ".ompk", "AGENTS.md"));
	expect(projectFile?.depth).toBe(2);
});

test("empty child AGENTS.md falls through to parent AGENTS.md", async () => {
	writeFile(path.join(subPkg, ".ompk", "AGENTS.md"), "");
	writeFile(path.join(project, ".ompk", "AGENTS.md"), "# root agents\n");

	const files = await loadNativeContextFiles({ cwd: subPkg, home, repoRoot: project });

	const projectFile = files.find(f => f.level === "project");
	expect(projectFile).toBeDefined();
	expect(projectFile?.path).toBe(path.join(project, ".ompk", "AGENTS.md"));
	expect(projectFile?.content).toContain("root agents");
});

// --- loadCapability cwd canonicalization -------------------------------------

/** Non-canonical spellings of `dir` that must behave like the canonical path. */
function nonCanonicalForms(dir: string): string[] {
	const forms = [`${dir}${path.sep}.`, dir.replaceAll("\\", "/")];
	const rel = path.relative(process.cwd(), dir);
	if (rel && !path.isAbsolute(rel)) forms.push(rel);
	if (/^[A-Za-z]:/.test(dir)) {
		const drive = dir[0] as string;
		const swapped = drive === drive.toLowerCase() ? drive.toUpperCase() : drive.toLowerCase();
		forms.push(swapped + dir.slice(1));
	}
	return forms;
}

/**
 * Symlinked spelling of `dir`, created OUTSIDE the repo's lexical path
 * (directly under tempDir, a sibling of `project`). Only `realpath` — not
 * `path.resolve` — maps it back into the repo, so this form regresses on
 * every platform if canonicalization is dropped: a lexical walk from the
 * link never finds `.git` or the repo's context files. Returns null when
 * the platform refuses to create the link (e.g. locked-down Windows).
 */
function symlinkedForm(dir: string): string | null {
	const link = path.join(tempDir, "linked-cwd");
	try {
		// "junction" works without privileges on Windows; plain symlink elsewhere.
		fs.symlinkSync(dir, link, "junction");
		return link;
	} catch {
		return null;
	}
}

function cwdForms(dir: string): string[] {
	const forms = nonCanonicalForms(dir);
	const linked = symlinkedForm(dir);
	if (linked) forms.push(linked);
	return forms;
}

test("walk-up stops at the repo root for non-canonical cwd forms", async () => {
	// Decoy ABOVE the repo root: a walk that misses the repoRoot sentinel
	// (e.g. because cwd separators/case never string-match) would leak it.
	writeFile(path.join(tempDir, ".ompk", "AGENTS.md"), "# DECOY above repo root\n");

	for (const cwd of cwdForms(subPkg)) {
		clearCache();
		const result = await loadCapability<ContextFile>(contextFileCapability.id, { cwd });
		expect(result.all.some(f => f.content.includes("DECOY above repo root"))).toBe(false);
	}
});

test("repo AGENTS.md is found from non-canonical cwd forms", async () => {
	writeFile(path.join(project, ".ompk", "AGENTS.md"), "# canonical repo agents\n");

	for (const cwd of cwdForms(subPkg)) {
		clearCache();
		const result = await loadCapability<ContextFile>(contextFileCapability.id, { cwd });
		const found = result.items.find(f => f.content.includes("canonical repo agents"));
		expect(found).toBeDefined();
		expect(found?.level).toBe("project");
	}
});
