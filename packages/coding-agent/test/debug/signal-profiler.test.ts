import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

// A subprocess keeps signal listeners, environment and the inspector isolated from other tests.
describe("signal CPU profiler", () => {
	it("captures a running process once when SIGUSR2 arrives twice", async () => {
		if (process.platform === "win32") return;
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-signal-profile-"));
		const entry = path.join(dir, "probe.ts");
		const modulePath = path.resolve(import.meta.dir, "../../src/debug/signal-profiler.ts");
		try {
			await Bun.write(
				entry,
				`import {installSignalProfiler} from ${JSON.stringify(modulePath)};
const remove = installSignalProfiler();
process.emit("SIGUSR2");
process.emit("SIGUSR2");
await Bun.sleep(31000);
remove();
`,
			);
			const child = Bun.spawn([process.execPath, entry], {
				env: { ...process.env, HOME: dir, XDG_STATE_HOME: dir, XDG_DATA_HOME: dir, XDG_CACHE_HOME: dir },
				stdout: "ignore",
				stderr: "pipe",
			});
			expect(await child.exited).toBe(0);
			const files = await fs.readdir(dir, { recursive: true });
			const profiles = files.filter(file => file.endsWith(".cpuprofile"));
			expect(profiles).toHaveLength(1);
			const profile = await Bun.file(path.join(dir, profiles[0]!)).json();
			expect(profile.endTime - profile.startTime).toBeGreaterThan(29_000_000);
			expect(
				profile.nodes.some(
					(node: { callFrame: { functionName: string } }) => node.callFrame.functionName === "(root)",
				),
			).toBe(true);
		} finally {
			await fs.rm(dir, { recursive: true, force: true });
		}
	}, 40_000);
});
