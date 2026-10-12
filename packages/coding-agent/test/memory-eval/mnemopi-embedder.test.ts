import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { mnemopiEngine } from "../../bench/memory-eval/engines/mnemopi";
import { runCases } from "../../bench/memory-eval/runner";
import type { EvalCase } from "../../bench/memory-eval/types";

const twoMessageCase: EvalCase = {
	caseId: "c/1",
	dataset: "beam-100k",
	messages: [
		{ messageId: "m1", sessionId: "s", role: "user", content: "alpha beta" },
		{ messageId: "m2", sessionId: "s", role: "user", content: "gamma delta" },
	],
	questions: [{ questionId: "q1", text: "gamma", category: "cat", goldMessageIds: ["m2"], goldSessionIds: [] }],
};

// Embeds the warmup text and the first message, then fails: the first message still gets a vector,
// so only the adapter's failure check (not the vectors-present guard) can stop the run.
const FAILING_EMBED_SERVER = `import json, sys
for n, line in enumerate(sys.stdin, 1):
    req = json.loads(line)
    if n <= 2:
        reply = {"id": req["id"], "result": [[0.1] * 384 for _ in req["params"]["texts"]]}
    else:
        reply = {"id": req["id"], "error": "embed boom"}
    print(json.dumps(reply), flush=True)
`;

let tmp: string;
beforeAll(async () => {
	tmp = await fs.mkdtemp(path.join(os.tmpdir(), "memory-eval-embedder-"));
});
afterAll(async () => {
	await fs.rm(tmp, { recursive: true, force: true });
});

describe("mnemopi python embedder", () => {
	it("a failing embedding server aborts the run instead of leaving rows without vectors", async () => {
		const embedScript = path.join(tmp, "failing_embed_server.py");
		await Bun.write(embedScript, FAILING_EMBED_SERVER);
		const engine = mnemopiEngine({ embedder: "python", embedPython: "python3", embedScript });
		try {
			await expect(runCases(engine, [twoMessageCase], "standard", 10, tmp)).rejects.toThrow("embed boom");
		} finally {
			await engine.dispose();
		}
	});
});
