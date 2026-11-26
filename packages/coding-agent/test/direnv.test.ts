import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { applyDirenvPreflight, executeBash } from "@oh-my-pi/pi-coding-agent/exec/bash-executor";
import { clearDirenvCachesForTests, findEnvrc, loadDirenvEnv } from "@oh-my-pi/pi-coding-agent/exec/direnv";
import { TempDir } from "@oh-my-pi/pi-utils";

const savedEnv: Record<string, string | undefined> = {};

const tmpDirs: TempDir[] = [];
function tmp(): string {
	const dir = TempDir.createSync("@pi-direnv-");
	tmpDirs.push(dir);
	// direnv's working directory on macOS can resolve /var to /private/var.
	return realpathSync(dir.path());
}

beforeEach(() => {
	const home = tmp();
	for (const key of [
		"HOME",
		"XDG_DATA_HOME",
		"XDG_CONFIG_HOME",
		"XDG_CACHE_HOME",
		"DIRENV_CONFIG",
		"DIRENV_DISABLE",
		"DIRENV_EXE_PATH",
		"PATH",
		"PI_DISABLE_UUTILS_BUILTINS",
	]) {
		savedEnv[key] = Bun.env[key];
		if (key.startsWith("DIRENV_")) delete Bun.env[key];
		else if (key.endsWith("_HOME") || key === "HOME") Bun.env[key] = path.join(home, key.toLowerCase());
	}
});

afterEach(async () => {
	for (const key in savedEnv) {
		if (savedEnv[key] === undefined) delete Bun.env[key];
		else Bun.env[key] = savedEnv[key];
	}
	for (const dir of tmpDirs.splice(0)) await dir.remove();
	clearDirenvCachesForTests();
});

// Independent fixtures for the format written by upstream `direnv allow`/`deny`.
async function trustMarker(file: string, allow: boolean): Promise<string> {
	const hash = createHash("sha256").update(`${file}\n`);
	if (allow) hash.update(await fs.readFile(file));
	return path.join(Bun.env.XDG_DATA_HOME!, "direnv", allow ? "allow" : "deny", hash.digest("hex"));
}

async function allowEnvrc(dir: string, name = ".envrc"): Promise<void> {
	const file = path.join(dir, name);
	await Bun.write(await trustMarker(file, true), `${file}\n`);
}

