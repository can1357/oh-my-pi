import { describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { repairBorrowedWorkspaceNodeModules } from "../../src/task/workspace-dependencies";

/** Run actual Windows consumers, never a platform-name simulation or a Wine shim. */
describe.skipIf(process.platform !== "win32")("native Windows borrowed workspace consumers", () => {
	for (const compiled of [false, true]) {
		it(`runs native consumers (${compiled ? "compiled omp" : "Bun"})`, async () => {
			const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp Windows workspace "));
			const runtime = process.execPath;
			console.log(JSON.stringify({ pid: process.pid, platform: process.platform, runtime, compiled, bun: Bun.version }));
			try {
				const borrowed = path.join(root, "borrowed");
				const worker = path.join(root, "worker with spaces");
				for (const [checkout, source] of [
					[borrowed, "old"],
					[worker, "worker"],
				] as const) {
					await fs.mkdir(path.join(checkout, "packages/local"), { recursive: true });
					await fs.writeFile(path.join(checkout, "package.json"), JSON.stringify({ workspaces: ["packages/*"] }));
					await fs.writeFile(
						path.join(checkout, "packages/local/package.json"),
						JSON.stringify({ name: "local", type: "module", exports: "./index.js", bin: { local: "./cli.mjs" } }),
					);
					await fs.writeFile(
						path.join(checkout, "packages/local/index.js"),
						`export const singleton = {}; export const source = ${JSON.stringify(source)};`,
					);
					await fs.writeFile(
						path.join(checkout, "packages/local/cli.mjs"),
						`console.log(JSON.stringify({source:${JSON.stringify(source)},args:process.argv.slice(2)}));`,
					);
				}
				const modules = path.join(borrowed, "node_modules");
				await fs.mkdir(path.join(modules, ".bin"), { recursive: true });
				await fs.mkdir(path.join(modules, "external/node_modules/nested"), { recursive: true });
				await fs.symlink(path.join(borrowed, "packages/local"), path.join(modules, "local"), "junction");
				await fs.symlink(
					path.join(borrowed, "packages/local"),
					path.join(modules, "external/node_modules/local"),
					"junction",
				);
				for (const member of ["external", "external/node_modules/nested"]) {
					await fs.writeFile(
						path.join(modules, member, "package.json"),
						JSON.stringify({ type: "module", exports: "./index.js" }),
					);
				}
				await fs.writeFile(
					path.join(modules, "external/index.js"),
					'export {singleton} from "local"; export {singleton as nested} from "nested";',
				);
				await fs.writeFile(path.join(modules, "external/node_modules/nested/index.js"), 'export {singleton} from "local";');
				await fs.writeFile(path.join(modules, ".metadata"), "ordinary metadata");
				await fs.writeFile(path.join(modules, ".bin/ordinary.cmd"), "@echo ordinary-started\r\n");
				await fs.writeFile(path.join(modules, ".bin/local"), "borrowed extensionless launcher");
				await fs.symlink(modules, path.join(worker, "node_modules"), "junction");
				await fs.writeFile(
					path.join(worker, "check.mjs"),
					'import {singleton,source} from "local"; import {singleton as peer,nested} from "external"; console.log(JSON.stringify({source,direct:singleton===peer,nested:singleton===nested}));',
				);

				// Model the actual privilege boundary while leaving every junction/copy operation native.
				const symlink = fs.symlink;
				const denyFileLinks = vi.spyOn(fs, "symlink").mockImplementation(async (target, destination, type) => {
					if (type !== "junction" && type !== "dir") {
						throw Object.assign(new Error("file symlink privilege unavailable"), { code: "EPERM" });
					}
					return symlink(target, destination, type);
				});
				try {
					if (compiled) Object.defineProperty(process, "execPath", { value: "C:\\Program Files\\omp\\omp.exe" });
					await repairBorrowedWorkspaceNodeModules(worker);
				} finally {
					Object.defineProperty(process, "execPath", { value: runtime });
					denyFileLinks.mockRestore();
				}
				expect((await fs.lstat(path.join(worker, "node_modules"))).isSymbolicLink()).toBe(false);
				for (const file of [".metadata", ".bin/ordinary.cmd", ".bin/local", ".bin/local.cmd", ".bin/local.ps1"]) {
					expect((await fs.lstat(path.join(worker, "node_modules", file))).isSymbolicLink()).toBe(false);
				}

				const run = async (argv: string[]) => {
					const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toLowerCase() !== "path"));
					env.Path = `${path.dirname(runtime)};${process.env.Path ?? process.env.PATH ?? ""}`;
					const child = Bun.spawn(argv, {
						cwd: worker,
						stdout: "pipe",
						stderr: "pipe",
						env,
						windowsVerbatimArguments: argv[0] === "cmd.exe",
					});
					console.log(JSON.stringify({ childPid: child.pid, argv }));
					const [stdout, stderr] = await Promise.all([
						new Response(child.stdout).text(),
						new Response(child.stderr).text(),
					]);
					const status = await child.exited;
					console.log(JSON.stringify({ status, stdout, stderr }));
					expect(status, stderr).toBe(0);
					return stdout.trim();
				};
				expect(JSON.parse(await run([runtime, path.join(worker, "check.mjs")]))).toEqual({
					source: "worker",
					direct: true,
					nested: true,
				});
				const expected = { source: "worker", args: ["arg with spaces", "--next"] };
				const launcher = path.join(worker, "node_modules/.bin/local.cmd");
				expect(
					JSON.parse(await run(["cmd.exe", "/d", "/s", "/c", `""${launcher}" "arg with spaces" --next"`])),
				).toEqual(expected);
				const ordinary = path.join(worker, "node_modules/.bin/ordinary.cmd");
				expect(await run(["cmd.exe", "/d", "/s", "/c", `""${ordinary}""`])).toBe("ordinary-started");
				const powershell = Bun.which("pwsh") ?? Bun.which("powershell");
				if (!powershell) throw new Error("A genuine Windows PowerShell consumer is required");
				expect(
					JSON.parse(
						await run([
							powershell,
							"-NoProfile",
							"-NonInteractive",
							"-ExecutionPolicy",
							"Bypass",
							"-File",
							path.join(worker, "node_modules/.bin/local.ps1"),
							"arg with spaces",
							"--next",
						]),
					),
				).toEqual(expected);
				const bash = path.join(process.env.ProgramFiles ?? "C:\\Program Files", "Git/bin/bash.exe");
				expect(
					JSON.parse(
						await run([
							bash,
							"--noprofile",
							"--norc",
							path.join(worker, "node_modules/.bin/local").replaceAll("\\", "/"),
							"arg with spaces",
							"--next",
						]),
					),
				).toEqual(expected);
			} finally {
				await fs.rm(root, { recursive: true, force: true });
			}
		}, 60_000);
	}
});
