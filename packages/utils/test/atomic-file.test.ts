import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fsSync from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	replaceFileAtomically,
	writeConfigFileAtomically,
	writeFileAtomically,
	writeFileAtomicallySync,
} from "../src/atomic-file";
import { getAgentDir, setAgentDir } from "../src/dirs";
import { removeWithRetries } from "../src/temp";

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

	test("stages beside the file the link names, so the publish is one rename in that directory", async () => {
		const shared = path.join(root, "shared");
		const profile = path.join(root, "profile");
		await fs.mkdir(shared);
		await fs.mkdir(profile);
		const target = path.join(shared, "registry.json");
		const link = path.join(profile, "registry.json");
		await linkTo(target, link);

		await writeConfigFileAtomically(link, "new", 0o644);

		expect((await fs.lstat(link)).isSymbolicLink()).toBe(true);
		expect(await fs.readFile(target, "utf8")).toBe("new");
		// Nothing is left behind on either side, and in particular the staging
		// never happened beside the LINK — staging there and renaming onto the
		// target is what fails EXDEV once the two are on different filesystems.
		expect(await fs.readdir(profile)).toEqual(["registry.json"]);
		expect(await fs.readdir(shared)).toEqual(["registry.json"]);
	});

	test("publishes onto a link whose target has a legal but very long name", async () => {
		// Resolving before staging puts the TARGET's basename in the staging name,
		// so a target the filesystem accepts at 245 bytes became a 290-byte staging
		// name and every registry write failed ENAMETOOLONG. A reviewer reproduced
		// that through `omp plugin marketplace add` on all three registries. The
		// name a user chose is legal; the name we derive from it must be too.
		const shared = path.join(root, "shared-long");
		await fs.mkdir(shared);
		const longName = `${"r".repeat(240)}.json`;
		const target = path.join(shared, longName);
		const link = path.join(root, "marketplaces.json");
		await fs.writeFile(target, "old");
		await fs.symlink(target, link);

		await writeConfigFileAtomically(link, "new", 0o644);

		expect((await fs.lstat(link)).isSymbolicLink()).toBe(true);
		expect(await fs.readFile(target, "utf8")).toBe("new");
		expect(await fs.readdir(shared)).toEqual([longName]);
	});

	// A link from one accepted root to another where the two sit on DIFFERENT
	// filesystems: the config root under a temp `HOME`, the agent directory on
	// tmpfs. `PI_CODING_AGENT_DIR` exists precisely to relocate the agent
	// directory, so this needs no exotic layout — and staging beside the path as
	// GIVEN, then renaming onto the resolved one, fails `EXDEV` here and loses the
	// write. Two reviewers reproduced that through `omp plugin marketplace add`.
	//
	// It runs in a CHILD process because the config root comes from `os.homedir()`,
	// which does not follow a later `process.env.HOME`: the only way to have two
	// accepted roots on two filesystems is to set `HOME` before the module loads.
	test.skipIf(!fsSync.existsSync("/dev/shm"))(
		"publishes onto a link that leaves this filesystem but stays inside omp's directories",
		async () => {
			const home = await fs.mkdtemp(path.join(os.tmpdir(), "atomic-file-home-"));
			const elsewhere = await fs.mkdtemp(path.join("/dev/shm", "atomic-file-agent-"));
			try {
				const configRoot = path.join(home, ".omp");
				await fs.mkdir(configRoot);
				if (fsSync.statSync(configRoot).dev === fsSync.statSync(elsewhere).dev) return;

				const target = path.join(elsewhere, "shared.json");
				const link = path.join(configRoot, "marketplaces.json");
				await fs.writeFile(target, "old");
				await fs.symlink(target, link);

				const script = path.join(home, "write.ts");
				await fs.writeFile(
					script,
					`import { writeConfigFileAtomically } from ${JSON.stringify(path.join(import.meta.dir, "..", "src", "atomic-file.ts"))};\n` +
						`await writeConfigFileAtomically(${JSON.stringify(link)}, "new", 0o644);\n`,
				);
				const child = Bun.spawnSync([process.execPath, "run", script], {
					env: { ...process.env, HOME: home, PI_CODING_AGENT_DIR: elsewhere },
					stderr: "pipe",
				});

				expect(child.stderr.toString()).toBe("");
				expect(child.exitCode).toBe(0);
				expect((await fs.lstat(link)).isSymbolicLink()).toBe(true);
				expect(await fs.readFile(target, "utf8")).toBe("new");
				// No staging debris beside the link, where a cross-device publish
				// would have had to leave it.
				expect((await fs.readdir(configRoot)).sort()).toEqual(["marketplaces.json"]);
			} finally {
				await removeWithRetries(elsewhere);
				await removeWithRetries(home);
			}
		},
	);
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

	test("the sync writer never reaches the rule, and leaves the named file alone anyway", async () => {
		const syncVictim = path.join(root, "victim-sync");
		const syncLink = path.join(project, "config.yml");
		await linkTo(syncVictim, syncLink, "untouched");

		writeFileAtomicallySync(syncLink, "new", 0o644);

		// Same outcome as the config form on this path, for a different reason
		// worth keeping apart: the config form asks the rule and the rule says no,
		// while the sync writer never follows anything in the first place.
		expect(await fs.readFile(syncVictim, "utf8")).toBe("untouched");
		expect((await fs.lstat(syncLink)).isSymbolicLink()).toBe(false);
		expect(await fs.readFile(syncLink, "utf8")).toBe("new");
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
