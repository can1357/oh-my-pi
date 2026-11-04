// Run as `bun test <this file>` from a package directory by hermetic-test-env.test.ts.
// Records which variables a test can see after its preload ran: in its own environment once omp's
// env loader has applied the dotenv files, in a child that `Bun.spawn` starts without options, in a
// worker started without options and in that worker's own child; and which agent dir omp resolves.
// Children start in the run directory, as an option-less spawn does, so a `.env` there (which Bun
// loads into any bun process started in it) must not put a removed name back.
import { test } from "bun:test";
import { getAgentDir } from "@oh-my-pi/pi-utils";

test("record the environment a test, its children and its workers see", async () => {
	const out = process.env.PI_TEST_HERMETIC_ENV_OUT;
	if (!out) throw new Error("PI_TEST_HERMETIC_ENV_OUT is not set");
	const child = Bun.spawn([process.execPath, "-e", "process.stdout.write(JSON.stringify(Object.keys(process.env)))"], {
		stdout: "pipe",
	});
	const worker = new Worker(new URL("./hermetic-env-worker.ts", import.meta.url).href);
	const fromWorker = Promise.withResolvers<{ worker: string[]; workerChild: string[] }>();
	worker.onmessage = event => fromWorker.resolve(event.data);
	worker.onerror = event => fromWorker.reject(new Error(event.message));
	const [childText, , seenByWorker] = await Promise.all([
		new Response(child.stdout).text(),
		child.exited,
		fromWorker.promise,
	]);
	worker.terminate();
	await Bun.write(
		out,
		JSON.stringify({
			test: Object.keys(process.env).sort(),
			child: JSON.parse(childText),
			...seenByWorker,
			agentDir: getAgentDir(),
		}),
	);
});
