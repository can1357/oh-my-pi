import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fsSync from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { replaceFileAtomically, writeFileAtomically, writeFileAtomicallySync } from "../src/atomic-file";
import {
	getAgentDir,
	getBaseConfigRoot,
	getPluginsDir,
	getProjectAgentDir,
	getProjectDir,
	getRemoteDir,
	getSkillshareStoreDir,
	getWorktreesDir,
	isOmpOwnedPath,
	setAgentDir,
	setProjectDir,
} from "../src/dirs";
import { removeWithRetries } from "../src/temp";

/**
 * A destination is only followed through a symlink when it sits in a directory
 * omp owns, so each test's temp root is made the agent directory. `foreign`
 * stands for a path omp does not own — a project checkout — and stays outside.
 */
let owned: string;
let foreign: string;
let originalAgentDir: string;

beforeEach(async () => {
	originalAgentDir = getAgentDir();
	owned = await fs.mkdtemp(path.join(os.tmpdir(), "atomic-owned-"));
	foreign = await fs.mkdtemp(path.join(os.tmpdir(), "atomic-foreign-"));
	setAgentDir(owned);
});

afterEach(async () => {
	setAgentDir(originalAgentDir);
	await fs.chmod(path.join(owned, "locked"), 0o700).catch(() => {});
	await removeWithRetries(owned).catch(() => {});
	await removeWithRetries(foreign).catch(() => {});
});

const isRoot = process.getuid?.() === 0;

