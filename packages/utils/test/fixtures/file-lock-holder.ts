import { withFileLock } from "../../src/file-lock";

const target = Bun.argv[2];
const readyPath = Bun.argv[3];
if (!target || !readyPath) throw new Error("file-lock-holder requires target and readiness paths");

await withFileLock(
	target,
	async () => {
		await Bun.write(readyPath, "ready");
		Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
	},
	{ retries: 1, retryDelayMs: 0 },
);
