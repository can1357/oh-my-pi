import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { applyDirenvPreflight, executeBash } from "@oh-my-pi/pi-coding-agent/exec/bash-executor";
import {
	cleanSpawnEnvForTests,
	clearDirenvCachesForTests,
	findEnvrc,
	loadDirenvEnv,
	parseDirenvExport,
} from "@oh-my-pi/pi-coding-agent/exec/direnv";
import { $which, TempDir } from "@oh-my-pi/pi-utils";

/** Real-direnv cases need the binary on PATH; skip cleanly when it's absent so
 *  the graceful-degradation code path (returns `null`) isn't asserted against. */
const hasDirenv = $which("direnv") !== null;

const tmpDirs: TempDir[] = [];
function tmp(): string {
	const dir = TempDir.createSync("@pi-direnv-");
	tmpDirs.push(dir);
	return dir.path();
}

afterEach(async () => {
	for (const dir of tmpDirs.splice(0)) await dir.remove();
	clearDirenvCachesForTests();
});

/** Explicitly `direnv allow` an `.envrc` (against the test-isolated HOME/XDG
 *  dirs). Loading now honors the allow list, so tests that expect an export
 *  must opt the file in the same way a user would. Re-run after every content
 *  change — direnv's allow entry is content-hashed. */
async function allowEnvrc(dir: string): Promise<void> {
	const env: Record<string, string> = {};
	for (const key in Bun.env) {
		const value = Bun.env[key];
		if (value !== undefined && !key.startsWith("DIRENV_")) env[key] = value;
	}
	const proc = Bun.spawn(["direnv", "allow"], { cwd: dir, env, stdout: "ignore", stderr: "ignore" });
	if ((await proc.exited) !== 0) throw new Error(`direnv allow failed in ${dir}`);
}

describe("findEnvrc", () => {
	it("walks up to the nearest .envrc above the start dir", async () => {
		const root = tmp();
		await Bun.write(path.join(root, ".envrc"), "export A=1\n");
		const nested = path.join(root, "a", "b");
		await fs.mkdir(nested, { recursive: true });

		expect(await findEnvrc(nested)).toBe(path.join(root, ".envrc"));
	});

	it("prefers the nearest .envrc when monorepo dirs nest them", async () => {
		const root = tmp();
		await Bun.write(path.join(root, ".envrc"), "export A=1\n");
		const sub = path.join(root, "pkg");
		await fs.mkdir(sub, { recursive: true });
		await Bun.write(path.join(sub, ".envrc"), "export B=2\n");

		expect(await findEnvrc(sub)).toBe(path.join(sub, ".envrc"));
	});

	it("returns null when no .envrc exists up the tree", async () => {
		const nested = path.join(tmp(), "x", "y");
		await fs.mkdir(nested, { recursive: true });

		expect(await findEnvrc(nested)).toBeNull();
	});
});

describe("cleanSpawnEnv versioning", () => {
	it("picks up Bun.env mutations after the first cached call", () => {
		const marker = `OMP_DIRENV_TEST_${process.pid}`;
		delete Bun.env[marker];
		clearDirenvCachesForTests();
		expect(cleanSpawnEnvForTests()[marker]).toBeUndefined();
		// Deferred MCP discovery mutates Bun.env mid-process (sdk.ts sets
		// EXA_API_KEY after the session is usable); a permanently cached
		// baseline would spawn direnv with stale values forever.
		Bun.env[marker] = "v1";
		try {
			expect(cleanSpawnEnvForTests()[marker]).toBe("v1");
		} finally {
			delete Bun.env[marker];
			clearDirenvCachesForTests();
		}
	});
});

describe("parseDirenvExport", () => {
	it("splits set values from null unsets", () => {
		const out = parseDirenvExport('{"FOO":"bar","BAZ":null,"PATH":"/x:/y"}');

		expect(out.set).toEqual({ FOO: "bar", PATH: "/x:/y" });
		expect(out.unset).toEqual(["BAZ"]);
	});

	it("treats empty / whitespace output as no diff", () => {
		expect(parseDirenvExport("")).toEqual({ set: {}, unset: [] });
		expect(parseDirenvExport("  \n")).toEqual({ set: {}, unset: [] });
	});
});

