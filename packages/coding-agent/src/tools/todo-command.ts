import type { DeveloperMessage } from "@oh-my-pi/pi-ai";
import { prompt } from "@oh-my-pi/pi-utils";
import todoUserEditData from "../prompts/system/todo-user-edit-data.md" with { type: "text" };
import todoUserEditReminder from "../prompts/system/todo-user-edit.md" with { type: "text" };
import { escapeHarnessTags } from "../session/harness-tags";
import { type CustomMessage, TODO_USER_EDIT_DATA_MESSAGE_TYPE } from "../session/transcript/messages";
import type { TodoItem, TodoPhase, TodoStatus } from "./details/todo";
import { applyOpsToPhases, phasesToMarkdown } from "./todo";

export type TodoMutationVerb = "done" | "drop" | "rm";
export type TodoUserEditVerb = "import" | "edit" | "append" | "start" | TodoMutationVerb;
export type TodoUserEditMessage = DeveloperMessage | CustomMessage;

export type TodoCommandOutcome = { ok: true; status: string } | { ok: false; error: string };

/** Where a manual `/todo` edit is saved and shown to the model. */
export interface TodoUserEditHost {
	commitTodoPhases(phases: TodoPhase[]): void;
	appendMessage(message: TodoUserEditMessage): void;
	/** TUI HUD refresh. ACP and RPC have no local mirror. */
	setTodos?(phases: TodoPhase[]): void;
}
interface TodoTaskHit {
	task: TodoItem;
	phase: TodoPhase;
}

/** /todo argument reader: double quotes group words, backslash escapes the next char. */
export function tokenize(input: string): string[] {
	const tokens: string[] = [];
	let current = "";
	let inQuote = false;
	for (let index = 0; index < input.length; index++) {
		const ch = input[index];
		if (ch === "\\" && index + 1 < input.length) {
			current += input[++index];
			continue;
		}
		if (ch === '"') {
			inQuote = !inQuote;
			continue;
		}
		if (!inQuote && /\s/.test(ch)) {
			if (current) {
				tokens.push(current);
				current = "";
			}
			continue;
		}
		current += ch;
	}
	if (current) tokens.push(current);
	return tokens;
}

/**
 * Candidate spellings for a /todo name argument, most literal first:
 * - the argument exactly as typed (quotes and escapes included)
 * - the text inside a single wrapping pair of quotes, verbatim — so backslashes
 *   a user quoted literally still reach a task that contains them
 * - the tokenized form (quotes grouped, escapes decoded, whitespace collapsed)
 */
function nameForms(input: string): { typed: string; forms: string[]; quoted: boolean } {
	const typed = input.trim();
	if (!typed) return { typed: "", forms: [], quoted: false };
	const tokens = tokenize(typed);
	const forms = [typed];
	const singleQuoted = typed.startsWith('"') && typed.endsWith('"') && tokens.length === 1;
	const inner = singleQuoted ? typed.slice(1, -1) : "";
	if (inner) forms.push(inner);
	const decoded = tokens.join(" ");
	if (decoded && decoded !== typed && decoded !== inner) forms.push(decoded);
	return { typed, forms, quoted: typed.includes('"') && forms.length > 1 };
}

function exactTask(phases: readonly TodoPhase[], query: string, ignoreCase = false): TodoTaskHit | undefined {
	const normalized = ignoreCase ? query.trim().toLowerCase() : query.trim();
	if (!normalized) return undefined;
	for (const phase of phases) {
		for (const task of phase.tasks) {
			const content = ignoreCase ? task.content.toLowerCase() : task.content;
			if (content === normalized) return { task, phase };
		}
	}
	return undefined;
}

function exactPhase(phases: readonly TodoPhase[], query: string, ignoreCase = false): TodoPhase | undefined {
	const normalized = ignoreCase ? query.trim().toLowerCase() : query.trim();
	if (!normalized) return undefined;
	return phases.find(phase => (ignoreCase ? phase.name.toLowerCase() : phase.name) === normalized);
}

function partialTask(phases: readonly TodoPhase[], query: string): TodoTaskHit | undefined {
	const normalized = query.trim().toLowerCase();
	if (!normalized) return undefined;
	const matches: TodoTaskHit[] = [];
	for (const phase of phases) {
		for (const task of phase.tasks) {
			if (task.content.toLowerCase().includes(normalized)) matches.push({ task, phase });
		}
	}
	if (matches.length === 1) return matches[0];
	const active = matches.filter(match => match.task.status === "in_progress" || match.task.status === "pending");
	if (active.length === 1) return active[0];
	return undefined;
}

