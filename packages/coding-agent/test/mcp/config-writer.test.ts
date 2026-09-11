import { $ } from "bun";
import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	addMCPServer,
	readDisabledServers,
	readMCPConfigFile,
	setServerDisabled,
	writeMCPConfigFile,
} from "../../src/mcp/config-writer";
import { publishSerializedConfig, withConfigFileLock } from "../../src/utils/atomic-file";

describe("config-writer concurrent mutations", () => {
	let dir: string;
	let filePath: string;

	beforeEach(async () => {
		dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "omp-mcp-config-"));
		filePath = path.join(dir, "mcp.json");
	});

	afterEach(async () => {
		await fs.promises.rm(dir, { recursive: true, force: true });
	});

	it("preserves both servers when two adds race the same file", async () => {
		await Promise.all([
			addMCPServer(filePath, "alpha", { type: "stdio", command: "a" }),
			addMCPServer(filePath, "bravo", { type: "stdio", command: "b" }),
		]);

		const config = await readMCPConfigFile(filePath);
		expect(Object.keys(config.mcpServers ?? {}).sort()).toEqual(["alpha", "bravo"]);
	});

	it("preserves both denylist edits when disable calls race", async () => {
		await Promise.all([setServerDisabled(filePath, "alpha", true), setServerDisabled(filePath, "bravo", true)]);

		expect((await readDisabledServers(filePath)).sort()).toEqual(["alpha", "bravo"]);
	});

	it("writes into a directory that does not exist yet", async () => {
		const nestedPath = path.join(dir, "nested", "deep", "mcp.json");
		await addMCPServer(nestedPath, "alpha", { type: "stdio", command: "a" });

		const config = await readMCPConfigFile(nestedPath);
		expect(Object.keys(config.mcpServers ?? {})).toEqual(["alpha"]);
	});
});

