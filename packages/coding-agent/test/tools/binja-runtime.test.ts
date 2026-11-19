import { describe, expect, it } from "bun:test";
import * as path from "node:path";
import { buildBinjaEnv } from "@oh-my-pi/pi-coding-agent/binja/runtime";

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
