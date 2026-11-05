import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fsSync from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	replaceConfigFileAtomically,
	replaceFileAtomically,
	writeFileAtomically,
	writeFileAtomicallySync,
} from "../src/atomic-file";
import { getAgentDir, setAgentDir } from "../src/dirs";
import { removeWithRetries } from "../src/temp";

/**
 * Stage content and publish it through the one config entry point the module
 * exports, which is how every production config write reaches the link rule:
 * `marketplace/registry.ts` stages its JSON and calls
 * `replaceConfigFileAtomically`. The staging path is a sibling of the path as
 * GIVEN, never of the resolved destination, exactly as the registry writer
 * stages beside the registry it was handed — so these tests exercise the real
 * arrangement rather than a convenience wrapper that no longer exists.
 */
async function writeConfigFileAtomically(filePath: string, content: string, mode: number = 0o600): Promise<void> {
	const staged = `${filePath}.${process.pid}.${crypto.randomUUID()}.staged`;
	try {
		const handle = await fs.open(staged, "wx", mode);
		try {
			await handle.writeFile(content, "utf8");
		} finally {
			await handle.close();
		}
		await fs.chmod(staged, mode);
		await replaceConfigFileAtomically(staged, filePath);
	} catch (error) {
		await fs.rm(staged, { force: true }).catch(() => {});
		throw error;
	}
}

/**
 * A config write follows a link only while every step stays inside a directory
 * omp keeps, so `root` is made the agent directory for the duration — without
 * that these tests would run in territory omp does not own and would never
 * reach the branch they are about. `outside` is ordinary user territory and
 * `project` is a checkout's own `.omp`; neither is followed.
 */
let root: string;
let outside: string;
let project: string;
let originalAgentDir: string;

beforeEach(async () => {
	originalAgentDir = getAgentDir();
	// The temp root is named like omp's real one. Without that, the root's own
	// `.omp` never appears in a path under test and a rule that mistook it for a
	// project's directory passed every test while breaking the default profile.
	root = path.join(await fs.mkdtemp(path.join(os.tmpdir(), "atomic-file-")), ".omp");
	await fs.mkdir(root);
	outside = await fs.mkdtemp(path.join(os.tmpdir(), "atomic-outside-"));
	project = path.join(root, "checkout", ".omp");
	await fs.mkdir(project, { recursive: true });
	setAgentDir(root);
});

afterEach(async () => {
	setAgentDir(originalAgentDir);
	await fs.chmod(path.join(root, "locked"), 0o700).catch(() => {});
	await removeWithRetries(root).catch(() => {});
	await removeWithRetries(outside).catch(() => {});
});

const isRoot = process.getuid?.() === 0;

async function linkTo(target: string, link: string, contents = "old"): Promise<void> {
	await fs.writeFile(target, contents);
	await fs.symlink(target, link);
}

