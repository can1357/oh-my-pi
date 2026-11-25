/** Outcome check: the named case prints the unchanged report within the time limit. */
const LIMIT_S = 3;

const golden = await Bun.file(new URL("./golden-60000.txt", import.meta.url)).text();
const started = performance.now();
const proc = Bun.spawn(["bun", "run", "report", "--rows", "60000"], { stdout: "pipe", stderr: "ignore", timeout: 30_000 });
const [printed, exitCode] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
const seconds = (performance.now() - started) / 1000;

if (exitCode !== 0) {
	console.log(`report exited ${exitCode} after ${seconds.toFixed(1)}s`);
	process.exit(1);
}
if (printed.trimEnd() !== golden.trimEnd()) {
	console.log("the 60000-line report changed");
	process.exit(1);
}
if (seconds > LIMIT_S) {
	console.log(`still slow: ${seconds.toFixed(1)}s (limit ${LIMIT_S}s)`);
	process.exit(1);
}
console.log(`speed ok: ${seconds.toFixed(2)}s`);
