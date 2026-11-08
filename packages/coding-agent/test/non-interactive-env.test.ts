import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { buildNonInteractiveEnv, NON_INTERACTIVE_ENV } from "@oh-my-pi/pi-coding-agent/exec/non-interactive-env";

describe("buildNonInteractiveEnv", () => {
	it("defaults Windows child-process encoding to UTF-8 when inherited env is unset", () => {
		const env = buildNonInteractiveEnv(undefined, { baseEnv: {}, platform: "win32" });

		expect(env.PYTHONIOENCODING).toBe("utf-8");
		expect(env.PYTHONUTF8).toBe("1");
		expect(env.LANG).toBe("C.UTF-8");
		expect(env.LC_ALL).toBe("C.UTF-8");
	});

	// An inherited `LANG=en_US.UTF-8` made `sort` collate while byte-order
	// tools (comm, git) disagreed, and localized messages vary by machine.
	it("pins the agent locale over an inherited one on every platform", () => {
		for (const platform of ["linux", "darwin", "win32"] as const) {
			const env = buildNonInteractiveEnv(undefined, {
				baseEnv: { LANG: "de_DE.UTF-8", LC_ALL: "de_DE.UTF-8", PYTHONUTF8: "0" },
				platform,
			});

			expect(env.LANG).toBe("C.UTF-8");
			expect(env.LC_ALL).toBe("C.UTF-8");
			expect(env.PYTHONIOENCODING).toBeUndefined();
			expect(env.PYTHONUTF8).toBeUndefined();
		}
	});

	it("lets a per-command locale or encoding replace the defaults", () => {
		const env = buildNonInteractiveEnv(
			{ PYTHONUTF8: "0", LC_CTYPE: "en_US.UTF-8" },
			{ baseEnv: {}, platform: "win32" },
		);

		expect(env.PYTHONIOENCODING).toBeUndefined();
		expect(env.PYTHONUTF8).toBe("0");
		expect(env.LANG).toBeUndefined();
		expect(env.LC_ALL).toBeUndefined();
		expect(env.LC_CTYPE).toBe("en_US.UTF-8");
	});

	it("keeps the inherited locale for user-shell commands, defaulting Windows to UTF-8", () => {
		const posix = buildNonInteractiveEnv(undefined, { baseEnv: {}, platform: "darwin", inheritLocale: true });
		expect(posix.LANG).toBeUndefined();
		expect(posix.LC_ALL).toBeUndefined();

		const windowsUnset = buildNonInteractiveEnv(undefined, { baseEnv: {}, platform: "win32", inheritLocale: true });
		expect(windowsUnset.LC_ALL).toBe("C.UTF-8");

		const windowsInherited = buildNonInteractiveEnv(undefined, {
			baseEnv: { LC_CTYPE: "en_US.UTF-8" },
			platform: "win32",
			inheritLocale: true,
		});
		expect(windowsInherited.LANG).toBeUndefined();
		expect(windowsInherited.LC_ALL).toBeUndefined();
	});

	it("does not invent a bogus GPG_TTY", () => {
		const env = buildNonInteractiveEnv(undefined, { baseEnv: {}, platform: "linux" });

		expect(env).not.toHaveProperty("GPG_TTY");
	});

	it("preserves per-command GPG_TTY overrides", () => {
		const env = buildNonInteractiveEnv({ GPG_TTY: "/dev/pts/7" }, { baseEnv: {}, platform: "linux" });

		expect(env.GPG_TTY).toBe("/dev/pts/7");
	});

	it("uses an executable SSH askpass rejector on POSIX", async () => {
		if (process.platform === "win32") return;
		const proc = Bun.spawn([NON_INTERACTIVE_ENV.SSH_ASKPASS], {
			stdout: "ignore",
			stderr: "ignore",
		});

		expect(await proc.exited).toBe(1);
	});

	it("injects clap-compatible CI=true by default", () => {
		expect(buildNonInteractiveEnv(undefined, { baseEnv: {}, platform: "linux" }).CI).toBe("true");
		expect(buildNonInteractiveEnv(undefined, { baseEnv: {}, platform: "win32" }).CI).toBe("true");
	});

	it("drops CI when PI_BASH_NO_CI or its legacy alias is set", () => {
		expect(
			buildNonInteractiveEnv(undefined, { baseEnv: { PI_BASH_NO_CI: "1" }, platform: "linux" }),
		).not.toHaveProperty("CI");
		expect(
			buildNonInteractiveEnv(undefined, { baseEnv: { CLAUDE_BASH_NO_CI: "1" }, platform: "linux" }),
		).not.toHaveProperty("CI");
		expect(
			buildNonInteractiveEnv(undefined, { baseEnv: { PI_BASH_NO_CI: "1" }, platform: "win32" }),
		).not.toHaveProperty("CI");
	});

	it("lets a per-command CI override win over the opt-out", () => {
		expect(buildNonInteractiveEnv({ CI: "0" }, { baseEnv: { PI_BASH_NO_CI: "1" }, platform: "linux" }).CI).toBe("0");
	});
});

