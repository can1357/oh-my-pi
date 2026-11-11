import { expect, it, setDefaultTimeout } from "bun:test";
import * as path from "node:path";
import { ptree } from "@oh-my-pi/pi-utils";
import { assertParity, parityCosine } from "../../bench/memory-eval/embed-parity";
import { envWithout } from "../../bench/memory-eval/env";

const PARITY = path.join(import.meta.dir, "../../bench/memory-eval/embed-parity.ts");
// Each case spawns the script, which loads Mnemopi; on a loaded machine that exceeds bun's 5 s default.
setDefaultTimeout(30_000);

it("parity fails on a non-finite or low cosine", () => {
	expect(() => assertParity([1, Number.NaN])).toThrow("text 1 has a non-finite cosine");
	expect(() => assertParity([1, 0.5])).toThrow("min cosine 0.5 < 0.99");
	expect(() => assertParity([1, 0.995])).not.toThrow();
});

// The shared cosine zeroes non-finite components and pads short vectors; parity must fail those embeddings instead.
it("parity cosine refuses a broken embedding that a lenient cosine would still score", () => {
	expect(() => parityCosine([1, 0, Number.NaN], [1, 0, 0])).toThrow("non-finite component");
	expect(() => parityCosine([1, 0], [1, 0, 0])).toThrow("vector dimensions differ: 2 vs 3");
	expect(parityCosine([3, 4], [6, 8])).toBeCloseTo(1, 12);
	expect(parityCosine([0, 0], [1, 0])).toBe(0);
});

it("embed-parity refuses to run while the environment could route Mnemopi embeddings to an API", async () => {
	const env = envWithout("MNEMOPI_");
	for (const extra of [{ MNEMOPI_EMBEDDINGS_VIA_API: "1" }, { OPENROUTER_BASE_URL: "http://localhost:1/v1" }]) {
		// The refusal comes before the parity file is read, so it need not exist.
		const { stderr, exitCode } = await ptree.exec([process.execPath, PARITY, "missing-parity.json"], {
			env: { ...env, ...extra },
			allowNonZero: true,
		});
		expect(exitCode).toBe(1);
		expect(stderr).toContain(
			`refusing to run mnemopi with MNEMOPI_* or OPENROUTER_BASE_URL set: ${Object.keys(extra)[0]}`,
		);
	}
});
