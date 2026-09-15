export interface OpenFileHolder {
	pid: number;
	close(): Promise<void>;
}

/** Keep a real descriptor open in a separate process until the test releases it. */
export async function holdFileOpen(file: string): Promise<OpenFileHolder> {
	const child = Bun.spawn(
		[
			process.execPath,
			"-e",
			`const fs = require("node:fs"); fs.openSync(${JSON.stringify(file)}, "r"); process.stdout.write("ready\\n"); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);`,
		],
		{ stdout: "pipe", stderr: "pipe" },
	);
	const reader = (child.stdout as ReadableStream<Uint8Array>).getReader();
	const ready = await reader.read();
	reader.releaseLock();
	if (new TextDecoder().decode(ready.value).trim() !== "ready") {
		child.kill();
		await child.exited;
		throw new Error("open-file holder did not start");
	}
	return {
		pid: child.pid,
		async close(): Promise<void> {
			child.kill();
			await child.exited;
		},
	};
}
