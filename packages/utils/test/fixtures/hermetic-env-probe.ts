// Run as `bun test <this file>` from a package directory by hermetic-test-env.test.ts.
// Records which variables a test in that package can see after the package's preload ran.
import { test } from "bun:test";

test("record the environment a test sees", async () => {
	const out = process.env.PI_TEST_HERMETIC_ENV_OUT;
	if (!out) throw new Error("PI_TEST_HERMETIC_ENV_OUT is not set");
	await Bun.write(out, JSON.stringify(Object.keys(process.env).sort()));
});