function configDir(): string {
	return path.join(Bun.env.XDG_CONFIG_HOME!, "direnv");
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

describe("loadDirenvEnv (embedded Bash, upstream trust format)", () => {
	it("sources the approved bytes even if a user library replaces .envrc during startup", async () => {
		const root = tmp();
		const rc = path.join(root, ".envrc");
		await Bun.write(rc, 'export PI_DIRENV_SNAPSHOT="${BASH_SOURCE[0]}"\n');
		await Bun.write(path.join(root, "replacement"), "printf leaked > ran\nexport PI_DIRENV_SNAPSHOT=changed\n");
		await Bun.write(
			path.join(configDir(), "lib", "replace.sh"),
			"if [[ -f replacement ]]; then mv -f replacement .envrc; fi\n",
		);
		await allowEnvrc(root);

		expect((await loadDirenvEnv(root))?.set.PI_DIRENV_SNAPSHOT).toBe("./.envrc");
		expect(await Bun.file(rc).text()).toContain("=changed");
		expect(await loadDirenvEnv(root)).toBeNull();
		expect(await Bun.file(path.join(root, "ran")).exists()).toBe(false);
	});

	it("returns null for an .envrc the user has not allowed (never auto-allows)", async () => {
		// The security contract: an untrusted `.envrc` is NEVER executed. A
		// poisoned repo gets nothing until the user runs `direnv allow` — exactly
		// the trust boundary direnv itself enforces in the user's shell.
		const root = tmp();
		await Bun.write(path.join(root, ".envrc"), "printf leaked > ran\nexport DIRENV_BLOCKED_TEST=leaked\n");

		expect(await loadDirenvEnv(root)).toBeNull();
		expect(await Bun.file(path.join(root, "ran")).exists()).toBe(false);
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

	it("uses embedded direnv even with utilities disabled and no binary on PATH", async () => {
		const root = tmp();
		Bun.env.PATH = root;
		Bun.env.PI_DISABLE_UUTILS_BUILTINS = "1";
		Bun.env.DIRENV_EXE_PATH = path.join(root, "missing-direnv");
		await Bun.write(
			path.join(root, ".envrc"),
			`export PI_DIRENV_MULTILINE='line 1\nline 2' PI_DIRENV_GATE=$PI_DISABLE_UUTILS_BUILTINS\n`,
		);
		await allowEnvrc(root);
		const diff = await loadDirenvEnv(root);
		expect(diff?.set.PI_DIRENV_MULTILINE).toBe("line 1\nline 2");
		expect(diff?.set.PI_DIRENV_GATE).toBe("1");
	});

	it("reports variables a .envrc unsets", async () => {
		const root = tmp();
		await Bun.write(path.join(root, ".envrc"), "unset PI_DIRENV_UNSET_TEST\n");
		await allowEnvrc(root);
		// A deletion only appears in the diff if the value starts in the env.
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

	it("applies deny precedence over a retained approval and notices revocation immediately", async () => {
		const root = tmp();
		const rc = path.join(root, ".envrc");
		await Bun.write(rc, "printf x >> runs\nexport DIRENV_DENY_TEST=allowed\n");
		await allowEnvrc(root);
		expect((await loadDirenvEnv(root))?.set.DIRENV_DENY_TEST).toBe("allowed");
		const deny = await trustMarker(rc, false);
		await Bun.write(deny, `${rc}\n`);
		expect(await loadDirenvEnv(root)).toBeNull();
		expect(await Bun.file(path.join(root, "runs")).text()).toBe("x");
		await fs.unlink(deny);
		expect((await loadDirenvEnv(root))?.set.DIRENV_DENY_TEST).toBe("allowed");
		await fs.unlink(await trustMarker(rc, true));
		expect(await loadDirenvEnv(root)).toBeNull();
		expect(await Bun.file(path.join(root, "runs")).text()).toBe("xx");
	});

	it("honors user whitelists until a denial or a configuration change revokes them", async () => {
		const root = tmp();
		const rc = path.join(root, ".envrc");
		const config = path.join(configDir(), "direnv.toml");
		await Bun.write(rc, "export PI_DIRENV_WHITELIST=loaded\n");
		await Bun.write(config, `[whitelist]\nexact = [${JSON.stringify(root)}]\n`);
		expect((await loadDirenvEnv(root))?.set.PI_DIRENV_WHITELIST).toBe("loaded");

		const marker = await trustMarker(rc, false);
		await Bun.write(marker, `${rc}\n`);
		expect(await loadDirenvEnv(root)).toBeNull();
		await fs.unlink(marker);
		expect((await loadDirenvEnv(root))?.set.PI_DIRENV_WHITELIST).toBe("loaded");

		await Bun.write(config, "[whitelist]\nexact = []\n");
		expect(await loadDirenvEnv(root)).toBeNull();
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
		expect(await loadDirenvEnv(root)).toBeNull();
		await allowEnvrc(root);
		expect((await loadDirenvEnv(root))?.set.DIRENV_CACHE_TEST).toBe("two");
	});

	it("does not reuse a parent's warm env when a nearer unapproved .envrc appears", async () => {
		const root = tmp();
		const child = path.join(root, "child");
		await fs.mkdir(child);
		await Bun.write(path.join(root, ".envrc"), "export PI_DIRENV_PARENT_TEST=approved\n");
		await allowEnvrc(root);
		expect((await loadDirenvEnv(child))?.set.PI_DIRENV_PARENT_TEST).toBe("approved");
		await Bun.write(path.join(child, ".envrc"), "printf unapproved > ran\n");
		expect(await loadDirenvEnv(child)).toBeNull();
		expect(await Bun.file(path.join(child, "ran")).exists()).toBe(false);
	});

	it("updates exports from a source_env dependency when it changes", async () => {
		const root = tmp();
		const helper = path.join(root, "child", ".envrc");
		await Bun.write(path.join(root, ".envrc"), "source_env child\n");
		await Bun.write(helper, "printf x >> ran\nexport PI_DIRENV_NESTED=first\n");
		await allowEnvrc(root);

		expect((await loadDirenvEnv(root))?.set.PI_DIRENV_NESTED).toBe("first");
		expect((await loadDirenvEnv(root))?.set.PI_DIRENV_NESTED).toBe("first");

		await Bun.write(helper, "printf x >> ran\nexport PI_DIRENV_NESTED=second\n");
		expect((await loadDirenvEnv(root))?.set.PI_DIRENV_NESTED).toBe("second");
		expect(await Bun.file(path.join(root, "child", "ran")).text()).toBe("xx");
	});

	it("does not execute the remainder when a require_allowed input is unapproved or changed", async () => {
		const root = tmp();
		const rc = path.join(root, ".envrc");
		const input = path.join(root, "manifest");
		await Bun.write(rc, "require_allowed manifest\nprintf x >> ran\nexport PI_DIRENV_REQUIRED=ok\n");
		await Bun.write(input, "one");
		await allowEnvrc(root);
		expect(await loadDirenvEnv(root)).toBeNull();
		expect(await Bun.file(path.join(root, "ran")).exists()).toBe(false);
		const rcHash = createHash("sha256").update(`${rc}\n`).digest("hex");
		const inputHash = createHash("sha256").update(`${input}\none`).digest("hex");
		const marker = path.join(Bun.env.XDG_DATA_HOME!, "direnv", "allowed-required", rcHash, inputHash);
		await Bun.write(marker, `${input}\n`);
		expect((await loadDirenvEnv(root))?.set.PI_DIRENV_REQUIRED).toBe("ok");
		await fs.unlink(marker);
		expect(await loadDirenvEnv(root)).toBeNull();
		await Bun.write(marker, `${input}\n`);
		await Bun.write(input, "two");
		expect(await loadDirenvEnv(root)).toBeNull();
		expect(await Bun.file(path.join(root, "ran")).text()).toBe("x");
	});

	it("parses watched dotenv files as data rather than running them as Bash", async () => {
		const root = tmp();
		await Bun.write(path.join(root, ".envrc"), "dotenv_if_exists config\n");
		await Bun.write(path.join(root, "config"), `PI_DIRENV_DOTENV='$(touch ran)'\n`);
		await allowEnvrc(root);
		expect((await loadDirenvEnv(root))?.set.PI_DIRENV_DOTENV).toBe("$(touch ran)");
		expect(await Bun.file(path.join(root, "ran")).exists()).toBe(false);
		await Bun.write(path.join(root, "config"), "PI_DIRENV_DOTENV=changed\n");
		expect((await loadDirenvEnv(root))?.set.PI_DIRENV_DOTENV).toBe("changed");
	});

	it("ignores a nearer .env when disabled and caches the actual .envrc", async () => {
		const root = tmp();
		const sub = path.join(root, "sub");
		await Bun.write(path.join(sub, ".env"), "PI_DIRENV_ROOT=dotenv\n");
		await Bun.write(path.join(configDir(), "direnvrc"), "export PI_DIRENV_ROOT=$PWD\n");
		await Bun.write(path.join(root, ".envrc"), "printf x >> runs\n");
		await allowEnvrc(root);
		expect((await loadDirenvEnv(sub))?.set.PI_DIRENV_ROOT).toBe(root);
		expect((await loadDirenvEnv(sub))?.set.PI_DIRENV_ROOT).toBe(root);
		expect(await Bun.file(path.join(root, "runs")).text()).toBe("x");

		await Bun.write(path.join(configDir(), "direnv.toml"), "[global]\nload_dotenv = true\n");
		expect(await loadDirenvEnv(sub)).toBeNull();
	});

	it("requires approval for config-enabled .env files and loads them as data", async () => {
		const root = tmp();
		await Bun.write(path.join(configDir(), "direnv.toml"), "[global]\nload_dotenv = true\n");
		await Bun.write(path.join(root, ".env"), "PI_DIRENV_AUTO_DOTENV=approved\n");
		expect(await loadDirenvEnv(root)).toBeNull();
		await allowEnvrc(root, ".env");
		expect((await loadDirenvEnv(root))?.set.PI_DIRENV_AUTO_DOTENV).toBe("approved");
	});

	it("parses the approved .env snapshot after direnvrc replaces the file", async () => {
		const root = tmp();
		await Bun.write(path.join(configDir(), "direnv.toml"), "[global]\nload_dotenv = true\n");
		await Bun.write(path.join(root, ".env"), 'PI_DIRENV_DOTENV_SNAPSHOT="${PI_DIRENV_USER_CONFIG}:$PWD"\n');
		await Bun.write(path.join(root, "replacement"), "PI_DIRENV_DOTENV_SNAPSHOT=replacement\n");
		await Bun.write(
			path.join(configDir(), "direnvrc"),
			"export PI_DIRENV_USER_CONFIG=approved\nif [[ -f replacement ]]; then mv -f replacement .env; fi\n",
		);
		await allowEnvrc(root, ".env");

		expect((await loadDirenvEnv(root))?.set.PI_DIRENV_DOTENV_SNAPSHOT).toBe(`approved:${root}`);
		expect(await loadDirenvEnv(root)).toBeNull();
	});

	it("sources an integrity-pinned URL and never executes content with a mismatched digest", async () => {
		const root = tmp();
		const script = "export PI_DIRENV_URL=approved\n";
		const integrity = `sha256-${createHash("sha256").update(script).digest("base64")}`;
		let response = "printf unapproved > ran\n";
		const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response(response) });
		try {
			await Bun.write(path.join(root, ".envrc"), `source_url '${server.url}' '${integrity}' || exit 1\n`);
			await allowEnvrc(root);
			expect(await loadDirenvEnv(root)).toBeNull();
			expect(await Bun.file(path.join(root, "ran")).exists()).toBe(false);
			response = script;
			expect((await loadDirenvEnv(root))?.set.PI_DIRENV_URL).toBe("approved");
		} finally {
			await server.stop(true);
		}
	});

	it("loads a user-supplied use devenv helper with the upstream helper surface", async () => {
		const root = tmp();
		await Bun.write(
			path.join(configDir(), "lib", "devenv.sh"),
			[
				"use_devenv() {",
				"  direnv_version 2.21.3 || return",
				"  watch_file devenv.nix || return",
				"  export PI_DIRENV_DEVENV=$1",
				"}",
			].join("\n"),
		);
		await Bun.write(path.join(root, ".envrc"), "use devenv argument\n");
		await allowEnvrc(root);
		expect((await loadDirenvEnv(root))?.set.PI_DIRENV_DEVENV).toBe("argument");
	});

	it("enforces the evaluation time limit and caller cancellation", async () => {
		const root = tmp();
		await Bun.write(path.join(root, ".envrc"), "sleep 5\nprintf x > ran\n");
		await allowEnvrc(root);
		expect(await loadDirenvEnv(root, { timeoutMs: 40 })).toBeNull();
		// A native run consumes an actual AbortSignal rather than a fake timer.
		expect(await loadDirenvEnv(root, { signal: AbortSignal.timeout(60) })).toBeNull();
		expect(await Bun.file(path.join(root, "ran")).exists()).toBe(false);
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

	it("does not cache an old value under a watch stamp acquired after evaluation", async () => {
		const root = tmp();
		await Bun.write(path.join(root, "value"), "first\n");
		await Bun.write(
			path.join(root, ".envrc"),
			'watch_file value\nread -r PI_WATCH_VALUE < value\nexport PI_WATCH_VALUE\nprintf "next\\n" > value\n',
		);
		await allowEnvrc(root);
		expect((await loadDirenvEnv(root))?.set.PI_WATCH_VALUE).toBe("first");
		expect((await loadDirenvEnv(root))?.set.PI_WATCH_VALUE).toBe("next");
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

describe("bash executor direnv wiring (end-to-end)", () => {
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

describe("applyDirenvPreflight (shared all-backends preflight)", () => {
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