describe("a config write follows a symlinked destination", () => {
	test("follows a link that sits directly in the config root", async () => {
		// Where the default profile keeps every one of these files, and the one
		// place containment has to treat "is the root" as "is inside it".
		const target = path.join(root, "shared.json");
		const link = path.join(root, "marketplaces.json");
		await linkTo(target, link);

		await writeConfigFileAtomically(link, "new", 0o644);

		expect((await fs.lstat(link)).isSymbolicLink()).toBe(true);
		expect(await fs.readFile(target, "utf8")).toBe("new");
	});

	test("replaces the link's target and leaves the link in place", async () => {
		const target = path.join(root, "marketplaces.json");
		const link = path.join(root, "profile-marketplaces.json");
		await linkTo(target, link);

		await writeConfigFileAtomically(link, "new", 0o644);

		expect((await fs.lstat(link)).isSymbolicLink()).toBe(true);
		expect(await fs.readFile(target, "utf8")).toBe("new");
		// The two names still reach one file: the profile keeps sharing the default's registry.
		expect((await fs.stat(link)).ino).toBe((await fs.stat(target)).ino);
		expect((await fs.readdir(root)).sort()).toEqual(["checkout", "marketplaces.json", "profile-marketplaces.json"]);
	});

	test("follows a link into another directory, not only a sibling", async () => {
		const shared = path.join(root, "shared");
		const profile = path.join(root, "profile");
		await fs.mkdir(shared);
		await fs.mkdir(profile);
		const target = path.join(shared, "config.yml");
		const link = path.join(profile, "config.yml");
		await linkTo(target, link);

		await writeConfigFileAtomically(link, "new", 0o644);

		expect((await fs.lstat(link)).isSymbolicLink()).toBe(true);
		expect(await fs.readFile(target, "utf8")).toBe("new");
		// Staged and published in the target's directory, leaving nothing behind.
		expect(await fs.readdir(shared)).toEqual(["config.yml"]);
		expect(await fs.readdir(profile)).toEqual(["config.yml"]);
	});

	test("resolves `..` the way the kernel does, in the link's directory and in its text", async () => {
		// alias -> physical/nested. A plain write through either spelling lands on
		// physical/target.json; resolving `..` lexically would land beside alias.
		await fs.mkdir(path.join(root, "physical", "nested"), { recursive: true });
		const target = path.join(root, "physical", "target.json");
		await fs.writeFile(target, "old");
		await fs.symlink(path.join(root, "physical", "nested"), path.join(root, "alias"));
		await fs.symlink("../target.json", path.join(root, "alias", "from-dir.json"));
		await fs.symlink("alias/../target.json", path.join(root, "from-text.json"));

		await writeConfigFileAtomically(path.join(root, "alias", "from-dir.json"), "first", 0o644);
		expect(await fs.readFile(target, "utf8")).toBe("first");

		await writeConfigFileAtomically(path.join(root, "from-text.json"), "second", 0o644);
		expect(await fs.readFile(target, "utf8")).toBe("second");
		expect(fsSync.existsSync(path.join(root, "target.json"))).toBe(false);
	});

	test("a filename ending in a backslash is a filename, not a directory", async () => {
		// `\` is an ordinary character in a POSIX name; treating it as a separator
		// abandoned the chain at `middle\` and left the target unwritten.
		const target = path.join(root, "real");
		const middle = path.join(root, "middle\\");
		const link = path.join(root, "config.json");
		await linkTo(target, middle);
		await fs.symlink(middle, link);

		await writeConfigFileAtomically(link, "new", 0o644);

		expect(await fs.readFile(target, "utf8")).toBe("new");
		expect((await fs.lstat(middle)).isSymbolicLink()).toBe(true);
	});

	test("follows a chain of links", async () => {
		const target = path.join(root, "real");
		const middle = path.join(root, "middle");
		const link = path.join(root, "link");
		await linkTo(target, middle);
		await fs.symlink(middle, link);

		await writeConfigFileAtomically(link, "new", 0o644);

		expect((await fs.lstat(link)).isSymbolicLink()).toBe(true);
		expect((await fs.lstat(middle)).isSymbolicLink()).toBe(true);
		expect(await fs.readFile(target, "utf8")).toBe("new");
	});

	test("creates the file a dangling link names, as a plain write would", async () => {
		const target = path.join(root, "absent.json");
		const link = path.join(root, "link.json");
		await fs.symlink(target, link);

		await writeConfigFileAtomically(link, "new", 0o644);

		expect((await fs.lstat(link)).isSymbolicLink()).toBe(true);
		expect(await fs.readFile(target, "utf8")).toBe("new");
	});

	test("reports ELOOP for a link cycle instead of looping", async () => {
		const a = path.join(root, "a");
		const b = path.join(root, "b");
		await fs.symlink(b, a);
		await fs.symlink(a, b);

		await expect(writeConfigFileAtomically(a, "new", 0o644)).rejects.toThrow(/ELOOP/);
	});

	test("the sync writer never follows a link, even inside omp's own directories", async () => {
		// The boot config migration is its only caller. It is the one writer that
		// could not opt in even if it wanted to — there is no synchronous config
		// form — so a link at its destination is replaced, exactly as on main.
		const target = path.join(root, "real.yml");
		const link = path.join(root, "link.yml");
		await linkTo(target, link);

		writeFileAtomicallySync(link, "new", 0o644);

		expect((await fs.lstat(link)).isSymbolicLink()).toBe(false);
		expect(await fs.readFile(link, "utf8")).toBe("new");
		expect(await fs.readFile(target, "utf8")).toBe("old");
	});

	// Root bypasses the directory's mode bits and Windows has no POSIX modes.
	test.skipIf(process.platform === "win32" || isRoot)(
		"fails and leaves the link alone when the target's directory is unwritable",
		async () => {
			const locked = path.join(root, "locked");
			await fs.mkdir(locked);
			const target = path.join(locked, "config.yml");
			const link = path.join(root, "config.yml");
			await linkTo(target, link);
			await fs.chmod(locked, 0o500);

			await expect(writeConfigFileAtomically(link, "new", 0o644)).rejects.toThrow(/EACCES|EROFS|EPERM/);

			expect((await fs.lstat(link)).isSymbolicLink()).toBe(true);
			expect(await fs.readFile(target, "utf8")).toBe("old");
			await fs.chmod(locked, 0o700);
		},
	);

	test("publishes a staged file onto the link's target and removes the staged copy", async () => {
		const shared = path.join(root, "shared");
		const profile = path.join(root, "profile");
		await fs.mkdir(shared);
		await fs.mkdir(profile);
		const target = path.join(shared, "registry.json");
		const link = path.join(profile, "registry.json");
		await linkTo(target, link);
		const staged = path.join(profile, "registry.json.staged");
		await fs.writeFile(staged, "new");

		await replaceConfigFileAtomically(staged, link);

		expect((await fs.lstat(link)).isSymbolicLink()).toBe(true);
		expect(await fs.readFile(target, "utf8")).toBe("new");
		expect(fsSync.existsSync(staged)).toBe(false);
	});
});

