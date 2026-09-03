import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { addMCPServer, readDisabledServers, readMCPConfigFile, setServerDisabled } from "../../src/mcp/config-writer";

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
});
