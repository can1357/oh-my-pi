// A server whose root marker sits below the session cwd (a monorepo package)
// serves files under that marker instead of reporting "no language server".
import { afterEach, describe, expect, test } from "bun:test";
import * as path from "node:path";
import { describeMissingServers, getServersForFile, loadConfig } from "@oh-my-pi/pi-coding-agent/lsp/config";
import { TempDir } from "@oh-my-pi/pi-utils";

const SERVER = {
	command: process.execPath,
	fileTypes: [".xyz"],
	rootMarkers: ["xyz.project"],
};

describe("nested project roots", () => {
	let tempDir: TempDir | undefined;
	afterEach(() => {
		tempDir?.removeSync();
		tempDir = undefined;
	});

	async function project(): Promise<string> {
		tempDir = TempDir.createSync("@omp-lsp-nested-root-");
		const root = tempDir.path();
		await Bun.write(path.join(root, ".omp", "lsp.json"), JSON.stringify({ servers: { "xyz-ls": SERVER } }));
		await Bun.write(path.join(root, "apps", "web", "xyz.project"), "");
		await Bun.write(path.join(root, "apps", "web", "src", "main.xyz"), "");
		await Bun.write(path.join(root, "scripts", "loose.xyz"), "");
		return root;
	}

	test("enables a server for files under a marker below the cwd", async () => {
		const root = await project();
		const config = loadConfig(root);
		expect(config.servers["xyz-ls"]).toBeUndefined();

		const servers = getServersForFile(config, path.join(root, "apps", "web", "src", "main.xyz"));
		expect(servers.map(([name]) => name)).toEqual(["xyz-ls"]);
		expect(config.servers["xyz-ls"]?.resolvedCommand).toBe(process.execPath);
	});

	test("names the missing marker when no ancestor has one", async () => {
		const root = await project();
		const config = loadConfig(root);
		const loose = path.join(root, "scripts", "loose.xyz");

		expect(getServersForFile(config, loose)).toEqual([]);
		expect(describeMissingServers(config, loose)).toContain("xyz-ls: no xyz.project");
	});
});
