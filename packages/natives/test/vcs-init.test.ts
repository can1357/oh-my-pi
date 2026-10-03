import { afterEach, beforeEach, expect, test } from "bun:test";
import * as path from "node:path";
import { TempDir } from "@oh-my-pi/pi-utils";
import * as vcs from "../native/vcs.js";

let dir: TempDir;
beforeEach(async () => {
	dir = await TempDir.create("@omp-vcs-init-");
});
afterEach(async () => {
	await dir.remove();
});

test("initializes around user files, honors local identity, and rejects re-init without replacing HEAD", async () => {
	const file = dir.join("user.txt");
	await Bun.write(file, "keep this content");
	const repo = vcs.initGit(dir.path());
	await repo.configSet("user.name", "Initializer Fixture");
	await repo.configSet("user.email", "initializer@example.test");
	await repo.configSet("core.hooksPath", path.join(repo.info().gitDir, "unused-fixture-hooks"));
	const sha = await repo.commitCreate("initial empty commit", { allowEmpty: true });
	expect((await repo.commitDetails(sha)).author).toMatchObject({
		name: "Initializer Fixture",
		email: "initializer@example.test",
	});
	let failure: unknown;
	try {
		vcs.initGit(dir.path());
	} catch (error) {
		failure = error;
	}
	expect(failure).toMatchObject({ name: "VcsError", code: "Backend" });
	expect(await vcs.requireGit(dir.path()).headSha()).toBe(sha);
	expect(await Bun.file(file).text()).toBe("keep this content");
});