function partialPhase(phases: readonly TodoPhase[], query: string): TodoPhase | undefined {
	const normalized = query.trim().toLowerCase();
	if (!normalized) return undefined;
	const prefixMatches = phases.filter(phase => phase.name.toLowerCase().startsWith(normalized));
	if (prefixMatches.length === 1) return prefixMatches[0];
	const substringMatches = phases.filter(phase => phase.name.toLowerCase().includes(normalized));
	if (substringMatches.length === 1) return substringMatches[0];
	return undefined;
}

export function findPhaseFuzzy(phases: readonly TodoPhase[], query: string): TodoPhase | undefined {
	return exactPhase(phases, query) ?? exactPhase(phases, query, true) ?? partialPhase(phases, query);
}

function partialTaskAcross(phases: readonly TodoPhase[], forms: readonly string[]): TodoTaskHit | undefined {
	for (const form of [...forms.slice(1), forms[0]]) {
		if (!form) continue;
		const hit = partialTask(phases, form);
		if (hit) return hit;
	}
	return undefined;
}

function partialPhaseAcross(phases: readonly TodoPhase[], forms: readonly string[]): TodoPhase | undefined {
	for (const form of [...forms.slice(1), forms[0]]) {
		if (!form) continue;
		const phase = partialPhase(phases, form);
		if (phase) return phase;
	}
	return undefined;
}

function matchTaskLiteral(phases: readonly TodoPhase[], query: string): TodoTaskHit | undefined {
	return exactTask(phases, query) ?? exactTask(phases, query, true) ?? partialTask(phases, query);
}

function matchExactTaskAcross(phases: readonly TodoPhase[], forms: readonly string[]): TodoTaskHit | undefined {
	for (const ignoreCase of [false, true]) {
		for (const form of forms) {
			const hit = exactTask(phases, form, ignoreCase);
			if (hit) return hit;
		}
	}
	return undefined;
}

function matchExactPhaseAcross(phases: readonly TodoPhase[], forms: readonly string[]): TodoPhase | undefined {
	for (const ignoreCase of [false, true]) {
		for (const form of forms) {
			const phase = exactPhase(phases, form, ignoreCase);
			if (phase) return phase;
		}
	}
	return undefined;
}

function matchTask(phases: readonly TodoPhase[], input: string): TodoTaskHit | undefined {
	const { typed, forms, quoted } = nameForms(input);
	if (!typed) return undefined;
	if (quoted) {
		return matchExactTaskAcross(phases, forms) ?? partialTaskAcross(phases, forms);
	}
	const literal = matchTaskLiteral(phases, typed);
	if (literal) return literal;
	const fallbacks = forms.slice(1);
	if (fallbacks.length === 0) return undefined;
	return matchExactTaskAcross(phases, fallbacks) ?? partialTaskAcross(phases, fallbacks);
}

function matchTarget(phases: readonly TodoPhase[], input: string): { task?: TodoTaskHit; phase?: TodoPhase } {
	const { typed, forms, quoted } = nameForms(input);
	if (!typed) return {};
	if (quoted) {
		// Quoted name: every exact spelling before any loose match, so a phase
		// that merely contains the quoted text never shadows the task itself.
		for (const ignoreCase of [false, true]) {
			for (const form of forms) {
				const task = exactTask(phases, form, ignoreCase);
				if (task) return { task };
				const phase = exactPhase(phases, form, ignoreCase);
				if (phase) return { phase };
			}
		}
		const task = partialTaskAcross(phases, forms);
		if (task) return { task };
		const phase = partialPhaseAcross(phases, forms);
		if (phase) return { phase };
		return {};
	}
	// Unquoted: try the literal spelling first (tasks before phases, exact before
	// partial) so literal backslashes never lose to an escape-decoded collision.
	const literalTask = matchTaskLiteral(phases, typed);
	if (literalTask) return { task: literalTask };
	const literalPhase = findPhaseFuzzy(phases, typed);
	if (literalPhase) return { phase: literalPhase };
	const fallbacks = forms.slice(1);
	if (fallbacks.length === 0) return {};
	const decodedTask = matchExactTaskAcross(phases, fallbacks) ?? partialTaskAcross(phases, fallbacks);
	if (decodedTask) return { task: decodedTask };
	const decodedPhase = matchExactPhaseAcross(phases, fallbacks) ?? partialPhaseAcross(phases, fallbacks);
	if (decodedPhase) return { phase: decodedPhase };
	return {};
}

function noticeText(verb: TodoUserEditVerb, phases: TodoPhase[], removed: boolean, hasData: boolean): string {
	return prompt.render(todoUserEditReminder, {
		verb: `/todo ${verb}`,
		removed,
		cleared: phases.length === 0,
		hasData,
	});
}

