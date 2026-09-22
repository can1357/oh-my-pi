import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { TempDir } from "@oh-my-pi/pi-utils";
import { Settings } from "../../src/config/settings";
import { disposeAllVmContexts } from "../../src/eval/js/context-manager";
import { executeJs } from "../../src/eval/js/executor";
import type { JsExecutorOptions } from "../../src/eval/js/executor";
import { resolveJsPackageEnvironment } from "../../src/eval/js/package-installer";
import type { ToolSession } from "../../src/tools";

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

	it("installs outside the project and imports without restarting the retained namespace", async () => {
		using workspace = TempDir.createSync("@omp-js-package-workspace-");
		using packageDir = TempDir.createSync("@omp-js-package-fixture-");
		const packageName = `omp-eval-fixture-${crypto.randomUUID()}`;
		await Bun.write(
			path.join(packageDir.path(), "package.json"),
			JSON.stringify({ name: packageName, version: "1.0.0", type: "module", exports: "./index.js" }),
		);
		await Bun.write(path.join(packageDir.path(), "index.js"), "export const value = 2;\n");

		const sessionId = `js-package:${crypto.randomUUID()}`;
		const session = makeSession(workspace.path(), sessionId);
		const options = executorOptions(session, sessionId);
		managedRoots.push(resolveJsPackageEnvironment(workspace.path()).root);

		const seeded = await executeJs("var packageSeed = 40;", options);
		expect(seeded.exitCode).toBe(0);
		const installed = await executeJs("", {
			...options,
			packages: [pathToFileURL(packageDir.path()).href],
		});
		expect(installed.exitCode).toBe(0);
		expect(installed.output).toContain("OMP-managed environment");
		expect(installed.output).toContain("Lifecycle scripts were disabled");

		const imported = await executeJs(
			`import { value } from ${JSON.stringify(packageName)}; var packageResult = packageSeed + value; packageResult;`,
			options,
		);
		expect(imported.exitCode).toBe(0);
		expect(imported.output.trim()).toBe("42");
		const retained = await executeJs("packageResult + 1", options);
		expect(retained.output.trim()).toBe("43");

		const otherSessionId = `js-package-shared:${crypto.randomUUID()}`;
		const otherSession = makeSession(workspace.path(), otherSessionId);
		const shared = await executeJs(
			`import { value } from ${JSON.stringify(packageName)}; JSON.stringify([value, typeof packageSeed]);`,
			executorOptions(otherSession, otherSessionId),
		);
		expect(shared.exitCode).toBe(0);
		expect(JSON.parse(shared.output.trim())).toEqual([2, "undefined"]);

		const scriptDir = path.join(workspace.path(), "scripts");
		await fs.mkdir(scriptDir);
		await Bun.write(
			path.join(scriptDir, "consumer.ts"),
			`import { value } from ${JSON.stringify(packageName)}; export const derived = value + 1;\n`,
		);
		const loadedFilename = path.join(scriptDir, "loaded.ts");
		const loadedSource = 'import { derived } from "./consumer.ts"; derived;';
		await Bun.write(loadedFilename, loadedSource);
		const importedFromModule = await executeJs(loadedSource, { ...options, filename: loadedFilename });
		expect(importedFromModule.exitCode).toBe(0);
		expect(importedFromModule.output.trim()).toBe("3");

		for (const projectArtifact of ["package.json", "bun.lock", "node_modules"]) {
			await expect(fs.access(path.join(workspace.path(), projectArtifact))).rejects.toBeDefined();
		}
	}, 30_000);

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
		const sessionId = `js-package-missing:${crypto.randomUUID()}`;
		const session = makeSession(workspace.path(), sessionId);
		const result = await executeJs('await import("@babel/parser")', executorOptions(session, sessionId));
		expect(result.exitCode).toBe(1);
		expect(result.output).toContain("JS package environment fallback");
	});
});
