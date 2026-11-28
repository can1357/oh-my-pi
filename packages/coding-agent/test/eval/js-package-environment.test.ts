import { afterEach, describe, expect, it, spyOn } from "bun:test";
import * as fsSync from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { setAgentDir, TempDir } from "@oh-my-pi/pi-utils";
import { Settings } from "../../src/config/settings";
import { disposeAllVmContexts } from "../../src/eval/js/context-manager";
import { executeJs } from "../../src/eval/js/executor";
import type { JsExecutorOptions } from "../../src/eval/js/executor";
import { installJsPackages, resolveJsPackageEnvironment } from "../../src/eval/js/package-installer";
import * as workerClient from "../../src/subprocess/worker-client";
import type { ToolSession } from "../../src/tools";
import {
	BELOW_TOOL_SCORE,
	BELOW_TOOL_SCORE_TIMEOUT_MS,
	belowToolScore,
} from "../../../utils/test/helpers/tool-process";
import { beginSettingsTest, restoreEnvValue, restoreSettingsTestState } from "../helpers/settings-test-state";

/** The timeout of a case that runs an installer: its launch, its run and the lock around it. */
const INSTALL_TIMEOUT_MS = 30_000;

function makeSession(cwd: string, evalSessionId: string, options?: { autoProvision?: boolean }): ToolSession {
	return {
		cwd,
		hasUI: false,
		settings: Settings.isolated({
			"async.enabled": false,
			"eval.autoProvision": options?.autoProvision ?? true,
			"task.isolation.enabled": false,
			"task.enableLsp": true,
		}),
		taskDepth: 0,
		enableLsp: true,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		getActiveModelString: () => "p/active",
		getModelString: () => "p/fallback",
		getArtifactsDir: () => null,
		getSessionId: () => evalSessionId,
		getEvalSessionId: () => evalSessionId,
	};
}

function executorOptions(session: ToolSession, sessionId: string): JsExecutorOptions {
	return { cwd: session.cwd, sessionId, session };
}

function canResolve(specifier: string, fromDir: string): boolean {
	try {
		Bun.resolveSync(specifier, fromDir);
		return true;
	} catch {
		return false;
	}
}

/**
 * Picks a package OMP itself resolves but none of `roots` can. Prefers `@babel/parser`; a stray
 * `node_modules` above a root (e.g. `npm i` run in the Windows profile dir) legitimately puts
 * it in that root's ancestry, so fall back to any other package installed for OMP.
 */
function ompOnlyPackage(...roots: string[]): string {
	const ompDir = path.resolve(import.meta.dir, "../..");
	const repoModules = path.resolve(ompDir, "../../node_modules");
	const candidates = [
		"@babel/parser",
		...fsSync.readdirSync(repoModules).filter(name => !name.startsWith(".") && !name.startsWith("@")),
	];
	const picked = candidates.find(name => canResolve(name, ompDir) && !roots.some(root => canResolve(name, root)));
	if (!picked) throw new Error(`Every OMP dependency is also resolvable from ${roots.join(" or ")}`);
	return picked;
}

