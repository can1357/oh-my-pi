import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { mnemopiEngine } from "../../bench/memory-eval/engines/mnemopi";
import { PythonProcess } from "../../bench/memory-eval/engines/python-process";
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

// Replies with the PYTHON* variables it inherited.
const ENV_REPORTING_SERVER = `import json, os, sys
for line in sys.stdin:
    req = json.loads(line)
    print(json.dumps({"id": req["id"], "result": sorted(k for k in os.environ if k.upper().startswith("PYTHON"))}), flush=True)
`;

describe("python helper environment", () => {
	it("keeps PYTHON* import overrides away from the helper, so it imports the pinned venv's packages", async () => {
		const script = path.join(tmp, "env_reporting_server.py");
		await Bun.write(script, ENV_REPORTING_SERVER);
		const helper = new PythonProcess("env reporter", "python3", script, {
			PATH: Bun.env.PATH,
			PYTHONPATH: path.join(tmp, "another-fastembed"),
			PYTHONHOME: tmp,
			KEPT: "1",
		});
		try {
			expect(await helper.call("env")).toEqual([]);
		} finally {
			await helper.shutdown();
		}
	});
});

// Any call fails: under fts-only Mnemopi must never ask the embedder.
const DEAD_EMBED_SERVER = `import sys\nsys.exit("fts-only asked for an embedding")\n`;

describe("mnemopi engine under fts-only", () => {
	it("maps Mnemopi rows back to message ids by row id and never embeds", async () => {
		const embedScript = path.join(tmp, "dead_embed_server.py");
		await Bun.write(embedScript, DEAD_EMBED_SERVER);
		const engine = mnemopiEngine({ embedder: "python", embedPython: "python3", embedScript });
		try {
			const { questions } = await runCases(engine, [twoMessageCase], "fts-only", 10, tmp);
			expect(questions[0].ranked[0]).toMatchObject({ messageIds: ["m2"], viaFallback: false });
			expect(questions[0].ranked.filter(hit => hit.viaFallback)).toEqual([]);
			expect(questions[0].metrics["recall@10"]).toBe(1);
			// The result file's describe() runs after the last case; it must not start the dead server either.
			expect(await engine.describe()).toMatchObject({ embedder: "python", embeddings_disabled: "true" });
		} finally {
			await engine.dispose();
		}
	});

	it("keeps every working-memory row past Mnemopi's 1000-row production default", async () => {
		// SQLite syncs every insert: 1200 rows take ~0.3 s on tmpfs and ~15 s on a disk.
		const base = process.platform === "linux" ? "/dev/shm" : tmp;
		const storeDir = await fs.mkdtemp(path.join(base, "memory-eval-wm-"));
		const rows = 1200;
		const engine = mnemopiEngine();
		try {
			await engine.warmup("fts-only");
			await engine.open({ ...twoMessageCase, messages: [] }, { storeDir, protocol: "fts-only" });
			const items = Array.from({ length: rows }, (_, i) => ({
				messageId: `m${i}`,
				content: `message number ${i} about topic ${i % 7}`,
				source: "user",
				importance: 0.5,
			}));
			expect(new Set(await engine.remember(items)).size).toBe(rows);
			await engine.close();
			const db = new Database(path.join(storeDir, "mnemopi.db"), { readonly: true });
			try {
				expect(db.query("SELECT COUNT(*) AS n FROM working_memory").get()).toEqual({ n: rows });
			} finally {
				db.close();
			}
		} finally {
			await engine.dispose();
			await fs.rm(storeDir, { recursive: true, force: true });
		}
	});
});
