import { expect, it } from "bun:test";
import * as path from "node:path";
import { PtySession } from "@oh-my-pi/pi-natives";
import { TempDir } from "@oh-my-pi/pi-utils";

it.skipIf(process.platform === "win32")(
	"delivers Unicode writes in order and wakes the renderer when a real PTY drains",
	async () => {
		const fragments = [
			`${"a".repeat(16 * 1024 - 1)}🚀`,
			"界".repeat(128 * 1024),
			"\ud800",
			"\udc00",
			"",
			"tail\ud800",
		];
		const binding = path.join(import.meta.dir, "../native/index.js");
		const source = `
import { TtyWriter } from ${JSON.stringify(binding)};
const drained = Promise.withResolvers();
const writer = new TtyWriter(1, 256 * 1024, () => drained.resolve());
process.stdin.resume();
try {
	for (const fragment of ${JSON.stringify(fragments)}) writer.write(fragment);
	await drained.promise;
	if (writer.dead) throw new Error("terminal disconnected");
	if (!writer.flushSync(5000)) throw new Error("terminal failed to drain");
} finally {
	writer.stop(0);
	process.stdin.pause();
}
`;
		await using temp = await TempDir.create("@tty-writer-");
		const script = temp.join("writer.ts");
		await Bun.write(script, source);
		const session = new PtySession();
		let output = "";
		let callbackError: Error | null = null;
		const result = await session.startArgv(
			{
				application: process.execPath,
				args: [script],
				cwd: import.meta.dir,
				timeoutMs: 10_000,
				cols: 80,
				rows: 24,
			},
			(error, chunk) => {
				callbackError = error;
				output += chunk;
			},
		);
		expect(callbackError).toBeNull();
		expect(result.timedOut).toBeFalse();
		expect(result.exitCode).toBe(0);
		// Each write is a separate JS string: lone surrogates cannot pair across writes.
		expect(output).toBe(fragments.map(fragment => Buffer.from(fragment).toString()).join(""));
	},
	15_000,
);
