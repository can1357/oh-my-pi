import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import packageJson from "../package.json" with { type: "json" };

const packageDir = path.join(import.meta.dir, "..");

/**
 * A compiled binary whose embedded addon did not extract fails to load and
 * prints the steps to recover. These rows drive that failure through the real
 * loader: a copy of the loader's files in a directory with no addon, and an
 * empty natives directory, so every candidate fails. The printed steps must not
 * send the user to a `.node` download, because no release publishes one; they
 * name the release page of the running version instead.
 *
 * `loadNative` runs once per process, so the loader runs in a child process.
 */
const PROBE = `
import * as loader from "./native/loader-state.js";

let result;
try {
	loader.loadNative();
	result = { ok: true };
} catch (error) {
	result = { ok: false, error: error instanceof Error ? error.message : String(error) };
}
process.stdout.write(JSON.stringify(result));
process.exit(0);
`;

interface ProbeResult {
	ok: boolean;
	error?: string;
}

let root = "";
let loaderDir = "";
let natives = "";
let home = "";

beforeAll(async () => {
	root = await fs.mkdtemp(path.join(os.tmpdir(), "pi-natives-help-message-"));
	loaderDir = path.join(root, "loader");
	natives = path.join(root, "natives");
	home = path.join(root, "home");
	await fs.mkdir(path.join(loaderDir, "native"), { recursive: true });
	for (const file of ["loader-state.js", "embedded-addon.js", "version-sentinel.js"]) {
		await fs.copyFile(path.join(packageDir, "native", file), path.join(loaderDir, "native", file));
	}
	await fs.copyFile(path.join(packageDir, "package.json"), path.join(loaderDir, "package.json"));
	await Bun.write(path.join(loaderDir, "probe.ts"), PROBE);
	await fs.mkdir(natives);
	await fs.mkdir(home);
});

afterAll(async () => {
	if (root) await fs.rm(root, { recursive: true, force: true });
});

async function failedCompiledLoad(): Promise<ProbeResult> {
	const child = Bun.spawn([process.execPath, path.join(loaderDir, "probe.ts")], {
		cwd: loaderDir,
		env: { ...process.env, PI_COMPILED: "1", PI_NATIVES_DIR: natives, HOME: home, USERPROFILE: home },
		stdout: "pipe",
		stderr: "pipe",
	});
	const [stdout, stderr, code] = await Promise.all([
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
		child.exited,
	]);
	if (code !== 0 || !stdout) throw new Error(`probe exited ${code}: ${stderr}`);
	return JSON.parse(stdout) as ProbeResult;
}

describe("a compiled binary whose addon fails to load", () => {
	it("points at the release page of the running version, not at a .node download", async () => {
		const probe = await failedCompiledLoad();
		expect(probe.ok).toBe(false);
		expect(probe.error).not.toContain("/releases/latest/download/");
		expect(probe.error).toContain(`https://github.com/can1357/oh-my-pi/releases/tag/v${packageJson.version}`);
	}, 60_000);
});
