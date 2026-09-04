/**
 * A/B caller-root resolution contracts for the internal URL tools.
 *
 * Two top-level roots (A and B) both contain a same-named parked `Worker`
 * (transcript + `.md` output). The process-global registry's single `Main`
 * ref belongs to B, and B's roster scan ran first, so every global-first
 * lookup points at B. When a session rooted in A resolves `history://Worker`
 * or `agent://Worker` through the tool paths — grep, find, and bash URL
 * expansion — the caller's own root must win:
 *
 * - `history://Worker` serves A's transcript (roster refresh per caller root),
 * - `agent://Worker` scans A's canonical artifact directory first,
 * - repeated caller resolutions reuse the settled roster latch (no re-scans),
 * - a caller root with no artifacts falls back gracefully to the global scan,
 * - no caller session file keeps the pre-existing global behavior.
 */
import { afterEach, beforeEach, describe, expect, it, spyOn, vi } from "bun:test";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { InternalUrlRouter } from "@oh-my-pi/pi-coding-agent/internal-urls";
import { resetRegisteredArtifactDirsForTests } from "@oh-my-pi/pi-coding-agent/internal-urls/registry-helpers";
import { AgentRegistry, MAIN_AGENT_ID } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { ensurePersistedRoster } from "@oh-my-pi/pi-coding-agent/registry/persisted-agents";
import { CURRENT_SESSION_VERSION } from "@oh-my-pi/pi-coding-agent/session/session-entries";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { expandInternalUrls } from "@oh-my-pi/pi-coding-agent/tools/bash-skill-urls";
import { GlobTool } from "@oh-my-pi/pi-coding-agent/tools/glob";
import { GrepTool } from "@oh-my-pi/pi-coding-agent/tools/grep";

function sessionHeader(id: string): string {
	return JSON.stringify({
		type: "session",
		version: CURRENT_SESSION_VERSION,
		id,
		timestamp: "2026-08-13T17:14:48.125Z",
		cwd: "/tmp",
	});
}

/** Transcript with a distinguishable user line: header + session_init + message. */
async function writeTranscriptWithLine(sessionFile: string, id: string, secret: string): Promise<void> {
	await Bun.write(
		sessionFile,
		`${[
			sessionHeader(id),
			JSON.stringify({
				type: "session_init",
				id: `si-${id}`,
				parentId: null,
				timestamp: "2026-08-13T17:14:49.000Z",
				systemPrompt: "review",
				task: `task-${secret}`,
				tools: ["read"],
			}),
			JSON.stringify({
				type: "message",
				id: `m-${id}`,
				parentId: null,
				timestamp: "2026-08-13T17:14:50.000Z",
				message: { role: "user", content: `secret-${secret}-line`, timestamp: 1 },
			}),
		].join("\n")}\n`,
	);
}

/** Directory a roster scan reads for a root (`<sessionFile>` minus `.jsonl`). */
function scanDir(sessionFile: string): string {
	return sessionFile.slice(0, -".jsonl".length);
}

function countReaddirs(readdirs: string[], dir: string): number {
	return readdirs.filter(target => target === dir).length;
}

/** Spy on `fs.promises.readdir` (the binding the roster scan uses), recording each scanned directory. */
function spyOnReaddirs(readdirs: string[]): void {
	const realReaddir = fs.promises.readdir;
	spyOn(fs.promises, "readdir").mockImplementation((async (target: fs.PathLike) => {
		readdirs.push(String(target));
		return realReaddir(target, { withFileTypes: true });
	}) as unknown as typeof fs.promises.readdir);
}

function makeSession(cwd: string, sessionFile: string | null = null): ToolSession {
	return {
		cwd,
		hasUI: false,
		getSessionFile: () => sessionFile,
		getSessionSpawns: () => "*",
		settings: Settings.isolated({ "grep.contextBefore": 0, "grep.contextAfter": 0 }),
	};
}

function getResultText(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content
		.filter(c => c.type === "text")
		.map(c => c.text ?? "")
		.join("\n");
}

/**
 * Lay out the A/B trees: both roots hold a same-named `Worker`. The caller's
 * session file is `rootA` unless a test overrides it.
 */
