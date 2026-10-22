import type { FileDiagnosticsResult } from "@oh-my-pi/pi-tui/tools/lsp";
import { composeDiagnosticsSummary, summarizeDiagnosticMessages } from "./utils";

const DIAGNOSTIC_LOCATION_PREFIX_RE = /^.*?:\d+:\d+\s+/;

export function diagnosticIdentity(message: string): string {
	return message.replace(DIAGNOSTIC_LOCATION_PREFIX_RE, "");
}

export class DiagnosticsLedger {
	readonly #seen = new Map<string, Set<string>>();

	reduce(absPath: string, result: FileDiagnosticsResult): FileDiagnosticsResult {
		const previous = this.#seen.get(absPath);
		const currentIdentities = new Set<string>();
		const fresh: string[] = [];

		for (const message of result.messages) {
			const identity = diagnosticIdentity(message);
			currentIdentities.add(identity);
			if (!previous?.has(identity)) {
				fresh.push(message);
			}
		}

		if (currentIdentities.size === 0) {
			this.#seen.delete(absPath);
		} else {
			this.#seen.set(absPath, currentIdentities);
		}

		if (fresh.length === result.messages.length) {
			return result;
		}

		const summarized = summarizeDiagnosticMessages(fresh);
		return {
			...result,
			messages: fresh,
			errored: summarized.errored,
			// The reduction drops the repeated findings, so the summary is
			// recomputed: re-compose the unavailable status with it. Otherwise a
			// file whose server published no verdict comes back as "no issues"
			// and reads as clean (issue #15408).
			summary: composeDiagnosticsSummary(summarized.summary, result.unjudgedServers ?? []),
		};
	}
}

export interface DiagnosticsLedgerOwner {
	diagnosticsLedger?: DiagnosticsLedger;
}

export function getDiagnosticsLedger(owner: DiagnosticsLedgerOwner): DiagnosticsLedger {
	owner.diagnosticsLedger ??= new DiagnosticsLedger();
	return owner.diagnosticsLedger;
}
