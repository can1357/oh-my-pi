import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { getLastChangelogVersionPath, TempDir } from "@oh-my-pi/pi-utils";

// Every settings read opens its file non-blocking and requires a regular file. A FIFO at a
// settings path — or a link to one — blocked the open until a writer came, at startup, for every
// command; a synchronous read blocked the whole event loop, so no timer in the same process could
// ever report it. Each case therefore runs in a child process that is killed if it hangs, and a
// child that finishes — whatever it decided about the unreadable file — is the pass.
const CHILD_DEADLINE_MS = 20_000;
const packageRoot = path.resolve(import.meta.dir, "../..");

let tempDir: TempDir;
let agentDir: string;
let projectDir: string;

beforeEach(() => {
	tempDir = TempDir.createSync("@omp-settings-fifo-");
	agentDir = path.join(tempDir.path(), "agent");
	projectDir = path.join(tempDir.path(), "project");
	fs.mkdirSync(agentDir, { recursive: true });
	fs.mkdirSync(projectDir, { recursive: true });
});

afterEach(() => {
	tempDir.removeSync();
});

function mkfifo(target: string): void {
	fs.mkdirSync(path.dirname(target), { recursive: true });
	const made = Bun.spawnSync(["mkfifo", target]);
	if (made.exitCode !== 0) throw new Error(made.stderr.toString());
}

/** Run `body` against fresh isolated settings in a child; resolves with its outcome, or "hung". */
async function inChild(body: string): Promise<{ outcome: "finished" | "hung"; stdout: string; stderr: string }> {
	const script = `
		import { unlinkSync } from "node:fs";
		import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
		import { cfgSetupVersion } from "@oh-my-pi/pi-coding-agent/modes/settings";
		const agentDir = ${JSON.stringify(agentDir)};
		const cwd = ${JSON.stringify(projectDir)};
		void cfgSetupVersion;
		void unlinkSync;
		try {
			${body}
			console.log("FINISHED");
		} catch (error) {
			console.log("FINISHED WITH", String(error));
		}
		process.exit(0);
	`;
	const child = Bun.spawn([process.execPath, "-e", script], {
		cwd: packageRoot,
		stdout: "pipe",
		stderr: "pipe",
		env: { ...process.env, PI_CODING_AGENT_DIR: agentDir },
	});
	// A real timer, because the defect is a blocking open: no fake clock reaches the child.
	const settled = await Promise.race([child.exited.then(() => true), Bun.sleep(CHILD_DEADLINE_MS).then(() => false)]);
	if (!settled) child.kill("SIGKILL");
	await child.exited;
	const [stdout, stderr] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()]);
	return { outcome: settled && stdout.includes("FINISHED") ? "finished" : "hung", stdout, stderr };
}

describe.skipIf(process.platform === "win32")("a FIFO at a settings path is refused, not waited on", () => {
	it("config.yml reached through a link", async () => {
		const pipe = path.join(tempDir.path(), "elsewhere", "pipe");
		mkfifo(pipe);
		fs.symlinkSync(pipe, path.join(agentDir, "config.yml"));

		const run = await inChild("await Settings.loadIsolated({ cwd, agentDir });");

		expect(run.outcome).toBe("finished");
		expect(fs.lstatSync(pipe).isFIFO()).toBe(true);
	}, 30_000);

	for (const write of ["the value it already holds", "a new value"] as const) {
		it(`config.yml read again when a setting is written: ${write}`, async () => {
			const config = path.join(agentDir, "config.yml");
			fs.writeFileSync(config, "setupVersion: 1\n");
			// Loaded as a regular file, then replaced by a FIFO before the write reads it back.
			const run = await inChild(`
				const settings = await Settings.loadIsolated({ cwd, agentDir });
				unlinkSync(${JSON.stringify(config)});
				if (Bun.spawnSync(["mkfifo", ${JSON.stringify(config)}]).exitCode !== 0) throw new Error("mkfifo");
				cfgSetupVersion.set(settings, ${write === "the value it already holds" ? 1 : 2});
			`);

			expect(run.outcome).toBe("finished");
			expect(fs.lstatSync(config).isFIFO()).toBe(true);
		}, 30_000);
	}

	it("a --config overlay", async () => {
		const overlay = path.join(tempDir.path(), "overlay.yml");
		mkfifo(overlay);

		const run = await inChild(
			`await Settings.loadIsolated({ cwd, agentDir, configFiles: [${JSON.stringify(overlay)}] });`,
		);

		expect(run.outcome).toBe("finished");
		// The overlay loader treats an unreadable overlay as the hard error it is.
		expect(run.stdout).toContain("Failed to read config overlay");
	}, 30_000);

	it("the legacy settings.json a first start migrates", async () => {
		mkfifo(path.join(agentDir, "settings.json"));

		const run = await inChild("await Settings.loadIsolated({ cwd, agentDir });");

		expect(run.outcome).toBe("finished");
		expect(fs.lstatSync(path.join(agentDir, "settings.json")).isFIFO()).toBe(true);
	}, 30_000);

	it("the last-changelog-version marker a legacy config.yml seeds", async () => {
		fs.writeFileSync(path.join(agentDir, "config.yml"), "lastChangelogVersion: 1.0.0\n");
		const marker = getLastChangelogVersionPath(agentDir);
		mkfifo(marker);

		const run = await inChild("await Settings.loadIsolated({ cwd, agentDir });");

		expect(run.outcome).toBe("finished");
		expect(fs.lstatSync(marker).isFIFO()).toBe(true);
	}, 30_000);
});