it("filters expanded dotenv values while preserving matching and empty launcher values", async () => {
	const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "omp-env-"));
	try {
		await Bun.write(
			path.join(tmp, ".env"),
			[
				"BASE=loaded-by-omp",
				"EMPTY_PARENT_VAR=project-secret",
				"TEST_ENV_FROM_DOTENV=$BASE-suffix",
				"NODE_ENV=development",
				"export EXPORTED_SECRET=exported",
				"COMMENTED_SECRET=secret # trailing comment",
				"",
			].join("\n"),
		);
		await Bun.write(
			path.join(tmp, ".env.local"),
			"CONVEX_DEPLOYMENT=anonymous:root-local\nCONVEX_URL=http://127.0.0.1:3210\n",
		);
		const procmgrPath = path.resolve(import.meta.dir, "../../utils/src/procmgr.ts");
		const script = [
			`import { getShellConfig } from ${JSON.stringify(procmgrPath)};`,
			"const env = getShellConfig().env;",
			"console.log(JSON.stringify({",
			"	project: env.TEST_ENV_FROM_DOTENV ?? null,",
			"	deployment: env.CONVEX_DEPLOYMENT ?? null,",
			"	url: env.CONVEX_URL ?? null,",
			"	inherited: env.OMP_TEST_INHERITED_MARKER ?? null,",
			"	empty: env.EMPTY_PARENT_VAR ?? null,",
			"	matching: env.NODE_ENV ?? null,",
			"	exported: env.EXPORTED_SECRET ?? null,",
			"	commented: env.COMMENTED_SECRET ?? null,",
			"}));",
		].join("\n");
		const bunArgSets = process.platform === "linux" ? [[], ["--no-env-file"]] : [["--no-env-file"]];
		for (const bunArgs of bunArgSets) {
			const proc = Bun.spawn([process.execPath, ...bunArgs, "--no-install", "--eval", script], {
				cwd: tmp,
				env: {
					HOME: process.env.HOME ?? "",
					EMPTY_PARENT_VAR: "",
					OMP_TEST_INHERITED_MARKER: "keep-me",
					NODE_ENV: "development",
					PATH: process.env.PATH ?? "",
					SHELL: process.env.SHELL ?? "/bin/bash",
				},
				stdout: "pipe",
				stderr: "pipe",
			});
			const [stdout, stderr, exitCode] = await Promise.all([
				new Response(proc.stdout).text(),
				new Response(proc.stderr).text(),
				proc.exited,
			]);

			expect(stderr).toBe("");
			expect(exitCode).toBe(0);
			const payload: {
				project: string | null;
				deployment: string | null;
				url: string | null;
				inherited: string | null;
				empty: string | null;
				matching: string | null;
				exported: string | null;
				commented: string | null;
			} = JSON.parse(stdout);
			expect(payload).toEqual({
				project: null,
				deployment: null,
				url: null,
				inherited: "keep-me",
				matching: "development",
				empty: "",
				exported: null,
				commented: null,
			});
		}
	} finally {
		await fs.rm(tmp, { recursive: true, force: true });
	}
});
