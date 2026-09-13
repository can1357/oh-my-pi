import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { invalidate, readDirEntries, readFile } from "@oh-my-pi/pi-coding-agent/capability/fs";

describe.skipIf(process.platform === "win32")("fs capability cache canonical identity", () => {
	const dirs: string[] = [];

	afterEach(async () => {
		for (const dir of dirs.splice(0)) await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
	});

	async function freshDir(): Promise<string> {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-fs-cache-"));
		dirs.push(dir);
		return dir;
	}

	test("reads through two aliases of one referent share a single cache entry", async () => {
		// A user-level and a project-level mcp.json symlinked to one dotfiles
		// referent: a mutation published through one alias must not leave the
		// other serving the cached pre-mutation content.
		const dir = await freshDir();
		const referent = path.join(dir, "target.json");
		const userAlias = path.join(dir, "user-mcp.json");
		const projectAlias = path.join(dir, "project-mcp.json");
		await Bun.write(referent, "v1");
		await fs.symlink(referent, userAlias);
		await fs.symlink(referent, projectAlias);

		expect(await readFile(userAlias)).toBe("v1");

		await Bun.write(referent, "v2");
		invalidate(projectAlias);

		expect(await readFile(userAlias)).toBe("v2");
	});

	test("a missing or dangling path still caches per lexical spelling", async () => {
		// Canonicalization must not MERGE distinct missing files: two aliases
		// of a dangling link cannot be realpath'd, so each keeps its own
		// (null) entry and a later-created referent is read fresh.
		const dir = await freshDir();
		const referent = path.join(dir, "target.json");
		const alias = path.join(dir, "dangling-alias");
		await fs.symlink(referent, alias);

		expect(await readFile(alias)).toBe(null);

		await Bun.write(referent, "created-after");
		invalidate(alias);

		expect(await readFile(alias)).toBe("created-after");
	});

	test("invalidating a deleted child drops its canonical-keyed entries", async () => {
		// Delete-then-invalidate flows: the child is GONE when invalidate
		// runs, so its realpath fails — but the entry was cached under the
		// CANONICAL key (read through the symlinked directory). The fallback
		// must rebuild that key from the surviving parent instead of deleting
		// only the lexical alias key and leaving stale entries behind.
		const dir = await freshDir();
		const realDir = path.join(dir, "real");
		await fs.mkdir(realDir);
		const child = path.join(realDir, "child.json");
		await Bun.write(child, "v1");
		const aliasDir = path.join(dir, "alias");
		await fs.symlink(realDir, aliasDir);

		expect(await readFile(path.join(aliasDir, "child.json"))).toBe("v1");
		expect((await readDirEntries(aliasDir)).map(entry => entry.name)).toContain("child.json");

		await fs.rm(child);
		invalidate(path.join(aliasDir, "child.json"));

		expect(await readFile(child)).toBe(null);
		expect((await readDirEntries(realDir)).map(entry => entry.name)).toEqual([]);
	});
});
