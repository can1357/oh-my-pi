/**
 * Classify optional live-provider smoke results without hiding product failures.
 * The deterministic phase gate owns acceptance; live probing is only invalid
 * when the provider did not produce the requested tool call or raw input.
 */

export type LiveSmokeClassification = "OK" | "HARNESS_INVALID" | "REGRESSION";

export function classifyLiveSmoke(exitCode: number, verdict: string): LiveSmokeClassification {
	if (exitCode === 0 && verdict.includes("exact=True")) return "OK";
	if (verdict.includes("tool_mismatch=True") || verdict.includes("raw_input_mismatch=True")) {
		return "HARNESS_INVALID";
	}
	return "REGRESSION";
}

if (import.meta.main) {
	const [rawExitCode = "1", verdict = ""] = Bun.argv.slice(2);
	const exitCode = Number.parseInt(rawExitCode, 10);
	console.log(classifyLiveSmoke(Number.isFinite(exitCode) ? exitCode : 1, verdict));
}