async function setupAbRoots(
	dir: string,
): Promise<{ rootA: string; rootB: string; childA: string; childB: string; artifactA: string; artifactB: string }> {
	const rootA = path.join(dir, "a", "main.jsonl");
	const rootB = path.join(dir, "b", "main.jsonl");
	const childA = path.join(dir, "a", "main", "Worker.jsonl");
	const childB = path.join(dir, "b", "main", "Worker.jsonl");
	const artifactA = path.join(dir, "a", "main", "Worker.md");
	const artifactB = path.join(dir, "b", "main", "Worker.md");
	await Bun.write(rootA, `${sessionHeader("a")}\n`);
	await Bun.write(rootB, `${sessionHeader("b")}\n`);
	await writeTranscriptWithLine(childA, "worker", "A");
	await writeTranscriptWithLine(childB, "worker", "B");
	await Bun.write(artifactA, "A OUTPUT");
	await Bun.write(artifactB, "B OUTPUT");
	return { rootA, rootB, childA, childB, artifactA, artifactB };
}

/** Install the A/B trap: B's roster scan ran first AND the global Main ref is B. */
async function installGlobalMainB(registry: AgentRegistry, rootB: string): Promise<void> {
	await ensurePersistedRoster(registry, rootB);
	registry.register({
		id: MAIN_AGENT_ID,
		displayName: MAIN_AGENT_ID,
		kind: "main",
		session: null,
		sessionFile: rootB,
		status: "running",
	});
}

