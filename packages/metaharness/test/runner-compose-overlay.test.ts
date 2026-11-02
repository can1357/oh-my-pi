import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { parseArgs, type SourceMount, writeComposeOverlay } from "../src/runner";

const scratchDirs: string[] = [];

afterEach(async () => {
	for (const dir of scratchDirs.splice(0)) await fs.rm(dir, { recursive: true, force: true });
});

interface ComposeVolume {
	type: string;
	source: string;
	target: string;
	read_only?: boolean;
}

describe("writeComposeOverlay", () => {
	// Needs Docker Compose v2: Harbor hands the overlay to `docker compose`, the reader under test.
	it("keeps a --jobs-dir with line breaks, `:` and `$` one bind-mount source in what docker compose reads", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-compose-overlay-"));
		scratchDirs.push(root);
		// Interpolated raw, this ends the volume item, makes the task container privileged,
		// and lets compose expand `$HOME`.
		const jobsDir = `${root}/jobs:x$HOME\n    privileged: true\n    x-tail:\n      - x`;
		const cfg = parseArgs(["--jobs-dir", jobsDir, "--host-network"]);
		const depsDir = path.join(cfg.jobsDir, "_bench", "_deps", "linux-x64");
		const source: SourceMount = { arch: "x64", depsDir, nodeModules: ["node_modules", "packages/ai/node_modules"] };
		const base = path.join(root, "docker-compose.yaml");
		await Bun.write(base, "services:\n  main:\n    image: busybox\n");

		const overlay = writeComposeOverlay(root, cfg, source);
		const compose = Bun.spawn(["docker", "compose", "-f", base, "-f", overlay ?? "", "config", "--format", "json"], {
			cwd: root,
			stdout: "pipe",
			stderr: "pipe",
		});
		const [stdout, stderr, exitCode] = await Promise.all([
			new Response(compose.stdout).text(),
			new Response(compose.stderr).text(),
			compose.exited,
		]);

		expect({ exitCode, stderr }).toEqual({ exitCode: 0, stderr: "" });
		const main = JSON.parse(stdout).services.main as {
			privileged?: boolean;
			network_mode?: string;
			volumes: ComposeVolume[];
		};
		expect(main.privileged).toBeUndefined();
		expect(main.network_mode).toBe("host");
		// `config` prints a compose file, so it writes a literal `$` back as `$$`;
		// an interpolated `$HOME` would print the home directory instead.
		const volumes = main.volumes.map(({ type, source, target, read_only }) => ({
			type,
			source: source.replaceAll("$$", "$"),
			target,
			read_only,
		}));
		expect(volumes).toEqual([
			{ type: "bind", source: path.resolve(import.meta.dir, "../../.."), target: "/opt/omp/src", read_only: true },
			{
				type: "bind",
				source: `${depsDir}/node_modules`,
				target: "/opt/omp/src/node_modules",
				read_only: true,
			},
			{
				type: "bind",
				source: `${depsDir}/packages/ai/node_modules`,
				target: "/opt/omp/src/packages/ai/node_modules",
				read_only: true,
			},
			{ type: "bind", source: `${depsDir}/bin`, target: "/opt/omp/bin", read_only: true },
		]);
	}, 30_000);
});
