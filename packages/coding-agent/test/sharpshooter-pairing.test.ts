import { afterEach, describe, expect, it, spyOn, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { resolveMemoryBackend } from "@oh-my-pi/pi-coding-agent/memory-backend";
import type { MemoryBackend, MemoryBackendStartOptions } from "@oh-my-pi/pi-coding-agent/memory-backend/types";
import { withSharpshooter } from "@oh-my-pi/pi-coding-agent/memory-backend/with-sharpshooter";
import { mnemopiBackend } from "@oh-my-pi/pi-coding-agent/mnemopi/backend";
import { sharpshooterBackend } from "@oh-my-pi/pi-coding-agent/sharpshooter/backend";
import { sharpshooterBankDir } from "@oh-my-pi/pi-coding-agent/sharpshooter/paths";
import { TempDir } from "@oh-my-pi/pi-utils";

afterEach(() => {
	vi.restoreAllMocks();
});

/** Start options carrying a session, which the wrapper checks before registering. */
function startOptions(isDisposed = false): MemoryBackendStartOptions {
	return { session: { isDisposed } } as unknown as MemoryBackendStartOptions;
}

/** A store backend that records what the wrapper asked of it. */
function stubPrimary(calls: string[]): MemoryBackend {
	return {
		id: "mnemopi",
		start: () => {
			calls.push("start");
		},
		buildDeveloperInstructions: async () => "PRIMARY INSTRUCTIONS",
		clear: async () => {
			calls.push("clear");
		},
		enqueue: async () => {
			calls.push("enqueue");
		},
		status: async () => ({
			backend: "mnemopi" as const,
			active: true,
			writable: true,
			searchable: true,
			message: "primary status",
		}),
		search: async (_context, query) => ({
			backend: "mnemopi" as const,
			query,
			count: 1,
			items: [{ content: "primary hit" }],
		}),
		save: async () => ({ backend: "mnemopi" as const, stored: 1 }),
		beforeAgentStartPrompt: async () => ({ context: "PRIMARY TURN PROMPT", commit: () => true }),
		preCompactionContext: async () => "PRIMARY COMPACTION",
	};
}

describe("sharpshooter paired with a store backend", () => {
	it("leaves the backend alone when the flag is off", async () => {
		const settings = Settings.isolated({ "memory.backend": "mnemopi" });
		expect(await resolveMemoryBackend(settings)).toBe(mnemopiBackend);
	});

	it("wraps the selected backend when the flag is on", async () => {
		const settings = Settings.isolated({ "memory.backend": "mnemopi", "sharpshooter.enabled": true });
		const resolved = await resolveMemoryBackend(settings);
		expect(resolved).not.toBe(mnemopiBackend);
		// Tool gating reads memory.backend, and the id must keep agreeing with it.
		expect(resolved.id).toBe("mnemopi");
	});

	it("never wraps sharpshooter around itself", async () => {
		const settings = Settings.isolated({ "memory.backend": "sharpshooter", "sharpshooter.enabled": true });
		expect(await resolveMemoryBackend(settings)).toBe(sharpshooterBackend);
		// And with the flag off, so the resolver ignores it in both directions.
		const off = Settings.isolated({ "memory.backend": "sharpshooter", "sharpshooter.enabled": false });
		expect(await resolveMemoryBackend(off)).toBe(sharpshooterBackend);
	});

	it("pairs with the off backend without turning memory tools on", async () => {
		const settings = Settings.isolated({ "memory.backend": "off", "sharpshooter.enabled": true });
		const resolved = await resolveMemoryBackend(settings);
		expect(resolved.id).toBe("off");
	});

	it("injects both backends' instructions", async () => {
		using temp = TempDir.createSync("@pi-sharpshooter-pairing-");
		const root = temp.path();
		const agentDir = path.join(root, "agent");
		const cwd = path.join(root, "project");
		await fs.mkdir(cwd, { recursive: true });
		const settings = Settings.isolated({ "memory.backend": "mnemopi", "sharpshooter.enabled": true });
		await settings.reloadForCwd(cwd);
		const bankDir = sharpshooterBankDir(agentDir, cwd);
		await fs.mkdir(bankDir, { recursive: true });
		await Bun.write(path.join(bankDir, "architecture.md"), "- Keep storage project-scoped.\n");

		const paired = withSharpshooter(stubPrimary([]));
		const instructions = await paired.buildDeveloperInstructions(agentDir, settings);
		expect(instructions).toContain("PRIMARY INSTRUCTIONS");
		expect(instructions).toContain("Keep storage project-scoped.");
	});

	it("starts both backends and awaits them", async () => {
		const calls: string[] = [];
		const start = spyOn(sharpshooterBackend, "start").mockImplementation(() => {
			calls.push("sharpshooter start");
		});
		const paired = withSharpshooter(stubPrimary(calls));
		await paired.start(startOptions());
		// Sharpshooter registers first, before any await, so a caller that drops the
		// returned promise cannot dispose ahead of its registration.
		expect(calls).toEqual(["sharpshooter start", "start"]);
		expect(start).toHaveBeenCalled();
	});

	it("consolidates the selected backend without forcing a decision-file rewrite", async () => {
		const calls: string[] = [];
		const enqueue = spyOn(sharpshooterBackend, "enqueue").mockImplementation(async () => {
			calls.push("sharpshooter enqueue");
		});
		const paired = withSharpshooter(stubPrimary(calls));
		await paired.enqueue("/agent", "/cwd");
		// Forcing consolidation rewrites all three files whole, and a reply that
		// empties one of them passes the all-empty guard (#10200). An action aimed
		// at the store must not be able to trigger it.
		expect(calls).toEqual(["enqueue"]);
		expect(enqueue).not.toHaveBeenCalled();
	});

	it("runs the sharpshooter leg even when the selected backend throws", async () => {
		const seen: string[] = [];
		spyOn(sharpshooterBackend, "buildDeveloperInstructions").mockImplementation(async () => {
			seen.push("sharpshooter");
			return "SHARPSHOOTER RULES";
		});
		const failing: MemoryBackend = {
			...stubPrimary([]),
			buildDeveloperInstructions: async () => {
				throw new Error("instructions failed");
			},
		};
		const paired = withSharpshooter(failing);
		await expect(paired.buildDeveloperInstructions("/agent", {} as never)).rejects.toThrow("instructions failed");
		expect(seen).toEqual(["sharpshooter"]);
	});

	it("registers sharpshooter before yielding, so a discarded promise still starts it", () => {
		const calls: string[] = [];
		spyOn(sharpshooterBackend, "start").mockImplementation(() => {
			calls.push("sharpshooter start");
		});
		const slowPrimary: MemoryBackend = {
			...stubPrimary(calls),
			start: async () => {
				await Bun.sleep(20);
				calls.push("start");
			},
		};
		const paired = withSharpshooter(slowPrimary);
		// The SDK drops this promise on the floor. Sharpshooter must already be
		// registered by the time it does, or disposal can outrun its registration.
		void paired.start(startOptions());
		expect(calls).toEqual(["sharpshooter start"]);
	});

	it("does not register sharpshooter onto a session that is already disposed", async () => {
		const calls: string[] = [];
		const start = spyOn(sharpshooterBackend, "start").mockImplementation(() => {
			calls.push("sharpshooter start");
		});
		const paired = withSharpshooter(stubPrimary(calls));
		// resolveMemoryBackend awaits a cold backend import and the SDK discards this
		// promise, so disposal can run its unconditional release before start is
		// reached. Registering then leaves a subscription and a scheduler on a dead
		// session, and the scheduler ticks immediately.
		await paired.start(startOptions(true));

		expect(start).not.toHaveBeenCalled();
		expect(calls).toEqual(["start"]);
	});

	it("runs the sharpshooter leg for status and search when the primary throws", async () => {
		spyOn(sharpshooterBackend, "status").mockResolvedValue({
			backend: "sharpshooter",
			active: true,
			writable: false,
			searchable: true,
			message: "architecture.md: 3 lines",
		});
		const seen: string[] = [];
		spyOn(sharpshooterBackend, "search").mockImplementation(async () => {
			seen.push("sharpshooter search");
			return { backend: "sharpshooter", query: "q", count: 0, items: [] };
		});
		const failing: MemoryBackend = {
			...stubPrimary([]),
			status: async () => {
				throw new Error("status failed");
			},
			search: async () => {
				throw new Error("search failed");
			},
		};
		const paired = withSharpshooter(failing);
		await expect(paired.status?.({ agentDir: "/agent", cwd: "/cwd" })).rejects.toThrow("status failed");
		await expect(paired.search?.({ agentDir: "/agent", cwd: "/cwd" }, "q")).rejects.toThrow("search failed");
		expect(seen).toEqual(["sharpshooter search"]);
	});

	it("does not answer an aborted search with sharpshooter hits", async () => {
		// Sharpshooter reads three local files and can finish before a slower
		// primary notices the signal, so the abort lands between the two legs. A
		// result that says "Search aborted." and carries memories anyway is worse
		// than either honest answer.
		spyOn(sharpshooterBackend, "search").mockResolvedValue({
			backend: "sharpshooter",
			query: "deploy",
			count: 1,
			items: [{ content: "- Deploy through the script.", source: "architecture.md" }],
		});
		const controller = new AbortController();
		const aborting: MemoryBackend = {
			...stubPrimary([]),
			search: async (_context, query) => {
				controller.abort();
				return { backend: "mnemopi" as const, query, count: 0, items: [], message: "Search aborted." };
			},
		};

		const result = await withSharpshooter(aborting).search?.({ agentDir: "/agent", cwd: "/cwd" }, "deploy", {
			signal: controller.signal,
		});

		expect(result?.items).toEqual([]);
		expect(result?.count).toBe(0);
		expect(result?.message).toBe("Search aborted.");
	});

	it("keeps the caller's search limit across both backends", async () => {
		spyOn(sharpshooterBackend, "search").mockResolvedValue({
			backend: "sharpshooter",
			query: "deploy",
			count: 1,
			items: [{ content: "- Deploy through the script.", source: "architecture.md" }],
		});
		const paired = withSharpshooter(stubPrimary([]));
		// Each backend applies the limit to its own results, so the merge has to
		// re-apply it or a limit of 1 returns two items.
		const result = await paired.search?.({ agentDir: "/agent", cwd: "/cwd" }, "deploy", { limit: 1 });
		expect(result?.items).toHaveLength(1);
		expect(result?.count).toBe(1);
	});

	it("answers a zero limit the same way whether or not sharpshooter matched", async () => {
		// A backend reads a non-positive limit its own way (mnemopi clamps it to one
		// item), and the pair must not turn that into two different answers depending
		// on whether the decision files happened to contain the needle.
		const oneItem = {
			backend: "mnemopi" as const,
			query: "deploy",
			count: 1,
			items: [{ content: "clamped to one" }],
		};
		const clamping: MemoryBackend = { ...stubPrimary([]), search: async () => oneItem };

		const searchSpy = spyOn(sharpshooterBackend, "search");
		searchSpy.mockResolvedValue({ backend: "sharpshooter", query: "deploy", count: 0, items: [] });
		const withoutHit = await withSharpshooter(clamping).search?.({ agentDir: "/agent", cwd: "/cwd" }, "deploy", {
			limit: 0,
		});

		searchSpy.mockResolvedValue({
			backend: "sharpshooter",
			query: "deploy",
			count: 1,
			items: [{ content: "- Deploy through the script.", source: "architecture.md" }],
		});
		const withHit = await withSharpshooter(clamping).search?.({ agentDir: "/agent", cwd: "/cwd" }, "deploy", {
			limit: 0,
		});

		expect(withoutHit?.items).toEqual(oneItem.items);
		expect(withHit?.items).toEqual(withoutHit?.items);
		expect(withHit?.count).toBe(withoutHit?.count ?? -1);
	});

	it("still returns a sharpshooter hit when the primary fills the limit", async () => {
		spyOn(sharpshooterBackend, "search").mockResolvedValue({
			backend: "sharpshooter",
			query: "deploy",
			count: 1,
			items: [{ content: "- Deploy through the script.", source: "architecture.md" }],
		});
		const full: MemoryBackend = {
			...stubPrimary([]),
			search: async (_context, query) => ({
				backend: "mnemopi" as const,
				query,
				count: 10,
				items: Array.from({ length: 10 }, (_, index) => ({ content: `primary ${index}` })),
			}),
		};
		const paired = withSharpshooter(full);
		// Concatenating and slicing would drop sharpshooter entirely here, which is
		// exactly when a decision-file hit is worth seeing.
		const result = await paired.search?.({ agentDir: "/agent", cwd: "/cwd" }, "deploy", { limit: 10 });
		expect(result?.items).toHaveLength(10);
		expect(result?.items.map(item => item.content)).toContain("- Deploy through the script.");
	});

	it("reports the context as searchable when only sharpshooter can search", async () => {
		spyOn(sharpshooterBackend, "status").mockResolvedValue({
			backend: "sharpshooter",
			active: true,
			writable: false,
			searchable: true,
			message: "architecture.md: 3 lines",
		});
		const unsearchable: MemoryBackend = {
			...stubPrimary([]),
			status: async () => ({
				backend: "local" as const,
				active: true,
				writable: true,
				searchable: false,
				message: "local",
			}),
		};
		const paired = withSharpshooter(unsearchable);
		const status = await paired.status?.({ agentDir: "/agent", cwd: "/cwd" });
		expect(status?.searchable).toBe(true);
	});

	it("reports memory as active when only sharpshooter is running", async () => {
		spyOn(sharpshooterBackend, "status").mockResolvedValue({
			backend: "sharpshooter",
			active: true,
			writable: false,
			searchable: true,
			message: "architecture.md: 3 lines",
		});
		// `off` paired with sharpshooter still runs a scheduler, prompt injection and
		// search, so status must not call that session inactive.
		const settings = Settings.isolated({ "memory.backend": "off", "sharpshooter.enabled": true });
		const resolved = await resolveMemoryBackend(settings);
		const status = await resolved.status?.({ agentDir: "/agent", cwd: "/cwd" });
		expect(status?.backend).toBe("off");
		expect(status?.active).toBe(true);
		expect(status?.searchable).toBe(true);
	});

	it("clears the selected backend without touching the decision files", async () => {
		using temp = TempDir.createSync("@pi-sharpshooter-pairing-clear-");
		const root = temp.path();
		const agentDir = path.join(root, "agent");
		const cwd = path.join(root, "project");
		await fs.mkdir(cwd, { recursive: true });
		const bankDir = sharpshooterBankDir(agentDir, cwd);
		await fs.mkdir(bankDir, { recursive: true });
		const decisions = path.join(bankDir, "architecture.md");
		await Bun.write(decisions, "- Keep storage project-scoped.\n");

		// No spy here: the point is that the real files are still on disk afterwards.
		// They are rewritten whole by a model and kept in no history, so a wipe is
		// unrecoverable (see #10200).
		const calls: string[] = [];
		const paired = withSharpshooter(stubPrimary(calls));
		await paired.clear(agentDir, cwd);

		expect(calls).toContain("clear");
		await expect(Bun.file(decisions).text()).resolves.toBe("- Keep storage project-scoped.\n");
	});

	it("keeps the primary's turn prompt, save and compaction hooks", async () => {
		const paired = withSharpshooter(stubPrimary([]));
		// The hook hands back a preparation the caller commits, so the wrapper must
		// pass the object through untouched rather than just its text.
		const prepared = await paired.beforeAgentStartPrompt?.({} as never, "prompt");
		expect(prepared?.context).toBe("PRIMARY TURN PROMPT");
		expect(prepared?.commit()).toBe(true);
		await expect(paired.preCompactionContext?.([], {} as never)).resolves.toBe("PRIMARY COMPACTION");
		await expect(paired.save?.({ agentDir: "/agent", cwd: "/cwd" }, { content: "note" })).resolves.toMatchObject({
			stored: 1,
		});
	});

	it("merges search hits from both backends", async () => {
		spyOn(sharpshooterBackend, "search").mockResolvedValue({
			backend: "sharpshooter",
			query: "deploy",
			count: 1,
			items: [{ content: "- Deploy through the script.", source: "architecture.md" }],
		});
		const paired = withSharpshooter(stubPrimary([]));
		const result = await paired.search?.({ agentDir: "/agent", cwd: "/cwd" }, "deploy");
		expect(result?.backend).toBe("mnemopi");
		expect(result?.count).toBe(2);
		expect(result?.items.map(item => item.content)).toEqual(["primary hit", "- Deploy through the script."]);
	});

	it("reports both backends in status", async () => {
		spyOn(sharpshooterBackend, "status").mockResolvedValue({
			backend: "sharpshooter",
			active: true,
			writable: false,
			searchable: true,
			message: "architecture.md: 3 lines",
		});
		const paired = withSharpshooter(stubPrimary([]));
		const status = await paired.status?.({ agentDir: "/agent", cwd: "/cwd" });
		expect(status?.backend).toBe("mnemopi");
		expect(status?.message).toContain("primary status");
		expect(status?.message).toContain("sharpshooter — architecture.md: 3 lines");
	});

	it("still surfaces a failure from the selected backend", async () => {
		const failing: MemoryBackend = {
			...stubPrimary([]),
			enqueue: async () => {
				throw new Error("retain failed");
			},
			buildDeveloperInstructions: async () => {
				throw new Error("instructions failed");
			},
		};
		const paired = withSharpshooter(failing);
		// Pairing must not turn a real failure into a logged one the caller never sees.
		await expect(paired.enqueue("/agent", "/cwd")).rejects.toThrow("retain failed");
		await expect(paired.buildDeveloperInstructions("/agent", {} as never)).rejects.toThrow("instructions failed");
	});

	it("keeps the primary working when the paired backend throws", async () => {
		spyOn(sharpshooterBackend, "buildDeveloperInstructions").mockRejectedValue(new Error("sharpshooter is broken"));
		spyOn(sharpshooterBackend, "start").mockImplementation(() => {
			throw new Error("sharpshooter is broken");
		});
		const calls: string[] = [];
		const paired = withSharpshooter(stubPrimary(calls));
		await expect(paired.buildDeveloperInstructions("/agent", {} as never)).resolves.toBe("PRIMARY INSTRUCTIONS");
		await paired.start(startOptions());
		expect(calls).toContain("start");
	});
});
