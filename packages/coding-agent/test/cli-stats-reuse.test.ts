import { expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { TempDir } from "@oh-my-pi/pi-utils";
import {
	STATS_DASHBOARD_HEADER,
	STATS_DASHBOARD_HOSTNAME,
	STATS_DASHBOARD_HOSTNAME_HEADER,
	STATS_DASHBOARD_SECURITY_VERSION,
} from "../../stats/src/port-conflict";

const cliEntry = path.resolve(import.meta.dir, "../src/cli.ts");

it.skipIf(process.platform === "win32")(
	"exits successfully after opening an existing dashboard without stopping it",
	async () => {
		using tempDir = TempDir.createSync("@omp-cli-stats-reuse-");
		const opener = tempDir.join(process.platform === "darwin" ? "open" : "xdg-open");
		await Bun.write(opener, "#!/bin/sh\nexit 0\n");
		await fs.chmod(opener, 0o755);

		const existing = Bun.serve({
			port: 0,
			hostname: STATS_DASHBOARD_HOSTNAME,
			fetch: () =>
				Response.json([], {
					headers: {
						[STATS_DASHBOARD_HEADER]: STATS_DASHBOARD_SECURITY_VERSION,
						[STATS_DASHBOARD_HOSTNAME_HEADER]: STATS_DASHBOARD_HOSTNAME,
					},
				}),
		});
		try {
			const home = tempDir.path();
			// Run outside any Tern pane the test runner sits in: with TERN_* set, omp opens the
			// dashboard in that pane (replacing its block) instead of the stub opener on PATH.
			const hostEnv: Record<string, string | undefined> = {};
			for (const key in process.env) if (!key.startsWith("TERN_")) hostEnv[key] = process.env[key];
			const proc = Bun.spawn([process.execPath, cliEntry, "stats", "--port", String(existing.port)], {
				cwd: home,
				env: {
					...hostEnv,
					HOME: home,
					USERPROFILE: home,
					PI_CODING_AGENT_DIR: tempDir.join("agent"),
					OMP_PROFILE: "",
					PI_PROFILE: "",
					XDG_CONFIG_HOME: tempDir.join("config"),
					XDG_CACHE_HOME: tempDir.join("cache"),
					XDG_DATA_HOME: tempDir.join("data"),
					XDG_STATE_HOME: tempDir.join("state"),
					PATH: `${home}${path.delimiter}${process.env.PATH ?? ""}`,
					NO_COLOR: "1",
				},
				stdin: "ignore",
				stdout: "pipe",
				stderr: "pipe",
			});
			const [exitCode, stdout, stderr] = await Promise.all([
				proc.exited,
				new Response(proc.stdout).text(),
				new Response(proc.stderr).text(),
			]);
			const url = `http://${STATS_DASHBOARD_HOSTNAME}:${existing.port}`;
			expect(exitCode, stderr).toBe(0);
			expect(stdout).toContain(`Dashboard available at: ${url}`);
			const response = await fetch(`${url}/api/stats/models`);
			expect(response.status).toBe(200);
			await response.body?.cancel();
		} finally {
			existing.stop(true);
		}
	},
	30_000,
);
