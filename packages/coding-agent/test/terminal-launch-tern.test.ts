import { expect, it } from "bun:test";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { classifyTerminalMultiplexer } from "@oh-my-pi/pi-tui/terminal-multiplexer";
import { createDefaultTerminalLaunchRequest, createTerminalLauncher } from "../src/subprocess/terminal-launch";

// Opt in: this exercises a live desktop daemon and briefly shows a private test session.
const enabled = process.env.OMP_TEST_TERN_LAUNCH === "1" && process.env.TERN_PANE_SOCKET && process.env.TERN_PANE;

it.skipIf(!enabled)(
	"launches literal argv and cwd in real Tern panes and tabs without replacing the parent",
	async () => {
		const root = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), "omp-tern-launch-")));
		const cwd = path.join(root, "working directory; literal");
		const tern = process.env.TERN_EXE || "tern";
		const originalPane = process.env.TERN_PANE!;
		let session: number | undefined;
		async function cli(...args: string[]) {
			const proc = Bun.spawn([tern, ...args], { stdout: "pipe", stderr: "pipe" });
			const [stdout, stderr, exitCode] = await Promise.all([
				new Response(proc.stdout).text(),
				new Response(proc.stderr).text(),
				proc.exited,
			]);
			if (exitCode !== 0) throw new Error(`Tern test CLI failed: ${stderr}`);
			return stdout;
		}
		try {
			await fsp.mkdir(cwd);
			const seed = JSON.parse(
				await cli(
					"new",
					"session",
					`omp-launch-test-${process.pid}`,
					"--json",
					"--cwd",
					root,
					"--",
					process.execPath,
					"-e",
					"process.stdin.resume()",
				),
			);
			session = seed.session;
			const env = { ...process.env, TERN_PANE: String(seed.block) };
			const launch = createTerminalLauncher({ environment: () => env });
			const capture = path.join(root, "capture.ts");
			await Bun.write(
				capture,
				"await Bun.write(process.argv[2], JSON.stringify({ argv: process.argv.slice(3), cwd: process.cwd() })); process.stdin.resume();\n",
			);
			const argv = ["", "two words", "it's $(literal); text", "--json", "line\nbreak"];
			for (const placement of ["pane", "window"] as const) {
				const destination = path.join(root, `${placement}.json`);
				const captured = Promise.withResolvers<void>();
				const watcher = fs.watch(root, (_event, filename) => {
					if (filename?.toString() === path.basename(destination)) captured.resolve();
				});
				try {
					const plan = createDefaultTerminalLaunchRequest(
						classifyTerminalMultiplexer(env),
						placement,
						[process.execPath, capture, destination, ...argv],
						cwd,
					);
					if ("error" in plan) throw new Error(plan.error);
					const result = await launch(plan.request);
					await captured.promise;
					expect(JSON.parse(await Bun.file(destination).text())).toEqual({ argv, cwd });
					const state = JSON.parse(await cli("inspect", "--json"));
					const testSession = state.sessions.find((entry: { id: number }) => entry.id === session);
					expect(
						testSession.tabs
							.flatMap((tab: { blocks: { id: number }[] }) => tab.blocks)
							.some((block: { id: number }) => block.id === seed.block),
					).toBe(true);
					if (placement === "pane") {
						expect(
							testSession.tabs
								.find((tab: { id: number }) => tab.id === seed.tab)
								.blocks.some((block: { id: number }) => String(block.id) === result.id),
						).toBe(true);
					} else {
						expect(
							testSession.tabs.some(
								(tab: { id: number }) => String(tab.id) === result.id && tab.id !== seed.tab,
							),
						).toBe(true);
					}
				} finally {
					watcher.close();
				}
			}
		} finally {
			if (session !== undefined) await cli("kill", "session", String(session));
			await cli("focus", originalPane);
			await fsp.rm(root, { recursive: true, force: true });
		}
	},
	30_000,
);
