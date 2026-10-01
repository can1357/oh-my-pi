import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as vcs from "@oh-my-pi/pi-natives/vcs";
import { getLesson } from "@oh-my-pi/pi-coding-agent/tutorials/catalog";
import { createSandbox } from "@oh-my-pi/pi-coding-agent/tutorials/sandbox";
import { TempDir } from "@oh-my-pi/pi-utils";

describe("createSandbox", () => {
	it("creates a clean repo with the fixture committed and leaves the cwd project untouched", async () => {
		using root = TempDir.createSync("@pi-tutorial-sandbox-");
		using project = TempDir.createSync("@pi-tutorial-project-");
		await Bun.write(path.join(project.path(), "keep.txt"), "mine\n");
		const before = await fs.readdir(project.path(), { recursive: true });

		const lesson = getLesson("basics")!;
		const cwd = process.cwd();
		process.chdir(project.path());
		let dir: string;
		try {
			dir = await createSandbox(lesson, { root: root.path(), now: new Date(2026, 0, 2, 3, 4, 5) });
		} finally {
			process.chdir(cwd);
		}

		expect(dir).toBe(path.join(root.path(), "basics-20260102-030405"));
		const repo = vcs.requireGit(dir);
		expect(repo.info().repoRoot).toBe(dir);
		expect(await repo.logSubjects(5)).toEqual(["initial commit"]);
		expect(await repo.isDirty()).toBe(false);
		expect(await Bun.file(path.join(dir, "src/cart.ts")).exists()).toBe(true);
		expect(await fs.readdir(project.path(), { recursive: true })).toEqual(before);
		expect(vcs.git(project.path())).toBeNull();
	});

	it("commits history overlays after the fixture, and never reuses a directory", async () => {
		using root = TempDir.createSync("@pi-tutorial-sandbox-");
		const lesson = getLesson("jevify")!;
		const now = new Date(2026, 0, 2, 3, 4, 5);
		const first = await createSandbox(lesson, { root: root.path(), now });
		const second = await createSandbox(lesson, { root: root.path(), now });

		expect(second).not.toBe(first);
		const repo = vcs.requireGit(first);
		expect(await repo.logSubjects(5)).toEqual(["refactor: rename logger", "initial commit"]);
		expect(await repo.isDirty()).toBe(false);
	});
});
