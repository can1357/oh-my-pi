/**
 * Run by test-preload.test.ts as `bun test` in each test root, started without the
 * test-runtime marker, the way a developer's direct `bun test` starts. It spawns a child
 * each way a test does and prints, as one line, the marker each child received.
 */
import { expect, it } from "bun:test";
import { spawnSync as nodeSpawnSync } from "node:child_process";
import { PtySession, Shell } from "@oh-my-pi/pi-natives";

const READ_MARKER = ["-e", "process.stdout.write(process.env.PI_TEST_RUNTIME ?? 'unset')"];

const shellQuote = (word: string): string => `'${word.replaceAll("'", `'\\''`)}'`;

/** What the child of a native session wrote, without the line ending a terminal adds. */
async function nativeChildOutput(
	run: (onChunk: (error: Error | null, chunk: string) => void) => Promise<unknown>,
): Promise<string> {
	let output = "";
	await run((error, chunk) => {
		if (error) throw error;
		output += chunk;
	});
	return output.trim();
}

/** The markers the children of a Worker received; see test-preload.worker.ts. */
async function workerChildMarkers(): Promise<Record<string, string>> {
	const worker = new Worker(new URL("./test-preload.worker.ts", import.meta.url));
	const report = Promise.withResolvers<Record<string, string>>();
	worker.onmessage = event => report.resolve(event.data);
	worker.onerror = event => report.reject(new Error(event.message));
	try {
		return await report.promise;
	} finally {
		worker.terminate();
	}
}

it("reports the test-runtime marker each kind of child receives", async () => {
	const cmd = [process.execPath, ...READ_MARKER];
	const received = {
		bunSpawn: await new Response(Bun.spawn(cmd, { stdout: "pipe" }).stdout).text(),
		bunSpawnCmd: await new Response(Bun.spawn({ cmd, stdout: "pipe" }).stdout).text(),
		bunSpawnSync: Bun.spawnSync(cmd).stdout.toString(),
		bunSpawnSyncCmd: Bun.spawnSync({ cmd }).stdout.toString(),
		processEnv: Bun.spawnSync(cmd, { env: { ...process.env } }).stdout.toString(),
		nodeChildProcess: nodeSpawnSync(process.execPath, READ_MARKER, { encoding: "utf8" }).stdout,
		bunShell: await Bun.$`${process.execPath} ${READ_MARKER}`.text(),
		nativeShell: await nativeChildOutput(onChunk =>
			new Shell().run({ command: cmd.map(shellQuote).join(" "), timeoutMs: 10_000 }, onChunk),
		),
		nativePty: await nativeChildOutput(onChunk =>
			new PtySession().startArgv({ application: process.execPath, args: READ_MARKER, timeoutMs: 10_000 }, onChunk),
		),
		...(await workerChildMarkers()),
		removedByCaller: Bun.spawnSync(cmd, { env: { ...process.env, PI_TEST_RUNTIME: undefined } }).stdout.toString(),
	};
	console.log(`CHILD_MARKERS ${JSON.stringify(received)}`);
	expect(Object.values(received).every(value => value === "1" || value === "unset")).toBe(true);
});
