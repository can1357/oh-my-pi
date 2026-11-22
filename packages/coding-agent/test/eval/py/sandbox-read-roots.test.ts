import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import {
	checkPythonKernelAvailability,
	getCachedPythonKernelAvailability,
} from "@oh-my-pi/pi-coding-agent/eval/py/kernel";
import { pythonReadRoots } from "@oh-my-pi/pi-coding-agent/eval/py/runtime";
import { cfgSandboxEnabled, cfgSandboxScope } from "@oh-my-pi/pi-coding-agent/sandbox/settings";
import { TempDir } from "@oh-my-pi/pi-utils";
import { TEST_PYTHON } from "../../helpers/python";
import { beginSettingsTest, restoreSettingsTestState, type SettingsTestState } from "../../helpers/settings-test-state";

let scratch: TempDir;
/** Realpath of the scratch dir, so expectations compare with `pythonReadRoots`' resolved paths. */
let root: string;

beforeEach(() => {
	scratch = TempDir.createSync("@omp-py-read-roots-");
	root = fs.realpathSync(scratch.path());
});

afterEach(() => {
	vi.restoreAllMocks();
	scratch.removeSync();
});

/** Creates an empty interpreter file at `<prefix>/<relative>` and returns its path. */
function makeInterpreter(prefix: string, relative: string): string {
	const exe = path.join(prefix, relative);
	fs.mkdirSync(path.dirname(exe), { recursive: true });
	fs.writeFileSync(exe, "");
	return exe;
}

