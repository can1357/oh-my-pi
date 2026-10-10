import { describe, expect, it } from "bun:test";
import * as path from "node:path";
import { type } from "@oh-my-pi/omptype";

const PROBE = path.resolve(import.meta.dir, "fixtures/when-healthy-tokenizer-domain-probe.ts");
const ProbeResult = type({
	primaryTextTokens: "number",
	fallbackTextTokens: "number",
	requests: "string[]",
	compactions: "number",
});

describe("when-healthy return across tokenizers", () => {
	it("stays on the fallback when the prompt overflows the primary's window in the primary's tokenizer", async () => {
		// The test environment swaps native encodings for a byte estimate, which
		// hides the tokenizer mismatch; a production-mode child counts for real.
		const child = Bun.spawn([process.execPath, PROBE], {
			cwd: path.resolve(import.meta.dir, ".."),
			env: { HOME: process.env.HOME, PATH: process.env.PATH, NODE_ENV: "production", PI_TOKENIZER_ACCURATE: "1" },
			stdin: "ignore",
			stdout: "pipe",
			stderr: "pipe",
		});
		try {
			const [stdout, stderr, exitCode] = await Promise.all([
				new Response(child.stdout).text(),
				new Response(child.stderr).text(),
				child.exited,
			]);
			expect(exitCode, stderr).toBe(0);
			const result = ProbeResult.assert(JSON.parse(stdout));
			// Precondition: only the primary's own count overflows its 3,300-token window.
			expect(result.fallbackTextTokens).toBeLessThan(3300);
			expect(result.primaryTextTokens).toBeGreaterThan(3300);
			expect(result.requests).toEqual(["gpt-4o-mini"]);
			expect(result.compactions).toBe(0);
		} finally {
			child.kill();
		}
	}, 30_000);
});