describe("a config write never follows a link inside a project's own config directory", () => {
	// A repository commits whatever it likes in its `.omp`; following a link found
	// there would let a clone redirect the write onto any file its user can write.
	test("replaces the link and leaves the file it pointed at untouched", async () => {
		const victim = path.join(root, "victim");
		const link = path.join(project, "installed_plugins.json");
		await linkTo(victim, link, "untouched");

		await writeConfigFileAtomically(link, "new", 0o644);

		expect(await fs.readFile(victim, "utf8")).toBe("untouched");
		expect((await fs.lstat(link)).isSymbolicLink()).toBe(false);
		expect(await fs.readFile(link, "utf8")).toBe("new");
	});

	test("the staged form refuses it too, and the sync writer never reaches the rule", async () => {
		const victim = path.join(root, "victim-staged");
		const link = path.join(project, "mcp.json");
		await linkTo(victim, link, "untouched");
		const staged = path.join(project, "mcp.json.staged");
		await fs.writeFile(staged, "new");
		const syncVictim = path.join(root, "victim-sync");
		const syncLink = path.join(project, "config.yml");
		await linkTo(syncVictim, syncLink, "untouched");

		await replaceConfigFileAtomically(staged, link);
		writeFileAtomicallySync(syncLink, "new", 0o644);

		// Both leave the named file alone, for different reasons worth keeping
		// apart: the staged config form asks the rule and the rule says no, while
		// the sync writer never follows anything in the first place.
		expect(await fs.readFile(victim, "utf8")).toBe("untouched");
		expect(await fs.readFile(syncVictim, "utf8")).toBe("untouched");
		expect((await fs.lstat(syncLink)).isSymbolicLink()).toBe(false);
	});

	test("a nested project directory is recognised at any depth", async () => {
		const victim = path.join(root, "victim-deep");
		const deep = path.join(root, "wherever", "a", "checkout", "sits", ".omp", "plugins");
		await fs.mkdir(deep, { recursive: true });
		const link = path.join(deep, "installed_plugins.json");
		await linkTo(victim, link, "untouched");

		await writeConfigFileAtomically(link, "new", 0o644);

		expect(await fs.readFile(victim, "utf8")).toBe("untouched");
	});
});

