import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { buildSessionContext } from "@oh-my-pi/pi-coding-agent/session/session-context";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";

const tempDirs: TempDir[] = [];

function makeTempDir(prefix: string): string {
	const dir = TempDir.createSync(prefix);
	tempDirs.push(dir);
	return dir.path();
}

afterEach(async () => {
	await Promise.all(tempDirs.splice(0).map(dir => dir.remove()));
});

function readJsonl(file: string): Array<Record<string, unknown>> {
	return fs
		.readFileSync(file, "utf8")
		.trimEnd()
		.split("\n")
		.filter(Boolean)
		.map(line => JSON.parse(line) as Record<string, unknown>)
		.filter(entry => entry.type !== "title");
}

function tierEntries(file: string): Array<Record<string, unknown>> {
	return readJsonl(file).filter(entry => entry.type === "service_tier_change");
}

describe("service tier change persistence", () => {
	it("persists a legacy all-off change without an overrides field and reconstructs explicit-off overrides", async () => {
		const dir = makeTempDir("@omp-tier-persist-off-");
		const sessionFile = path.join(dir, "session.jsonl");
		const seeded = await SessionManager.open(sessionFile, dir);
		seeded.appendServiceTierChange(null);
		await seeded.ensureOnDisk();
		await seeded.close();

		const lines = tierEntries(sessionFile);
		expect(lines).toHaveLength(1);
		expect(lines[0]).not.toHaveProperty("overrides");

		const reloaded = await SessionManager.open(sessionFile, dir);
		try {
			const context = reloaded.buildSessionContext();
			expect(context.serviceTier).toBeUndefined();
			expect(context.serviceTierOverrides).toEqual({ openai: null, anthropic: null, google: null });
		} finally {
			await reloaded.close();
		}
	});

	it("reconstructs a legacy full-family snapshot as identical serviceTier and overrides", async () => {
		const dir = makeTempDir("@omp-tier-persist-full-");
		const sessionFile = path.join(dir, "session.jsonl");
		const seeded = await SessionManager.open(sessionFile, dir);
		seeded.appendServiceTierChange({ openai: "priority", anthropic: "priority", google: "flex" });
		await seeded.ensureOnDisk();
		await seeded.close();

		const reloaded = await SessionManager.open(sessionFile, dir);
		try {
			const context = reloaded.buildSessionContext();
			const snapshot = { openai: "priority", anthropic: "priority", google: "flex" } as const;
			expect(context.serviceTier).toEqual(snapshot);
			expect(context.serviceTierOverrides).toEqual(snapshot);
		} finally {
			await reloaded.close();
		}
	});

	it("lists absent families as explicit off when converting a legacy partial snapshot", async () => {
		const dir = makeTempDir("@omp-tier-persist-partial-");
		const sessionFile = path.join(dir, "session.jsonl");
		const seeded = await SessionManager.open(sessionFile, dir);
		seeded.appendServiceTierChange({ openai: "priority" });
		await seeded.ensureOnDisk();
		await seeded.close();

		const reloaded = await SessionManager.open(sessionFile, dir);
		try {
			const context = reloaded.buildSessionContext();
			expect(context.serviceTier).toEqual({ openai: "priority" });
			expect(context.serviceTierOverrides).toEqual({ openai: "priority", anthropic: null, google: null });
		} finally {
			await reloaded.close();
		}
	});

	it("expands a legacy scalar priority snapshot into full-family overrides after reload", async () => {
		const dir = makeTempDir("@omp-tier-persist-scalar-priority-");
		const sessionFile = path.join(dir, "session.jsonl");
		const timestamp = new Date().toISOString();
		const lines = [
			{ type: "session", version: 3, id: "scalar-priority", timestamp, cwd: dir },
			{ type: "service_tier_change", id: "t1", parentId: null, timestamp, serviceTier: "priority" },
		];
		await Bun.write(sessionFile, lines.map(line => JSON.stringify(line)).join("\n") + "\n");

		const reloaded = await SessionManager.open(sessionFile, dir);
		try {
			const context = reloaded.buildSessionContext();
			const full = { openai: "priority", anthropic: "priority", google: "priority" } as const;
			expect(context.serviceTier).toEqual(full);
			expect(context.serviceTierOverrides).toEqual(full);
		} finally {
			await reloaded.close();
		}
	});

	it("expands a legacy openai-only scalar with absent families explicit off after reload", async () => {
		const dir = makeTempDir("@omp-tier-persist-scalar-openai-");
		const sessionFile = path.join(dir, "session.jsonl");
		const timestamp = new Date().toISOString();
		const lines = [
			{ type: "session", version: 3, id: "scalar-openai-only", timestamp, cwd: dir },
			{ type: "service_tier_change", id: "t1", parentId: null, timestamp, serviceTier: "openai-only" },
		];
		await Bun.write(sessionFile, lines.map(line => JSON.stringify(line)).join("\n") + "\n");

		const reloaded = await SessionManager.open(sessionFile, dir);
		try {
			const context = reloaded.buildSessionContext();
			expect(context.serviceTier).toEqual({ openai: "priority" });
			expect(context.serviceTierOverrides).toEqual({ openai: "priority", anthropic: null, google: null });
		} finally {
			await reloaded.close();
		}
	});

	it("persists a new-format clearing record as an empty overrides object", async () => {
		const dir = makeTempDir("@omp-tier-persist-clear-");
		const sessionFile = path.join(dir, "session.jsonl");
		const seeded = await SessionManager.open(sessionFile, dir);
		seeded.appendServiceTierChange(null, {});
		await seeded.ensureOnDisk();
		await seeded.close();

		const lines = tierEntries(sessionFile);
		expect(lines).toHaveLength(1);
		expect(lines[0]).toEqual(expect.objectContaining({ serviceTier: null, overrides: {} }));

		const reloaded = await SessionManager.open(sessionFile, dir);
		try {
			const context = reloaded.buildSessionContext();
			expect(context.serviceTier).toBeUndefined();
			expect(context.serviceTierOverrides).toEqual({});
		} finally {
			await reloaded.close();
		}
	});

	it("persists per-family selections including explicit off, keeping the effective snapshot", async () => {
		const dir = makeTempDir("@omp-tier-persist-select-");
		const sessionFile = path.join(dir, "session.jsonl");
		const seeded = await SessionManager.open(sessionFile, dir);
		seeded.appendServiceTierChange({ openai: "flex" }, { openai: "flex", anthropic: null });
		await seeded.ensureOnDisk();
		await seeded.close();

		const lines = tierEntries(sessionFile);
		expect(lines).toHaveLength(1);
		expect(lines[0]).toEqual(
			expect.objectContaining({
				serviceTier: { openai: "flex" },
				overrides: { openai: "flex", anthropic: null },
			}),
		);

		const reloaded = await SessionManager.open(sessionFile, dir);
		try {
			const context = reloaded.buildSessionContext();
			expect(context.serviceTier).toEqual({ openai: "flex" });
			expect(context.serviceTierOverrides).toEqual({ openai: "flex", anthropic: null });
		} finally {
			await reloaded.close();
		}
	});

	it("reconstructs overrides from the selected branch path after reload", async () => {
		const dir = makeTempDir("@omp-tier-persist-branch-");
		const sessionFile = path.join(dir, "session.jsonl");
		const seeded = await SessionManager.open(sessionFile, dir);
		const flexId = seeded.appendServiceTierChange({ openai: "flex" }, { openai: "flex" });
		const clearedId = seeded.appendServiceTierChange({ openai: "flex" }, { openai: null, anthropic: "priority" });
		await seeded.ensureOnDisk();
		await seeded.close();

		const reloaded = await SessionManager.open(sessionFile, dir);
		try {
			const entries = reloaded.getEntries();
			const byLeaf = (leafId: string) => buildSessionContext(entries, leafId);

			expect(byLeaf(flexId).serviceTierOverrides).toEqual({ openai: "flex" });
			expect(byLeaf(clearedId).serviceTierOverrides).toEqual({ openai: null, anthropic: "priority" });
			// The legacy effective snapshot is preserved verbatim for old readers
			// even when the override selection disagrees with it.
			expect(byLeaf(clearedId).serviceTier).toEqual({ openai: "flex" });
			expect(reloaded.buildSessionContext().serviceTierOverrides).toEqual({ openai: null, anthropic: "priority" });
		} finally {
			await reloaded.close();
		}
	});

	it("degrades corrupt persisted overrides safely instead of trusting them", async () => {
		const dir = makeTempDir("@omp-tier-persist-corrupt-");
		const sessionFile = path.join(dir, "session.jsonl");
		const timestamp = new Date().toISOString();
		const lines = [
			{ type: "session", version: 3, id: "corr", timestamp, cwd: dir },
			{
				// Non-object overrides: ignored, the legacy snapshot governs.
				type: "service_tier_change",
				id: "t1",
				parentId: null,
				timestamp,
				serviceTier: { openai: "priority" },
				overrides: "priority",
			},
			{
				// Junk members and unknown families are dropped, valid ones kept.
				type: "service_tier_change",
				id: "t2",
				parentId: "t1",
				timestamp,
				serviceTier: {},
				overrides: { openai: 42, bogus: "flex", anthropic: "priority", google: null },
			},
			{
				// Absent both fields: no tier information either way.
				type: "service_tier_change",
				id: "t3",
				parentId: "t2",
				timestamp,
			},
		];
		await Bun.write(sessionFile, lines.map(line => JSON.stringify(line)).join("\n") + "\n");

		const reloaded = await SessionManager.open(sessionFile, dir);
		try {
			const entries = reloaded.getEntries();
			const byLeaf = (leafId: string) => buildSessionContext(entries, leafId);

			expect(byLeaf("t1").serviceTierOverrides).toEqual({ openai: "priority", anthropic: null, google: null });
			expect(byLeaf("t2").serviceTierOverrides).toEqual({ anthropic: "priority", google: null });
			expect(byLeaf("t2").serviceTier).toBeUndefined();
			expect(byLeaf("t3").serviceTierOverrides).toBeUndefined();
			expect(byLeaf("t3").serviceTier).toBeUndefined();
		} finally {
			await reloaded.close();
		}
	});
});