describe("writeFileAtomically through a symlinked destination omp owns", () => {
	test("replaces the link's target and leaves the link in place", async () => {
		const target = path.join(owned, "marketplaces.json");
		const link = path.join(owned, "profile-marketplaces.json");
		await fs.writeFile(target, "old");
		await fs.symlink(target, link);

		await writeFileAtomically(link, "new", 0o644);

		expect((await fs.lstat(link)).isSymbolicLink()).toBe(true);
		expect(await fs.readFile(target, "utf8")).toBe("new");
		// The two names still reach one file: the profile keeps sharing the default's registry.
		expect((await fs.stat(link)).ino).toBe((await fs.stat(target)).ino);
		expect((await fs.readdir(owned)).sort()).toEqual(["marketplaces.json", "profile-marketplaces.json"]);
	});

	test("follows a link into another directory, not only a sibling", async () => {
		const shared = path.join(owned, "shared");
		const profile = path.join(owned, "profile");
		await fs.mkdir(shared);
		await fs.mkdir(profile);
		const target = path.join(shared, "config.yml");
		const link = path.join(profile, "config.yml");
		await fs.writeFile(target, "old");
		await fs.symlink(target, link);

		await writeFileAtomically(link, "new", 0o644);

		expect((await fs.lstat(link)).isSymbolicLink()).toBe(true);
		expect(await fs.readFile(target, "utf8")).toBe("new");
		// Staged and published in the target's directory, leaving nothing behind.
		expect(await fs.readdir(shared)).toEqual(["config.yml"]);
		expect(await fs.readdir(profile)).toEqual(["config.yml"]);
	});

	test("resolves a relative link through a symlinked parent the way the kernel does", async () => {
		// alias -> physical/nested, and alias/config.json -> ../target.json. A plain
		// write lands on physical/target.json; resolving `..` lexically would land on
		// a target.json beside alias instead.
		await fs.mkdir(path.join(owned, "physical", "nested"), { recursive: true });
		const target = path.join(owned, "physical", "target.json");
		await fs.writeFile(target, "old");
		await fs.symlink(path.join(owned, "physical", "nested"), path.join(owned, "alias"));
		const link = path.join(owned, "alias", "config.json");
		await fs.symlink("../target.json", link);

		await writeFileAtomically(link, "new", 0o644);

		expect(await fs.readFile(target, "utf8")).toBe("new");
		expect(fsSync.existsSync(path.join(owned, "target.json"))).toBe(false);
		expect((await fs.lstat(link)).isSymbolicLink()).toBe(true);
	});

	test("follows a chain of links", async () => {
		const target = path.join(owned, "real");
		const middle = path.join(owned, "middle");
		const link = path.join(owned, "link");
		await fs.writeFile(target, "old");
		await fs.symlink(target, middle);
		await fs.symlink(middle, link);

		await writeFileAtomically(link, "new", 0o644);

		expect((await fs.lstat(link)).isSymbolicLink()).toBe(true);
		expect((await fs.lstat(middle)).isSymbolicLink()).toBe(true);
		expect(await fs.readFile(target, "utf8")).toBe("new");
	});

	test("creates the file a dangling link names, as a plain write would", async () => {
		const target = path.join(owned, "absent.json");
		const link = path.join(owned, "link.json");
		await fs.symlink(target, link);

		await writeFileAtomically(link, "new", 0o644);

		expect((await fs.lstat(link)).isSymbolicLink()).toBe(true);
		expect(await fs.readFile(target, "utf8")).toBe("new");
	});

	test("reports ELOOP for a link cycle instead of looping", async () => {
		const a = path.join(owned, "a");
		const b = path.join(owned, "b");
		await fs.symlink(b, a);
		await fs.symlink(a, b);

		await expect(writeFileAtomically(a, "new", 0o644)).rejects.toThrow(/ELOOP/);
	});

	test("writeFileAtomicallySync keeps the link too", async () => {
		const target = path.join(owned, "real.yml");
		const link = path.join(owned, "link.yml");
		await fs.writeFile(target, "old");
		await fs.symlink(target, link);

		writeFileAtomicallySync(link, "new", 0o644);

		expect((await fs.lstat(link)).isSymbolicLink()).toBe(true);
		expect(await fs.readFile(target, "utf8")).toBe("new");
	});

	// Root bypasses the directory's mode bits and Windows has no POSIX modes.
	test.skipIf(process.platform === "win32" || isRoot)(
		"fails and leaves the link alone when the target's directory is unwritable",
		async () => {
			const locked = path.join(owned, "locked");
			await fs.mkdir(locked);
			const target = path.join(locked, "config.yml");
			const link = path.join(owned, "config.yml");
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

describe("writeFileAtomically on a destination omp does not own", () => {
	// A checkout's `.omp/` holds whatever the repository committed. Following a link
	// there would let a clone redirect the write onto any file its user can write.
	test("the project's own .omp directory is never owned, even under an omp root", () => {
		expect(isOmpOwnedPath(path.join(getProjectAgentDir(), "plugins"))).toBe(false);
	});

	test("replaces a link outside omp's directories instead of following it", async () => {
		const victim = path.join(owned, "victim");
		const link = path.join(foreign, "installed_plugins.json");
		await fs.writeFile(victim, "untouched");
		await fs.symlink(victim, link);

		await writeFileAtomically(link, "new", 0o644);

		expect(await fs.readFile(victim, "utf8")).toBe("untouched");
		expect((await fs.lstat(link)).isSymbolicLink()).toBe(false);
		expect(await fs.readFile(link, "utf8")).toBe("new");
	});

	test("writeFileAtomicallySync does not follow one either", async () => {
		const victim = path.join(owned, "victim.yml");
		const link = path.join(foreign, "config.yml");
		await fs.writeFile(victim, "untouched");
		await fs.symlink(victim, link);

		writeFileAtomicallySync(link, "new", 0o644);

		expect(await fs.readFile(victim, "utf8")).toBe("untouched");
		expect((await fs.lstat(link)).isSymbolicLink()).toBe(false);
	});
});

describe("writeFileAtomically on a plain destination", () => {
	test("publishes the content and stages nothing durable", async () => {
		const target = path.join(owned, "plain.json");
		await fs.writeFile(target, "old");

		await writeFileAtomically(target, "new", 0o600);

		expect(await fs.readFile(target, "utf8")).toBe("new");
		expect(await fs.readdir(owned)).toEqual(["plain.json"]);
	});

	test.skipIf(process.platform === "win32")("publishes at the requested mode", async () => {
		const target = path.join(owned, "moded.json");

		await writeFileAtomically(target, "new", 0o600);

		expect((await fs.stat(target)).mode & 0o777).toBe(0o600);
	});

	test("creates a destination that does not exist yet", async () => {
		const target = path.join(owned, "fresh.json");

		await writeFileAtomically(target, "new", 0o644);

		expect(await fs.readFile(target, "utf8")).toBe("new");
		expect((await fs.lstat(target)).isSymbolicLink()).toBe(false);
	});
});

describe("replaceFileAtomically with a staged file in another directory", () => {
	test("moves by rename on one filesystem, without copying", async () => {
		const from = path.join(owned, "from");
		const to = path.join(owned, "to");
		await fs.mkdir(from);
		await fs.mkdir(to);
		const staged = path.join(from, "download.part");
		const destination = path.join(to, "download.bin");
		await fs.writeFile(staged, "payload");
		// A finished download is read-only; a rename does not need write permission
		// on it, a copy-and-fsync would.
		await fs.chmod(staged, 0o444);
		const stagedIno = (await fs.stat(staged)).ino;

		await replaceFileAtomically(staged, destination);

		expect(await fs.readFile(destination, "utf8")).toBe("payload");
		expect((await fs.stat(destination)).ino).toBe(stagedIno);
		expect(fsSync.existsSync(staged)).toBe(false);
	});

	test("publishes onto the link's target and removes the staged copy", async () => {
		const shared = path.join(owned, "shared");
		const profile = path.join(owned, "profile");
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
		expect(await fs.readdir(shared)).toEqual(["registry.json"]);
	});
});

describe("boundaries the resolver must keep", () => {
	test("a `..` inside the link's own text walks out of the physical parent", async () => {
		// alias -> physical/nested, and the link's text is `alias/../target.json`: the
		// kernel resolves `alias` first, so `..` leaves physical/nested for physical,
		// not the directory the link sits in.
		await fs.mkdir(path.join(owned, "physical", "nested"), { recursive: true });
		const target = path.join(owned, "physical", "target.json");
		await fs.writeFile(target, "old");
		await fs.symlink(path.join(owned, "physical", "nested"), path.join(owned, "alias"));
		const link = path.join(owned, "config.json");
		await fs.symlink("alias/../target.json", link);

		await writeFileAtomically(link, "new", 0o644);

		expect(await fs.readFile(target, "utf8")).toBe("new");
		expect(fsSync.existsSync(path.join(owned, "target.json"))).toBe(false);
		expect((await fs.lstat(link)).isSymbolicLink()).toBe(true);
	});

	test("every tree omp fills from elsewhere is foreign, wherever its producer puts it", () => {
		// Asked of the producers, not spelled out: a worktree base the user moved
		// with `worktree.base` must stay foreign, which a literal `wt` would miss.
		for (const tree of [
			getWorktreesDir(),
			getRemoteDir(),
			getSkillshareStoreDir(),
			path.join(getPluginsDir(), "cache"),
			path.join(getPluginsDir(), "node_modules"),
		]) {
			expect(isOmpOwnedPath(path.join(tree, "pkg", "nested", "config.json"))).toBe(false);
		}
		// Another profile's copies live under a CONFIG root, not under an agent
		// directory moved outside it; the test below covers them.
		// The names are anchored, so a user's own directory keeps its meaning.
		expect(isOmpOwnedPath(path.join(owned, "agent", "prompts", "wt"))).toBe(true);
		expect(isOmpOwnedPath(path.join(owned, "agent", "plugins", "cache"))).toBe(true);
	});
});

describe("classification does not depend on where omp happens to be pointed", () => {
	test("a filename ending in a backslash is a filename, not a directory", async () => {
		// `\` is an ordinary character in a POSIX name. Treating it as a separator
		// abandoned the chain at `middle\` and left the target unwritten.
		const target = path.join(owned, "real");
		const middle = path.join(owned, "middle\\");
		const link = path.join(owned, "config.json");
		await fs.writeFile(target, "old");
		await fs.symlink(target, middle);
		await fs.symlink(middle, link);

		await writeFileAtomically(link, "new", 0o644);

		expect(await fs.readFile(target, "utf8")).toBe("new");
		expect((await fs.lstat(middle)).isSymbolicLink()).toBe(true);
	});

	test("an inactive profile's downloaded trees are foreign too", () => {
		for (const tree of ["wt", "remote", "skillshare", "puppeteer", "webcache"]) {
			expect(isOmpOwnedPath(path.join(getBaseConfigRoot(), "profiles", "other", tree, "x"))).toBe(false);
		}
		expect(
			isOmpOwnedPath(path.join(getBaseConfigRoot(), "profiles", "other", "cache", "fastembed-runtime", "x")),
		).toBe(false);
	});

	test("an agent directory outside the config root holds none of those trees", () => {
		// `owned` is this test's agent dir, outside the config root. A directory the
		// user named `plugins/cache` there is theirs; the downloaded one is under
		// the config root and is excluded by its producer.
		expect(isOmpOwnedPath(path.join(owned, "plugins", "cache"))).toBe(true);
		expect(isOmpOwnedPath(path.join(owned, "webcache", "x"))).toBe(true);
		expect(isOmpOwnedPath(path.join(getPluginsDir(), "cache", "x"))).toBe(false);
	});

	test("a project's config directory is foreign wherever the checkout holding it sits", () => {
		// `worktree.base` is per project, while the directory producer answers for
		// whichever project this process set last, so a second project's checkout
		// cannot be recognised by location. Its shape is what gives it away.
		for (const base of ["wt", "trees-b", path.join("nested", "anywhere")]) {
			const checkout = path.join(getBaseConfigRoot(), base, "pr-1", ".omp");
			expect(isOmpOwnedPath(path.join(checkout, "mcp.json"))).toBe(false);
			expect(isOmpOwnedPath(path.join(checkout, "plugins"))).toBe(false);
		}
		// The config root itself is not a nested project directory.
		expect(isOmpOwnedPath(path.join(getBaseConfigRoot(), "agent"))).toBe(true);
	});

	test("a project config directory is found by its own name, which PI_CONFIG_DIR does not move", () => {
		const previous = process.env.PI_CONFIG_DIR;
		process.env.PI_CONFIG_DIR = ".myomp";
		try {
			setAgentDir(owned);
			expect(isOmpOwnedPath(path.join(getBaseConfigRoot(), "trees-b", "pr-1", ".omp", "mcp.json"))).toBe(false);
		} finally {
			if (previous === undefined) delete process.env.PI_CONFIG_DIR;
			else process.env.PI_CONFIG_DIR = previous;
			setAgentDir(owned);
		}
	});

	test("a checkout under an agent directory outside the config root is foreign too", () => {
		// `owned` is this test's agent dir, outside the config root; the final
		// containment check used to reach it without the shape rule.
		expect(isOmpOwnedPath(path.join(owned, "trees-b", "pr-1", ".omp", "mcp.json"))).toBe(false);
		expect(isOmpOwnedPath(path.join(owned, "agent", "config.yml"))).toBe(true);
	});

	test("a session started from the home directory still owns its own config", () => {
		// With cwd at home, the project's `.omp` IS the config root, so keying the
		// exclusion on it classed every config file as somebody else's and turned
		// the fix off without a word.
		const previous = getProjectDir();
		try {
			setProjectDir(path.dirname(getBaseConfigRoot()));
			expect(getProjectAgentDir()).toBe(getBaseConfigRoot());
			expect(isOmpOwnedPath(getBaseConfigRoot())).toBe(true);
			expect(isOmpOwnedPath(path.join(getBaseConfigRoot(), "profiles", "pbc"))).toBe(true);
			// A checkout under it is still somebody else's, by shape.
			expect(isOmpOwnedPath(path.join(getBaseConfigRoot(), "wt", "pr-1", ".omp"))).toBe(false);
		} finally {
			setProjectDir(previous);
		}
	});

	test("nested roots are measured against the innermost one", () => {
		// An XDG app root configured inside the config root makes the roots nest.
		// Measured against the outer one, a downloaded tree's name sits one segment
		// too deep to be seen.
		const previous = process.env.XDG_DATA_HOME;
		process.env.XDG_DATA_HOME = path.join(getBaseConfigRoot(), "data");
		try {
			setAgentDir(owned);
			const inner = path.join(getBaseConfigRoot(), "data", "omp");
			expect(isOmpOwnedPath(path.join(inner, "profiles", "other", "plugins", "cache", "x"))).toBe(false);
			expect(isOmpOwnedPath(path.join(inner, "wt", "pr-1", "src"))).toBe(false);
			expect(isOmpOwnedPath(path.join(inner, "agent", "config.yml"))).toBe(true);
		} finally {
			if (previous === undefined) delete process.env.XDG_DATA_HOME;
			else process.env.XDG_DATA_HOME = previous;
			setAgentDir(owned);
		}
	});

	test("an installed dependency tree is foreign under any runtime, named or not", () => {
		// Speech, transcription, the tiny title model and the embedder all install
		// through the same machinery, and naming their directories one at a time is
		// how three gaps were found. The `node_modules` a package manager writes is
		// the shape they share.
		for (const runtime of ["tts-runtime", "stt-runtime", "tiny-runtime", "fastembed-runtime", "whatever-is-next"]) {
			const installed = path.join(getBaseConfigRoot(), "agent", "cache", runtime, "node_modules");
			expect(isOmpOwnedPath(path.join(installed, "pkg", "dist", "index.js"))).toBe(false);
			expect(isOmpOwnedPath(path.join(installed, ".bin", "probe"))).toBe(false);
		}
		expect(isOmpOwnedPath(path.join(getPluginsDir(), "node_modules", "pkg"))).toBe(false);
		// The runtime's own directory above `node_modules` is still omp's.
		expect(isOmpOwnedPath(path.join(getBaseConfigRoot(), "agent", "cache", "tts-runtime"))).toBe(true);
	});
});
