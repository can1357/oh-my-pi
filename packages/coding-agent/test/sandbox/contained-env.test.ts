import { afterEach, describe, expect, it, vi } from "bun:test";
import {
	containedEnv,
	inheritedContainedEnv,
	sandboxProcessEnv,
	withSandboxTempDir,
} from "@oh-my-pi/pi-coding-agent/sandbox/env";
import type { SandboxStatus } from "@oh-my-pi/pi-coding-agent/sandbox/runtime";
import * as utils from "@oh-my-pi/pi-utils";

afterEach(() => {
	vi.restoreAllMocks();
});

// Which values omp's own .env files define is `stripOmpDotenvEnv`'s contract (pi-utils env tests);
// here `OWN_KEY` stands in for one of them.
describe("containedEnv", () => {
	it("strips the base env and layers the explicit env on top unchanged, own-file values included", () => {
		vi.spyOn(utils, "stripOmpDotenvEnv").mockImplementation(env =>
			Object.fromEntries(
				Object.entries(env).filter(
					(entry): entry is [string, string] => entry[0] !== "OWN_KEY" && entry[1] !== undefined,
				),
			),
		);
		const base = { OWN_KEY: "secret", KEPT: "kept", UNSET: undefined };
		expect(containedEnv(base)).toStrictEqual({ KEPT: "kept" });
		expect(containedEnv(base, { OWN_KEY: "secret", KEPT: "explicit", SKIPPED: undefined })).toStrictEqual({
			KEPT: "explicit",
			OWN_KEY: "secret",
		});
	});
});

describe("git repo location", () => {
	it("drops a GIT_DIR/GIT_WORK_TREE omp inherited but keeps one the explicit env sets", () => {
		const saved = { GIT_DIR: Bun.env.GIT_DIR, GIT_WORK_TREE: Bun.env.GIT_WORK_TREE };
		Bun.env.GIT_DIR = "/elsewhere/.git";
		Bun.env.GIT_WORK_TREE = "/elsewhere";
		try {
			const env = inheritedContainedEnv();
			expect(env.GIT_DIR).toBeUndefined();
			expect(env.GIT_WORK_TREE).toBeUndefined();
			expect(env.PATH).toBe(Bun.env.PATH!);
			expect(inheritedContainedEnv({ GIT_DIR: "/explicit/.git" }).GIT_DIR).toBe("/explicit/.git");
		} finally {
			for (const [key, value] of Object.entries(saved)) {
				if (value === undefined) delete Bun.env[key];
				else Bun.env[key] = value;
			}
		}
	});

	it("keeps a GIT_DIR a contained session shell exported (a PTY seed env), so pty runs match plain runs", () => {
		const seed = { GIT_DIR: "/home/u/.dotfiles", GIT_WORK_TREE: "/home/u", KEPT: "kept" };
		expect(containedEnv(seed)).toStrictEqual(seed);
	});
});

describe("sandboxProcessEnv", () => {
	const allowlist = {
		status: (): SandboxStatus => ({ state: "active", backend: "bubblewrap", network: "allowlist", warnings: [] }),
		tempDir: () => "/sandbox-tmp",
	};

	it("drops FTP_PROXY with the other proxy variables in allowlist mode, so a stale seed credential never leaks", () => {
		const env = {
			HTTP_PROXY: "http://seed:old@10.0.2.2:4000",
			FTP_PROXY: "http://seed:old@10.0.2.2:4000",
			ftp_proxy: "http://seed:old@10.0.2.2:4000",
			PATH: "/usr/bin",
		};
		expect(sandboxProcessEnv(allowlist, env)).toStrictEqual({
			PATH: "/usr/bin",
			TMPDIR: "/sandbox-tmp",
			TMP: "/sandbox-tmp",
			TEMP: "/sandbox-tmp",
		});
		// Outside allowlist mode the proxy variables pass through.
		expect(sandboxProcessEnv(allowlist, env, "allow")).toMatchObject({ FTP_PROXY: env.FTP_PROXY });
	});
});

describe("withSandboxTempDir", () => {
	const env = { Temp: "C:\\Users\\me\\AppData\\Local\\Temp", tmp: "C:\\host-tmp", TEMP: "C:\\old", PATH: "p" };

	it("drops other spellings of the temp variables on Windows before setting the canonical keys", () => {
		expect(withSandboxTempDir(env, "C:\\sandbox", "win32")).toStrictEqual({
			PATH: "p",
			TMPDIR: "C:\\sandbox",
			TMP: "C:\\sandbox",
			TEMP: "C:\\sandbox",
		});
	});

	it("keeps differently cased keys elsewhere: they are distinct variables", () => {
		expect(withSandboxTempDir(env, "/sandbox", "linux")).toStrictEqual({
			Temp: env.Temp,
			tmp: env.tmp,
			PATH: "p",
			TMPDIR: "/sandbox",
			TMP: "/sandbox",
			TEMP: "/sandbox",
		});
	});
});
