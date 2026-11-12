import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { HotReloadCoordinator } from "../../src/session/hot-reload";
import {
	createSkillsHotReloadSubsystem,
	createToolsHotReloadSubsystem,
	describeCustomToolsRefresh,
	sourceSignature,
} from "../../src/session/tools-hot-reload";

describe("describeCustomToolsRefresh", () => {
	it("is silent when nothing changed and nothing failed", () => {
		expect(
			describeCustomToolsRefresh({
				added: [],
				replaced: [],
				removed: [],
				errors: [],
			}),
		).toBeUndefined();
	});

	it("counts additions, replacements and removals", () => {
		expect(
			describeCustomToolsRefresh({
				added: ["a", "b"],
				replaced: ["c"],
				removed: [],
				errors: [],
			}),
		).toEqual({
			level: "info",
			message: "tools reloaded: +2 ~1 -0",
		});
	});

	it("lists each failed module and downgrades to a warning", () => {
		const notice = describeCustomToolsRefresh({
			added: ["a"],
			replaced: [],
			removed: [],
			errors: [{ path: "/tools/broken.ts", error: "boom" }],
		});
		expect(notice?.level).toBe("warning");
		expect(notice?.message).toBe("tools reloaded: +1 ~0 -0, 1 failed\n  broken.ts: boom");
	});

	it("reports a failure even when no tool changed", () => {
		const notice = describeCustomToolsRefresh({
			added: [],
			replaced: [],
			removed: [],
			errors: [{ path: "/tools/broken.ts", error: "boom" }],
		});
		expect(notice?.message.split("\n")[0]).toBe("tools unchanged: +0 ~0 -0, 1 failed");
	});
});

