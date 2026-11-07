import type { FileDiagnosticsResult } from "@oh-my-pi/pi-tui/tools/lsp";
import type { ToolSession } from "../tools";
import { getToolConversationState } from "../tools/tool-state";
import { unreportedSummary } from "./diagnostics";
import { summarizeDiagnosticMessages } from "./utils";

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

		// The reduction drops the repeated findings, so the summary is recomputed:
		// a server that never reported for this file must stay named in it, or the
		// file reads as clean once its findings were deduplicated away (#15408).
		// With no fresh findings left the notice stands alone, as the pipeline and
		// the writethrough write it: "no issues" would be the false claim.
		const summarized = summarizeDiagnosticMessages(fresh);
		const unreported = result.unreported;
		return {
			...result,
			messages: fresh,
			errored: summarized.errored,
			summary:
				unreported && unreported.length > 0
					? unreportedSummary(unreported, fresh.length > 0 ? summarized.summary : undefined)
					: summarized.summary,
		};
	}
}

export function getDiagnosticsLedger(session: ToolSession): DiagnosticsLedger {
	const state = getToolConversationState(session);
	state.diagnosticsLedger ??= new DiagnosticsLedger();
	return state.diagnosticsLedger;
}
