import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { addMCPServer, readDisabledServers, readMCPConfigFile, setServerDisabled } from "../../src/mcp/config-writer";
import { withConfigFileLock } from "../../src/utils/atomic-file";

describe("config-writer concurrent mutations", () => {
	let dir: string;
	let filePath: string;

	beforeEach(async () => {
		dir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-mcp-config-"));
		filePath = path.join(dir, "mcp.json");
	});

	afterEach(async () => {
		await fs.rm(dir, { recursive: true, force: true });
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
		dir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-mcp-symlink-"));
	});

	afterEach(async () => {
		await fs.rm(dir, { recursive: true, force: true });
	});

	it("writes to the referent and keeps the mcp.json symlink intact", async () => {
		const target = path.join(dir, "real-mcp.json");
		await fs.writeFile(target, JSON.stringify({ mcpServers: {} }));
		const link = path.join(dir, "mcp.json");
		await fs.symlink(target, link);

		await addMCPServer(link, "alpha", { type: "stdio", command: "a" });

		expect((await fs.lstat(link)).isSymbolicLink()).toBe(true);
		const config = await readMCPConfigFile(link);
		expect(Object.keys(config.mcpServers ?? {})).toEqual(["alpha"]);
	});

	it("recreates the referent of a dangling mcp.json symlink", async () => {
		const target = path.join(dir, "shared", "real-mcp.json");
		const link = path.join(dir, "mcp.json");
		await fs.symlink(target, link);

		await addMCPServer(link, "alpha", { type: "stdio", command: "a" });

		expect((await fs.lstat(link)).isSymbolicLink()).toBe(true);
		const config = await readMCPConfigFile(link);
		expect(Object.keys(config.mcpServers ?? {})).toEqual(["alpha"]);
	});

	it("keeps only owner bits of the referent's mode (0o640 → 0o600, 0o400 stays 0o400)", async () => {
		// mcp.json carries credentials (server `env`, auth `headers`), so an
		// edit must not leave group/world bits in place; but a mode stricter
		// than owner-rw must not be loosened either.
		const groupReadable = path.join(dir, "group-readable.json");
		await fs.writeFile(groupReadable, JSON.stringify({ mcpServers: {} }));
		await fs.chmod(groupReadable, 0o640);
		const linkA = path.join(dir, "mcp-a.json");
		await fs.symlink(groupReadable, linkA);

		await setServerDisabled(linkA, "alpha", true);
		expect((await fs.stat(groupReadable)).mode & 0o777).toBe(0o600);

		const ownerReadOnly = path.join(dir, "owner-read-only.json");
		await fs.writeFile(ownerReadOnly, JSON.stringify({ mcpServers: {} }));
		await fs.chmod(ownerReadOnly, 0o400);
		const linkB = path.join(dir, "mcp-b.json");
		await fs.symlink(ownerReadOnly, linkB);

		await setServerDisabled(linkB, "alpha", true);
		expect((await fs.stat(ownerReadOnly)).mode & 0o777).toBe(0o400);
	});

	it("follows a directory symlink inside a dangling relative target before applying ..", async () => {
		// mcp.json -> alias/../config.json where `alias` is a symlinked
		// directory (alias -> elsewhere/deep) and config.json does not exist.
		// The filesystem follows `alias` first and then pops its PHYSICAL
		// parent, so the write must land on elsewhere/config.json — a lexical
		// path.resolve() would collapse `alias/..` to the link's own directory
		// and clobber an unrelated sibling there.
		const deepDir = path.join(dir, "elsewhere", "deep");
		await fs.mkdir(deepDir, { recursive: true });
		await fs.symlink(deepDir, path.join(dir, "alias"));
		const link = path.join(dir, "mcp.json");
		await fs.symlink("alias/../config.json", link);
		const lexicalSibling = path.join(dir, "config.json");

		await addMCPServer(link, "alpha", { type: "stdio", command: "a" });

		expect((await fs.lstat(link)).isSymbolicLink()).toBe(true);
		// The write landed on the PHYSICAL parent (`alias` followed, then `..`
		// popped its real parent), never on the lexical sibling.
		const physicalTarget = path.join(dir, "elsewhere", "config.json");
		expect((await fs.stat(physicalTarget)).isFile()).toBe(true);
		await expect(fs.stat(lexicalSibling)).rejects.toMatchObject({ code: "ENOENT" });
		const config = await readMCPConfigFile(link);
		expect(Object.keys(config.mcpServers ?? {})).toEqual(["alpha"]);
	});

	it("serializes read-modify-writes that alias one target through two symlinks", async () => {
		// Two configured paths, one physical mcp.json. The write lock must be
		// taken on the resolved target so both mutations land; locking each
		// logical path separately lets both read the same old JSON and the
		// last rename drop the other's server.
		const target = path.join(dir, "real-mcp.json");
		await fs.writeFile(target, JSON.stringify({ mcpServers: {} }));
		const linkA = path.join(dir, "mcp-a.json");
		const linkB = path.join(dir, "mcp-b.json");
		await fs.symlink(target, linkA);
		await fs.symlink(target, linkB);

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
		await fs.symlink("missing-dir", path.join(dir, "alias"));
		const link = path.join(dir, "mcp.json");
		await fs.symlink("alias/config.json", link);

		await addMCPServer(link, "alpha", { type: "stdio", command: "a" });

		expect((await fs.lstat(link)).isSymbolicLink()).toBe(true);
		expect((await fs.lstat(path.join(dir, "alias"))).isSymbolicLink()).toBe(true);
		const config = await readMCPConfigFile(link);
		expect(Object.keys(config.mcpServers ?? {})).toEqual(["alpha"]);
	});

	it("collapses aliased parent directories onto one lock for a first-time config", async () => {
		// alias-a and alias-b both point at real/; mcp.json does not exist yet.
		// Creating it through either alias must lock on the same physical
		// parent, or the two first-time adds race on different lexical paths
		// and one mutation is lost.
		const realDir = path.join(dir, "real");
		await fs.mkdir(realDir);
		await fs.symlink(realDir, path.join(dir, "alias-a"));
		await fs.symlink(realDir, path.join(dir, "alias-b"));

		await Promise.all([
			addMCPServer(path.join(dir, "alias-a", "mcp.json"), "alpha", { type: "stdio", command: "a" }),
			addMCPServer(path.join(dir, "alias-b", "mcp.json"), "bravo", { type: "stdio", command: "b" }),
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
		await fs.symlink("managed//mcp.json", doubleSlash);
		await addMCPServer(doubleSlash, "alpha", { type: "stdio", command: "a" });
		expect((await fs.lstat(doubleSlash)).isSymbolicLink()).toBe(true);

		const dotSegment = path.join(dir, "mcp-b.json");
		await fs.symlink("managed/./mcp.json", dotSegment);
		await addMCPServer(dotSegment, "bravo", { type: "stdio", command: "b" });
		expect((await fs.lstat(dotSegment)).isSymbolicLink()).toBe(true);

		const config = await readMCPConfigFile(path.join(dir, "managed", "mcp.json"));
		expect(Object.keys(config.mcpServers ?? {}).sort()).toEqual(["alpha", "bravo"]);
	});

	it("pins the lock callback to the resolved target even if the link is retargeted mid-callback", async () => {
		const original = path.join(dir, "original.json");
		const retarget = path.join(dir, "retarget.json");
		await fs.writeFile(original, JSON.stringify({ mcpServers: {} }));
		const link = path.join(dir, "mcp.json");
		await fs.symlink(original, link);

		let pinned: string | undefined;
		await withConfigFileLock(link, async writePath => {
			pinned = writePath;
			// Retarget the link while the lock is held: the callback must
			// still see and use the locked referent.
			await fs.unlink(link);
			await fs.symlink(retarget, link);
			await fs.writeFile(writePath, JSON.stringify({ mcpServers: { pinned: { type: "stdio", command: "x" } } }));
		});

		expect(pinned).toBe(original);
		expect(Object.keys(JSON.parse(await fs.readFile(original, "utf-8")).mcpServers)).toEqual(["pinned"]);
		expect(await fs.readFile(link, "utf-8").catch(() => "")).toBe("");
	});
});