describe("internal URL tools resolve against the caller root (A/B same ids)", () => {
	let dir: string;
	let readdirs: string[];
	let rootA: string;
	let rootB: string;
	let childA: string;
	let childB: string;
	let artifactA: string;
	let artifactB: string;

	beforeEach(async () => {
		AgentRegistry.resetGlobalForTests();
		InternalUrlRouter.resetForTests();
		resetRegisteredArtifactDirsForTests();
		dir = path.join(await fsp.mkdtemp(path.join(os.tmpdir(), "caller-root-ab-")));
		({ rootA, rootB, childA, childB, artifactA, artifactB } = await setupAbRoots(dir));
		readdirs = [];
		spyOnReaddirs(readdirs);
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		AgentRegistry.resetGlobalForTests();
		InternalUrlRouter.resetForTests();
		resetRegisteredArtifactDirsForTests();
		await fsp.rm(dir, { recursive: true, force: true });
	});

	it("grep history://Worker serves the caller root's transcript when the global Main is the other root", async () => {
		const registry = AgentRegistry.global();
		await installGlobalMainB(registry, rootB);
		expect(registry.get("Worker")?.sessionFile).toBe(childB);

		const tool = new GrepTool(makeSession(dir, rootA));
		const result = await tool.execute("grep-history-a", { pattern: "secret-A-line", path: "history://Worker" });
		const text = getResultText(result);
		expect(text).toContain("secret-A-line");
		expect(text).not.toContain("secret-B-line");
		expect(registry.get("Worker")?.sessionFile).toBe(childA);

		// A settled roster latch: the second resolution reuses it — no re-scan.
		const again = await tool.execute("grep-history-a-again", { pattern: "secret-A-line", path: "history://Worker" });
		expect(getResultText(again)).toContain("secret-A-line");
		// agent:// from the same caller shares the settled latch too.
		const agent = await tool.execute("grep-agent-a", { pattern: "A OUTPUT", path: "agent://Worker" });
		expect(getResultText(agent)).toContain("A OUTPUT");
		expect(getResultText(agent)).not.toContain("B OUTPUT");
		expect(countReaddirs(readdirs, scanDir(rootA))).toBe(1);
		expect(countReaddirs(readdirs, scanDir(rootB))).toBe(1);
	});

	it("grep agent://Worker serves the caller root's output artifact when the global Main is the other root", async () => {
		const registry = AgentRegistry.global();
		await installGlobalMainB(registry, rootB);

		const tool = new GrepTool(makeSession(dir, rootA));
		const result = await tool.execute("grep-agent-a", { pattern: "A OUTPUT", path: "agent://Worker" });
		expect(getResultText(result)).toContain("A OUTPUT");
		expect(getResultText(result)).not.toContain("B OUTPUT");
	});

	it("find history://Worker resolves the caller root's transcript file when the global Main is the other root", async () => {
		const registry = AgentRegistry.global();
		await installGlobalMainB(registry, rootB);

		const tool = new GlobTool(makeSession(dir, rootA));
		const result = await tool.execute("find-history-a", { path: "history://Worker" });
		const text = getResultText(result);
		expect(text).toContain("# a/main/");
		expect(text).toContain("Worker.jsonl");
		expect(text).not.toContain("# b/main/");
	});

	it("bash agent:// expansion resolves the caller root's output path when the global Main is the other root", async () => {
		const registry = AgentRegistry.global();
		await installGlobalMainB(registry, rootB);

		const expanded = await expandInternalUrls("cat agent://Worker", {
			skills: [],
			internalRouter: InternalUrlRouter.instance(),
			cwd: dir,
			sessionFile: rootA,
		});
		expect(expanded).toContain(artifactA);
		expect(expanded).not.toContain(artifactB);

		// No caller session file: keep the pre-existing global behavior (B's
		// Main-owned dir wins) instead of guessing a caller root.
		const noSession = await expandInternalUrls("cat agent://Worker", {
			skills: [],
			internalRouter: InternalUrlRouter.instance(),
			cwd: dir,
		});
		expect(noSession).toContain(artifactB);
		expect(noSession).not.toContain(artifactA);
	});

	it("switching the caller root switches which root's history and agent output win", async () => {
		const registry = AgentRegistry.global();
		await installGlobalMainB(registry, rootB);

		// Caller A: A's refs replace B's and A's output wins.
		const toolA = new GrepTool(makeSession(dir, rootA));
		const aHistory = await toolA.execute("grep-history-a", { pattern: "secret-A-line", path: "history://Worker" });
		expect(getResultText(aHistory)).toContain("secret-A-line");
		expect(getResultText(aHistory)).not.toContain("secret-B-line");
		const aAgent = await toolA.execute("grep-agent-a", { pattern: "A OUTPUT", path: "agent://Worker" });
		expect(getResultText(aAgent)).toContain("A OUTPUT");

		// Caller B: A's re-scan superseded B's latch, so B re-scans exactly
		// once and B's transcript + output win again.
		const toolB = new GrepTool(makeSession(dir, rootB));
		const bHistory = await toolB.execute("grep-history-b", { pattern: "secret-B-line", path: "history://Worker" });
		expect(getResultText(bHistory)).toContain("secret-B-line");
		expect(getResultText(bHistory)).not.toContain("secret-A-line");
		expect(registry.get("Worker")?.sessionFile).toBe(childB);
		const bAgent = await toolB.execute("grep-agent-b", { pattern: "B OUTPUT", path: "agent://Worker" });
		expect(getResultText(bAgent)).toContain("B OUTPUT");
		expect(getResultText(bAgent)).not.toContain("A OUTPUT");

		expect(countReaddirs(readdirs, scanDir(rootA))).toBe(1);
		expect(countReaddirs(readdirs, scanDir(rootB))).toBe(2);
	});

	it("a caller root with no artifacts falls back gracefully to the global registry", async () => {
		const registry = AgentRegistry.global();
		await installGlobalMainB(registry, rootB);

		// Caller C's session file points at a root whose artifacts dir was
		// never created: nothing caller-specific exists, so resolution must
		// not crash and keeps serving the global best effort (B's refs).
		const rootC = path.join(dir, "c", "main.jsonl");
		const tool = new GrepTool(makeSession(dir, rootC));
		const history = await tool.execute("grep-history-c", { pattern: "secret-B-line", path: "history://Worker" });
		expect(getResultText(history)).toContain("secret-B-line");
		const agent = await tool.execute("grep-agent-c", { pattern: "B OUTPUT", path: "agent://Worker" });
		expect(getResultText(agent)).toContain("B OUTPUT");
	});

	it("agent://Worker/<field> pairs the sidecar with the SAME root as the matched Worker.md", async () => {
		const registry = AgentRegistry.global();
		await installGlobalMainB(registry, rootB);

		// Root A has no sidecar; root B has one with a different payload. A's
		// caller must never answer with B's sidecar.
		await fsp.writeFile(path.join(dir, "a", "main", "Worker.md"), JSON.stringify({ count: 1 }));
		await fsp.writeFile(path.join(dir, "b", "main", "Worker.md"), JSON.stringify({ count: 2 }));
		await fsp.writeFile(path.join(dir, "b", "main", "Worker.json"), JSON.stringify({ count: 2 }));

		const router = InternalUrlRouter.instance();
		const resource = await router.resolve("agent://Worker/count", { sessionFile: rootA });
		expect(JSON.parse(resource.content)).toBe(1);
		expect(resource.sourcePath?.endsWith(path.join("a", "main", "Worker.md"))).toBe(true);
	});
});
