import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { findCompatibleNativeAddons, writeLocalPackageLauncher } from "./install-local-package";

const tempDirs = new Set<string>();

async function makeTempDir(): Promise<string> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-local-package-"));
	tempDirs.add(dir);
	return dir;
}

interface LauncherRun {
	exitCode: number;
	stderr: string;
}

async function runLauncher(launcherPath: string, cwd: string, outputPath: string): Promise<LauncherRun> {
	const argv = [launcherPath, "--detached-test"];
	const subprocess = Bun.spawn(argv, {
		cwd,
		env: { ...process.env, OMP_LOCAL_PACKAGE_TEST_OUTPUT: outputPath },
		stdout: "pipe",
		stderr: "pipe",
	});
	const [exitCode, stderr] = await Promise.all([
		subprocess.exited,
		new Response(subprocess.stderr as ReadableStream<Uint8Array>).text(),
	]);
	return { exitCode, stderr };
}

afterEach(async () => {
	await Promise.all([...tempDirs].map(dir => fs.rm(dir, { recursive: true, force: true })));
	tempDirs.clear();
});

describe("install-local-package launcher", () => {
	it("runs the packaged CLI from the caller's directory after replacing a source link", async () => {
		const root = await makeTempDir();
		const installDir = path.join(root, "installed-package");
		const binDir = path.join(root, "bin");
		const launchDir = path.join(root, "launch");
		const callerDir = path.join(root, "caller");
		const outputPath = path.join(root, "result.json");
		const packageDir = path.join(installDir, "node_modules", "@oh-my-pi", "pi-coding-agent");

		await fs.mkdir(path.join(packageDir, "scripts"), { recursive: true });
		await fs.mkdir(path.join(packageDir, "dist"), { recursive: true });
		await fs.mkdir(callerDir, { recursive: true });
		await Bun.write(
			path.join(packageDir, "scripts", "omp.ts"),
			"const cwd = process.env.OMP_LAUNCH_CWD; if (cwd) process.chdir(cwd);\n",
		);
		await Bun.write(
			path.join(packageDir, "dist", "cli.js"),
			'const output = process.env.OMP_LOCAL_PACKAGE_TEST_OUTPUT; if (!output) throw new Error("Missing output path"); await Bun.write(output, JSON.stringify({ cwd: process.cwd(), args: process.argv.slice(2) }));\n',
		);
		await fs.mkdir(binDir, { recursive: true });

		const priorLauncher = path.join(binDir, process.platform === "win32" ? "omp.cmd" : "omp");
		await Bun.write(priorLauncher, "source-linked launcher");
		if (process.platform === "win32") await Bun.write(path.join(binDir, "omp.exe"), "prior binary");

		const launcher = await writeLocalPackageLauncher({
			installDir,
			binDir,
			launchDir,
			bunPath: process.execPath,
		});
		const run = await runLauncher(launcher.launcherPath, callerDir, outputPath);
		if (run.exitCode !== 0) throw new Error(`Launcher failed:\n${run.stderr}`);

		expect(run.exitCode).toBe(0);
		const record = await Bun.file(outputPath).json();
		expect(record).toEqual({
			cwd: callerDir,
			args: ["--detached-test"],
		});
		expect(launcher.preservedLaunchers).toContainEqual(expect.stringContaining("before-local-package"));
		if (process.platform === "win32") {
			expect(launcher.preservedLaunchers).toContainEqual(expect.stringContaining("omp.exe.before-local-package"));
		}
	});

	it("prefers the Bun executable adjacent to the global bin", async () => {
		const root = await makeTempDir();
		const installDir = path.join(root, "installed-package");
		const binDir = path.join(root, "bin");
		const launchDir = path.join(root, "launch");
		const bunPath = path.join(binDir, process.platform === "win32" ? "bun.exe" : "bun");
		await fs.mkdir(binDir, { recursive: true });
		await Bun.write(bunPath, "placeholder");

		const launcher = await writeLocalPackageLauncher({ installDir, binDir, launchDir });

		expect(await Bun.file(launcher.launcherPath).text()).toContain(bunPath);
	});
});

describe("local package native reuse", () => {
	it("accepts matching-version host addons including modern-only x64", async () => {
		const root = await makeTempDir();
		await Bun.write(
			path.join(root, "pi_natives.win32-x64-baseline.node"),
			"binary-prefix __piNativesV17_0_4 binary-suffix",
		);
		await Bun.write(path.join(root, "pi_natives.win32-x64-modern.node"), "__piNativesV17_0_3");

		expect(await findCompatibleNativeAddons(root, "win32-x64", "17.0.4")).toEqual([
			"pi_natives.win32-x64-baseline.node",
		]);
		expect(await findCompatibleNativeAddons(root, "win32-x64", "17.0.3")).toEqual([
			"pi_natives.win32-x64-modern.node",
		]);
		expect(await findCompatibleNativeAddons(root, "win32-x64", "17.0.5")).toEqual([]);
	});
});
