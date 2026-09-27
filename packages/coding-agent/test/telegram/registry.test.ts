/**
 * Topic registry contract: the mapping survives restarts, names stay unique
 * among open sessions, and a damaged file is refused instead of replaced.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { TopicRegistryError, openTopicRegistry } from "@oh-my-pi/pi-coding-agent/telegram/registry";
import type { TopicEntry, TopicEntryDraft } from "@oh-my-pi/pi-coding-agent/telegram/types";

let dir = "";

beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "telegram-registry-"));
});

afterEach(() => {
	fs.rmSync(dir, { recursive: true, force: true });
});

const file = (): string => path.join(dir, "registry.json");

const entry = (overrides: Partial<TopicEntryDraft> = {}): TopicEntryDraft => ({
	threadId: 7,
	name: "Fix the gate",
	cwd: "/home/dev/code/project",
	sessionFile: "/state/7.jsonl",
	sessionId: "7",
	status: "running",
	...overrides,
});

describe("topic registry", () => {
	it("keeps the writable record across a reopen and reports its own path", async () => {
		const clock = { now: () => 1_700_000_000_000 };
		const registry = openTopicRegistry({ path: file(), clock });
		registry.put(entry());
		await registry.flush();
		const reopened = openTopicRegistry({ path: file(), clock });
		expect(reopened.get(7)).toEqual({ ...entry(), createdAt: 1_700_000_000_000, updatedAt: 1_700_000_000_000 });
		expect(reopened.list()).toHaveLength(1);
		expect(reopened.path).toBe(file());
	});

	it("rejects a duplicate name while the holder is open and frees it once closed", () => {
		const registry = openTopicRegistry({ path: file() });
		registry.put(entry({ threadId: 1, name: "Agent" }));
		let thrown: unknown;
		try {
			registry.put(entry({ threadId: 2, name: "agent" }));
		} catch (error) {
			thrown = error;
		}
		expect(thrown).toBeInstanceOf(TopicRegistryError);
		expect((thrown as TopicRegistryError).reason).toBe("name_taken");
		expect(registry.list()).toHaveLength(1);
		registry.update(1, { status: "closed" });
		registry.put(entry({ threadId: 2, name: "Agent" }));
		expect(registry.list()).toHaveLength(2);
		expect(registry.byName("agent")?.threadId).toBe(2);
	});

	it("matches names case-insensitively and prefers the open entry", () => {
		const registry = openTopicRegistry({ path: file() });
		registry.put(entry({ threadId: 1, name: "Review", status: "closed" }));
		registry.put(entry({ threadId: 2, name: "Review" }));
		expect(registry.byName("rEvIeW")?.threadId).toBe(2);
		expect(registry.byName("nothing like it")).toBeNull();
		expect(registry.get(99)).toBeNull();
	});

	it("resolves an entry by its session file and nothing else", () => {
		const registry = openTopicRegistry({ path: file() });
		registry.put(entry({ threadId: 3, name: "Three", sessionFile: "/sessions/three.jsonl" }));
		expect(registry.bySessionFile("/sessions/three.jsonl")?.threadId).toBe(3);
		expect(registry.bySessionFile("/sessions/other.jsonl")).toBeNull();
		registry.put(entry({ threadId: 4, name: "Four", sessionFile: null }));
		expect(registry.bySessionFile("/sessions/three.jsonl")?.threadId).toBe(3);
	});

	it("stamps updatedAt from the injected clock and never rewrites createdAt", async () => {
		let now = 1_000;
		const registry = openTopicRegistry({ path: file(), clock: { now: () => now } });
		const first = registry.put(entry({ threadId: 1 }));
		expect(first.createdAt).toBe(1_000);
		expect(first.updatedAt).toBe(1_000);
		now = 2_000;
		const second = registry.update(1, { status: "idle" });
		expect(second.createdAt).toBe(1_000);
		expect(second.updatedAt).toBe(2_000);
		await registry.flush();
		expect(openTopicRegistry({ path: file(), clock: { now: () => now } }).get(1)?.updatedAt).toBe(2_000);
	});

	it("keeps no temporary file next to the registry and persists a readable array", async () => {
		const registry = openTopicRegistry({ path: file() });
		registry.put(entry({ threadId: 1, name: "Agent" }));
		registry.update(1, { status: "closed" });
		await registry.flush();
		expect(fs.readdirSync(dir)).toEqual(["registry.json"]);
		const stored: unknown = JSON.parse(fs.readFileSync(file(), "utf8"));
		expect(Array.isArray(stored)).toBe(true);
		expect((stored as TopicEntry[])[0]).toMatchObject({ threadId: 1, name: "Agent", status: "closed" });
	});

	it("applies a mutation in memory at once and only writes it on flush", async () => {
		const registry = openTopicRegistry({ path: file() });
		registry.put(entry({ threadId: 1, name: "Agent" }));
		expect(registry.get(1)?.name).toBe("Agent");
		expect(fs.existsSync(file())).toBe(false);
		await registry.flush();
		expect(fs.existsSync(file())).toBe(true);
	});

	it("writes the final state of a burst of mutations when it is flushed", async () => {
		const registry = openTopicRegistry({ path: file() });
		registry.put(entry({ threadId: 1, name: "Agent" }));
		for (let turn = 0; turn < 50; turn += 1) {
			registry.update(1, { status: turn % 2 === 0 ? "running" : "idle", tailOffset: turn });
		}
		await registry.flush();
		const stored = JSON.parse(fs.readFileSync(file(), "utf8")) as TopicEntry[];
		expect(stored).toHaveLength(1);
		expect(stored[0]).toMatchObject({ threadId: 1, name: "Agent", status: "idle", tailOffset: 49 });
	});

	it("surfaces a failed write through flush without failing the mutation", async () => {
		const registry = openTopicRegistry({ path: file() });
		registry.put(entry({ threadId: 1, name: "Agent" }));
		await registry.flush();
		// The state directory becomes a regular file: the queued write cannot land.
		fs.rmSync(dir, { recursive: true, force: true });
		fs.writeFileSync(dir, "not a directory");
		registry.update(1, { status: "closed" });
		expect(registry.get(1)?.status).toBe("closed");
		await expect(registry.flush()).rejects.toThrow();
		// Nothing has landed since: a later flush must not claim durability.
		await expect(registry.flush()).rejects.toThrow();
	});

	it("refuses a damaged file with a named error instead of starting empty", () => {
		fs.writeFileSync(file(), '{"sessions": [');
		expect(() => openTopicRegistry({ path: file() })).toThrow(TopicRegistryError);
		try {
			openTopicRegistry({ path: file() });
		} catch (error) {
			expect((error as TopicRegistryError).reason).toBe("broken_file");
			expect((error as Error).message).toContain("does not parse as JSON");
		}
		fs.writeFileSync(file(), '{"threadId": 1}');
		expect(() => openTopicRegistry({ path: file() })).toThrow(/not a session list/u);
		fs.writeFileSync(file(), '[{"name": "no thread"}]');
		expect(() => openTopicRegistry({ path: file() })).toThrow(/without a numeric threadId/u);
	});

	it("refuses an update of an unknown session and returns null for an unknown removal", () => {
		const registry = openTopicRegistry({ path: file() });
		try {
			registry.update(42, { status: "idle" });
			throw new Error("update should have thrown");
		} catch (error) {
			expect(error).toBeInstanceOf(TopicRegistryError);
			expect((error as TopicRegistryError).reason).toBe("unknown_thread");
		}
		expect(registry.remove(42)).toBeNull();
		registry.put(entry({ threadId: 1 }));
		expect(registry.remove(1)?.threadId).toBe(1);
		expect(registry.list()).toEqual([]);
	});

	it("keeps numeric thread ids numeric across a reopen", async () => {
		const registry = openTopicRegistry({ path: file() });
		registry.put(entry({ threadId: 7 }));
		expect(registry.get(7)?.threadId).toBe(7);
		await registry.flush();
		const again = openTopicRegistry({ path: file() });
		expect(again.get(7)?.name).toBe("Fix the gate");
		expect(typeof again.get(7)?.threadId).toBe("number");
	});

	it("refuses an entry without a name", () => {
		const registry = openTopicRegistry({ path: file() });
		try {
			registry.put(entry({ threadId: 1, name: "   " }));
			throw new Error("put should have thrown");
		} catch (error) {
			expect((error as TopicRegistryError).reason).toBe("no_name");
		}
	});

	it("hands out the first free name and never a name an open sibling holds", () => {
		const registry = openTopicRegistry({ path: file() });
		expect(registry.freeName("session")).toBe("session");
		registry.put(entry({ threadId: 1, name: "session" }));
		expect(registry.freeName("session")).toBe("session 2");
		registry.put(entry({ threadId: 2, name: "session 2" }));
		expect(registry.freeName("session")).toBe("session 3");
		registry.update(1, { status: "closed" });
		expect(registry.freeName("Review")).toBe("Review");
	});
});