describe("a write that does not ask to follow a link never does", () => {
	test("the plain writers replace a link, as they always have", async () => {
		const victim = path.join(root, "victim");
		const link = path.join(root, "session.jsonl");
		await linkTo(victim, link, "untouched");
		const stagedVictim = path.join(root, "victim-staged");
		const stagedLink = path.join(root, "artifact.bin");
		await linkTo(stagedVictim, stagedLink, "untouched");
		const staged = path.join(root, "artifact.bin.staged");
		await fs.writeFile(staged, "new");

		await writeFileAtomically(link, "new", 0o644);
		await replaceFileAtomically(staged, stagedLink);

		expect(await fs.readFile(victim, "utf8")).toBe("untouched");
		expect((await fs.lstat(link)).isSymbolicLink()).toBe(false);
		expect(await fs.readFile(stagedVictim, "utf8")).toBe("untouched");
		expect((await fs.lstat(stagedLink)).isSymbolicLink()).toBe(false);
	});
});

describe("writes to a plain destination are unchanged", () => {
	test("publish the content and stage nothing durable", async () => {
		const target = path.join(root, "plain.json");
		await fs.writeFile(target, "old");

		await writeConfigFileAtomically(target, "new", 0o600);

		expect(await fs.readFile(target, "utf8")).toBe("new");
		expect((await fs.readdir(root)).sort()).toEqual(["checkout", "plain.json"]);
	});

	test.skipIf(process.platform === "win32")("publish at the requested mode", async () => {
		const target = path.join(root, "moded.json");

		await writeConfigFileAtomically(target, "new", 0o600);

		expect((await fs.stat(target)).mode & 0o777).toBe(0o600);
	});

	test("create a destination that does not exist yet", async () => {
		const target = path.join(root, "fresh.json");

		await writeFileAtomically(target, "new", 0o644);

		expect(await fs.readFile(target, "utf8")).toBe("new");
		expect((await fs.lstat(target)).isSymbolicLink()).toBe(false);
	});

	test("move a read-only staged file between directories by rename, without copying", async () => {
		const from = path.join(root, "from");
		const to = path.join(root, "to");
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
});

describe("a config write follows a link only while it stays inside omp's directories", () => {
	// The narrowing, stated two-sided. A link whose target leaves omp's roots is
	// replaced — which is what upstream main does with every link, so nothing a
	// user has today is lost — and that is deliberate, not a gap.
	test("a link pointing out of omp's directories is replaced, as it is on main", async () => {
		const away = path.join(outside, "dotfiles-marketplaces.json");
		const link = path.join(root, "marketplaces.json");
		await linkTo(away, link, "the dotfiles copy");

		await writeConfigFileAtomically(link, "new", 0o644);

		expect(await fs.readFile(away, "utf8")).toBe("the dotfiles copy");
		expect((await fs.lstat(link)).isSymbolicLink()).toBe(false);
		expect(await fs.readFile(link, "utf8")).toBe("new");
	});

	test("a chain is followed only as far as it stays inside them", async () => {
		const away = path.join(outside, "away.json");
		const inside = path.join(root, "inside.json");
		const entry = path.join(root, "entry.json");
		await fs.writeFile(away, "the dotfiles copy");
		await fs.symlink(away, inside);
		await fs.symlink(inside, entry);

		await writeConfigFileAtomically(entry, "new", 0o644);

		// The first hop stays inside and is followed; the second leaves, so the
		// link that would have left is the one replaced.
		expect(await fs.readFile(away, "utf8")).toBe("the dotfiles copy");
		expect((await fs.lstat(entry)).isSymbolicLink()).toBe(true);
		expect((await fs.lstat(inside)).isSymbolicLink()).toBe(false);
		expect(await fs.readFile(inside, "utf8")).toBe("new");
	});
});

describe("a `..` in the path given to the writer is resolved by the filesystem", () => {
	// `path.resolve` collapses `alias/..` before anything physical happens, which
	// discards the component that says where the entry really is.
	test("walks into a project's config directory, and refuses the link there", async () => {
		const sub = path.join(project, "sub");
		await fs.mkdir(sub, { recursive: true });
		await fs.symlink(sub, path.join(root, "alias"));
		const victim = path.join(root, "victim-dotdot");
		const link = path.join(project, "entry.json");
		await linkTo(victim, link, "untouched");

		// Built by hand: `path.join` would collapse the `..` and the spelling under
		// test would never reach the writer.
		const spelled = `${root}${path.sep}alias${path.sep}..${path.sep}entry.json`;
		await writeConfigFileAtomically(spelled, "new", 0o644);

		expect(await fs.readFile(victim, "utf8")).toBe("untouched");
		expect((await fs.lstat(link)).isSymbolicLink()).toBe(false);
	});

	test("walks out of omp's directories, and refuses the link there", async () => {
		const sub = path.join(outside, "sub");
		await fs.mkdir(sub, { recursive: true });
		await fs.symlink(sub, path.join(root, "alias-out"));
		const victim = path.join(root, "victim-out");
		const link = path.join(outside, "entry.json");
		await linkTo(victim, link, "untouched");

		const spelled = `${root}${path.sep}alias-out${path.sep}..${path.sep}entry.json`;
		await writeConfigFileAtomically(spelled, "new", 0o644);

		expect(await fs.readFile(victim, "utf8")).toBe("untouched");
		expect((await fs.lstat(link)).isSymbolicLink()).toBe(false);
	});
});

describe("a declared root that is itself a symlink", () => {
	// `PI_CODING_AGENT_DIR` or a home directory can be given as a link to the
	// real directory. Comparing the declared spelling with the canonical one then
	// says the link sitting in that root is not in any root at all.
	test("still counts as a root, so a link directly in it is followed", async () => {
		const real = path.join(outside, "real-root");
		const declared = path.join(outside, "declared-root");
		await fs.mkdir(real);
		await fs.symlink(real, declared);
		setAgentDir(declared);

		const target = path.join(declared, "shared.json");
		const link = path.join(declared, "marketplaces.json");
		await linkTo(target, link);

		await writeConfigFileAtomically(link, "new", 0o644);

		expect((await fs.lstat(link)).isSymbolicLink()).toBe(true);
		expect(await fs.readFile(target, "utf8")).toBe("new");
	});
});

describe("the boundary reads names the way the filesystem does", () => {
	// `PI_CONFIG_DIR` is a path. Discovery resolves it, so `./custom/config`
	// names the directory `custom/config`; splitting the raw string gave a `.`
	// component no real directory has, and the project went unrecognised.
	test("a configured project directory spelled with `.` or `..` is still recognised", async () => {
		const previous = process.env.PI_CONFIG_DIR;
		process.env.PI_CONFIG_DIR = "./custom/config";
		try {
			const checkout = path.join(root, "checkout-spelled", "custom", "config");
			await fs.mkdir(checkout, { recursive: true });
			const victim = path.join(root, "victim-spelled");
			const link = path.join(checkout, "installed_plugins.json");
			await linkTo(victim, link, "untouched");

			await writeConfigFileAtomically(link, "new", 0o644);

			expect(await fs.readFile(victim, "utf8")).toBe("untouched");
			expect((await fs.lstat(link)).isSymbolicLink()).toBe(false);
		} finally {
			if (previous === undefined) delete process.env.PI_CONFIG_DIR;
			else process.env.PI_CONFIG_DIR = previous;
		}
	});

	test("a directory whose name merely starts with dots is inside its root", async () => {
		// `..ordinary` is a name, not a traversal; containment that tested the
		// prefix put it outside the root and stopped following links under it.
		const dir = path.join(root, "..ordinary");
		await fs.mkdir(dir);
		const target = path.join(root, "shared.json");
		const link = path.join(dir, "entry.json");
		await linkTo(target, link);

		await writeConfigFileAtomically(link, "new", 0o644);

		expect((await fs.lstat(link)).isSymbolicLink()).toBe(true);
		expect(await fs.readFile(target, "utf8")).toBe("new");
	});
});
