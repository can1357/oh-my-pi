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

// A fake Mnemosyne 4.0.0b4 for the real engine script: recall ranks one derived row above every remembered row and,
// like Mnemosyne, returns at most top_k rows.
const FAKE_BEAM = `import sqlite3

class BeamMemory:
    def __init__(self, session_id, db_path):
        self.conn = sqlite3.connect(":memory:")
        self.conn.execute("CREATE TABLE memory_embeddings (id TEXT)")
        self.conn.execute("INSERT INTO memory_embeddings VALUES ('v')")
        self.rows = []

    def remember(self, content, source, importance):
        self.rows.append({"id": "r%d" % (len(self.rows) + 1), "tier": "working", "content": content})
        return self.rows[-1]["id"]

    def recall(self, query, top_k):
        derived = {"id": "memoria_facts", "tier": "memoria", "content": "[MEMORIA facts]", "source_memory_id": None}
        return ([derived] + self.rows)[:top_k]
`;

/** The real engine script, run against FAKE_BEAM instead of an installed Mnemosyne. */
async function realScriptOnFakeMnemosyne(): Promise<string> {
	const fake = path.join(tmp, "fake-mnemosyne");
	await Bun.write(
		path.join(fake, "mnemosyne_memory-4.0.0b4.dist-info", "METADATA"),
		"Metadata-Version: 2.1\nName: mnemosyne-memory\nVersion: 4.0.0b4\n",
	);
	await Bun.write(path.join(fake, "mnemosyne", "__init__.py"), "");
	await Bun.write(path.join(fake, "mnemosyne", "core", "__init__.py"), "");
	await Bun.write(
		path.join(fake, "mnemosyne", "core", "embeddings.py"),
		`_DEFAULT_MODEL = "fake"\ndef available():\n    return True\ndef embed(texts):\n    return [[1.0] for _ in texts]\n`,
	);
	await Bun.write(path.join(fake, "mnemosyne", "core", "beam.py"), FAKE_BEAM);
	return stub(
		"fake-mnemosyne-run.py",
		`import runpy, sys\nsys.path.insert(0, ${JSON.stringify(fake)})\nrunpy.run_path(${JSON.stringify(REAL_SCRIPT)}, run_name="__main__")\n`,
	);
}

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

	it("passes dropped derived rows through and hides the per-run data dir", async () => {
		const script = await stub(
			"dropped.py",
			`import json, os, sys
HIT = {"engine_id": "r1", "tier": "working", "content": "alpha beta", "summary_of": []}
DROPPED = {"tier": "memoria_source", "engine_id": "memoria_source_r2", "source_memory_id": "r2", "rank": 1}
for line in sys.stdin:
    req = json.loads(line)
    op = req["op"]
    if op == "remember":
        result = ["r%d" % (i + 1) for i in range(len(req["params"]["items"]))]
    elif op == "recall":
        result = {"hits": [HIT], "dropped": [DROPPED]}
    elif op == "describe":
        result = {"MNEMOSYNE_DATA_DIR": os.environ["MNEMOSYNE_DATA_DIR"]}
    elif op == "vector_count":
        result = 1
    elif op == "resources":
        result = {"peak_rss_bytes": 2, "baseline_rss_bytes": 1}
    else:
        result = None
    print(json.dumps({"id": req["id"], "result": result}), flush=True)
`,
		);
		const engine = mnemosyneEngine({ python: "python3", script });
		try {
			const { questions } = await runCases(engine, [twoMessageCase], "standard", 10, tmp);
			expect(questions[0].ranked.map(h => h.messageIds)).toEqual([["m1"]]);
			expect(questions[0].dropped).toEqual([{ tier: "memoria_source", messageIds: ["m2"], rank: 1, gold: true }]);
			expect((await engine.describe()).MNEMOSYNE_DATA_DIR).toBe("<temp>");
		} finally {
			await engine.dispose();
		}
	});

	it("fetches past derived rows until k working or episodic rows are ranked", async () => {
		const threeMessageCase: EvalCase = {
			...twoMessageCase,
			messages: [
				...twoMessageCase.messages,
				{ messageId: "m3", sessionId: "s", role: "user", content: "eta theta" },
			],
		};
		const engine = mnemosyneEngine({ python: "python3", script: await realScriptOnFakeMnemosyne() });
		try {
			const { questions } = await runCases(engine, [threeMessageCase], "standard", 2, tmp);
			// At top_k=2 the derived row would leave one ranked row and miss gold m2; m3 is past the top 2.
			expect(questions[0].ranked.map(h => h.messageIds)).toEqual([["m1"], ["m2"]]);
			expect(questions[0].metrics["recall@10"]).toBe(1);
			expect(questions[0].dropped).toEqual([{ tier: "memoria", messageIds: [], rank: 0, gold: false }]);
		} finally {
			await engine.dispose();
		}
	});
});
