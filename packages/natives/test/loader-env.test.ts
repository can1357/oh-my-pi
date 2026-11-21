import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

const LOADER = path.join(import.meta.dir, "..", "native", "loader-state.js");

// Bun autoloads the cwd's dotenv files into `process.env` before the loader
// runs, so provenance can only be probed in a fresh process launched there.
const PROBE = `
import { initLoaderContext } from ${JSON.stringify(LOADER)};
const extra = process.env.__PROBE_SET_NATIVES_DIR;
if (extra) process.env.PI_NATIVES_DIR = extra;
console.log(JSON.stringify({
	nativesDir: initLoaderContext({ isCompiledBinary: true }).nativesDir,
	env: { PI_NATIVES_DIR: process.env.PI_NATIVES_DIR, XDG_DATA_HOME: process.env.XDG_DATA_HOME },
}));
`;

describe("native loader ignores project dotenv directory overrides", () => {
	let root = "";
	let workspace = "";
	let home = "";
	let hostile = "";

	beforeEach(async () => {
		root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "omp-loader-env-")));
		workspace = path.join(root, "workspace");
		home = path.join(root, "home");
		hostile = path.join(root, "hostile");
		await fs.mkdir(workspace);
		await fs.mkdir(home);
		await fs.mkdir(path.join(hostile, "omp"), { recursive: true });
	});

	afterEach(async () => {
		await fs.rm(root, { recursive: true, force: true });
	});

	function probe(launchEnv: Record<string, string> = {}) {
		const env: Record<string, string> = {};
		for (const key of ["PATH", "TMPDIR", "SYSTEMROOT"]) {
			const value = process.env[key];
			if (value !== undefined) env[key] = value;
		}
		Object.assign(env, { HOME: home, USERPROFILE: home, PI_NATIVE_VARIANT: "baseline" }, launchEnv);
		const result = Bun.spawnSync([process.execPath, "-e", PROBE], {
			cwd: workspace,
			env,
			stdout: "pipe",
			stderr: "pipe",
		});
		if (result.exitCode !== 0) throw new Error(result.stderr.toString());
		return JSON.parse(result.stdout.toString()) as {
			nativesDir: string;
			env: { PI_NATIVES_DIR?: string; XDG_DATA_HOME?: string };
		};
	}

	const defaultDir = () => path.join(home, ".omp", "natives");

	it("ignores PI_NATIVES_DIR and XDG_DATA_HOME from the project .env", async () => {
		await fs.writeFile(
			path.join(workspace, ".env"),
			`PI_NATIVES_DIR=${path.join(hostile, "natives")}\nXDG_DATA_HOME=${hostile}\n`,
		);
		const out = probe();
		// Bun did autoload the values; the loader still refused them.
		expect(out.env.PI_NATIVES_DIR).toBe(path.join(hostile, "natives"));
		expect(out.env.XDG_DATA_HOME).toBe(hostile);
		expect(out.nativesDir).toBe(defaultDir());
	});

	it("ignores directories built by $VAR / ${VAR} expansion in .env.local and .env.development", async () => {
		await fs.mkdir(path.join(home, "evil", "omp"), { recursive: true });
		await fs.writeFile(path.join(workspace, ".env.local"), "XDG_DATA_HOME=$HOME/evil\n");
		await fs.writeFile(
			path.join(workspace, ".env.development"),
			`EVIL_ROOT=${hostile}\nPI_NATIVES_DIR=\${EVIL_ROOT}/natives\n`,
		);
		const out = probe();
		expect(out.env.XDG_DATA_HOME).toBe(path.join(home, "evil"));
		expect(out.env.PI_NATIVES_DIR).toBe(path.join(hostile, "natives"));
		expect(out.nativesDir).toBe(defaultDir());
	});

	it("honors launch-environment values over the project .env", async () => {
		await fs.writeFile(
			path.join(workspace, ".env"),
			`PI_NATIVES_DIR=${path.join(hostile, "natives")}\nXDG_DATA_HOME=${hostile}\n`,
		);
		const launched = path.join(root, "launched");
		expect(probe({ PI_NATIVES_DIR: launched }).nativesDir).toBe(launched);

		const xdg = path.join(root, "xdg");
		await fs.mkdir(path.join(xdg, "omp"), { recursive: true });
		expect(probe({ XDG_DATA_HOME: xdg }).nativesDir).toBe(path.join(xdg, "omp", "natives"));
	});

	// Needs a launch-env snapshot (procfs) to tell the launcher's value from the identical dotenv one.
	it.skipIf(process.platform !== "linux")("honors a launch value equal to the project .env value", async () => {
		const shared = path.join(root, "shared");
		await fs.writeFile(path.join(workspace, ".env"), `PI_NATIVES_DIR=${shared}\n`);
		expect(probe({ PI_NATIVES_DIR: shared }).nativesDir).toBe(shared);
	});

	// Without a snapshot the origin is unknowable, so a value matching the dotenv one fails closed.
	it.skipIf(process.platform === "linux")(
		"falls back to the default dir for a launch value equal to the project .env value off Linux",
		async () => {
			const shared = path.join(root, "shared");
			await fs.writeFile(path.join(workspace, ".env"), `PI_NATIVES_DIR=${shared}\n`);
			expect(probe({ PI_NATIVES_DIR: shared }).nativesDir).toBe(defaultDir());
		},
	);

	it("honors a value the project dotenv files do not define", async () => {
		await fs.writeFile(path.join(workspace, ".env"), `PI_NATIVES_DIR=${path.join(hostile, "natives")}\n`);
		// Set in-process after autoload (as OMP's own .env loading does): not a project value.
		const own = path.join(root, "own");
		expect(probe({ __PROBE_SET_NATIVES_DIR: own }).nativesDir).toBe(own);
	});
});
