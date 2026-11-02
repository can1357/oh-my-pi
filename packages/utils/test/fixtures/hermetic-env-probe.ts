// Run as `bun test <this file>` from a package directory by hermetic-test-env.test.ts.
// Records which variables a test can see after its preload ran: in its own environment once omp's
// env loader has applied the dotenv files, in a child that `Bun.spawn` starts without an explicit
// `env`, and in a worker started without options.
import { test } from "bun:test";
import "@oh-my-pi/pi-utils";

test("record the environment a test, its children and its workers see", async () => {
	const out = process.env.PI_TEST_HERMETIC_ENV_OUT;
	if (!out) throw new Error("PI_TEST_HERMETIC_ENV_OUT is not set");
	const child = Bun.spawn([process.execPath, "-e", "process.stdout.write(JSON.stringify(Object.keys(process.env)))"], {
		stdout: "pipe",
	});
	const worker = new Worker(new URL("./hermetic-env-worker.ts", import.meta.url).href);
	const workerNames = Promise.withResolvers<string[]>();
	worker.onmessage = event => workerNames.resolve(event.data as string[]);
	worker.onerror = event => workerNames.reject(new Error(event.message));
	const [childText, , names] = await Promise.all([
		new Response(child.stdout).text(),
		child.exited,
		workerNames.promise,
	]);
	worker.terminate();
	await Bun.write(
		out,
		JSON.stringify({ test: Object.keys(process.env).sort(), child: JSON.parse(childText), worker: names }),
	);
});
