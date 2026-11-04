import { afterAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as fsSync from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { replaceFileAtomically, writeFileAtomically, writeFileAtomicallySync } from "../src/atomic-file";
import { removeWithRetries } from "../src/temp";

const ROOTS: string[] = [];

async function mkRoot(): Promise<string> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "atomic-file-test-"));
	ROOTS.push(root);
	return root;
}

afterAll(async () => {
	for (const root of ROOTS) {
		await fs.chmod(path.join(root, "locked"), 0o700).catch(() => {});
		await removeWithRetries(root).catch(() => {});
	}
});

/** Files left beside a destination after a write; a staged temp must never survive. */
async function siblings(dir: string): Promise<string[]> {
	return (await fs.readdir(dir)).sort();
}

describe("writeFileAtomically through a symlinked destination", () => {
	test("replaces the link's target and leaves the link in place", async () => {
		const root = await mkRoot();
		const target = path.join(root, "marketplaces.json");
		const link = path.join(root, "profile-marketplaces.json");
		await fs.writeFile(target, "old");
		await fs.symlink(target, link);

		await writeFileAtomically(link, "new", 0o644);

		expect((await fs.lstat(link)).isSymbolicLink()).toBe(true);
		expect(await fs.readFile(target, "utf8")).toBe("new");
		// The two names still reach one file: the profile keeps sharing the default's registry.
		expect((await fs.stat(link)).ino).toBe((await fs.stat(target)).ino);
		expect(await siblings(root)).toEqual(["marketplaces.json", "profile-marketplaces.json"]);
	});

	test("follows a link into another directory, not only a sibling", async () => {
		const root = await mkRoot();
		const shared = path.join(root, "shared");
		const profile = path.join(root, "profile");
		await fs.mkdir(shared);
		await fs.mkdir(profile);
		const target = path.join(shared, "config.yml");
		const link = path.join(profile, "config.yml");
		await fs.writeFile(target, "old");
		await fs.symlink(target, link);

		await writeFileAtomically(link, "new", 0o644);

		expect((await fs.lstat(link)).isSymbolicLink()).toBe(true);
		expect(await fs.readFile(target, "utf8")).toBe("new");
		// The staged copy is published from the target's directory and leaves nothing behind.
		expect(await siblings(shared)).toEqual(["config.yml"]);
		expect(await siblings(profile)).toEqual(["config.yml"]);
	});

	test("follows a chain of links", async () => {
		const root = await mkRoot();
		const target = path.join(root, "real");
		const middle = path.join(root, "middle");
		const link = path.join(root, "link");
		await fs.writeFile(target, "old");
		await fs.symlink(target, middle);
		await fs.symlink(middle, link);

		await writeFileAtomically(link, "new", 0o644);

		expect((await fs.lstat(link)).isSymbolicLink()).toBe(true);
		expect((await fs.lstat(middle)).isSymbolicLink()).toBe(true);
		expect(await fs.readFile(target, "utf8")).toBe("new");
	});

	test("creates the file a dangling link names, as a plain write would", async () => {
		const root = await mkRoot();
		const target = path.join(root, "absent.json");
		const link = path.join(root, "link.json");
		await fs.symlink(target, link);

		await writeFileAtomically(link, "new", 0o644);

		expect((await fs.lstat(link)).isSymbolicLink()).toBe(true);
		expect(await fs.readFile(target, "utf8")).toBe("new");
	});

	test("reports ELOOP for a link cycle instead of looping", async () => {
		const root = await mkRoot();
		const a = path.join(root, "a");
		const b = path.join(root, "b");
		await fs.symlink(b, a);
		await fs.symlink(a, b);

		await expect(writeFileAtomically(a, "new", 0o644)).rejects.toThrow(/ELOOP/);
	});

	test("writeFileAtomicallySync keeps the link too", async () => {
		const root = await mkRoot();
		const target = path.join(root, "real.yml");
		const link = path.join(root, "link.yml");
		await fs.writeFile(target, "old");
		await fs.symlink(target, link);

		writeFileAtomicallySync(link, "new", 0o644);

		expect((await fs.lstat(link)).isSymbolicLink()).toBe(true);
		expect(await fs.readFile(target, "utf8")).toBe("new");
	});

	// Root bypasses the directory's mode bits and Windows has no POSIX modes.
	test.skipIf(process.platform === "win32" || (process.getuid?.() !== undefined && process.getuid() === 0))(
		"fails and leaves the link alone when the target's directory is unwritable",
		async () => {
			const root = await mkRoot();
			const locked = path.join(root, "locked");
			await fs.mkdir(locked);
			const target = path.join(locked, "config.yml");
			const link = path.join(root, "config.yml");
			await fs.writeFile(target, "old");
			await fs.symlink(target, link);
			await fs.chmod(locked, 0o500);

			await expect(writeFileAtomically(link, "new", 0o644)).rejects.toThrow(/EACCES|EROFS|EPERM/);

			expect((await fs.lstat(link)).isSymbolicLink()).toBe(true);
			expect(await fs.readFile(target, "utf8")).toBe("old");
			await fs.chmod(locked, 0o700);
		},
	);
});

describe("writeFileAtomically on a plain destination", () => {
	test("publishes the content at the requested mode and stages nothing durable", async () => {
		const root = await mkRoot();
		const target = path.join(root, "plain.json");
		await fs.writeFile(target, "old");

		await writeFileAtomically(target, "new", 0o600);

		expect(await fs.readFile(target, "utf8")).toBe("new");
		expect((await fs.stat(target)).mode & 0o777).toBe(0o600);
		expect(await siblings(root)).toEqual(["plain.json"]);
	});

	test("creates a destination that does not exist yet", async () => {
		const root = await mkRoot();
		const target = path.join(root, "fresh.json");

		await writeFileAtomically(target, "new", 0o644);

		expect(await fs.readFile(target, "utf8")).toBe("new");
		expect((await fs.lstat(target)).isSymbolicLink()).toBe(false);
	});
});

describe("replaceFileAtomically with a staged file that is not the target's sibling", () => {
	test("publishes onto the link's target and removes the staged copy", async () => {
		const root = await mkRoot();
		const shared = path.join(root, "shared");
		const profile = path.join(root, "profile");
		await fs.mkdir(shared);
		await fs.mkdir(profile);
		const target = path.join(shared, "registry.json");
		const link = path.join(profile, "registry.json");
		await fs.writeFile(target, "old");
		await fs.symlink(target, link);
		const staged = path.join(profile, "registry.json.staged");
		await fs.writeFile(staged, "new");

		await replaceFileAtomically(staged, link);

		expect((await fs.lstat(link)).isSymbolicLink()).toBe(true);
		expect(await fs.readFile(target, "utf8")).toBe("new");
		expect(fsSync.existsSync(staged)).toBe(false);
		expect(await siblings(shared)).toEqual(["registry.json"]);
	});
});
