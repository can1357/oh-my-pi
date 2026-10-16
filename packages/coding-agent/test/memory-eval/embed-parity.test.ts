import { expect, it, setDefaultTimeout } from "bun:test";
import * as path from "node:path";
import { assertParity } from "../../bench/memory-eval/embed-parity";

const PARITY = path.join(import.meta.dir, "../../bench/memory-eval/embed-parity.ts");
// Each case spawns the script, which loads Mnemopi; on a loaded machine that exceeds bun's 5 s default.
setDefaultTimeout(30_000);

it("parity fails on a non-finite or low cosine", () => {
	expect(() => assertParity([1, Number.NaN])).toThrow("text 1 has a non-finite cosine");
	expect(() => assertParity([1, 0.5])).toThrow("min cosine 0.5 < 0.99");
	expect(() => assertParity([1, 0.995])).not.toThrow();
});

it("embed-parity refuses to run while the environment could route Mnemopi embeddings to an API", async () => {
	const env = Object.fromEntries(Object.entries(Bun.env).filter(([key]) => !key.startsWith("MNEMOPI_")));
	for (const extra of [{ MNEMOPI_EMBEDDINGS_VIA_API: "1" }, { OPENROUTER_BASE_URL: "http://localhost:1/v1" }]) {
		// The refusal comes before the parity file is read, so it need not exist.
		const proc = Bun.spawn([process.execPath, PARITY, "missing-parity.json"], {
			env: { ...env, ...extra },
			stdout: "pipe",
			stderr: "pipe",
		});
		const [stderr, code] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
		expect(code).toBe(1);
		expect(stderr).toContain(`refusing to run mnemopi with MNEMOPI_* or OPENROUTER_BASE_URL set: ${Object.keys(extra)[0]}`);
	}
});
