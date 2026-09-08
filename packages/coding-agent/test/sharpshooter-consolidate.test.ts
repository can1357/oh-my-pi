import { afterEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import * as ai from "@oh-my-pi/pi-ai";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import {
	renderSharpshooterSessions,
	runSharpshooterConsolidation,
} from "@oh-my-pi/pi-coding-agent/sharpshooter/consolidate";
import {
	readSharpshooterState,
	sharpshooterBankDir,
	sharpshooterMemoryFilePath,
	writeSharpshooterState,
} from "@oh-my-pi/pi-coding-agent/sharpshooter/paths";
import {
	appendSharpshooterDelta,
	listSharpshooterDeltas,
	type SharpshooterSessionDeltas,
} from "@oh-my-pi/pi-coding-agent/sharpshooter/queue";
import type { SharpshooterDelta } from "@oh-my-pi/pi-coding-agent/sharpshooter/types";
import { TempDir } from "@oh-my-pi/pi-utils";
import { createInMemoryAuthStorage } from "./helpers/agent-session-setup";

interface Harness {
	agentDir: string;
	cwd: string;
	settings: Settings;
	modelRegistry: ModelRegistry;
	sessionId: string;
}

function createHarness(root: string): Harness {
	const agentDir = path.join(root, "agent");
	const cwd = path.join(root, "project");
	const authStorage = createInMemoryAuthStorage();
	authStorage.setRuntimeApiKey("anthropic", "test-key");
	const modelRegistry = new ModelRegistry(authStorage, path.join(root, "models.yml"));
	if (!modelRegistry.find("anthropic", "claude-haiku-4-5")) {
		throw new Error("Expected bundled anthropic/claude-haiku-4-5 model");
	}
	return {
		agentDir,
		cwd,
		settings: Settings.isolated({
			"sharpshooter.model": "anthropic/claude-haiku-4-5",
			"sharpshooter.intervalMinutes": 5,
		}),
		modelRegistry,
		sessionId: "01900000-0000-7000-8000-000000000001",
	};
}

function delta(
	sessionId: string,
	ts: number,
	statement: string,
	overrides: Partial<SharpshooterDelta> = {},
): SharpshooterDelta {
	return {
		v: 1,
		kind: "architecture_decision",
		statement,
		source: "explicit_user",
		evidence: statement,
		friction: { corrective: false, regression: false, subtle: true },
		sessionId,
		ts,
		...overrides,
	};
}

function completion(files: Array<{ name: string; content: string }>): ai.AssistantMessage {
	return {
		role: "assistant",
		api: "openai-completions",
		provider: "test",
		model: "claude-haiku-4-5",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		timestamp: Date.now(),
		stopReason: "toolUse",
		content: [
			{
				type: "toolCall",
				id: "replace-1",
				name: "replace_memory_files",
				arguments: { files },
			},
		],
	};
}

const completeFiles = [
	{ name: "architecture.md", content: "# Architecture\n\n- Keep boundaries explicit." },
	{ name: "product.md", content: "# Product\n\n- Prefer the direct workflow." },
	{ name: "style.md", content: "# Style\n\n- Use restrained contrast." },
];

afterEach(() => {
	vi.restoreAllMocks();
});

describe("runSharpshooterConsolidation", () => {
	it("short-circuits while not due and force bypasses the due check", async () => {
		using temp = TempDir.createSync("@pi-sharpshooter-not-due-");
		const harness = createHarness(temp.path());
		await appendSharpshooterDelta(harness.agentDir, harness.cwd, delta("session-a", 1, "Keep one boundary."));
		await writeSharpshooterState(harness.agentDir, harness.cwd, {
			v: 1,
			lastConsolidatedAt: Date.now(),
		});
		const completeSpy = vi.spyOn(ai, "completeSimple").mockResolvedValue(completion(completeFiles));

		const skipped = await runSharpshooterConsolidation(harness);
		expect(skipped).toEqual({ ran: false, reason: "not_due" });
		expect(completeSpy).not.toHaveBeenCalled();

		const forced = await runSharpshooterConsolidation({ ...harness, force: true });
		expect(forced).toEqual({ ran: true, sessions: 1, deltas: 1 });
		expect(completeSpy).toHaveBeenCalledTimes(1);
	});

	it("stamps an empty queue without calling the model", async () => {
		using temp = TempDir.createSync("@pi-sharpshooter-empty-");
		const harness = createHarness(temp.path());
		const before = Date.now();
		const completeSpy = vi.spyOn(ai, "completeSimple");

		const result = await runSharpshooterConsolidation({ ...harness, force: true });
		const state = await readSharpshooterState(harness.agentDir, harness.cwd);

		expect(result).toEqual({ ran: false, reason: "empty" });
		expect(completeSpy).not.toHaveBeenCalled();
		expect(state.lastConsolidatedAt).toBeGreaterThanOrEqual(before);
	});

	it("writes all returned files, consumes only the listed deltas, and records the result", async () => {
		using temp = TempDir.createSync("@pi-sharpshooter-happy-");
		const harness = createHarness(temp.path());
		await appendSharpshooterDelta(harness.agentDir, harness.cwd, delta("session-a", 10, "Keep one boundary."));
		await appendSharpshooterDelta(
			harness.agentDir,
			harness.cwd,
			delta("session-b", 20, "Keep the product direct.", { kind: "product_decision" }),
		);
		const listed = await listSharpshooterDeltas(harness.agentDir, harness.cwd);
		const listedFiles = listed.flatMap(group => group.deltas.map(item => item.file));
		vi.spyOn(ai, "completeSimple").mockImplementation(async () => {
			await appendSharpshooterDelta(harness.agentDir, harness.cwd, delta("session-a", 30, "Late arrival."));
			return completion(completeFiles);
		});

		const result = await runSharpshooterConsolidation({ ...harness, force: true });

		expect(result).toEqual({ ran: true, sessions: 2, deltas: 2 });
		for (const file of completeFiles) {
			expect(await Bun.file(sharpshooterMemoryFilePath(harness.agentDir, harness.cwd, file.name)).text()).toBe(
				file.content,
			);
		}
		for (const file of listedFiles) expect(await Bun.file(file).exists()).toBe(false);
		const remaining = await listSharpshooterDeltas(harness.agentDir, harness.cwd);
		expect(remaining).toHaveLength(1);
		expect(remaining[0]?.deltas.map(item => item.delta.statement)).toEqual(["Late arrival."]);
		const state = await readSharpshooterState(harness.agentDir, harness.cwd);
		expect(state.lastResult).toMatchObject({ sessions: 2, deltas: 2, model: "claude-haiku-4-5" });
		expect(state.lastResult?.at).toBe(state.lastConsolidatedAt);
	});

	it("rejects an over-budget file without consuming deltas or changing memory files", async () => {
		using temp = TempDir.createSync("@pi-sharpshooter-budget-");
		const harness = createHarness(temp.path());
		await appendSharpshooterDelta(harness.agentDir, harness.cwd, delta("session-a", 1, "Keep one boundary."));
		const bankDir = sharpshooterBankDir(harness.agentDir, harness.cwd);
		await Bun.write(path.join(bankDir, "architecture.md"), "old architecture");
		await Bun.write(path.join(bankDir, "product.md"), "old product");
		await Bun.write(path.join(bankDir, "style.md"), "old style");
		vi.spyOn(ai, "completeSimple").mockResolvedValue(
			completion([
				{ name: "architecture.md", content: Array.from({ length: 121 }, (_, index) => `line ${index}`).join("\n") },
				{ name: "product.md", content: "new product" },
				{ name: "style.md", content: "new style" },
			]),
		);

		const result = await runSharpshooterConsolidation({ ...harness, force: true });

		expect(result.ran).toBe(false);
		expect(result.reason).toBe("error");
		expect(result.error).toContain("120-line limit");
		expect(await Bun.file(path.join(bankDir, "architecture.md")).text()).toBe("old architecture");
		expect(await Bun.file(path.join(bankDir, "product.md")).text()).toBe("old product");
		expect(await Bun.file(path.join(bankDir, "style.md")).text()).toBe("old style");
		expect(await listSharpshooterDeltas(harness.agentDir, harness.cwd)).toHaveLength(1);
		const state = await readSharpshooterState(harness.agentDir, harness.cwd);
		expect(state.lastError?.message).toContain("120-line limit");
	});

	it("rejects an all-empty replacement without consuming deltas or wiping memory files", async () => {
		using temp = TempDir.createSync("@pi-sharpshooter-empty-wipe-");
		const harness = createHarness(temp.path());
		await appendSharpshooterDelta(harness.agentDir, harness.cwd, delta("session-a", 1, "Keep one boundary."));
		const bankDir = sharpshooterBankDir(harness.agentDir, harness.cwd);
		await Bun.write(path.join(bankDir, "architecture.md"), "old architecture");
		await Bun.write(path.join(bankDir, "product.md"), "old product");
		await Bun.write(path.join(bankDir, "style.md"), "old style");
		vi.spyOn(ai, "completeSimple").mockResolvedValue(
			completion([
				{ name: "architecture.md", content: "" },
				{ name: "product.md", content: "   \n\t " },
				{ name: "style.md", content: "" },
			]),
		);

		const result = await runSharpshooterConsolidation({ ...harness, force: true });

		expect(result.ran).toBe(false);
		expect(result.reason).toBe("error");
		expect(result.error).toContain("all-empty");
		expect(await Bun.file(path.join(bankDir, "architecture.md")).text()).toBe("old architecture");
		expect(await Bun.file(path.join(bankDir, "product.md")).text()).toBe("old product");
		expect(await Bun.file(path.join(bankDir, "style.md")).text()).toBe("old style");
		expect(await listSharpshooterDeltas(harness.agentDir, harness.cwd)).toHaveLength(1);
		const state = await readSharpshooterState(harness.agentDir, harness.cwd);
		expect(state.lastError?.message).toContain("all-empty");
	});

	it("accepts an all-empty replacement when the current memory files are already empty", async () => {
		using temp = TempDir.createSync("@pi-sharpshooter-empty-noop-");
		const harness = createHarness(temp.path());
		await appendSharpshooterDelta(
			harness.agentDir,
			harness.cwd,
			delta("session-a", 1, "One-shot decision.", {
				friction: { corrective: false, regression: false, subtle: false },
			}),
		);
		vi.spyOn(ai, "completeSimple").mockResolvedValue(
			completion([
				{ name: "architecture.md", content: "" },
				{ name: "product.md", content: "" },
				{ name: "style.md", content: "" },
			]),
		);

		const result = await runSharpshooterConsolidation({ ...harness, force: true });

		expect(result).toEqual({ ran: true, sessions: 1, deltas: 1 });
		expect(await listSharpshooterDeltas(harness.agentDir, harness.cwd)).toHaveLength(0);
		const state = await readSharpshooterState(harness.agentDir, harness.cwd);
		expect(state.lastConsolidatedAt).toBeGreaterThan(0);
		expect(state.lastError).toBeUndefined();
	});
});

describe("renderSharpshooterSessions", () => {
	it("orders sessions and deltas chronologically and includes every consolidation field", () => {
		const groups: SharpshooterSessionDeltas[] = [
			{
				sessionId: "later",
				deltas: [
					{ delta: delta("later", 30, "Third."), file: "/queue/third" },
					{
						delta: delta("later", 20, "Second.", {
							kind: "rejected_approach",
							evidence: 'Use "B".',
							rejectedAlternative: "A",
							rationale: "B avoids drift",
							friction: { corrective: true, regression: true, subtle: false },
						}),
						file: "/queue/second",
					},
				],
			},
			{
				sessionId: "earlier",
				deltas: [{ delta: delta("earlier", 10, "First."), file: "/queue/first" }],
			},
		];

		const rendered = renderSharpshooterSessions(groups);

		expect(rendered.indexOf("### session earlier")).toBeLessThan(rendered.indexOf("### session later"));
		expect(rendered.indexOf('statement="Second."')).toBeLessThan(rendered.indexOf('statement="Third."'));
		expect(rendered).toContain("kind=rejected_approach");
		expect(rendered).toContain('evidence="Use \\"B\\"."');
		expect(rendered).toContain("friction(corrective=true, regression=true, subtle=false)");
		expect(rendered).toContain('rejectedAlternative="A"');
		expect(rendered).toContain('rationale="B avoids drift"');
	});
});
