import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { buildBinjaEnv, probeBinjaRuntime, resolveBinjaRuntime } from "@oh-my-pi/pi-coding-agent/binja/runtime";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/sdk";

const LICENSE = "sentinel-license-text";
const PYTHON_DIR = path.join("opt", "binaryninja", "python");

describe("buildBinjaEnv", () => {
	it("never carries BN_LICENSE into the worker environment", () => {
		const env = buildBinjaEnv({ HOME: "/home/user", BN_LICENSE: LICENSE, bn_license: LICENSE }, PYTHON_DIR, {
			BN_LICENSE: LICENSE,
			BN_USER_DIRECTORY: "/srv/binja-user",
		});

		expect(Object.keys(env).filter(key => key.toUpperCase() === "BN_LICENSE")).toEqual([]);
		expect(Object.values(env)).not.toContain(LICENSE);
		expect(env.HOME).toBe("/home/user");
	});

	it("copies BN_USER_DIRECTORY from the parent and disables plugins", () => {
		const env = buildBinjaEnv({}, PYTHON_DIR, { BN_USER_DIRECTORY: "/srv/binja-user" });

		expect(env).toEqual({
			PYTHONUNBUFFERED: "1",
			PYTHONIOENCODING: "utf-8",
			PYTHONPATH: PYTHON_DIR,
			BN_DISABLE_USER_PLUGINS: "1",
			BN_DISABLE_REPOSITORY_PLUGINS: "1",
			BN_USER_DIRECTORY: "/srv/binja-user",
		});
	});

	it("leaves BN_USER_DIRECTORY out when the parent does not set it", () => {
		expect(buildBinjaEnv({}, PYTHON_DIR, {})).not.toHaveProperty("BN_USER_DIRECTORY");
	});

	it("puts the API directory ahead of an existing PYTHONPATH", () => {
		const env = buildBinjaEnv({ PYTHONPATH: "/site" }, PYTHON_DIR, {});

		expect(env.PYTHONPATH).toBe(`${PYTHON_DIR}${path.delimiter}/site`);
	});

	it("drops undefined entries of the interpreter environment", () => {
		expect(buildBinjaEnv({ VIRTUAL_ENV: undefined }, PYTHON_DIR, {})).not.toHaveProperty("VIRTUAL_ENV");
	});
});

// The shims are `#!/bin/sh` scripts standing in for a Python interpreter.
describe.skipIf(process.platform === "win32")("Binary Ninja interpreter probe", () => {
	let root: string;
	let install: string;
	let ok: string;
	let refused: string;
	let broken: string;
	let stalled: string;

	async function shim(name: string, body: string): Promise<string> {
		const file = path.join(root, name);
		await Bun.write(file, `#!/bin/sh\n${body}\n`);
		await fs.chmod(file, 0o755);
		return file;
	}

	function session(python: string): ToolSession {
		return {
			cwd: root,
			hasUI: false,
			getSessionFile: () => null,
			getSessionSpawns: () => "*",
			settings: Settings.isolated({ "binja.installDir": install, "binja.python": python }),
		};
	}

	beforeAll(async () => {
		root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "binja-runtime-")));
		install = path.join(root, "install");
		for (const lib of ["libbinaryninjacore.so.1", "libbinaryninjacore.dylib"]) {
			await Bun.write(path.join(install, lib), "");
		}
		ok = await shim("ok", "exit 0");
		refused = await shim("refused", "echo 'License is not valid. Please supply a valid license.' >&2\nexit 1");
		broken = await shim("broken", "echo \"ModuleNotFoundError: No module named 'binaryninja'\" >&2\nexit 1");
		stalled = await shim("stalled", "exec /bin/sleep 30");
		await Settings.init({ inMemory: true, cwd: root });
	});

	afterAll(async () => {
		await fs.rm(root, { recursive: true, force: true });
	});

	it("tells a refused licence from every other failure", async () => {
		expect(await probeBinjaRuntime({ pythonPath: ok, env: {} })).toBe("ok");
		expect(await probeBinjaRuntime({ pythonPath: refused, env: {} })).toBe("license");
		expect(await probeBinjaRuntime({ pythonPath: broken, env: {} })).toBe("unusable");
		expect(await probeBinjaRuntime({ pythonPath: path.join(root, "missing"), env: {} })).toBe("unusable");
	});

	it("gives up on an interpreter that does not answer in time", async () => {
		const started = performance.now();
		expect(await probeBinjaRuntime({ pythonPath: stalled, env: {} }, 300)).toBe("unusable");
		expect(performance.now() - started).toBeLessThan(10_000);
	});

	it("reports a refused licence as such, and any other failure as no usable interpreter", async () => {
		await expect(resolveBinjaRuntime(session(refused))).rejects.toThrow(/refused its license/);
		await expect(resolveBinjaRuntime(session(broken))).rejects.toThrow(
			/no Python interpreter can import binaryninja .*tried: .*broken/,
		);
	});
});
