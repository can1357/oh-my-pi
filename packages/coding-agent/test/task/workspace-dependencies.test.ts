import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { repairBorrowedWorkspaceNodeModules, workspaceBinRuntime } from "../../src/task/workspace-dependencies";

const roots: string[] = [];

afterEach(async () => {
	await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true })));
});

async function readWorkerImports(workerRoot: string): Promise<{ local: string; external: string }> {
	const entry = path.join(workerRoot, "packages", "app", "resolve.mjs");
	const child = Bun.spawn([process.execPath, "run", entry], {
		cwd: workerRoot,
		stdout: "pipe",
		stderr: "pipe",
	});
	const [stdout, stderr] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()]);
	const exitCode = await child.exited;
	if (exitCode !== 0) throw new Error(`worker import failed (${exitCode}): ${stderr}`);
	return JSON.parse(stdout.trim()) as { local: string; external: string };
}

async function makeCheckout(root: string, source: string): Promise<void> {
	await fs.mkdir(path.join(root, "packages", "ai"), { recursive: true });
	await fs.mkdir(path.join(root, "packages", "app"), { recursive: true });
	await fs.writeFile(path.join(root, "package.json"), JSON.stringify({ workspaces: ["packages/*"] }));
	await fs.writeFile(
		path.join(root, "packages", "ai", "package.json"),
		JSON.stringify({
			name: "@oh-my-pi/pi-ai",
			type: "module",
			exports: "./index.js",
			bin: { "pi-ai": "./bin/cli.mjs" },
		}),
	);
	await fs.writeFile(
		path.join(root, "packages", "ai", "index.js"),
		`export const source = ${JSON.stringify(source)};\n`,
	);
	await fs.mkdir(path.join(root, "packages", "ai", "bin"), { recursive: true });
	await fs.writeFile(
		path.join(root, "packages", "ai", "bin", "cli.mjs"),
		`#!/usr/bin/env bun\nconsole.log(JSON.stringify({ source: ${JSON.stringify(source)}, args: process.argv.slice(2) }));\n`,
	);
	await fs.writeFile(
		path.join(root, "packages", "app", "resolve.mjs"),
		'import { source as local } from "@oh-my-pi/pi-ai";\nimport { source as external } from "safe-cache";\nconsole.log(JSON.stringify({ local, external }));\n',
	);
}

async function readWorkerEntry(
	workerRoot: string,
	entry: string,
	...args: string[]
): Promise<{ source: string; args: string[] }> {
	const child = Bun.spawn([process.execPath, "run", entry, ...args], {
		cwd: workerRoot,
		stdout: "pipe",
		stderr: "pipe",
	});
	const [stdout, stderr] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()]);
	const exitCode = await child.exited;
	if (exitCode !== 0) throw new Error(`worker command failed (${exitCode}): ${stderr}`);
	return JSON.parse(stdout.trim()) as { source: string; args: string[] };
}

async function readWorkerCommand(workerRoot: string, command: string): Promise<{ source: string; args: string[] }> {
	return readWorkerEntry(workerRoot, path.join(workerRoot, "node_modules", ".bin", command));
}