function dataText(action: string, phases: TodoPhase[]): string {
	// Action and checklist embed user- or file-named tasks/phases: deliver at
	// user precedence and escape harness tags so they cannot forge a reminder.
	const markdown = phases.length === 0 ? "(empty)" : phasesToMarkdown(phases).trimEnd();
	return prompt.render(todoUserEditData, {
		action: escapeHarnessTags(action),
		markdown: escapeHarnessTags(markdown),
	});
}

/** Save a user edit and tell the model the user did it, including when items were removed. */
export function commitTodoUserEdit(
	host: TodoUserEditHost,
	phases: TodoPhase[],
	verb: TodoUserEditVerb,
	options?: { detail?: string; removed?: boolean },
): void {
	const removed = options?.removed ?? false;
	const detail = options?.detail;
	const hasData = phases.length > 0 || detail !== undefined;
	const timestamp = Date.now();
	host.commitTodoPhases(phases);
	host.setTodos?.(phases);
	host.appendMessage({
		role: "developer",
		content: noticeText(verb, phases, removed, hasData),
		attribution: "user",
		timestamp,
	});
	if (hasData) {
		const action = detail ? `/todo ${verb} ${detail}` : `/todo ${verb}`;
		host.appendMessage({
			role: "custom",
			customType: TODO_USER_EDIT_DATA_MESSAGE_TYPE,
			content: [{ type: "text", text: dataText(action, phases) }],
			display: false,
			attribution: "user",
			timestamp,
		});
	}
}

function commitApplied(
	host: TodoUserEditHost,
	applied: { phases: TodoPhase[]; errors: string[] },
	verb: TodoUserEditVerb,
	detail: string,
	removed: boolean,
	status: string,
): TodoCommandOutcome {
	if (applied.errors.length > 0) return { ok: false, error: applied.errors.join("; ") };
	commitTodoUserEdit(host, applied.phases, verb, { detail, removed });
	return { ok: true, status };
}

/** `/todo start`. Refuses a missing or ambiguous task and does not save a rejected update. */
export function applyTodoStart(host: TodoUserEditHost, phases: TodoPhase[], rest: string): TodoCommandOutcome {
	const query = rest.trim();
	if (!query) return { ok: false, error: "Usage: /todo start <task>" };
	const hit = matchTask(phases, query);
	if (!hit) return { ok: false, error: `No task matched "${query}". Use /todo to list current tasks.` };
	return commitApplied(
		host,
		applyOpsToPhases(phases, [{ op: "start", task: hit.task.content }]),
		"start",
		hit.task.content,
		false,
		`Started: ${hit.task.content}`,
	);
}

/** `/todo done`, `/todo drop`, and `/todo rm`. Bare done/drop updates every task directly; errors are not saved. */
export function applyTodoMutation(
	host: TodoUserEditHost,
	phases: TodoPhase[],
	verb: TodoMutationVerb,
	rest: string,
): TodoCommandOutcome {
	const query = rest.trim();
	if (!query) {
		if (verb === "rm") {
			commitTodoUserEdit(host, [], "rm", { removed: true });
			return { ok: true, status: "Cleared all todos." };
		}
		const status: TodoStatus = verb === "done" ? "completed" : "abandoned";
		const next = phases.map(phase => ({
			name: phase.name,
			tasks: phase.tasks.map(task => ({ ...task, status })),
		}));
		commitTodoUserEdit(host, next, verb, next.length > 0 ? { detail: "(all)" } : undefined);
		return { ok: true, status: verb === "done" ? "Marked all tasks completed." : "Marked all tasks abandoned." };
	}

	const target = matchTarget(phases, query);
	if (target.task) {
		const content = target.task.task.content;
		const status =
			verb === "done"
				? `Marked completed: ${content}`
				: verb === "drop"
					? `Marked abandoned: ${content}`
					: `Removed: ${content}`;
		return commitApplied(
			host,
			applyOpsToPhases(phases, [{ op: verb, task: content }]),
			verb,
			content,
			verb === "rm",
			status,
		);
	}
	if (target.phase) {
		const name = target.phase.name;
		const status =
			verb === "done"
				? `Marked phase ${name} completed.`
				: verb === "drop"
					? `Marked phase ${name} abandoned.`
					: `Removed phase: ${name}`;
		return commitApplied(
			host,
			applyOpsToPhases(phases, [{ op: verb, phase: name }]),
			verb,
			name,
			verb === "rm",
			status,
		);
	}
	return { ok: false, error: `No task or phase matched "${query}".` };
}
