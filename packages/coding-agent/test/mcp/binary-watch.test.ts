import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { McpBinaryWatcher, resolveWatchedPaths } from "../../src/mcp/binary-watch";

const POLL_MS = 20;

describe("McpBinaryWatcher", () => {
	const dirs: string[] = [];
	const watchers: McpBinaryWatcher[] = [];

	afterEach(async () => {
		for (const watcher of watchers.splice(0)) watcher.dispose();
		for (const dir of dirs.splice(0)) await fs.rm(dir, { recursive: true, force: true });
	});

	async function fixture(): Promise<{ dir: string; script: string }> {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-binary-watch-"));
		dirs.push(dir);
		const script = path.join(dir, "server.js");
		await fs.writeFile(script, "console.log(1);\n");
		return { dir, script };
	}

	function start(onChange: (name: string, changed: string[]) => void): McpBinaryWatcher {
		const watcher = new McpBinaryWatcher(onChange, POLL_MS);
		watchers.push(watcher);
		return watcher;
	}

	async function settle(): Promise<void> {
		await Bun.sleep(POLL_MS * 8);
	}

	it("resolves the command and script arguments, not flags or URLs", async () => {
		const { dir, script } = await fixture();
		const paths = await resolveWatchedPaths({
			command: "node",
			args: ["--flag", "https://example.com/x", "server.js", "missing.js"],
			cwd: dir,
		});
		expect(paths).toContain(script);
		expect(paths.filter(p => p.endsWith("missing.js") || p.includes("example.com"))).toEqual([]);
		expect(paths.length).toBe(2);
	});

	it("reports a script whose bytes changed", async () => {
		const { dir, script } = await fixture();
		const changes: Array<[string, string[]]> = [];
		const watcher = start((name, changed) => changes.push([name, changed]));
		await watcher.watch("srv", { command: "node", args: ["server.js"], cwd: dir });

		await fs.writeFile(script, "console.log(2);\n");
		await settle();

		expect(changes.length).toBe(1);
		expect(changes[0][0]).toBe("srv");
		expect(changes[0][1]).toEqual([script]);
	});

	it("ignores a touch that leaves the bytes identical", async () => {
		const { dir, script } = await fixture();
		const changes: string[] = [];
		const watcher = start(name => changes.push(name));
		await watcher.watch("srv", { command: "node", args: ["server.js"], cwd: dir });

		const future = new Date(Date.now() + 60_000);
		await fs.utimes(script, future, future);
		await settle();

		expect(changes).toEqual([]);
	});

	it("fires once per change, then again for the next one", async () => {
		const { dir, script } = await fixture();
		const changes: string[] = [];
		const watcher = start(name => changes.push(name));
		await watcher.watch("srv", { command: "node", args: ["server.js"], cwd: dir });

		await fs.writeFile(script, "console.log(2);\n");
		await settle();
		await settle();
		expect(changes.length).toBe(1);

		await fs.writeFile(script, "console.log(3);\n");
		await settle();
		expect(changes.length).toBe(2);
	});

	it("stops reporting after unwatch and drops the timer when idle", async () => {
		const { dir, script } = await fixture();
		const changes: string[] = [];
		const watcher = start(name => changes.push(name));
		await watcher.watch("srv", { command: "node", args: ["server.js"], cwd: dir });
		expect(watcher.size).toBe(1);

		watcher.unwatch("srv");
		await fs.writeFile(script, "console.log(2);\n");
		await settle();

		expect(watcher.size).toBe(0);
		expect(changes).toEqual([]);
	});

	it("does not watch remote servers", async () => {
		const watcher = start(() => {});
		await watcher.watch("remote", { type: "http", url: "https://example.com/mcp" });
		expect(watcher.size).toBe(0);
	});
});