describe("borrowed workspace dependencies", () => {
	it("resolves local packages from the worker checkout and keeps cached external packages", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-borrowed-workspace-"));
		roots.push(root);
		const oldCheckout = path.join(root, "checkout-old");
		const currentCheckout = path.join(root, "checkout-current");
		const workerCheckout = path.join(root, "worker-current");
		await makeCheckout(oldCheckout, "checkout-old");
		await makeCheckout(currentCheckout, "checkout-current");

		const oldNodeModules = path.join(oldCheckout, "node_modules");
		await fs.mkdir(path.join(oldNodeModules, "@oh-my-pi"), { recursive: true });
		await fs.symlink(
			path.join(oldCheckout, "packages", "ai"),
			path.join(oldNodeModules, "@oh-my-pi", "pi-ai"),
			"dir",
		);
		await fs.mkdir(path.join(oldNodeModules, "safe-cache"), { recursive: true });
		await fs.writeFile(
			path.join(oldNodeModules, "safe-cache", "package.json"),
			JSON.stringify({ name: "safe-cache", type: "module", exports: "./index.js" }),
		);
		await fs.writeFile(
			path.join(oldNodeModules, "safe-cache", "index.js"),
			'export const source = "external-cache";\n',
		);
		await fs.writeFile(path.join(oldNodeModules, "safe-cache", "cli.mjs"), 'console.log("external-bin");\n');
		await fs.mkdir(path.join(oldNodeModules, ".bin"));
		await fs.symlink("../safe-cache/cli.mjs", path.join(oldNodeModules, ".bin", "safe-command"));
		await fs.symlink("../@oh-my-pi/pi-ai/bin/cli.mjs", path.join(oldNodeModules, ".bin", "pi-ai"));
		await fs.symlink("../missing-package", path.join(oldNodeModules, "dangling-package"), "dir");
		await fs.symlink(oldNodeModules, path.join(currentCheckout, "node_modules"), "dir");
		await fs.cp(currentCheckout, workerCheckout, { recursive: true });
		await fs.mkdir(path.join(workerCheckout, "packages", "new-package"), { recursive: true });
		await fs.writeFile(
			path.join(workerCheckout, "packages", "new-package", "package.json"),
			JSON.stringify({ name: "@oh-my-pi/new-package", type: "module", exports: "./index.js" }),
		);
		await fs.writeFile(
			path.join(workerCheckout, "packages", "new-package", "index.js"),
			'export const source = "new-workspace-package";\n',
		);

		const baseline = await readWorkerImports(workerCheckout);
		expect(baseline).toEqual({ local: "checkout-old", external: "external-cache" });

		await repairBorrowedWorkspaceNodeModules(workerCheckout);

		expect(await fs.lstat(path.join(workerCheckout, "node_modules")).then(stat => stat.isSymbolicLink())).toBe(false);
		expect(await fs.realpath(path.join(workerCheckout, "node_modules", "@oh-my-pi", "pi-ai"))).toBe(
			path.join(workerCheckout, "packages", "ai"),
		);
		expect(await fs.realpath(path.join(workerCheckout, "node_modules", "safe-cache"))).toBe(
			path.join(oldNodeModules, "safe-cache"),
		);
		expect(await fs.realpath(path.join(workerCheckout, "node_modules", "@oh-my-pi", "new-package"))).toBe(
			path.join(workerCheckout, "packages", "new-package"),
		);
		expect(await fs.realpath(path.join(workerCheckout, "node_modules", ".bin", "pi-ai"))).toBe(
			path.join(workerCheckout, "packages", "ai", "bin", "cli.mjs"),
		);
		expect(await readWorkerCommand(workerCheckout, "pi-ai")).toEqual({ source: "checkout-current", args: [] });
		expect(await fs.realpath(path.join(workerCheckout, "node_modules", ".bin", "safe-command"))).toBe(
			path.join(oldNodeModules, "safe-cache", "cli.mjs"),
		);
		expect(
			await fs
				.lstat(path.join(workerCheckout, "node_modules", "dangling-package"))
				.then(stat => stat.isSymbolicLink()),
		).toBe(true);
		expect(await readWorkerImports(workerCheckout)).toEqual({
			local: "checkout-current",
			external: "external-cache",
		});
	});

	it("discovers pnpm workspace members declared only in pnpm-workspace.yaml", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-pnpm-workspace-"));
		roots.push(root);
		const oldCheckout = path.join(root, "checkout-old");
		const workerCheckout = path.join(root, "worker-current");
		await fs.mkdir(path.join(oldCheckout, "node_modules"), { recursive: true });
		await fs.mkdir(path.join(workerCheckout, "packages", "local"), { recursive: true });
		await fs.writeFile(path.join(workerCheckout, "package.json"), JSON.stringify({ name: "pnpm-root" }));
		await fs.writeFile(path.join(workerCheckout, "pnpm-workspace.yaml"), "packages:\n  - packages/*\n");
		await fs.writeFile(
			path.join(workerCheckout, "packages", "local", "package.json"),
			JSON.stringify({ name: "@example/local" }),
		);
		await fs.symlink(path.join(oldCheckout, "node_modules"), path.join(workerCheckout, "node_modules"), "dir");

		await repairBorrowedWorkspaceNodeModules(workerCheckout);

		expect(await fs.realpath(path.join(workerCheckout, "node_modules", "@example", "local"))).toBe(
			path.join(workerCheckout, "packages", "local"),
		);
	});

	it("uses Windows junction semantics when rebuilding directory links", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-windows-junction-"));
		roots.push(root);
		const oldCheckout = path.join(root, "checkout-old");
		const workerCheckout = path.join(root, "worker-current");
		await makeCheckout(oldCheckout, "checkout-old");
		await fs.mkdir(path.join(oldCheckout, "node_modules", "@oh-my-pi"), { recursive: true });
		await fs.symlink(
			path.join(oldCheckout, "packages", "ai"),
			path.join(oldCheckout, "node_modules", "@oh-my-pi", "pi-ai"),
			"dir",
		);
		await makeCheckout(workerCheckout, "checkout-current");
		await fs.symlink(path.join(oldCheckout, "node_modules"), path.join(workerCheckout, "node_modules"), "dir");
		const platform = process.platform;
		try {
			Object.defineProperty(process, "platform", { value: "win32" });
			await repairBorrowedWorkspaceNodeModules(workerCheckout);
		} finally {
			Object.defineProperty(process, "platform", { value: platform });
		}
		expect(await fs.realpath(path.join(workerCheckout, "node_modules", "@oh-my-pi", "pi-ai"))).toBe(
			path.join(workerCheckout, "packages", "ai"),
		);
		const cmdPath = path.join(workerCheckout, "node_modules", ".bin", "pi-ai.cmd");
		const ps1Path = path.join(workerCheckout, "node_modules", ".bin", "pi-ai.ps1");
		expect(await fs.lstat(cmdPath).then(stat => stat.isSymbolicLink())).toBe(false);
		expect(await Bun.file(cmdPath).text()).toBe(
			`@"${process.execPath}" "%~dp0..\\..\\packages\\ai\\bin\\cli.mjs" %*\r\n`,
		);
		expect(await Bun.file(ps1Path).text()).toContain(
			`"${process.execPath}" "$PSScriptRoot\\..\\..\\packages\\ai\\bin\\cli.mjs" @args`,
		);
		expect(
			await readWorkerEntry(
				workerCheckout,
				path.join(workerCheckout, "packages", "ai", "bin", "cli.mjs"),
				"arg with spaces",
				"--next",
			),
		).toEqual({ source: "checkout-current", args: ["arg with spaces", "--next"] });
	});
	it("never launches Windows workspace bins through a compiled omp executable", () => {
		expect(workspaceBinRuntime("C:\\Program Files\\omp\\omp.exe")).toBe("bun");
		expect(workspaceBinRuntime("/usr/local/bin/omp")).toBe("bun");
		expect(workspaceBinRuntime("C:\\tools\\bun\\bun.exe")).toBe("C:\\tools\\bun\\bun.exe");
		expect(workspaceBinRuntime("/home/user/.bun/bin/bun")).toBe("/home/user/.bun/bin/bun");
	});

	it("leaves workspace packages removed by a negative pattern linked to the borrowed tree", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-negated-workspace-"));
		roots.push(root);
		const oldCheckout = path.join(root, "checkout-old");
		const workerCheckout = path.join(root, "worker-current");
		await fs.mkdir(path.join(oldCheckout, "node_modules", "@example"), { recursive: true });
		await fs.mkdir(path.join(oldCheckout, "registry", "legacy"), { recursive: true });
		await fs.symlink(
			path.join(oldCheckout, "registry", "legacy"),
			path.join(oldCheckout, "node_modules", "@example", "legacy"),
			"dir",
		);
		for (const name of ["local", "legacy"]) {
			await fs.mkdir(path.join(workerCheckout, "packages", name), { recursive: true });
			await fs.writeFile(
				path.join(workerCheckout, "packages", name, "package.json"),
				JSON.stringify({ name: `@example/${name}` }),
			);
		}
		await fs.writeFile(path.join(workerCheckout, "package.json"), JSON.stringify({ name: "pnpm-root" }));
		await fs.writeFile(
			path.join(workerCheckout, "pnpm-workspace.yaml"),
			"packages:\n  - packages/**\n  - '!packages/legacy'\n",
		);
		await fs.symlink(path.join(oldCheckout, "node_modules"), path.join(workerCheckout, "node_modules"), "dir");

		await repairBorrowedWorkspaceNodeModules(workerCheckout);

		expect(await fs.realpath(path.join(workerCheckout, "node_modules", "@example", "local"))).toBe(
			path.join(workerCheckout, "packages", "local"),
		);
		expect(await fs.realpath(path.join(workerCheckout, "node_modules", "@example", "legacy"))).toBe(
			path.join(oldCheckout, "registry", "legacy"),
		);
	});
});
