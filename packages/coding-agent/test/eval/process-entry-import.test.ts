import { expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { TempDir } from "@oh-my-pi/pi-utils";

it("imports the CLI entry graph without loading dotenv before profile bootstrap", async () => {
	using tempDir = TempDir.createSync("@omp-js-process-import-");
	await Bun.write(path.join(tempDir.path(), ".env"), "OMP_PROCESS_ENTRY_ENV_PROBE=loaded-too-early\n");
	const env = Object.fromEntries(
		Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
	);
	delete env.OMP_PROCESS_ENTRY_ENV_PROBE;
	env.HOME = tempDir.path();
	const fixture = path.resolve(import.meta.dir, "../fixtures/js-process-entry-import.ts");
	const proc = Bun.spawn([process.execPath, fixture], {
		env,
		stdout: "pipe",
		stderr: "pipe",
	});
	const [exitCode, stdout, stderr] = await Promise.all([
		proc.exited,
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
	]);
	expect(exitCode).toBe(0);
	expect(stdout).toBe("");
	expect(stderr).toBe("");
});

async function pingComputerWorker(
	entry: string,
	id: string,
	argv: string[] = ["__omp_worker_computer"],
): Promise<unknown> {
	const worker = new Worker(entry, {
		type: "module",
		argv,
	});
	const response = Promise.withResolvers<unknown>();
	worker.addEventListener("message", event => {
		if (event.data?.type === "pong" && event.data.id === id) response.resolve(event.data);
	});
	worker.addEventListener("error", event => response.reject(event.error ?? new Error(event.message)));
	worker.postMessage({ type: "ping", id });
	try {
		return await response.promise;
	} finally {
		worker.terminate();
	}
}

it("starts ordinary CLI paths without loading the native computer addon", async () => {
	const cliPath = path.resolve(import.meta.dir, "../../src/cli.ts");
	for (const args of [
		["--no-addons", cliPath, "--version"],
		[cliPath, "--help"],
	]) {
		const proc = Bun.spawn([process.execPath, ...args], {
			stdout: "pipe",
			stderr: "pipe",
		});
		const [exitCode, stderr] = await Promise.all([proc.exited, new Response(proc.stderr).text()]);
		expect(exitCode, `${args.at(-1)}: ${stderr}`).toBe(0);
	}
	// Two cold CLI spawns (`--version`, `--help`) per run; the assertion is the exit
	// code, not the wall time.
}, 30_000);

it("dispatches the computer worker through the CLI host selector in a child process", async () => {
	const fixture = path.resolve(import.meta.dir, "../fixtures/computer-worker-cli-selector.ts");
	const proc = Bun.spawn([process.execPath, "--no-addons", fixture], {
		stdout: "pipe",
		stderr: "pipe",
	});
	const [exitCode, stdout, stderr] = await Promise.all([
		proc.exited,
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
	]);
	expect(exitCode, stderr).toBe(0);
	expect(stdout).toBe('{"type":"pong","id":"computer-cli-selector"}\n');
});

it("loads the computer worker module directly outside a declared CLI host", async () => {
	const entry = new URL("../../src/tools/computer/worker-entry.ts", import.meta.url).href;
	const response = await pingComputerWorker(entry, "computer-direct-module", []);
	expect(response).toEqual({ type: "pong", id: "computer-direct-module" });
});

it("dispatches the computer worker from a single npm-style host bundle", async () => {
	const packageDir = path.resolve(import.meta.dir, "../..");
	const outDir = fs.mkdtempSync(path.join(packageDir, ".computer-worker-bundle-"));
	try {
		const output = await Bun.build({
			entrypoints: [path.join(packageDir, "test/fixtures/computer-worker-bundled-host.ts")],
			outdir: outDir,
			naming: "cli.js",
			target: "bun",
			external: ["@oh-my-pi/pi-natives"],
			define: { "process.env.PI_BUNDLED": JSON.stringify("true") },
			throw: false,
		});
		expect(output.logs).toEqual([]);
		expect(output.outputs.map(file => path.basename(file.path))).toEqual(["cli.js"]);
		const response = await pingComputerWorker(output.outputs[0]!.path, "computer-npm-bundle");
		expect(response).toEqual({ type: "pong", id: "computer-npm-bundle" });
	} finally {
		fs.rmSync(outDir, { recursive: true, force: true });
	}
});

it("keeps non-computer selectors isolated in a compiled single-entry worker host", async () => {
	using tempDir = TempDir.createSync("@omp-compiled-worker-selector-");
	const packageDir = path.resolve(import.meta.dir, "../..");
	const outfile = path.join(tempDir.path(), process.platform === "win32" ? "worker-host.exe" : "worker-host");
	const build = Bun.spawn(
		[
			process.execPath,
			"build",
			"--compile",
			"--target=bun",
			`--outfile=${outfile}`,
			path.join(packageDir, "test/fixtures/compiled-worker-selector-host.ts"),
		],
		{ cwd: packageDir, stdout: "pipe", stderr: "pipe" },
	);
	const [buildExitCode, buildStderr] = await Promise.all([build.exited, new Response(build.stderr).text()]);
	expect(buildExitCode, buildStderr).toBe(0);
	const proc = Bun.spawn([outfile], {
		cwd: packageDir,
		stdout: "pipe",
		stderr: "pipe",
	});
	const [exitCode, stdout, stderr] = await Promise.all([
		proc.exited,
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
	]);
	expect(exitCode, stderr).toBe(0);
	expect(stdout).toBe('{"ok":true,"kind":"pong"}\n');
	// Compiles a standalone binary with `bun build --compile` before running it, so
	// this needs the same headroom as the other compile-backed tests.
}, 60_000);
