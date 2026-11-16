import { describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import * as natives from "@oh-my-pi/pi-natives";

const postmortemModuleUrl = pathToFileURL(join(import.meta.dir, "../src/index.ts")).href;

// The child prints "ready", then, from its cleanup pass, the sender postmortem
// recorded. With PROBE_SELF_HUP set it raises SIGHUP on itself after "ready".
const probeSource = `
import * as fs from "node:fs";
import { postmortem } from "${postmortemModuleUrl}";

postmortem.installProcessHandlers();
postmortem.register("probe", () => {
	fs.writeSync(1, \`\${JSON.stringify(postmortem.terminationSignalSender() ?? null)}\\n\`);
});
fs.writeSync(1, "ready\\n");
if (process.env.PROBE_SELF_HUP) process.kill(process.pid, "SIGHUP");
setInterval(() => {}, 1000);
`;

async function stopProbe(
	send: (pid: number) => number | undefined,
	env: Record<string, string> = {},
): Promise<{ exitCode: number; senderPid: number | undefined; recorded: unknown }> {
	const root = await mkdtemp(join(tmpdir(), "omp-signal-sender-"));
	const probePath = join(root, "probe.ts");
	try {
		await Bun.write(probePath, probeSource);
		const proc = Bun.spawn([process.execPath, probePath], {
			stdout: "pipe",
			stderr: "inherit",
			env: { ...process.env, ...env, OMP_AGENT_DIR: join(root, "agent") },
		});
		const lines = (async function* () {
			let buffered = "";
			for await (const chunk of proc.stdout) {
				buffered += new TextDecoder().decode(chunk);
				let newline = buffered.indexOf("\n");
				while (newline >= 0) {
					yield buffered.slice(0, newline);
					buffered = buffered.slice(newline + 1);
					newline = buffered.indexOf("\n");
				}
			}
		})();
		expect((await lines.next()).value).toBe("ready");
		const senderPid = send(proc.pid);
		const recorded = (await lines.next()).value;
		const exitCode = await proc.exited;
		return { exitCode, senderPid, recorded: recorded === undefined ? undefined : JSON.parse(recorded) };
	} finally {
		await rm(root, { recursive: true, force: true });
	}
}

// Pull requests test against main's prebuilt addon; until it carries the
// capture, these run on main and on local builds only. The SIGTERM path, with
// command name and parent pid, is proven end to end in coding-agent's
// session-exit-diagnostics test.
describe.skipIf(process.platform === "win32" || typeof natives.captureSignalSender !== "function")(
	"postmortem signal sender",
	() => {
		it("names the process that sent SIGHUP", async () => {
			const result = await stopProbe(pid => {
				const killer = Bun.spawnSync(["sh", "-c", `echo $$; kill -HUP ${pid}`]);
				return Number(killer.stdout.toString().trim());
			});

			expect(result.exitCode).toBe(129);
			expect(result.recorded).toMatchObject({ pid: result.senderPid, uid: process.getuid?.() });
		});

		it("records no sender for a SIGHUP the process raised itself", async () => {
			const result = await stopProbe(() => undefined, { PROBE_SELF_HUP: "1" });

			expect(result.exitCode).toBe(129);
			expect(result.recorded).toBeNull();
		});
	},
);
