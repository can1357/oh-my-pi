import { expect, it, setDefaultTimeout } from "bun:test";
import * as path from "node:path";

const RUN = path.join(import.meta.dir, "../../bench/memory-eval/run.ts");
// Each case spawns the CLI, which loads the harness and Mnemopi; on a loaded machine that exceeds bun's 5 s default.
setDefaultTimeout(30_000);

/** Runs `run --engine mnemopi` with `extra` added to an environment that has no MNEMOPI_* variables. */
async function runMnemopi(extra: Record<string, string>): Promise<{ stderr: string; code: number }> {
	// The engine is created before the dataset is loaded, so no dataset is needed.
	const env = Object.fromEntries(Object.entries(Bun.env).filter(([key]) => !key.startsWith("MNEMOPI_")));
	const proc = Bun.spawn(
		[process.execPath, RUN, "run", "--dataset", "beam-100k", "--engine", "mnemopi", "--protocol", "standard"],
		{ env: { ...env, ...extra }, stdout: "pipe", stderr: "pipe" },
	);
	const [stderr, code] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
	return { stderr, code };
}

it("run refuses to start mnemopi while MNEMOPI_* variables are set", async () => {
	const { stderr, code } = await runMnemopi({ MNEMOPI_VEC_WEIGHT: "0.9" });
	expect(code).toBe(1);
	expect(stderr).toContain("refusing to run mnemopi with MNEMOPI_* or OPENROUTER_BASE_URL set:");
	expect(stderr).toContain("MNEMOPI_VEC_WEIGHT");
});

it("run refuses to start mnemopi while OPENROUTER_BASE_URL could route its embeddings to an API", async () => {
	const { stderr, code } = await runMnemopi({ OPENROUTER_BASE_URL: "http://localhost:1/v1" });
	expect(code).toBe(1);
	expect(stderr).toContain("refusing to run mnemopi with MNEMOPI_* or OPENROUTER_BASE_URL set: OPENROUTER_BASE_URL");
});
