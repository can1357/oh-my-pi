import { describe, expect, it } from "bun:test";
import { explore } from "../../../../.omp/skills/session-leaf-verification/verify";

// Bounded run of the session-leaf-verification skill harness. Deeper runs stay
// manual (`bun .omp/skills/session-leaf-verification/verify.ts 6`); this keeps
// the harness compiling and passing against the current session modules.
describe("session leaf contract (exhaustive, depth 3)", () => {
	it("holds P0-P4 for every operation sequence", async () => {
		const result = await explore(3);
		expect(result.failure).toBeUndefined();
		expect(result.explored).toBe(6 + 36 + 216);
	});

	it("replays exactly one named sequence", async () => {
		expect(await explore(4, ["append user", "append answer"])).toEqual({ explored: 1 });
	});

	it("names the valid steps when a replay step is misspelled", async () => {
		await expect(explore(4, ["append usr"])).rejects.toThrow(/unknown step "append usr"; valid steps: append user/);
	});
});
