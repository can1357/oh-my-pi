import { expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { isEnoent } from "@oh-my-pi/pi-utils";
import { registerCopyBlock } from "../src/utils/copy-store";

it.skipIf(process.platform !== "linux")(
	"releases the URL launcher while the clipboard owner holds only stdin source",
	async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-copy-argv-"));
		const recordPath = path.join(root, "received.json");
		const text = "source-fixture-marker\nconst answer = 42;\n";
		const url = registerCopyBlock(text);
		const clipboardTool = path.join(root, "wl-copy");
		await Bun.write(
			clipboardTool,
			`#!${process.execPath}\nawait Bun.write(${JSON.stringify(recordPath)}, JSON.stringify({ pid: process.ppid, text: await Bun.stdin.text() }));\nawait Bun.sleep(2000);\n`,
		);
		await fs.chmod(clipboardTool, 0o700);
		const launcher = Bun.spawn([process.execPath, path.join(import.meta.dir, "../src/cli.ts"), "copy", url], {
			env: {
				...process.env,
				PATH: `${root}${path.delimiter}${process.env.PATH ?? ""}`,
				PI_CODING_AGENT_DIR: path.join(root, "agent"),
				WAYLAND_DISPLAY: "omp-test-no-display",
				DISPLAY: "",
				XDG_RUNTIME_DIR: root,
			},
			stdin: "ignore",
			stdout: "ignore",
			stderr: "pipe",
			timeout: 5000,
		});
		try {
			let received: { pid: number; text: string } | undefined;
			const deadline = Date.now() + 4000;
			while (!received && Date.now() < deadline) {
				try {
					received = await Bun.file(recordPath).json();
				} catch (error) {
					if (!isEnoent(error)) throw error;
					await Bun.sleep(10);
				}
			}
			if (!received)
				throw new Error(`Clipboard tool did not receive input: ${await new Response(launcher.stderr).text()}`);
			expect(received.text).toBe(text);
			expect(await launcher.exited).toBe(0);
			const ownerArgs = await fs.readFile(`/proc/${received.pid}/cmdline`, "utf8");
			expect(ownerArgs).toContain("--stdin");
			expect(ownerArgs).not.toContain(url);
			expect(ownerArgs).not.toContain("source-fixture-marker");
		} finally {
			if (launcher.exitCode === null) launcher.kill();
			await launcher.exited;
			// The fake clipboard command exits on its own; no real display is contacted.
			await Bun.sleep(2100);
			await fs.rm(root, { recursive: true, force: true });
		}
	},
	10_000,
);