describe("tools & skills HotReloadSubsystem", () => {
	let root: string;
	let toolsDir: string;
	let skillsDir: string;
	let busy: boolean;
	let idleListeners: Array<() => void>;
	let toolReloads: number;
	let skillReloads: number;
	let notices: string[];
	let watcher: HotReloadCoordinator;
	let tick = 0;

	beforeEach(async () => {
		root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-tools-hot-reload-"));
		toolsDir = path.join(root, "tools");
		skillsDir = path.join(root, "skills");
		await fs.mkdir(toolsDir);
		await fs.mkdir(skillsDir);
		busy = false;
		idleListeners = [];
		toolReloads = 0;
		skillReloads = 0;
		notices = [];
		watcher = new HotReloadCoordinator({
			subsystems: [
				createToolsHotReloadSubsystem({
					roots: () => [toolsDir],
					reload: async () => {
						toolReloads++;
					},
				}),
				createSkillsHotReloadSubsystem({
					roots: () => [skillsDir],
					reload: async () => {
						skillReloads++;
					},
				}),
			],
			isBusy: () => busy,
			onIdle: listener => {
				idleListeners.push(listener);
				return () => {
					idleListeners = idleListeners.filter(l => l !== listener);
				};
			},
			notify: (_level, message) => {
				notices.push(message);
			},
			// The tests drive `poll()` themselves.
			pollIntervalMs: 3_600_000,
		});
	});

	afterEach(async () => {
		watcher.stop();
		await fs.rm(root, { recursive: true, force: true });
	});

	async function touch(dir: string, name: string): Promise<void> {
		const file = path.join(dir, name);
		await Bun.write(file, `${++tick}`);
		const bumped = new Date(Date.now() + tick * 1000);
		await fs.utimes(file, bumped, bumped);
	}

	it("reloads nothing while the sources are unchanged", async () => {
		await touch(toolsDir, "a.ts");
		await watcher.start();
		await watcher.poll();
		expect([toolReloads, skillReloads, notices]).toEqual([0, 0, []]);
	});

	it("reloads tools when a tool file is added, and skills only when skills changed", async () => {
		await watcher.start();
		await touch(toolsDir, "new.ts");
		await watcher.poll();
		expect([toolReloads, skillReloads]).toEqual([1, 0]);

		await touch(skillsDir, "skill.md");
		await watcher.poll();
		expect([toolReloads, skillReloads]).toEqual([1, 1]);
	});

	it("notices an edit, a deletion, and an edit nested in a subdirectory", async () => {
		await touch(toolsDir, "a.ts");
		await fs.mkdir(path.join(toolsDir, "pkg"));
		await touch(path.join(toolsDir, "pkg"), "index.ts");
		await watcher.start();

		await touch(toolsDir, "a.ts");
		await watcher.poll();
		await fs.rm(path.join(toolsDir, "a.ts"));
		await watcher.poll();
		await touch(path.join(toolsDir, "pkg"), "index.ts");
		await watcher.poll();

		expect(toolReloads).toBe(3);
	});

	it("does not reload while a turn is in flight, says so once, and reloads when the turn ends", async () => {
		await watcher.start();
		busy = true;
		await touch(toolsDir, "mid-turn.ts");
		await watcher.poll();
		await touch(toolsDir, "mid-turn-2.ts");
		await watcher.poll();

		expect(toolReloads).toBe(0);
		expect(notices).toEqual(["tool or skill files changed; reload deferred until the current turn ends"]);

		busy = false;
		for (const listener of idleListeners) listener();
		await watcher.poll();

		expect(toolReloads).toBe(1);
	});

	it("keeps going after a reload fails and reports the failure", async () => {
		const failing = new HotReloadCoordinator({
			subsystems: [
				createToolsHotReloadSubsystem({
					roots: () => [toolsDir],
					reload: async () => {
						throw new Error("tools exploded");
					},
				}),
				createSkillsHotReloadSubsystem({
					roots: () => [skillsDir],
					reload: async () => {
						skillReloads++;
					},
				}),
			],
			isBusy: () => false,
			onIdle: () => () => {},
			notify: (level, message) => {
				notices.push(`${level}: ${message}`);
			},
			pollIntervalMs: 3_600_000,
		});
		await failing.start();
		await touch(toolsDir, "a.ts");
		await touch(skillsDir, "s.md");
		await failing.poll();
		failing.stop();

		expect(notices).toEqual(["error: tools hot reload failed: tools exploded"]);
		expect(skillReloads).toBe(1);
	});

	it("does nothing after stop", async () => {
		await watcher.start();
		watcher.stop();
		await touch(toolsDir, "a.ts");
		await watcher.poll();
		expect(toolReloads).toBe(0);
		expect(idleListeners).toEqual([]);
	});

	it("watches tools and skills independently when watchTools or watchSkills is toggled", async () => {
		let watchTools = true;
		let watchSkills = false;
		const granular = new HotReloadCoordinator({
			subsystems: [
				createToolsHotReloadSubsystem({
					roots: () => [toolsDir],
					enabled: () => watchTools,
					reload: async () => {
						toolReloads++;
					},
				}),
				createSkillsHotReloadSubsystem({
					roots: () => [skillsDir],
					enabled: () => watchSkills,
					reload: async () => {
						skillReloads++;
					},
				}),
			],
			isBusy: () => false,
			onIdle: () => () => {},
			notify: () => {},
			pollIntervalMs: 3_600_000,
		});
		await granular.start();

		// Skills are disabled: skill edits do not trigger reloadSkills, tool edits do.
		await touch(skillsDir, "ignored.md");
		await touch(toolsDir, "watched.ts");
		await granular.poll();
		expect([toolReloads, skillReloads]).toEqual([1, 0]);

		// Flip: disable tools, enable skills. First poll after enabling skills captures baseline without reloading.
		watchTools = false;
		watchSkills = true;
		await granular.poll();
		expect([toolReloads, skillReloads]).toEqual([1, 0]);

		// Subsequent skill edit reloads skills; tool edit is ignored.
		await touch(toolsDir, "ignored.ts");
		await touch(skillsDir, "watched.md");
		await granular.poll();
		granular.stop();
		expect([toolReloads, skillReloads]).toEqual([1, 1]);
	});
});

describe("sourceSignature", () => {
	it("treats a missing root as empty and changes when it appears", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-source-signature-"));
		try {
			const missing = path.join(root, "absent");
			const before = await sourceSignature([missing]);
			await fs.mkdir(missing);
			expect(await sourceSignature([missing])).not.toBe(before);
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	});
});