describe("persistent JavaScript package environments", () => {
	const managedRoots: string[] = [];

	afterEach(async () => {
		await disposeAllVmContexts();
		await Promise.all(
			managedRoots
				.splice(0)
				.flatMap(root => [
					fs.rm(root, { recursive: true, force: true }),
					fs.rm(`${root}.install.lock`, { force: true }),
				]),
		);
	});

	/** Install a package into a project environment with `executable` as the runtime that installs it. */
	async function installWithRuntime(workspace: TempDir, executable: string): Promise<void> {
		const state = beginSettingsTest();
		setAgentDir(workspace.join("agent"));
		const resolve = spyOn(workerClient, "resolveExecutablePath").mockReturnValue(executable);
		try {
			await installJsPackages({
				packages: ["example-package"],
				cwd: workspace.path(),
				environment: "project",
				autoProvision: false,
			});
		} finally {
			resolve.mockRestore();
			restoreSettingsTestState(state);
		}
	}

	// Failure mode: the package installer, its child included, keeps Oh My Pi's OOM adjustment, so the kernel, picking
	// one process to kill for lack of memory, may kill Oh My Pi in its place; or the spawn changes Oh My Pi's value.
	const INSTALLER_SCORE = "sets the score of the package installer and its child, not the host";
	it.skipIf(!BELOW_TOOL_SCORE)(
		INSTALLER_SCORE,
		async () => {
			await belowToolScore(import.meta.path, INSTALLER_SCORE, async before => {
				using workspace = TempDir.createSync("@omp-js-package-score-");
				const executable = workspace.join("bun");
				const score = "/proc/self/oom_score_adj";
				await fs.writeFile(
					executable,
					[
						"#!/bin/sh",
						'exec > "$3/installer-scores"',
						`read -r score < ${score}`,
						`printf '%s\\n' "$score"`,
						`/bin/cat ${score}; :`,
					].join("\n"),
					{ mode: 0o700 },
				);
				await installWithRuntime(workspace, executable);
				expect(await Bun.file(score).text()).toBe(before);
				expect(await Bun.file(workspace.join("installer-scores")).text()).toBe("1000\n1000\n");
			});
		},
		BELOW_TOOL_SCORE_TIMEOUT_MS,
	);

	// Failure mode: the installer gets the environment a shell imports instead of this process's: `dash` drops
	// names that are not shell identifiers (an exported Bash function) and resets `IFS` and `OPTIND`.
	it.skipIf(process.platform !== "linux" || !Bun.which("python3"))(
		"starts the package installer with this process's environment unchanged",
		async () => {
			using workspace = TempDir.createSync("@omp-js-package-env-");
			const executable = workspace.join("bun");
			const vars: Record<string, string> = { "BASH_FUNC_f%%": "() { echo f; }", "a.b": "1", IFS: ":", OPTIND: "5" };
			await fs.writeFile(
				executable,
				[
					"#!/usr/bin/env python3",
					"import json, os, sys",
					`names = ${JSON.stringify(Object.keys(vars))}`,
					'with open(os.path.join(sys.argv[3], "installer-env"), "w") as out:',
					"    json.dump({name: os.environ.get(name) for name in names}, out)",
				].join("\n"),
				{ mode: 0o700 },
			);
			const saved = Object.keys(vars).map(name => [name, Bun.env[name]] as const);
			Object.assign(Bun.env, vars);
			try {
				await installWithRuntime(workspace, executable);
			} finally {
				for (const [name, value] of saved) restoreEnvValue(name, value);
			}
			expect(await Bun.file(workspace.join("installer-env")).json()).toEqual(vars);
		},
		INSTALL_TIMEOUT_MS,
	);

	/** A spawn's or an install's failure: its code, its errno (positive) and its message. */
	interface Failure {
		code: string | undefined;
		errno: number | undefined;
		message: string;
	}

	/**
	 * Install a package into a project environment with `body`, an executable file, as the runtime that installs
	 * it: that file, what the install throws, and what a spawn of that file throws.
	 */
	async function installWith(
		body: string,
	): Promise<{ executable: string; install: Failure | "installed"; spawn: Failure | "started" }> {
		using workspace = TempDir.createSync("@omp-js-package-installer-");
		const executable = workspace.join("bun");
		await fs.writeFile(executable, body, { mode: 0o700 });
		const failure = (error: NodeJS.ErrnoException): Failure => ({
			code: error.code,
			errno: error.errno === undefined ? undefined : Math.abs(error.errno),
			message: error.message,
		});
		let spawn: Failure | "started" = "started";
		try {
			Bun.spawn([executable], { stdout: "ignore", stderr: "ignore" }).kill();
		} catch (error) {
			spawn = failure(error as NodeJS.ErrnoException);
		}
		const install = await installWithRuntime(workspace, executable).then(() => "installed" as const, failure);
		return { executable, install, spawn };
	}

	// Failure mode: an installer that cannot start (a script whose `#!` interpreter is missing, a file without
	// `#!` that the kernel cannot load) is reported as a Bun that ran and exited 127, or runs as shell code. The
	// install fails with the errno of the installer's exec, the one its own spawn fails with.
	it.skipIf(process.platform !== "linux")(
		"fails an installer that cannot exec with the error of its exec",
		async () => {
			for (const [body, code] of [
				["#!/nonexistent/interpreter\n", "ENOENT"],
				["echo ran as shell code\n", "ENOEXEC"],
			]) {
				const { executable, install, spawn } = await installWith(body);
				expect(spawn).toMatchObject({ code });
				if (spawn === "started") throw new Error(`${executable} started`);
				expect(install).toMatchObject({ code: spawn.code, errno: spawn.errno });
				expect(install).toMatchObject({ message: expect.stringContaining(executable) });
			}
		},
		INSTALL_TIMEOUT_MS,
	);

	// Failure mode: an installer that starts and exits 127 is taken for one that could not start.
	it.skipIf(process.platform !== "linux")(
		"reports an installer that exits 127 by its exit",
		async () => {
			const { install } = await installWith("#!/bin/sh\nexit 127\n");
			expect(install).toMatchObject({ code: undefined, message: expect.stringContaining("(exit 127)") });
		},
		INSTALL_TIMEOUT_MS,
	);

	it("refuses an implicit managed environment bootstrap when auto-provisioning is disabled", async () => {
		using workspace = TempDir.createSync("@omp-js-package-policy-");
		const sessionId = `js-package-policy:${crypto.randomUUID()}`;
		const session = makeSession(workspace.path(), sessionId, { autoProvision: false });
		const environment = resolveJsPackageEnvironment(workspace.path());
		managedRoots.push(environment.root);

		const result = await executeJs("", {
			...executorOptions(session, sessionId),
			packages: ["package-that-must-not-be-fetched"],
		});
		expect(result.exitCode).toBe(1);
		expect(result.output).toContain("eval.autoProvision is disabled");
		await expect(fs.access(path.join(environment.root, "package.json"))).rejects.toBeDefined();
	});

	it("resolves file imports from the filename while preserving cwd and repeat execution", async () => {
		using workspace = TempDir.createSync("@omp-js-file-workspace-");
		using scriptDir = TempDir.createSync("@omp-js-file-script-");
		const filename = path.join(scriptDir.path(), "loaded.ts");
		const source = [
			'import { amount } from "./sibling.ts";',
			"globalThis.fileLoadCount = (globalThis.fileLoadCount ?? 0) + 1;",
			"var fileLoadedValue = fileSeed + amount;",
			"function fileAnswer() { return fileLoadedValue; }",
			"var fileObservedCwd = process.cwd();",
		].join("\n");
		await Bun.write(path.join(scriptDir.path(), "sibling.ts"), "export const amount = 2;\n");
		await Bun.write(filename, source);

		const sessionId = `js-file:${crypto.randomUUID()}`;
		const session = makeSession(workspace.path(), sessionId);
		const options = executorOptions(session, sessionId);
		await executeJs("var fileSeed = 10;", options);
		const first = await executeJs(source, { ...options, filename });
		const second = await executeJs(source, { ...options, filename });
		expect(first.exitCode).toBe(0);
		expect(second.exitCode).toBe(0);
		expect(first.output).not.toContain(source);
		expect(second.output).not.toContain(source);

		const reloadSource = "fileLoadedValue += 1; fileLoadedValue;";
		await Bun.write(filename, reloadSource);
		const reloaded = await executeJs(reloadSource, { ...options, filename });
		expect(reloaded.output.trim()).toBe("13");

		const retained = await executeJs("JSON.stringify([fileAnswer(), fileObservedCwd, fileLoadCount])", options);
		expect(JSON.parse(retained.output.trim())).toEqual([13, await fs.realpath(workspace.path()), 2]);
	});

	it("does not resolve a missing project package from OMP's own dependencies", async () => {
		// Dynamic import is the behavior under test: a static import would be
		// resolved by this test module's own dependency graph.
		using workspace = TempDir.createSync("@omp-js-package-missing-");
		// The eval falls back to the managed environment, which lives under the agent dir (by default in HOME), so a
		// `node_modules` beside HOME would supply the package. Root the agent dir in the workspace instead.
		const settingsState = beginSettingsTest();
		setAgentDir(workspace.join("agent"));
		try {
			const sessionId = `js-package-missing:${crypto.randomUUID()}`;
			const session = makeSession(workspace.path(), sessionId);
			// The package must be missing from both roots the eval resolves from: the project and its fallback.
			const { packageRoot } = resolveJsPackageEnvironment(workspace.path());
			if (packageRoot === undefined) throw new Error("The managed JS package environment has no fallback root");
			const specifier = ompOnlyPackage(workspace.path(), packageRoot);
			const result = await executeJs(
				`await import(${JSON.stringify(specifier)})`,
				executorOptions(session, sessionId),
			);
			expect(result.exitCode).toBe(1);
			expect(result.output).toContain("JS package environment fallback");
		} finally {
			restoreSettingsTestState(settingsState);
		}
	});
});
