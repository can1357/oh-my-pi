import { afterEach, describe, expect, it } from "bun:test";
import * as path from "node:path";
import { $which, TempDir } from "@pk-nerdsaver-ai/pi-utils";
import { disposeJuliaKernelSessionsByOwner, executeJulia } from "../jl/executor";

const HAS_JULIA = Boolean($which("julia"));
const OWNER_ID = "julia-prelude-tests";

// Julia's cold-start JIT/precompilation on a loaded CI runner has blown a 30s
// budget twice (the reported "35s hook timeout" is the 30s test budget plus
// hook overage), and this file is chunk 1 of the native bucket — when it
// flakes, the abort hides every later chunk. Disposal is already bounded
// (settleWithin, 10s per phase); the remaining variable is startup, so give
// the whole test a budget that reflects a cold JIT rather than a warm one.
// Tracked in NER-135.
const JULIA_TEST_TIMEOUT_MS = 120_000;

describe.skipIf(!HAS_JULIA)("eval Julia prelude helpers", () => {
	afterEach(async () => {
		await disposeJuliaKernelSessionsByOwner(OWNER_ID);
	});

	it(
		"supports output ranges, JSON queries, metadata, and ANSI stripping",
		async () => {
			using tempDir = TempDir.createSync("@omp-eval-julia-output-");
			const artifactsDir = path.join(tempDir.path(), "session-artifacts");
			await Bun.write(path.join(artifactsDir, "alpha.md"), "one\ntwo\nthree\nfour");
			await Bun.write(path.join(artifactsDir, "json.md"), JSON.stringify({ items: [{ name: "a" }, { name: "b" }] }));
			await Bun.write(path.join(artifactsDir, "ansi.md"), "\u001b[31mred\u001b[0m");

			const result = await executeJulia(
				`
println("RANGE=", replace(output("alpha", offset=2, limit=2), "\\n" => "|"))
println("QUERY=", output("json", query=".items[1].name"))
println("STRIPPED=", output("ansi", format="stripped"))
meta = output("alpha", format="json")
println("META=", meta["id"], ":", meta["char_count"] > 0)
multi = output("alpha", "json")
println("MULTI=", length(multi), ":", multi[1]["id"], ":", multi[2]["id"])
nothing
`,
				{
					cwd: tempDir.path(),
					artifactsDir,
					sessionId: `julia-prelude-output:${crypto.randomUUID()}`,
					kernelOwnerId: OWNER_ID,
					reset: true,
				},
			);

			expect(result.exitCode).toBe(0);
			expect(result.output).toContain("RANGE=two|three");
			expect(result.output).toContain('QUERY="b"');
			expect(result.output).toContain("STRIPPED=red");
			expect(result.output).toContain("META=alpha:true");
			expect(result.output).toContain("MULTI=2:alpha:json");
		},
		JULIA_TEST_TIMEOUT_MS,
	);

	it(
		"surfaces the exception type and message in the error output, not just stack frames",
		async () => {
			using tempDir = TempDir.createSync("@omp-eval-julia-error-");
			const result = await executeJulia(`println("="^8)\nmissing_var_xyz + 1`, {
				cwd: tempDir.path(),
				sessionId: `julia-prelude-error:${crypto.randomUUID()}`,
				kernelOwnerId: OWNER_ID,
				reset: true,
			});

			// The rendered error must carry the actual exception, not only the
			// runner-internal backtrace frames (regression: traceback-only output
			// hid `ename`/`evalue`).
			expect(result.output).toContain("UndefVarError");
			expect(result.output).toContain("missing_var_xyz");
			// Frames are still present alongside the message.
			expect(result.output).toContain("top-level scope");
		},
		JULIA_TEST_TIMEOUT_MS,
	);
});