describe.skipIf(!hasDirenv)("loadDirenvEnv (real direnv, allow-list honored)", () => {
	// `direnv allow` writes a trust entry into its data dir. Redirect HOME + the
	// XDG dirs to a throwaway tmp so real-direnv cases never leak allow state
	// into the dev/CI user's global direnv store.
	const savedEnv: Record<string, string | undefined> = {};
	beforeEach(() => {
		const home = tmp();
		for (const key of ["HOME", "XDG_DATA_HOME", "XDG_CONFIG_HOME", "XDG_CACHE_HOME"]) {
			savedEnv[key] = Bun.env[key];
			Bun.env[key] = path.join(home, key.toLowerCase());
		}
	});
	afterEach(() => {
		for (const [key, value] of Object.entries(savedEnv)) {
			if (value === undefined) delete Bun.env[key];
			else Bun.env[key] = value;
		}
	});

	it("returns null for an .envrc the user has not allowed (never auto-allows)", async () => {
		// The security contract: an untrusted `.envrc` is NEVER executed. A
		// poisoned repo gets nothing until the user runs `direnv allow` — exactly
		// the trust boundary direnv itself enforces in the user's shell.
		const root = tmp();
		await Bun.write(path.join(root, ".envrc"), "export DIRENV_BLOCKED_TEST=leaked\n");

		expect(await loadDirenvEnv(root)).toBeNull();
	});

	it("returns exported vars + PATH additions for an allowed .envrc", async () => {
		const root = tmp();
		await fs.mkdir(path.join(root, "bin"), { recursive: true });
		await Bun.write(path.join(root, ".envrc"), "export DIRENV_FEATURE_TEST=loaded\nPATH_add bin\n");
		await allowEnvrc(root);

		const diff = await loadDirenvEnv(root);

		expect(diff?.set.DIRENV_FEATURE_TEST).toBe("loaded");
		expect(diff?.set.PATH).toContain(path.join(root, "bin"));
	});

	it("reports variables a .envrc unsets", async () => {
		const root = tmp();
		await Bun.write(path.join(root, ".envrc"), "unset PI_DIRENV_UNSET_TEST\n");
		await allowEnvrc(root);
		// direnv emits a JSON null for a var only when it was present in the
		// spawn env and the `.envrc` removes it, so seed it in the parent env.
		// (Avoid a `DIRENV_`-prefixed name — the loader strips those before spawn.)
		Bun.env.PI_DIRENV_UNSET_TEST = "present";
		try {
			const diff = await loadDirenvEnv(root);
			expect(diff?.set.PI_DIRENV_UNSET_TEST).toBeUndefined();
			expect(diff?.unset).toContain("PI_DIRENV_UNSET_TEST");
		} finally {
			delete Bun.env.PI_DIRENV_UNSET_TEST;
		}
	});

	it("returns null when there is no .envrc to load", async () => {
		expect(await loadDirenvEnv(tmp())).toBeNull();
	});

	it("drops a warm export when the .envrc is denied", async () => {
		const root = tmp();
		await Bun.write(path.join(root, ".envrc"), "export DIRENV_DENY_TEST=allowed\n");
		await allowEnvrc(root);
		expect((await loadDirenvEnv(root))?.set.DIRENV_DENY_TEST).toBe("allowed");
		const proc = Bun.spawn(["direnv", "deny"], {
			cwd: root,
			env: cleanSpawnEnvForTests(),
			stdout: "ignore",
			stderr: "ignore",
		});
		expect(await proc.exited).toBe(0);
		expect(await loadDirenvEnv(root)).toBeNull();
		expect(await loadDirenvEnv(root)).toBeNull();
		await allowEnvrc(root);
		expect((await loadDirenvEnv(root))?.set.DIRENV_DENY_TEST).toBe("allowed");
	});

	it("restarts from a clean baseline when the OMP process environment changes", async () => {
		const root = tmp();
		await Bun.write(path.join(root, ".envrc"), "export PI_DIRENV_CHILD_TEST=$PI_DIRENV_PARENT_TEST\n");
		await allowEnvrc(root);
		const saved = Bun.env.PI_DIRENV_PARENT_TEST;
		Bun.env.PI_DIRENV_PARENT_TEST = "first";
		try {
			expect((await loadDirenvEnv(root))?.set.PI_DIRENV_CHILD_TEST).toBe("first");
			Bun.env.PI_DIRENV_PARENT_TEST = "second";
			expect((await loadDirenvEnv(root))?.set.PI_DIRENV_CHILD_TEST).toBe("second");
		} finally {
			if (saved === undefined) delete Bun.env.PI_DIRENV_PARENT_TEST;
			else Bun.env.PI_DIRENV_PARENT_TEST = saved;
		}
	});

	it("re-exports when the .envrc content changes (no stale cache)", async () => {
		// direnv's allow entry is content-hashed, so each rewrite is re-allowed —
		// mirroring what a user does after editing their own .envrc.
		const root = tmp();
		await Bun.write(path.join(root, ".envrc"), "export DIRENV_CACHE_TEST=one\n");
		await allowEnvrc(root);
		expect((await loadDirenvEnv(root))?.set.DIRENV_CACHE_TEST).toBe("one");

		await Bun.write(path.join(root, ".envrc"), "export DIRENV_CACHE_TEST=two\n");
		await allowEnvrc(root);
		expect((await loadDirenvEnv(root))?.set.DIRENV_CACHE_TEST).toBe("two");
	});

	it("reuses a warm export but refreshes after a same-second watched file change", async () => {
		const root = tmp();
		const countFile = path.join(root, "runs");
		const watched = path.join(root, "watched.env");
		const second = Math.floor(Date.now() / 1000) - 10;
		await Bun.write(watched, "one\n");
		await fs.utimes(watched, second + 0.1, second + 0.1);
		await Bun.write(
			path.join(root, ".envrc"),
			'watch_file watched.env\nprintf "x" >> runs\nexport DIRENV_WATCH_TEST="$(cat watched.env)"\n',
		);
		await allowEnvrc(root);
		expect((await loadDirenvEnv(root))?.set.DIRENV_WATCH_TEST).toBe("one");
		expect((await loadDirenvEnv(root))?.set.DIRENV_WATCH_TEST).toBe("one");
		expect(await Bun.file(countFile).text()).toBe("x");

		await Bun.write(watched, "two\n");
		await fs.utimes(watched, second + 0.2, second + 0.2);
		expect((await loadDirenvEnv(root))?.set.DIRENV_WATCH_TEST).toBe("two");
		expect((await loadDirenvEnv(root))?.set.DIRENV_WATCH_TEST).toBe("two");
		expect(await Bun.file(countFile).text()).toBe("xx");
	});

	it("refreshes when a missing watched file appears or an existing one disappears", async () => {
		const root = tmp();
		const watched = path.join(root, "optional.env");
		await Bun.write(
			path.join(root, ".envrc"),
			'watch_file optional.env\nif [[ -f optional.env ]]; then\nexport PI_DIRENV_OPTIONAL="$(cat optional.env)"\nelse\nexport PI_DIRENV_OPTIONAL=missing\nfi\nprintf "x" >> runs\n',
		);
		await allowEnvrc(root);
		expect((await loadDirenvEnv(root))?.set.PI_DIRENV_OPTIONAL).toBe("missing");
		expect((await loadDirenvEnv(root))?.set.PI_DIRENV_OPTIONAL).toBe("missing");
		expect(await Bun.file(path.join(root, "runs")).text()).toBe("x");

		await Bun.write(watched, "created\n");
		expect((await loadDirenvEnv(root))?.set.PI_DIRENV_OPTIONAL).toBe("created");

		await fs.unlink(watched);
		expect((await loadDirenvEnv(root))?.set.PI_DIRENV_OPTIONAL).toBe("missing");
		expect(await Bun.file(path.join(root, "runs")).text()).toBe("xxx");
	});

	it("keeps independent warm environments for different directories", async () => {
		const a = tmp();
		const b = tmp();
		await Bun.write(
			path.join(a, ".envrc"),
			'export PI_CACHE_PROJECT=a PI_CACHE_ONLY_A=present\nprintf "x" >> runs\n',
		);
		await Bun.write(path.join(b, ".envrc"), 'export PI_CACHE_PROJECT=b\nprintf "x" >> runs\n');
		await allowEnvrc(a);
		await allowEnvrc(b);
		expect((await loadDirenvEnv(a))?.set.PI_CACHE_PROJECT).toBe("a");
		const second = await loadDirenvEnv(b);
		expect(second?.set.PI_CACHE_PROJECT).toBe("b");
		expect(second?.set.PI_CACHE_ONLY_A).toBeUndefined();
		expect((await loadDirenvEnv(a))?.set.PI_CACHE_PROJECT).toBe("a");
		expect(await Bun.file(path.join(a, "runs")).text()).toBe("x");
		expect(await Bun.file(path.join(b, "runs")).text()).toBe("x");
	});

	it("recomputes refreshed overrides and unsets relative to the original baseline", async () => {
		const root = tmp();
		const mode = path.join(root, "mode");
		const restored = Bun.env.PI_CACHE_RESTORED;
		const removed = Bun.env.PI_CACHE_REMOVED;
		Bun.env.PI_CACHE_RESTORED = "baseline";
		Bun.env.PI_CACHE_REMOVED = "baseline";
		try {
			await Bun.write(mode, "first\n");
			await Bun.write(
				path.join(root, ".envrc"),
				'watch_file mode\nif [[ "$(cat mode)" == first ]]; then\nexport PI_CACHE_RESTORED=override\nelse\nunset PI_CACHE_REMOVED\nfi\n',
			);
			await allowEnvrc(root);
			expect((await loadDirenvEnv(root))?.set.PI_CACHE_RESTORED).toBe("override");
			await Bun.write(mode, "second\n");
			const refreshed = await loadDirenvEnv(root);
			expect(refreshed).not.toBeNull();
			expect(refreshed?.set.PI_CACHE_RESTORED).toBeUndefined();
			expect(refreshed?.unset).not.toContain("PI_CACHE_RESTORED");
			expect(refreshed?.unset).toContain("PI_CACHE_REMOVED");
			const warm = await loadDirenvEnv(root);
			expect(warm?.set.PI_CACHE_RESTORED).toBeUndefined();
			expect(warm?.unset).toContain("PI_CACHE_REMOVED");
		} finally {
			if (restored === undefined) delete Bun.env.PI_CACHE_RESTORED;
			else Bun.env.PI_CACHE_RESTORED = restored;
			if (removed === undefined) delete Bun.env.PI_CACHE_REMOVED;
			else Bun.env.PI_CACHE_REMOVED = removed;
		}
	});
});

