import type { RlmWorkerContext } from "./broker";
import { formatHandle, normalizeHandle } from "./store";
import type { RlmView } from "./view";

/** Serialize the provider-boundary payload (what the worker model sees). */
export function serializeWorkerProviderPayload(context: RlmWorkerContext): string {
	return context.messages.map(m => `[${m.role}]\n${m.content}`).join("\n\n");
}

/** Extract normalized handle ids referenced as rlm://h/<id> in a payload. */
export function extractRlmHandleIds(payload: string): string[] {
	const ids = new Set<string>();
	const re = /rlm:\/\/h\/([^[\s\]/]+)/g;
	let match: RegExpExecArray | null;
	while ((match = re.exec(payload)) !== null) {
		ids.add(normalizeHandle(match[1]!));
	}
	return [...ids];
}

/**
 * True when a formatted handle id appears in worker payload.
 * Uses boundary rules so `rlm://h/2` does not match `rlm://h/21` or bare `2` in byte offsets.
 */
export function workerContextContainsHandle(context: RlmWorkerContext, handleId: string): boolean {
	const id = normalizeHandle(handleId);
	if (!id) return false;
	const formatted = formatHandle(id);
	const escaped = formatted.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	const re = new RegExp(`${escaped}(?=\\[|$|[^0-9a-zA-Z_/-])`);
	const payload = serializeWorkerProviderPayload(context);
	return re.test(payload);
}

export interface WorkerMembraneViolation {
	kind: "ungranted_handle" | "forbidden_needle";
	detail: string;
}

export interface WorkerMembraneValidation {
	ok: boolean;
	violations: WorkerMembraneViolation[];
	allowedHandleIds: string[];
	referencedHandleIds: string[];
	payload: string;
}

/** Deterministic membrane check: worker payload may only cite handles present in the view. */
export function validateWorkerMembrane(
	context: RlmWorkerContext,
	view: RlmView,
	options?: { forbiddenNeedles?: readonly string[] },
): WorkerMembraneValidation {
	const allowedHandleIds = [...new Set(view.grants.map(g => normalizeHandle(g.handle)))];
	const allowed = new Set(allowedHandleIds);
	const payload = serializeWorkerProviderPayload(context);
	const referencedHandleIds = extractRlmHandleIds(payload);
	const violations: WorkerMembraneViolation[] = [];

	for (const handleId of referencedHandleIds) {
		if (!allowed.has(handleId)) {
			violations.push({
				kind: "ungranted_handle",
				detail: `ungranted handle in worker payload: ${formatHandle(handleId)}`,
			});
		}
	}

	for (const needle of options?.forbiddenNeedles ?? []) {
		if (!needle) continue;
		if (payload.includes(needle)) {
			violations.push({ kind: "forbidden_needle", detail: `forbidden content in worker payload: ${needle}` });
		}
	}

	return {
		ok: violations.length === 0,
		violations,
		allowedHandleIds,
		referencedHandleIds,
		payload,
	};
}

export function assertWorkerMembrane(
	context: RlmWorkerContext,
	view: RlmView,
	options?: { forbiddenNeedles?: readonly string[] },
): WorkerMembraneValidation {
	const result = validateWorkerMembrane(context, view, options);
	if (!result.ok) {
		const msg = result.violations.map(v => v.detail).join("; ");
		throw new Error(`rlm worker membrane violation: ${msg}`);
	}
	return result;
}
