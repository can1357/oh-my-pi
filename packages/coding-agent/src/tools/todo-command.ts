import type { DeveloperMessage } from "@oh-my-pi/pi-ai";
import type { TodoItem, TodoPhase } from "./details/todo";
import { prompt } from "@oh-my-pi/pi-utils";
import todoUserEditReminder from "../prompts/system/todo-user-edit.md" with { type: "text" };
import { escapeHarnessTags } from "../session/harness-tags";
import { applyOpsToPhases, phasesToMarkdown } from "./todo";

export type TodoMutationVerb = "done" | "drop" | "rm";

export type TodoCommandOutcome = { ok: true; status: string } | { ok: false; error: string };

/** Where a manual `/todo` edit is saved and shown to the model. */
export interface TodoUserEditHost {
	commitTodoPhases(phases: TodoPhase[]): void;
	appendMessage(message: DeveloperMessage): void;
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
function nameForms(input: string): { forms: string[]; quoted: boolean } {
	const typed = input.trim();
	if (!typed) return { forms: [], quoted: false };
	const tokens = tokenize(typed);
	const forms = [typed];
	const singleQuoted = typed.startsWith('"') && typed.endsWith('"') && tokens.length === 1;
	const inner = singleQuoted ? typed.slice(1, -1) : "";
	if (inner) forms.push(inner);
	const decoded = tokens.join(" ");
	if (decoded && decoded !== typed && decoded !== inner) forms.push(decoded);
	return { forms, quoted: typed.includes('"') && forms.length > 1 };
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

function matchTask(phases: readonly TodoPhase[], input: string): TodoTaskHit | undefined {
	const { forms } = nameForms(input);
	for (const ignoreCase of [false, true]) {
		for (const form of forms) {
			const hit = exactTask(phases, form, ignoreCase);
			if (hit) return hit;
		}
	}
	return partialTaskAcross(phases, forms);
}

function matchTarget(phases: readonly TodoPhase[], input: string): { task?: TodoTaskHit; phase?: TodoPhase } {
	const { forms, quoted } = nameForms(input);
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
	// Unquoted: tasks win before phases, the rule /todo rm has always used.
	for (const ignoreCase of [false, true]) {
		for (const form of forms) {
			const task = exactTask(phases, form, ignoreCase);
			if (task) return { task };
		}
	}
	const task = partialTaskAcross(phases, forms);
	if (task) return { task };
	for (const ignoreCase of [false, true]) {
		for (const form of forms) {
			const phase = exactPhase(phases, form, ignoreCase);
			if (phase) return { phase };
		}
	}
	const phase = partialPhaseAcross(phases, forms);
	if (phase) return { phase };
	return {};
}

function reminderText(action: string, phases: TodoPhase[], removed: boolean): string {
	// Action and checklist embed user-named tasks/phases: a crafted name must not
	// close the reminder or forge a second harness block.
	const markdown = phases.length === 0 ? "(empty)" : phasesToMarkdown(phases).trimEnd();
	return prompt.render(todoUserEditReminder, {
		action: escapeHarnessTags(action),
		removed,
		cleared: phases.length === 0,
		markdown: escapeHarnessTags(markdown),
	});
}

/** Save a user edit and tell the model the user did it, including when items were removed. */
export function commitTodoUserEdit(host: TodoUserEditHost, phases: TodoPhase[], action: string, removed = false): void {
	host.commitTodoPhases(phases);
	host.setTodos?.(phases);
	host.appendMessage({
		role: "developer",
		content: [{ type: "text", text: reminderText(action, phases, removed) }],
		attribution: "user",
		timestamp: Date.now(),
	});
}

function commitApplied(
	host: TodoUserEditHost,
	applied: { phases: TodoPhase[]; errors: string[] },
	action: string,
	removed: boolean,
	status: string,
): TodoCommandOutcome {
	if (applied.errors.length > 0) return { ok: false, error: applied.errors.join("; ") };
	commitTodoUserEdit(host, applied.phases, action, removed);
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
		`/todo start ${hit.task.content}`,
		false,
		`Started: ${hit.task.content}`,
	);
}

/** `/todo done`, `/todo drop`, and `/todo rm`. A bare done/drop names every task; errors are not saved. */
export function applyTodoMutation(
	host: TodoUserEditHost,
	phases: TodoPhase[],
	verb: TodoMutationVerb,
	rest: string,
): TodoCommandOutcome {
	const query = rest.trim();
	if (!query) {
		if (verb === "rm") {
			commitTodoUserEdit(host, [], "/todo rm (all)", true);
			return { ok: true, status: "Cleared all todos." };
		}
		const all = phases.flatMap(phase => phase.tasks.map(task => task.content));
		const applied =
			all.length > 0 ? applyOpsToPhases(phases, [{ op: verb, task: all }]) : { phases, errors: [] as string[] };
		return commitApplied(
			host,
			applied,
			`/todo ${verb} (all)`,
			false,
			verb === "done" ? "Marked all tasks completed." : "Marked all tasks abandoned.",
		);
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
			`/todo ${verb} ${content}`,
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
			`/todo ${verb} ${name}`,
			verb === "rm",
			status,
		);
	}
	return { ok: false, error: `No task or phase matched "${query}".` };
}
