import { expect, it } from "bun:test";
import * as path from "node:path";

const RUN = path.join(import.meta.dir, "../../bench/memory-eval/run.ts");

it("run refuses to start mnemopi while MNEMOPI_* variables are set", async () => {
	// The engine is created before the dataset is loaded, so no dataset is needed.
	const proc = Bun.spawn(
		[process.execPath, RUN, "run", "--dataset", "beam-100k", "--engine", "mnemopi", "--protocol", "standard"],
		{ env: { ...Bun.env, MNEMOPI_VEC_WEIGHT: "0.9" }, stdout: "pipe", stderr: "pipe" },
	);
	const [stderr, code] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
	expect(code).toBe(1);
	expect(stderr).toContain("refusing to run mnemopi with MNEMOPI_* set:");
	expect(stderr).toContain("MNEMOPI_VEC_WEIGHT");
});