describe.skipIf(!hasDirenv)("bash executor direnv wiring (end-to-end)", () => {
	const savedEnv: Record<string, string | undefined> = {};
	beforeEach(() => {
		const home = tmp();
		for (const key of ["HOME", "XDG_DATA_HOME", "XDG_CONFIG_HOME", "XDG_CACHE_HOME"]) {
			savedEnv[key] = Bun.env[key];
			Bun.env[key] = path.join(home, key.toLowerCase());
		}
	});
	afterEach(() => {
		for (const [key, value] of Object.entries(savedEnv)) {
			if (value === undefined) delete Bun.env[key];
			else Bun.env[key] = value;
		}
	});

	it("exposes direnv-loaded vars to the command while per-call env still wins", async () => {
		const root = tmp();
		await Bun.write(path.join(root, ".envrc"), "export DIRENV_WIRE_TEST=fromdirenv\nexport OVERRIDE_ME=fromdirenv\n");
		await allowEnvrc(root);

		const result = await executeBash('printf "%s|%s" "$DIRENV_WIRE_TEST" "$OVERRIDE_ME"', {
			cwd: root,
			env: { OVERRIDE_ME: "fromcaller" },
		});

		expect(result.output).toContain("fromdirenv|fromcaller");
	});

	it("removes variables the .envrc unsets from the command environment", async () => {
		const root = tmp();
		await Bun.write(path.join(root, ".envrc"), "unset PI_DIRENV_UNSET_E2E\n");
		await allowEnvrc(root);
		// Inherited from the process env (as an OMP-provided var would be); the
		// caller does NOT re-supply it, so direnv's unset must strip it. `printenv`
		// exits non-zero and prints nothing when the name is genuinely absent. A
		// unique sessionKey forces a fresh shell that captures the var we just set.
		// (Avoid a `DIRENV_`-prefixed name — the loader strips those before spawn.)
		Bun.env.PI_DIRENV_UNSET_E2E = "leaked";
		try {
			const result = await executeBash('printenv PI_DIRENV_UNSET_E2E; printf "rc=%s" "$?"', {
				cwd: root,
				sessionKey: `direnv-unset-${Date.now()}`,
			});
			expect(result.output).toContain("rc=1");
			expect(result.output).not.toContain("leaked");
		} finally {
			delete Bun.env.PI_DIRENV_UNSET_E2E;
		}
	});
});

