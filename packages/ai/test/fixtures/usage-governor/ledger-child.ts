/**
 * Child process for the ledger contract tests. Each child opens the shared usage-governor ledger
 * and admits against one window, so several processes contend on one SQLite file exactly as
 * separate `omp` processes do.
 *
 * argv[2] is a JSON {@link ChildConfig}. Output is one JSON line per event on stdout:
 *   {"kind":"admitted","grantId":"..."}, {"kind":"wait","admissibleAtMs":n}, then {"kind":"done","admitted":n}.
 *
 * `mode: "admit-until-wait"` admits until the ledger refuses, then exits. `mode: "hold"` admits once,
 * prints the grant, and then stays alive so the parent can kill it mid-run with its reservation open.
 */
import { type LedgerAdmitResult, UsageLedger } from "@oh-my-pi/pi-ai/usage-governor/ledger";

interface ChildConfig {
	dbPath: string;
	mode: "admit-until-wait" | "hold";
	maxAttempts: number;
	quotaKey: string;
	generation: number;
	label: string;
	resetsAt: number;
	durationMs?: number;
	usedFraction: number;
	reserve: number;
	fetchedAt: number;
	lead: number;
	/** Epoch ms before which the child waits; siblings sharing it start contending together. */
	startAtMs?: number;
	/** Milliseconds to yield between admissions. */
	pauseMs?: number;
}

const config: ChildConfig = JSON.parse(process.argv[2] ?? "{}");
const ledger = UsageLedger.open(config.dbPath);

function emit(event: Record<string, unknown>): void {
	process.stdout.write(`${JSON.stringify(event)}\n`);
}

function admitOnce(grantId: string): LedgerAdmitResult {
	return ledger.admit({
		grantId,
		nowMs: Date.now(),
		lead: config.lead,
		windows: [
			{
				quotaKey: config.quotaKey,
				generation: config.generation,
				label: config.label,
				resetsAt: config.resetsAt,
				durationMs: config.durationMs,
				usedFraction: config.usedFraction,
				exhausted: false,
				fetchedAt: config.fetchedAt,
				reserve: config.reserve,
			},
		],
		provider: "unit-ledger",
		credentialId: 1,
		source: "turn",
		interactive: false,
		pid: process.pid,
	});
}

if (config.mode === "hold") {
	const grantId = crypto.randomUUID();
	const result = admitOnce(grantId);
	if (result.kind !== "admitted") {
		emit({ kind: "wait", admissibleAtMs: result.admissibleAtMs });
		ledger.close();
		process.exit(0);
	}
	emit({ kind: "admitted", grantId });
	// Real process, real kill: the parent SIGKILLs this child, so no timer decides when the hold ends.
	setInterval(() => {}, 1_000);
} else {
	// Wall-clock start on purpose: separate processes must reach the shared file at one real instant.
	await Bun.sleep(Math.max(0, (config.startAtMs ?? 0) - Date.now()));
	let admitted = 0;
	for (let attempt = 0; attempt < config.maxAttempts; attempt += 1) {
		const result = admitOnce(crypto.randomUUID());
		if (result.kind !== "admitted") {
			emit({ kind: "wait", admissibleAtMs: result.admissibleAtMs });
			break;
		}
		admitted += 1;
		// A scheduler yield, not a timing assumption: the tests assert totals, never the per-child split.
		await Bun.sleep(config.pauseMs ?? 0);
	}
	emit({ kind: "done", admitted });
	ledger.close();
}
