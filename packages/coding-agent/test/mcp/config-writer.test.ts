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

	it("preserves the referent's file mode through the write", async () => {
		const target = path.join(dir, "real-mcp.json");
		await fs.writeFile(target, JSON.stringify({ mcpServers: {} }), { mode: 0o640 });
		await fs.chmod(target, 0o640);
		const link = path.join(dir, "mcp.json");
		await fs.symlink(target, link);

		await setServerDisabled(link, "alpha", true);

		expect((await fs.stat(target)).mode & 0o777).toBe(0o640);
	});
});
