/**
 * TTSR regex-sandbox child, entered through the hidden `__omp_worker_ttsr_regex`
 * selector. Reads one JSON request on stdin (`{ text, conditions: [{ source,
 * flags }] }`) and tests each condition against the text in order. Every line it
 * writes reaches the parent synchronously, so a parent that kills it at the
 * deadline still knows which condition was running:
 *
 *   S<i>                      condition i started
 *   R<i>:<start>:<len>:<0|1>  condition i finished (match start and length, or -1:0:0)
 *
 * Keep the imports minimal: the child's startup is paid once per sandboxed check.
 */
import * as fs from "node:fs";

interface SandboxRequest {
	text: string;
	conditions: Array<{ source: string; flags: string }>;
}

export function runTtsrRegexWorker(): void {
	const request = JSON.parse(fs.readFileSync(0, "utf8")) as SandboxRequest;
	for (const [index, { source, flags }] of request.conditions.entries()) {
		fs.writeSync(1, `S${index}\n`);
		const match = new RegExp(source, flags).exec(request.text);
		fs.writeSync(1, `R${index}:${match ? `${match.index}:${match[0].length}:1` : "-1:0:0"}\n`);
	}
}
