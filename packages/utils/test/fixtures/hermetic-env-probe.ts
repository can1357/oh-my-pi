// Run as `bun test <this file>` from a package directory by hermetic-test-env.test.ts.
// Records which variables a test in that package can see after the package's preload ran: in its
// own environment once omp's env loader has applied the dotenv files, and in a child that
// `Bun.spawn` starts without an explicit `env`.
import { test } from "bun:test";
import "@oh-my-pi/pi-utils";

test("record the environment a test and its children see", async () => {
	const out = process.env.PI_TEST_HERMETIC_ENV_OUT;
	if (!out) throw new Error("PI_TEST_HERMETIC_ENV_OUT is not set");
	const child = Bun.spawn([process.execPath, "-e", "process.stdout.write(JSON.stringify(Object.keys(process.env)))"], {
		stdout: "pipe",
	});
	const [childText] = await Promise.all([new Response(child.stdout).text(), child.exited]);
	await Bun.write(out, JSON.stringify({ test: Object.keys(process.env).sort(), child: JSON.parse(childText) }));
});
