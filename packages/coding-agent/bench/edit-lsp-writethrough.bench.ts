/**
 * Edit/write LSP-writethrough latency probe.
 *
 * The pure hashline apply is sub-2ms for normal files (see
 * `packages/hashline/bench/apply-edit.ts`). The real source of "applying an
 * edit takes a LOT of time" is the LSP writethrough's *synchronous* wait for
 * fresh diagnostics:
 *
 *   runLspWritethrough -> getDiagnosticsForFile -> waitForDiagnostics
 *
 * `waitForDiagnostics` polls every 100ms. Servers that echo the edited
 * document version are accepted immediately; servers that omit or mismatch it
 * (typescript-language-server) settle on the latest publish after a 250ms quiet
 * window so stale in-flight publishes can be superseded without burning the
 * full timeout.
 *
 * Gated by settings:
 *   - edit tool:  `lsp.diagnosticsOnEdit`  (default FALSE — edits fast by default)
 *   - write tool: `lsp.diagnosticsOnWrite` (default TRUE  — writes pay it by default)
 *   - both:       `lsp.formatOnWrite`      (default FALSE — ~24ms when on, fine)
 *
 * Requires a TypeScript language server on PATH and a tsconfig at the repo
 * root. Mutates a temp .ts file inside the repo so tsserver resolves it under
 * the project, then deletes it.
 *
 * Run: `bun run packages/coding-agent/bench/edit-lsp-writethrough.bench.ts`
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { createLspWritethrough, writethroughNoop } from "../src/lsp";

const REPO = path.resolve(import.meta.dir, "../../..");
const target = path.join(REPO, "packages/coding-agent/src/__bench_lsp_tmp.ts");

function body(n: number): string {
	return `// bench scratch file with an intentional type diagnostic
export function benchAdd_${n}(a: number, b: number): number {
	const result = a + b;
	return result;
}
export const benchValue_${n}: string = benchAdd_${n}(${n}, ${n + 1});
`;
}

async function timeCall(label: string, fn: () => Promise<unknown>): Promise<void> {
	const t0 = Bun.nanoseconds();
	await fn();
	console.log(`  ${label.padEnd(46)} ${((Bun.nanoseconds() - t0) / 1e6).toFixed(1).padStart(9)} ms`);
}

/**
 * Build a one-shot deferred handle mirroring the edit tool's
 * `beginDeferredDiagnosticsForPath`: `onDeferredDiagnostics` is the late-injection
 * sink, `signal` keeps the background fetch alive, `finalize` reports whether the
 * inline result arrived. Logs when late diagnostics land so #2 is observable.
 */
function makeDeferred(label: string) {
	const controller = new AbortController();
	const lateAt = { t: 0 };
	const startedAt = Bun.nanoseconds();
	return {
		handle: {
			onDeferredDiagnostics: (_d: unknown) => {
				lateAt.t = (Bun.nanoseconds() - startedAt) / 1e6;
				console.log(`      └─ ${label}: late diagnostics injected at +${lateAt.t.toFixed(0)} ms`);
			},
			signal: controller.signal,
			finalize: (_d: unknown) => {},
		},
		controller,
	};
}

await fs.writeFile(target, body(0));
try {
	console.log("\n--- writethroughNoop (LSP off — default edit path) ---");
	for (let i = 1; i <= 3; i++) {
		await timeCall(`noop write #${i}`, () => writethroughNoop(target, body(i), undefined, Bun.file(target)));
	}

	console.log("\n--- diagnostics, NO deferred channel (blocks until settle/timeout) ---");
	const wtDiag = createLspWritethrough(REPO, { enableDiagnostics: true, enableFormat: false });
	for (let i = 10; i <= 14; i++) {
		const label = i === 10 ? "write #1 (COLD: spawn+warm)" : `write #${i - 9} (warm)`;
		await timeCall(label, () => wtDiag(target, body(i), undefined, Bun.file(target)));
	}

	console.log("\n--- diagnostics, WITH deferred channel (short inline wait, then late) ---");
	for (let i = 30; i <= 34; i++) {
		const { handle } = makeDeferred(`write #${i - 29}`);
		await timeCall(`write #${i - 29} (inline)`, () =>
			wtDiag(target, body(i), undefined, Bun.file(target), undefined, () => handle),
		);
	}
	// Give any in-flight late fetches a moment to land before teardown.
	await Bun.sleep(6000);

	console.log("\n--- format writethrough (formatOnWrite) ---");
	const wtFmt = createLspWritethrough(REPO, { enableDiagnostics: false, enableFormat: true });
	for (let i = 20; i <= 22; i++) {
		await timeCall(`write #${i - 19}`, () => wtFmt(target, body(i), undefined, Bun.file(target)));
	}
} finally {
	await fs.rm(target, { force: true });
}

console.log("\n(done)");
process.exit(0);
