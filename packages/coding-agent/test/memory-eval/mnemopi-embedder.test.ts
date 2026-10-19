import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import * as path from "node:path";
import { TempDir } from "@oh-my-pi/pi-utils";
import { mnemopiEngine } from "../../bench/memory-eval/engines/mnemopi";
import { PythonProcess } from "../../bench/memory-eval/engines/python-process";
import { runCases } from "../../bench/memory-eval/runner";
import type { EvalCase } from "../../bench/memory-eval/types";
import { pythonPath } from "./python";

function python(): string {
	if (!pythonPath) throw new Error("Python is required for this test");
	return pythonPath;
}

const twoMessageCase: EvalCase = {
	caseId: "c/1",
	dataset: "beam-100k",
	messages: [
		{ messageId: "m1", sessionId: "s", role: "user", content: "alpha beta" },
		{ messageId: "m2", sessionId: "s", role: "user", content: "gamma delta" },
	],
	questions: [{ questionId: "q1", text: "gamma", category: "cat", goldMessageIds: ["m2"], goldSessionIds: [] }],
};

const EMBED_FAILURE_TRIGGER = "embed-failure-trigger";

// A request fails when, and only when, one of its texts carries the trigger: warmup and the first message embed fine,
// so which request fails does not depend on how many requests precede it or how they are batched.
const FAILING_EMBED_SERVER = `import json, sys
for line in sys.stdin:
    req = json.loads(line)
    texts = req["params"]["texts"]
    if any(${JSON.stringify(EMBED_FAILURE_TRIGGER)} in text for text in texts):
        reply = {"id": req["id"], "error": "embed boom"}
    else:
        reply = {"id": req["id"], "result": [[0.1] * 384 for _ in texts]}
    print(json.dumps(reply), flush=True)
`;

const failingEmbedCase: EvalCase = {
	...twoMessageCase,
	messages: [twoMessageCase.messages[0], { ...twoMessageCase.messages[1], content: `gamma ${EMBED_FAILURE_TRIGGER}` }],
};

let tmp: TempDir;
beforeAll(async () => {
	tmp = await TempDir.create("@memory-eval-embedder-");
});
afterAll(async () => {
	await tmp.remove();
});

describe("mnemopi python embedder", () => {
	it.skipIf(!pythonPath)(
		"a failing embedding server aborts the run instead of leaving rows without vectors",
		async () => {
			const embedScript = tmp.join("failing_embed_server.py");
			await Bun.write(embedScript, FAILING_EMBED_SERVER);
			const engine = mnemopiEngine({ embedder: "python", embedPython: python(), embedScript });
			try {
				// Mnemopi swallows the provider error and the first message may still have a vector: only the adapter
				// rethrowing the server's failure yields "embed boom" rather than the runner's "have no vector".
				// Failed runs can leave their store behind; do not reuse it in the FTS-only fixture.
				await expect(runCases(engine, [failingEmbedCase], "standard", 10, tmp.join("failed-run"))).rejects.toThrow(
					"embed boom",
				);
			} finally {
				await engine.dispose();
			}
		},
	);

	it("reports a missing Python interpreter during warmup, before ingesting any case", async () => {
		const missing = tmp.join("missing-python");
		const engine = mnemopiEngine({ embedder: "python", embedPython: missing });
		try {
			await expect(engine.warmup("standard")).rejects.toMatchObject({ code: "ENOENT" });
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
	it.skipIf(!pythonPath)(
		"keeps PYTHON* import overrides away from the helper, so it imports the pinned venv's packages",
		async () => {
			const script = tmp.join("env_reporting_server.py");
			await Bun.write(script, ENV_REPORTING_SERVER);
			// The inherited environment (SystemRoot on Windows, /etc-relative paths elsewhere) lets the interpreter start;
			// the PYTHON* overrides then replace whatever it carried.
			const helper = new PythonProcess("env reporter", python(), script, {
				...Bun.env,
				PYTHONPATH: tmp.join("another-fastembed"),
				PYTHONHOME: tmp.path(),
				KEPT: "1",
			});
			try {
				expect(await helper.call("env")).toEqual([]);
			} finally {
				await helper.shutdown();
			}
		},
	);
});

// Any call fails: under fts-only Mnemopi must never ask the embedder.
const DEAD_EMBED_SERVER = `import sys\nsys.exit("fts-only asked for an embedding")\n`;

describe("mnemopi engine under fts-only", () => {
	it("maps Mnemopi rows back to message ids by row id and never embeds", async () => {
		const embedScript = tmp.join("dead_embed_server.py");
		await Bun.write(embedScript, DEAD_EMBED_SERVER);
		// Runs without Python: with none installed the interpreter path is missing, so a spawn would throw from describe().
		// With Python, a spawn would run the dead script and fail the operation that triggered it.
		const embedPython = pythonPath ?? tmp.join("no-python");
		const engine = mnemopiEngine({ embedder: "python", embedPython, embedScript });
		try {
			const { questions } = await runCases(engine, [twoMessageCase], "fts-only", 10, tmp.path());
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
		// SQLite syncs every insert, so use the fewest rows that cross the limit; tmpfs avoids the disk where there is one.
		await using store = await TempDir.create(
			process.platform === "linux" ? "/dev/shm/memory-eval-wm-" : "@memory-eval-wm-",
		);
		const storeDir = store.path();
		const rows = 1001;
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
		}
	});
});
