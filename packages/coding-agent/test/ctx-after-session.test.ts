/**
 * The contract `docs/extensions.md` states for a `ctx` call that meets the end
 * of its session, row by row: each entry below is one row of the table in "A
 * `ctx` call across the end of its session", named in its "Gate shape" column,
 * and the table has no row this gate does not run.
 *
 * Only a separate process shows it: an unhandled rejection or an uncaught
 * exception is fatal through the postmortem handler, which no in-process
 * assertion can observe. Each shape runs in its own child
 * (`fixtures/ctx-after-session-probe.ts`). A fatal row is checked for its cause
 * as well as its exit — the report names the refusal and how it escaped — and a
 * survived row for what the extension saw.
 */
import { describe, expect, test } from "bun:test";
import * as path from "node:path";

const PROBE_PATH = path.join(import.meta.dir, "fixtures", "ctx-after-session-probe.ts");
const REPO_ROOT = path.resolve(import.meta.dir, "../../..");
/** What every refusal says (`ExtensionRuntime`'s retired-session error). */
const REFUSAL = "Extension session retired";

interface Observation {
	what: string;
	detail: unknown;
	hostCalls: number;
}

/** One shape's process: its exit, how a fatal ending was reported, and what the extension saw. */
interface ShapeRun {
	exit: number;
	fatal: { kind: string; refused: boolean } | null;
	observations: Observation[];
}

async function runShape(shape: string): Promise<ShapeRun> {
	const proc = Bun.spawn([process.execPath, PROBE_PATH, shape], {
		cwd: REPO_ROOT,
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
	});
	const [exit, stdout, stderr] = await Promise.all([
		proc.exited,
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
	]);
	// postmortem's report: `[Unhandled Rejection] Error: …` or `[Uncaught Exception] Error: …`.
	const report = stderr.split("\n").find(line => /^\[(Unhandled Rejection|Uncaught Exception)\]/.test(line));
	const observations = (Bun.JSONL.parse(stdout) as Observation[]).map(({ what, detail, hostCalls }) => ({
		what,
		detail,
		hostCalls,
	}));
	return {
		exit,
		fatal:
			report === undefined
				? null
				: { kind: report.slice(1, report.indexOf("]")), refused: report.includes(REFUSAL) },
		observations,
	};
}

const refusal = expect.stringContaining(REFUSAL);
const fatal = (kind: "Unhandled Rejection" | "Uncaught Exception") => ({ kind, refused: true });
const survived = (hostCalls = 1): Observation => ({ what: "survived", detail: undefined, hostCalls });
const caught = (hostCalls = 1): Observation => ({ what: "caught", detail: refusal, hostCalls });

/** Each documented row: the exit, the fatal report (`null` when the process survives), and what the
 *  extension saw, in order. */
const ROWS: Record<string, ShapeRun> = {
	// At the call: refused before any promise exists.
	"after-end-await-try": {
		exit: 0,
		fatal: null,
		observations: [{ what: "caught", detail: { returned: false, error: refusal }, hostCalls: 0 }, survived(0)],
	},
	"after-end-drop": { exit: 1, fatal: fatal("Uncaught Exception"), observations: [] },
	"after-end-catch": { exit: 1, fatal: fatal("Uncaught Exception"), observations: [] },
	// On the way back: the promise handed back is observed, and it rejects only if the session ended
	// before it settled.
	"dropped-original": {
		exit: 0,
		fatal: null,
		observations: [{ what: "original", detail: { status: "rejected", reason: refusal }, hostCalls: 1 }, survived()],
	},
	"stored-pending": { exit: 0, fatal: null, observations: [caught(), survived()] },
	"stored-fulfilled": {
		exit: 0,
		fatal: null,
		observations: [{ what: "fulfilled", detail: undefined, hostCalls: 1 }, survived()],
	},
	// Derived: each promise made from it is the extension's to observe.
	"derived-then": { exit: 1, fatal: fatal("Unhandled Rejection"), observations: [] },
	"derived-then-catch": { exit: 0, fatal: null, observations: [caught(), survived()] },
	"derived-then-handler": { exit: 0, fatal: null, observations: [caught(), survived()] },
	"derived-finally": {
		exit: 1,
		fatal: fatal("Unhandled Rejection"),
		observations: [{ what: "finally", detail: undefined, hostCalls: 1 }],
	},
	"derived-try-finally": {
		exit: 1,
		fatal: fatal("Unhandled Rejection"),
		observations: [{ what: "finally", detail: undefined, hostCalls: 1 }],
	},
	"derived-try-catch": { exit: 1, fatal: fatal("Unhandled Rejection"), observations: [] },
	"derived-all-awaited": { exit: 0, fatal: null, observations: [caught(), survived()] },
	"derived-all": { exit: 1, fatal: fatal("Unhandled Rejection"), observations: [] },
	"derived-async-all": { exit: 1, fatal: fatal("Unhandled Rejection"), observations: [] },
	"derived-async": { exit: 1, fatal: fatal("Unhandled Rejection"), observations: [] },
	"derived-async-try": { exit: 0, fatal: null, observations: [caught(), survived()] },
};

describe("a ctx call that meets the end of its session", () => {
	test("ends the process exactly where docs/extensions.md says, and for the refusal it names", async () => {
		const shapes = Object.keys(ROWS);
		const runs = await Promise.all(shapes.map(shape => runShape(shape)));

		expect(Object.fromEntries(shapes.map((shape, index) => [shape, runs[index]]))).toEqual(ROWS);
	}, 300_000);
});
