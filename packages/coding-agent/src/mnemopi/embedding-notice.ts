import type { EmbeddingRequestFailure } from "@oh-my-pi/pi-mnemopi/core/runtime-options";
import { redactUrlForLog } from "../mcp/json-rpc";
import { memoryNoticeErrorText } from "../memory-backend/messages";
import { redactMemorySecrets } from "../memory-backend/redact";
import type { AgentSession } from "../session/agent-session";

/** `notice` source of Mnemopi embedding failures; print mode writes these to stderr. */
export const MNEMOPI_NOTICE_SOURCE = "Mnemopi";

/**
 * Turns failed embedding API requests into session warnings. Mnemopi answers a failed
 * request by recalling with keywords only, so a wrong key, model id, or request shape
 * would otherwise stay invisible. Warns once per endpoint, model, and status (or, without a
 * status, per error message), with URL credentials and secret-shaped tokens redacted.
 */
export function embeddingFailureNotifier(
	session: Pick<AgentSession, "emitNotice">,
): (failure: EmbeddingRequestFailure) => void {
	const reported = new Set<string>();
	return failure => {
		const key = `${failure.baseUrl}\n${failure.model}\n${failure.status ?? failure.message}`;
		if (reported.has(key)) return;
		reported.add(key);
		const status = failure.status === undefined ? "" : `HTTP ${failure.status} from `;
		// Every field can carry configured or provider text; print mode writes the notice straight to stderr.
		const baseUrl = memoryNoticeErrorText(redactUrlForLog(failure.baseUrl));
		const model = memoryNoticeErrorText(failure.model);
		const detail = memoryNoticeErrorText(redactMemorySecrets(failure.message)) || "no response body";
		session.emitNotice(
			"warning",
			`Memory embeddings failed (${status}${baseUrl}, model ${model}); recall falls back to keyword search: ${detail}`,
			MNEMOPI_NOTICE_SOURCE,
		);
	};
}