// rename() over a symlink path replaces the LINK with a regular file, so a
// config managed via symlink (e.g. a dotfiles checkout) must be written at its
// referent. These contracts pin that behavior; skipped on Windows where
// unprivileged symlink creation is unavailable.
describe.skipIf(process.platform === "win32")("config-writer symlinked configs", () => {
	let dir: string;

	beforeEach(async () => {
		dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "omp-mcp-symlink-"));
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		await fs.promises.rm(dir, { recursive: true, force: true });
	});

	it("writes to the referent and keeps the mcp.json symlink intact", async () => {
		const target = path.join(dir, "real-mcp.json");
		await fs.promises.writeFile(target, JSON.stringify({ mcpServers: {} }));
		const link = path.join(dir, "mcp.json");
		await fs.promises.symlink(target, link);

		await addMCPServer(link, "alpha", { type: "stdio", command: "a" });

		expect((await fs.promises.lstat(link)).isSymbolicLink()).toBe(true);
		const config = await readMCPConfigFile(link);
		expect(Object.keys(config.mcpServers ?? {})).toEqual(["alpha"]);
	});

	it("recreates the referent of a dangling mcp.json symlink", async () => {
		const target = path.join(dir, "shared", "real-mcp.json");
		const link = path.join(dir, "mcp.json");
		await fs.promises.symlink(target, link);

		await addMCPServer(link, "alpha", { type: "stdio", command: "a" });

		expect((await fs.promises.lstat(link)).isSymbolicLink()).toBe(true);
		const config = await readMCPConfigFile(link);
		expect(Object.keys(config.mcpServers ?? {})).toEqual(["alpha"]);
	});

	it("keeps only owner bits of the referent's mode (0o640 → 0o600, 0o400 stays 0o400)", async () => {
		// mcp.json carries credentials (server `env`, auth `headers`), so an
		// edit must not leave group/world bits in place; but a mode stricter
		// than owner-rw must not be loosened either.
		const groupReadable = path.join(dir, "group-readable.json");
		await fs.promises.writeFile(groupReadable, JSON.stringify({ mcpServers: {} }));
		await fs.promises.chmod(groupReadable, 0o640);
		const linkA = path.join(dir, "mcp-a.json");
		await fs.promises.symlink(groupReadable, linkA);

		await setServerDisabled(linkA, "alpha", true);
		expect((await fs.promises.stat(groupReadable)).mode & 0o777).toBe(0o600);

		const ownerReadOnly = path.join(dir, "owner-read-only.json");
		await fs.promises.writeFile(ownerReadOnly, JSON.stringify({ mcpServers: {} }));
		await fs.promises.chmod(ownerReadOnly, 0o400);
		const linkB = path.join(dir, "mcp-b.json");
		await fs.promises.symlink(ownerReadOnly, linkB);

		await setServerDisabled(linkB, "alpha", true);
		expect((await fs.promises.stat(ownerReadOnly)).mode & 0o777).toBe(0o400);
	});

	it("falls back to owner-only mode when the referent has no owner bits", async () => {
		// A referent whose access comes only from group/world bits or an ACL
		// masks to mode 0 — publishing that would leave the config unreadable
		// even by its owner, where the writers previously created 0o600. The
		// full read-modify-write cannot exercise this (reading a 0o060
		// referent fails with EACCES before the publisher runs), so the
		// shared publisher's own contract is asserted directly.
		const target = path.join(dir, "group-only.json");
		await fs.promises.writeFile(target, JSON.stringify({ mcpServers: {} }));
		await fs.promises.chmod(target, 0o060);

		await publishSerializedConfig(
			target,
			JSON.stringify({
				mcpServers: { alpha: { type: "stdio", command: "a" } },
			}),
		);

		expect((await fs.promises.stat(target)).mode & 0o777).toBe(0o600);
		expect(JSON.parse(await fs.promises.readFile(target, "utf8")).mcpServers?.alpha).toBeDefined();
	});

	it("follows a directory symlink inside a dangling relative target before applying ..", async () => {
		// mcp.json -> alias/../config.json where `alias` is a symlinked
		// directory (alias -> elsewhere/deep) and config.json does not exist.
		// The filesystem follows `alias` first and then pops its PHYSICAL
		// parent, so the write must land on elsewhere/config.json — a lexical
		// path.resolve() would collapse `alias/..` to the link's own directory
		// and clobber an unrelated sibling there.
		const deepDir = path.join(dir, "elsewhere", "deep");
		await fs.promises.mkdir(deepDir, { recursive: true });
		await fs.promises.symlink(deepDir, path.join(dir, "alias"));
		const link = path.join(dir, "mcp.json");
		await fs.promises.symlink("alias/../config.json", link);
		const lexicalSibling = path.join(dir, "config.json");

		await addMCPServer(link, "alpha", { type: "stdio", command: "a" });

		expect((await fs.promises.lstat(link)).isSymbolicLink()).toBe(true);
		// The write landed on the PHYSICAL parent (`alias` followed, then `..`
		// popped its real parent), never on the lexical sibling.
		const physicalTarget = path.join(dir, "elsewhere", "config.json");
		expect((await fs.promises.stat(physicalTarget)).isFile()).toBe(true);
		await expect(fs.promises.stat(lexicalSibling)).rejects.toMatchObject({
			code: "ENOENT",
		});
		const config = await readMCPConfigFile(link);
		expect(Object.keys(config.mcpServers ?? {})).toEqual(["alpha"]);
	});

	it("serializes read-modify-writes that alias one target through two symlinks", async () => {
		// Two configured paths, one physical mcp.json. The write lock must be
		// taken on the resolved target so both mutations land; locking each
		// logical path separately lets both read the same old JSON and the
		// last rename drop the other's server.
		const target = path.join(dir, "real-mcp.json");
		await fs.promises.writeFile(target, JSON.stringify({ mcpServers: {} }));
		const linkA = path.join(dir, "mcp-a.json");
		const linkB = path.join(dir, "mcp-b.json");
		await fs.promises.symlink(target, linkA);
		await fs.promises.symlink(target, linkB);

		await Promise.all([
			addMCPServer(linkA, "alpha", { type: "stdio", command: "a" }),
			addMCPServer(linkB, "bravo", { type: "stdio", command: "b" }),
		]);

		const config = await readMCPConfigFile(linkA);
		expect(Object.keys(config.mcpServers ?? {}).sort()).toEqual(["alpha", "bravo"]);
	});

	it("follows a dangling intermediate directory symlink instead of freezing on the link", async () => {
		// mcp.json -> alias/config.json where `alias` is itself a dangling
		// symlink to a missing directory. The walk must follow `alias` and
		// recreate its referent (missing-dir/config.json); freezing on the
		// link path would leave the writer unable to create anything through
		// the link.
		await fs.promises.symlink("missing-dir", path.join(dir, "alias"));
		const link = path.join(dir, "mcp.json");
		await fs.promises.symlink("alias/config.json", link);

		await addMCPServer(link, "alpha", { type: "stdio", command: "a" });

		expect((await fs.promises.lstat(link)).isSymbolicLink()).toBe(true);
		expect((await fs.promises.lstat(path.join(dir, "alias"))).isSymbolicLink()).toBe(true);
		const config = await readMCPConfigFile(link);
		expect(Object.keys(config.mcpServers ?? {})).toEqual(["alpha"]);
	});

	it("collapses aliased parent directories onto one lock for a first-time config", async () => {
		// alias-a and alias-b both point at real/; mcp.json does not exist yet.
		// Creating it through either alias must lock on the same physical
		// parent, or the two first-time adds race on different lexical paths
		// and one mutation is lost.
		const realDir = path.join(dir, "real");
		await fs.promises.mkdir(realDir);
		await fs.promises.symlink(realDir, path.join(dir, "alias-a"));
		await fs.promises.symlink(realDir, path.join(dir, "alias-b"));

		await Promise.all([
			addMCPServer(path.join(dir, "alias-a", "mcp.json"), "alpha", {
				type: "stdio",
				command: "a",
			}),
			addMCPServer(path.join(dir, "alias-b", "mcp.json"), "bravo", {
				type: "stdio",
				command: "b",
			}),
		]);

		const config = await readMCPConfigFile(path.join(realDir, "mcp.json"));
		expect(Object.keys(config.mcpServers ?? {}).sort()).toEqual(["alpha", "bravo"]);
	});

	it("treats interior separators after a missing component as inert", async () => {
		// `managed//mcp.json` and `managed/./mcp.json` are equivalent
		// spellings of `managed/mcp.json`; only a TRAILING separator demands
		// the frozen component be a directory. Both links must write
		// successfully into the created `managed/` directory.
		const doubleSlash = path.join(dir, "mcp-a.json");
		await fs.promises.symlink("managed//mcp.json", doubleSlash);
		await addMCPServer(doubleSlash, "alpha", { type: "stdio", command: "a" });
		expect((await fs.promises.lstat(doubleSlash)).isSymbolicLink()).toBe(true);

		const dotSegment = path.join(dir, "mcp-b.json");
		await fs.promises.symlink("managed/./mcp.json", dotSegment);
		await addMCPServer(dotSegment, "bravo", { type: "stdio", command: "b" });
		expect((await fs.promises.lstat(dotSegment)).isSymbolicLink()).toBe(true);

		const config = await readMCPConfigFile(path.join(dir, "managed", "mcp.json"));
		expect(Object.keys(config.mcpServers ?? {}).sort()).toEqual(["alpha", "bravo"]);
	});

	it("pins the lock callback to the resolved target even if the link is retargeted mid-callback", async () => {
		const original = path.join(dir, "original.json");
		const retarget = path.join(dir, "retarget.json");
		await fs.promises.writeFile(original, JSON.stringify({ mcpServers: {} }));
		const link = path.join(dir, "mcp.json");
		await fs.promises.symlink(original, link);

		let pinned: string | undefined;
		await withConfigFileLock(link, async writePath => {
			pinned = writePath;
			// Retarget the link while the lock is held: the callback must
			// still see and use the locked referent.
			await fs.promises.unlink(link);
			await fs.promises.symlink(retarget, link);
			await fs.promises.writeFile(
				writePath,
				JSON.stringify({
					mcpServers: { pinned: { type: "stdio", command: "x" } },
				}),
			);
		});

		expect(pinned).toBe(original);
		expect(Object.keys(JSON.parse(await fs.promises.readFile(original, "utf-8")).mcpServers)).toEqual(["pinned"]);
		expect(await fs.promises.readFile(link, "utf-8").catch(() => "")).toBe("");
	});

	it("recreates the referent of a dangling ancestor directory link", async () => {
		// `dotfiles-link -> missing/dotfiles` (dangling DIRECTORY link) with
		// the config path INSIDE it: lstat through the dangling link is ENOENT
		// and realpath(parent) cannot resolve either, so the resolver must
		// walk the full path, follow the ancestor link, and recreate
		// missing/dotfiles/mcp.json instead of failing mkdir through the link.
		const linkDir = path.join(dir, "dotfiles-link");
		await fs.promises.symlink(path.join(dir, "missing", "dotfiles"), linkDir);

		await addMCPServer(path.join(linkDir, "mcp.json"), "alpha", {
			type: "stdio",
			command: "a",
		});

		expect((await fs.promises.lstat(linkDir)).isSymbolicLink()).toBe(true);
		const config = await readMCPConfigFile(path.join(dir, "missing", "dotfiles", "mcp.json"));
		expect(Object.keys(config.mcpServers ?? {})).toEqual(["alpha"]);
	});

	it("recreates the referent of a dangling ancestor link whose target ends with a separator", async () => {
		// `dotfiles-link -> missing/dotfiles/` — the trailing separator in the
		// link target names a directory only if nothing follows it; the config
		// leaf continues THROUGH it, so the walk must defer that demand and
		// recreate missing/dotfiles/mcp.json instead of surfacing ENOTDIR.
		const linkDir = path.join(dir, "dotfiles-link");
		await fs.promises.symlink(path.join(dir, "missing", "dotfiles") + path.sep, linkDir);

		await addMCPServer(path.join(linkDir, "mcp.json"), "alpha", {
			type: "stdio",
			command: "a",
		});

		expect((await fs.promises.lstat(linkDir)).isSymbolicLink()).toBe(true);
		const config = await readMCPConfigFile(path.join(dir, "missing", "dotfiles", "mcp.json"));
		expect(Object.keys(config.mcpServers ?? {})).toEqual(["alpha"]);
	});

	it("rejects a dangling link whose entire target names a directory", async () => {
		// `mcp.json -> missing-dir/`: the trailing separator is TERMINAL — the
		// whole resolution names a directory, which a config publish can never
		// target — so the write surfaces ENOTDIR instead of staging a regular
		// file where the referent directory belongs.
		await fs.promises.symlink("missing-dir/", path.join(dir, "mcp.json"));

		await expect(
			addMCPServer(path.join(dir, "mcp.json"), "alpha", {
				type: "stdio",
				command: "a",
			}),
		).rejects.toMatchObject({ code: "ENOTDIR" });
	});

	it("permits the host's full symlink-hop budget and rejects one past it", async () => {
		// MAXSYMLINKS is a kernel limit, not a constant: Linux resolves forty
		// symlink traversals and fails the forty-first, Darwin caps at
		// thirty-two. The boundary the walk must match is the HOST's, so a
		// maximally deep (but legal) chain still recreates its referent
		// instead of surfacing ELOOP one hop early — or, on Darwin, instead
		// of asserting Linux's forty and failing against the kernel's 32.
		const maxHops = process.platform === "darwin" ? 32 : 40;
		const hopChain = async (base: string, links: number): Promise<string> => {
			for (let i = 0; i < links; i++) {
				// a0 -> a1 -> …; the last link names the missing directory
				// the write must recreate through the chain.
				const target = i + 1 < links ? `a${i + 1}` : "missing-dir";
				await fs.promises.symlink(target, path.join(base, `a${i}`));
			}
			return path.join(base, "a0", "mcp.json");
		};

		const atLimit = path.join(dir, "at-limit");
		await fs.promises.mkdir(atLimit);
		await addMCPServer(await hopChain(atLimit, maxHops), "alpha", {
			type: "stdio",
			command: "a",
		});
		const config = await readMCPConfigFile(path.join(atLimit, "a0", "mcp.json"));
		expect(Object.keys(config.mcpServers ?? {})).toEqual(["alpha"]);

		const pastLimit = path.join(dir, "past-limit");
		await fs.promises.mkdir(pastLimit);
		await expect(
			addMCPServer(await hopChain(pastLimit, maxHops + 1), "alpha", {
				type: "stdio",
				command: "a",
			}),
		).rejects.toMatchObject({
			code: "ELOOP",
		});
	});

	it("counts the config link's own hop against the ancestor-chain budget", async () => {
		// `mcp.json -> missing/../dir/a0/config.json` over a dangling link
		// chain: the config link itself is ONE traversal, and the kernel's
		// MAXSYMLINKS caps the TOTAL for one open — so a chain making the
		// whole path exceed the budget must reject with ELOOP. Resolving it
		// anyway would "successfully" publish to a referent the repaired link
		// can never open. A total exactly AT the budget succeeds and stays
		// readable back through the link.
		const maxHops = process.platform === "darwin" ? 32 : 40;
		const chain = async (base: string, links: number): Promise<void> => {
			for (let i = 0; i < links; i++) {
				const target = i + 1 < links ? `a${i + 1}` : "dest";
				await fs.promises.symlink(target, path.join(base, `a${i}`));
			}
		};

		const atLimit = path.join(dir, "total-at-limit");
		await fs.promises.mkdir(path.join(atLimit, "dir"), { recursive: true });
		await chain(path.join(atLimit, "dir"), maxHops - 1); // chain links + the config link = budget
		const atLimitLink = path.join(atLimit, "mcp.json");
		await fs.promises.symlink("missing/../dir/a0/config.json", atLimitLink);
		await addMCPServer(atLimitLink, "alpha", {
			type: "stdio",
			command: "a",
		});
		// The write must land where the KERNEL can read it back through the link.
		const config = await readMCPConfigFile(atLimitLink);
		expect(Object.keys(config.mcpServers ?? {})).toEqual(["alpha"]);

		const pastLimit = path.join(dir, "total-past-limit");
		await fs.promises.mkdir(path.join(pastLimit, "dir"), { recursive: true });
		await chain(path.join(pastLimit, "dir"), maxHops); // chain links + the config link = budget + 1
		await fs.promises.symlink("missing/../dir/a0/config.json", path.join(pastLimit, "mcp.json"));
		await expect(
			addMCPServer(path.join(pastLimit, "mcp.json"), "alpha", {
				type: "stdio",
				command: "a",
			}),
		).rejects.toMatchObject({
			code: "ELOOP",
		});
	});

	it("walks an alias and .. in a missing leaf path physically, not lexically", async () => {
		// /base/alias/../mcp.json where `alias -> /other/deep`. The kernel
		// follows `alias` first and pops its PHYSICAL parent, so the write must
		// land on /other/mcp.json — path.resolve() would lexically collapse the
		// spelling onto the unrelated /base/mcp.json sibling and clobber it.
		const baseDir = path.join(dir, "base");
		const deepDir = path.join(dir, "other", "deep");
		await fs.promises.mkdir(baseDir, { recursive: true });
		await fs.promises.mkdir(deepDir, { recursive: true });
		await fs.promises.symlink(deepDir, path.join(baseDir, "alias"));
		const configPath = `${baseDir}${path.sep}alias${path.sep}..${path.sep}mcp.json`;

		await addMCPServer(configPath, "alpha", { type: "stdio", command: "a" });

		const physical = path.join(dir, "other", "mcp.json");
		const lexicalSibling = path.join(baseDir, "mcp.json");
		const config = await readMCPConfigFile(physical);
		expect(Object.keys(config.mcpServers ?? {})).toEqual(["alpha"]);
		await expect(fs.promises.stat(lexicalSibling)).rejects.toMatchObject({
			code: "ENOENT",
		});
	});

	it("refuses to publish over a FIFO referent and leaves it intact", async () => {
		// rename() over a FIFO destroys the special object. A config symlink
		// resolving to one must be refused up front, not written through.
		const fifo = path.join(dir, "pipe");
		await $`mkfifo ${fifo}`;
		const link = path.join(dir, "mcp.json");
		await fs.promises.symlink(fifo, link);

		await expect(writeMCPConfigFile(link, { mcpServers: {} })).rejects.toThrow(/not a regular file/);

		expect((await fs.promises.lstat(fifo)).isFIFO()).toBe(true);
		expect((await fs.promises.lstat(link)).isSymbolicLink()).toBe(true);
	});

	it("follows a component that appears as a directory symlink during the repair", async () => {
		// mcp.json -> managed/../config.json with `managed` missing. Between
		// the resolver's failed lstat and its repair mkdir, another process
		// creates `managed` as a symlink to an existing directory: the
		// recursive mkdir succeeds through the link, and the original
		// spelling now resolves THROUGH it — `..` must pop the referent's
		// REAL parent, or the write lands on the lexical sibling while
		// reporting success.
		const deep = path.join(dir, "elsewhere", "deep");
		await fs.promises.mkdir(deep, { recursive: true });
		const managed = path.join(dir, "managed");
		const link = path.join(dir, "mcp.json");
		await fs.promises.symlink("managed/../config.json", link);

		const realMkdir = fs.promises.mkdir.bind(fs.promises);
		let injected = false;
		// Spy on the fs.promises seam the resolver actually calls;
		// node:fs/promises is a separate namespace object in Bun. The cast
		// collapses mkdir's three overloads onto the mock's single signature.
		const racingMkdir = (async (target: string, options: unknown) => {
			if (!injected && String(target) === managed) {
				injected = true;
				await fs.promises.symlink(deep, managed);
				return;
			}
			return realMkdir(target, options as Parameters<typeof realMkdir>[1]);
		}) as unknown as typeof fs.promises.mkdir;
		vi.spyOn(fs.promises, "mkdir").mockImplementation(racingMkdir);

		await addMCPServer(link, "alpha", { type: "stdio", command: "a" });

		expect(injected).toBe(true);
		// Through the link: managed -> elsewhere/deep, `..` pops elsewhere.
		const physicalTarget = path.join(dir, "elsewhere", "config.json");
		expect((await fs.promises.stat(physicalTarget)).isFile()).toBe(true);
		await expect(fs.promises.stat(path.join(dir, "config.json"))).rejects.toMatchObject({ code: "ENOENT" });
		expect((await fs.promises.lstat(managed)).isSymbolicLink()).toBe(true);
		expect((await fs.promises.lstat(link)).isSymbolicLink()).toBe(true);
	});

	it("repairs a missing component reached through a dangling link before ..", async () => {
		// mcp.json -> inner/../config.json with `inner -> missing` (dangling).
		// Materializing `missing` as a directory makes the original spelling
		// resolve normally — the same repair as a plainly-missing
		// `managed/../config.json`, just reached through a dangling link.
		const link = path.join(dir, "mcp.json");
		await fs.promises.symlink("inner/../config.json", link);
		await fs.promises.symlink("missing", path.join(dir, "inner"));

		await addMCPServer(link, "alpha", { type: "stdio", command: "a" });

		expect((await fs.promises.lstat(link)).isSymbolicLink()).toBe(true);
		expect((await fs.promises.lstat(path.join(dir, "inner"))).isSymbolicLink()).toBe(true);
		expect((await fs.promises.lstat(path.join(dir, "missing"))).isDirectory()).toBe(true);
		const config = await readMCPConfigFile(path.join(dir, "config.json"));
		expect(Object.keys(config.mcpServers ?? {})).toEqual(["alpha"]);
	});
});
