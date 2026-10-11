import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { mnemosyneEngine } from "../../bench/memory-eval/engines/mnemosyne";
import { runCases } from "../../bench/memory-eval/runner";
import type { EvalCase } from "../../bench/memory-eval/types";

const REAL_SCRIPT = path.join(import.meta.dir, "../../bench/memory-eval/py/mnemosyne_engine.py");

const twoMessageCase: EvalCase = {
	caseId: "c/1",
	dataset: "beam-100k",
	messages: [
		{ messageId: "m1", sessionId: "s", role: "user", content: "alpha beta" },
		{ messageId: "m2", sessionId: "s", role: "user", content: "Gamma   DELTA" },
	],
	questions: [{ questionId: "q1", text: "q", category: "cat", goldMessageIds: ["m2"], goldSessionIds: [] }],
};

let tmp: string;
beforeAll(async () => {
	tmp = await fs.mkdtemp(path.join(os.tmpdir(), "memory-eval-mnemosyne-"));
});
afterAll(async () => {
	await fs.rm(tmp, { recursive: true, force: true });
});

/** Writes a stub engine script; Mnemosyne itself is not needed. */
async function stub(name: string, source: string): Promise<string> {
	const file = path.join(tmp, name);
	await Bun.write(file, source);
	return file;
}

// Answers the first request, then replies to the second with an error.
const ERRORING_STUB = `import json, sys
for n, line in enumerate(sys.stdin, 1):
    req = json.loads(line)
    reply = {"id": req["id"], "result": {}} if n == 1 else {"id": req["id"], "error": "boom"}
    print(json.dumps(reply), flush=True)
`;

describe("mnemosyne client", () => {
	it("adapter error aborts the run", async () => {
		const engine = mnemosyneEngine({ python: "python3", script: await stub("erroring.py", ERRORING_STUB) });
		await expect(runCases(engine, [twoMessageCase], "standard", 10, tmp)).rejects.toThrow("boom");
		await engine.dispose();
	});

	it("a crashed process aborts the run with its stderr", async () => {
		const script = await stub(
			"crashing.py",
			`import sys\nsys.stdin.readline()\nprint("kaput", file=sys.stderr)\nsys.exit(3)\n`,
		);
		const engine = mnemosyneEngine({ python: "python3", script });
		await expect(runCases(engine, [twoMessageCase], "standard", 10, tmp)).rejects.toThrow(/code 3.*kaput/s);
		await expect(engine.vectorCount()).rejects.toThrow("kaput");
		await engine.dispose();
	});

	it("a Mnemosyne version other than 4.0.0b4 aborts the run", async () => {
		const engine = mnemosyneEngine({ python: "python3", script: REAL_SCRIPT });
		await expect(runCases(engine, [twoMessageCase], "standard", 10, tmp)).rejects.toThrow("4.0.0b4");
		await engine.dispose();
	});

	it("one process serves one protocol", async () => {
		const engine = mnemosyneEngine({ python: "python3", script: await stub("erroring.py", ERRORING_STUB) });
		await engine.warmup("standard");
		await expect(engine.open(twoMessageCase, { storeDir: tmp, protocol: "fts-only" })).rejects.toThrow("fts-only");
		await engine.dispose();
	});

	it("does not pass the parent's MNEMOSYNE_* variables to the engine process", async () => {
		// Answers every request with the MNEMOSYNE_* variables of its own environment.
		const script = await stub(
			"env.py",
			`import json, os, sys
for line in sys.stdin:
    req = json.loads(line)
    env = {k: v for k, v in os.environ.items() if k.startswith("MNEMOSYNE_")}
    print(json.dumps({"id": req["id"], "result": env}), flush=True)
`,
		);
		const saved = process.env.MNEMOSYNE_VEC_WEIGHT;
		process.env.MNEMOSYNE_VEC_WEIGHT = "0.9";
		const engine = mnemosyneEngine({ python: "python3", script });
		try {
			await engine.warmup("standard");
			const info = await engine.describe();
			expect(info.MNEMOSYNE_VEC_WEIGHT).toBeUndefined();
			expect(info.MNEMOSYNE_LLM_ENABLED).toBe("false");
			expect(info.MNEMOSYNE_EMBEDDING_MODEL).toBe("BAAI/bge-small-en-v1.5");
		} finally {
			if (saved === undefined) delete process.env.MNEMOSYNE_VEC_WEIGHT;
			else process.env.MNEMOSYNE_VEC_WEIGHT = saved;
			await engine.dispose();
		}
	});
});