describe.skipIf(process.platform === "win32")("pythonReadRoots interpreter install root (POSIX)", () => {
	it("adds an install root holding lib/python3*", async () => {
		const prefix = path.join(root, "opt", "python");
		const exe = makeInterpreter(prefix, "bin/python3");
		fs.mkdirSync(path.join(prefix, "lib", "python3.12"), { recursive: true });
		expect(await pythonReadRoots({ pythonPath: exe, env: {} })).toEqual([prefix]);
	});

	it("adds an install root holding pyvenv.cfg", async () => {
		const prefix = path.join(root, "venv");
		const exe = makeInterpreter(prefix, "bin/python3");
		fs.writeFileSync(path.join(prefix, "pyvenv.cfg"), "home = /usr/bin\n");
		expect(await pythonReadRoots({ pythonPath: exe, env: {} })).toEqual([prefix]);
	});

	it("adds only the interpreter's directory when its parent is no Python install", async () => {
		const prefix = path.join(root, "tools");
		const exe = makeInterpreter(prefix, "bin/python3");
		// A `lib` without a python3* directory is no install marker.
		fs.mkdirSync(path.join(prefix, "lib", "node_modules"), { recursive: true });
		expect(await pythonReadRoots({ pythonPath: exe, env: {} })).toEqual([path.join(prefix, "bin")]);
	});

	it("never adds the home directory, even with an install marker", async () => {
		const home = path.join(root, "home", "user");
		vi.spyOn(os, "homedir").mockReturnValue(home);
		const exe = makeInterpreter(home, "bin/python3");
		fs.mkdirSync(path.join(home, "lib", "python3.11"), { recursive: true });
		expect(await pythonReadRoots({ pythonPath: exe, env: {} })).toEqual([path.join(home, "bin")]);
	});

	it("never adds an ancestor of the home directory", async () => {
		const prefix = path.join(root, "usr");
		vi.spyOn(os, "homedir").mockReturnValue(path.join(prefix, "home", "user"));
		const exe = makeInterpreter(prefix, "bin/python3");
		fs.mkdirSync(path.join(prefix, "lib", "python3.11"), { recursive: true });
		expect(await pythonReadRoots({ pythonPath: exe, env: {} })).toEqual([path.join(prefix, "bin")]);
	});

	it("never adds the home directory when os.homedir() is a symlink to it", async () => {
		const home = path.join(root, "home", "user");
		const linkHome = path.join(root, "link-home");
		const exe = makeInterpreter(home, "bin/python3");
		fs.mkdirSync(path.join(home, "lib", "python3.11"), { recursive: true });
		fs.symlinkSync(home, linkHome);
		vi.spyOn(os, "homedir").mockReturnValue(linkHome);
		expect(await pythonReadRoots({ pythonPath: exe, env: {} })).toEqual([path.join(home, "bin")]);
	});

	it("counts symlinked lib/python3* directories as an install marker", async () => {
		const prefix = path.join(root, "opt", "python");
		const exe = makeInterpreter(prefix, "bin/python3");
		const stdlib = path.join(root, "store", "python3.12");
		fs.mkdirSync(stdlib, { recursive: true });
		fs.mkdirSync(path.join(prefix, "lib"), { recursive: true });
		fs.symlinkSync(stdlib, path.join(prefix, "lib", "python3.12"));
		expect(await pythonReadRoots({ pythonPath: exe, env: {} })).toEqual([prefix]);
	});

	it.each([
		{ manager: "pyenv", shim: "shims/python", versions: ["versions", "3.12.4"] },
		{ manager: "asdf", shim: "shims/python3", versions: ["installs", "python", "3.12.4"] },
	])("adds the $manager root behind a shim", async ({ manager, shim, versions }) => {
		const base = path.join(root, "opt", manager);
		const exe = makeInterpreter(base, shim);
		fs.mkdirSync(path.join(base, ...versions), { recursive: true });
		expect(await pythonReadRoots({ pythonPath: exe, env: {} })).toEqual([base]);
	});

	it("adds only a shims directory whose parent holds no versions/ or installs/", async () => {
		const tools = path.join(root, "opt", "tools");
		const exe = makeInterpreter(tools, "shims/python");
		expect(await pythonReadRoots({ pythonPath: exe, env: {} })).toEqual([path.join(tools, "shims")]);
	});

	it("never adds a shim's version-manager root that is the home directory", async () => {
		const home = path.join(root, "home", "user");
		vi.spyOn(os, "homedir").mockReturnValue(home);
		const exe = makeInterpreter(home, "shims/python");
		fs.mkdirSync(path.join(home, "versions", "3.12.4"), { recursive: true });
		expect(await pythonReadRoots({ pythonPath: exe, env: {} })).toEqual([path.join(home, "shims")]);
	});

	it("resolves a committed venv symlink to home's interpreter without exposing home", async () => {
		const home = path.join(root, "home", "user");
		vi.spyOn(os, "homedir").mockReturnValue(home);
		const real = makeInterpreter(home, "bin/python3");
		fs.mkdirSync(path.join(home, "lib", "python3.11"), { recursive: true });
		const venv = path.join(home, "project", ".venv");
		fs.mkdirSync(path.join(venv, "bin"), { recursive: true });
		const link = path.join(venv, "bin", "python");
		fs.symlinkSync("../../../bin/python3", link);
		expect(await pythonReadRoots({ pythonPath: link, env: {}, venvPath: venv })).toEqual([venv, path.dirname(real)]);
	});
});

describe.skipIf(TEST_PYTHON === undefined)("Python availability cache containment", () => {
	let state: SettingsTestState | undefined;

	beforeEach(() => {
		state = beginSettingsTest();
	});

	afterEach(() => {
		restoreSettingsTestState(state);
		state = undefined;
	});

	it("does not serve a host-probed result once eval runs contained", async () => {
		const settings = await Settings.init({ inMemory: true, cwd: root });
		cfgSandboxEnabled.set(settings, false);
		const interpreter = TEST_PYTHON as string;
		const probed = await checkPythonKernelAvailability(root, interpreter, { forceProbe: true });
		expect(probed.ok).toBe(true);
		expect(getCachedPythonKernelAvailability(root, interpreter)).toEqual(probed);

		cfgSandboxEnabled.set(settings, true);
		cfgSandboxScope.set(settings, ["eval"]);
		expect(getCachedPythonKernelAvailability(root, interpreter)).toBeUndefined();

		cfgSandboxEnabled.set(settings, false);
		expect(getCachedPythonKernelAvailability(root, interpreter)).toEqual(probed);
	});
});