describe.skipIf(!hasDirenv)("applyDirenvPreflight (shared all-backends preflight)", () => {
	// This helper is what the ACP client-terminal and PTY backends call so they
	// expose the same devenv env as `executeBash`. Assert its core contract:
	// set-merge with caller-wins, the regex-gated `unset -v` prefix, and the
	// off/absent passthrough. HOME/XDG isolation mirrors the loader cases so
	// `direnv allow` never touches the dev/CI user's global store.
	const savedEnv: Record<string, string | undefined> = {};
	beforeEach(() => {
		const home = tmp();
		for (const key of ["HOME", "XDG_DATA_HOME", "XDG_CONFIG_HOME", "XDG_CACHE_HOME"]) {
			savedEnv[key] = Bun.env[key];
			Bun.env[key] = path.join(home, key.toLowerCase());
		}
	});
	afterEach(() => {
		for (const [key, value] of Object.entries(savedEnv)) {
			if (value === undefined) delete Bun.env[key];
			else Bun.env[key] = value;
		}
	});

	it("merges direnv set vars into env while the caller's env wins", async () => {
		const root = tmp();
		await Bun.write(path.join(root, ".envrc"), "export DIRENV_PF_SET=fromdirenv\nexport OVERRIDE_ME=fromdirenv\n");
		await allowEnvrc(root);

		const { command, env } = await applyDirenvPreflight("echo hi", root, {
			callerEnv: { OVERRIDE_ME: "fromcaller" },
			direnvSetting: "auto",
		});

		expect(env?.DIRENV_PF_SET).toBe("fromdirenv");
		expect(env?.OVERRIDE_ME).toBe("fromcaller");
		// No unset in this .envrc, so the command is returned unprefixed.
		expect(command).toBe("echo hi");
	});

	it("prepends a regex-gated `unset -v` for vars the .envrc removes, skipping caller-resupplied names", async () => {
		const root = tmp();
		await Bun.write(path.join(root, ".envrc"), "unset PI_PF_UNSET_A\nunset PI_PF_UNSET_B\n");
		await allowEnvrc(root);
		Bun.env.PI_PF_UNSET_A = "present";
		Bun.env.PI_PF_UNSET_B = "present";
		try {
			const { command } = await applyDirenvPreflight("run-it", root, {
				// Caller re-supplies B, so its unset must be skipped (caller wins).
				callerEnv: { PI_PF_UNSET_B: "kept" },
				direnvSetting: "auto",
			});
			expect(command).toContain("unset -v PI_PF_UNSET_A");
			expect(command).not.toContain("PI_PF_UNSET_B");
			expect(command.endsWith("run-it")).toBe(true);
		} finally {
			delete Bun.env.PI_PF_UNSET_A;
			delete Bun.env.PI_PF_UNSET_B;
		}
	});

	it("applies the shell commandPrefix after the unset prefix", async () => {
		const root = tmp();
		await Bun.write(path.join(root, ".envrc"), "unset PI_PF_ORDER\n");
		await allowEnvrc(root);
		Bun.env.PI_PF_ORDER = "present";
		try {
			const { command } = await applyDirenvPreflight("payload", root, {
				direnvSetting: "auto",
				commandPrefix: "strace -f",
			});
			// Ordering must be: `unset -v NAME; <prefix> <command>`.
			expect(command).toBe("unset -v PI_PF_ORDER; strace -f payload");
		} finally {
			delete Bun.env.PI_PF_ORDER;
		}
	});

	it("returns the command + caller env unchanged when direnv is off", async () => {
		const root = tmp();
		await Bun.write(path.join(root, ".envrc"), "export DIRENV_PF_OFF=loaded\n");

		const callerEnv = { FOO: "bar" };
		const { command, env } = await applyDirenvPreflight("noop", root, {
			callerEnv,
			direnvSetting: "off",
		});

		expect(command).toBe("noop");
		expect(env).toBe(callerEnv);
	});

	it("returns the command + caller env unchanged when no .envrc exists", async () => {
		const callerEnv = { FOO: "bar" };
		const { command, env } = await applyDirenvPreflight("noop", tmp(), {
			callerEnv,
			direnvSetting: "auto",
		});

		expect(command).toBe("noop");
		expect(env).toBe(callerEnv);
	});
});
