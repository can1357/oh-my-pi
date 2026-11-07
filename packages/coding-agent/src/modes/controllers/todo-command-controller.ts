import * as fs from "node:fs/promises";
import { applyOpsToPhases, markdownToPhases, phasesToMarkdown, resolveTodoMarkdownPath } from "../../tools/todo";
import { type TodoItem, type TodoPhase } from "@oh-my-pi/pi-tui/tools/todo";
import { copyToClipboard } from "../../utils/clipboard";
import { getEditorCommand, openInEditor } from "../../utils/external-editor";
import type { InteractiveModeContext } from "../types";
import { commitTodoEdit } from "../../slash-commands/helpers/todo";

const USAGE = [
	"Usage: /todo <verb> [args]",
	"  /todo                              Show current todos",
	"  /todo edit                         Open todos in $EDITOR",
	"  /todo copy                         Copy todos as Markdown to clipboard",
	"  /todo expand                       Show every phase and task in the HUD",
	"  /todo collapse                     Restore the bounded HUD preview",
	"  /todo export [<path>]              Write todos to file (default: TODO.md)",
	"  /todo import [<path>]              Replace todos from file (default: TODO.md)",
	"  /todo append [<phase>] <task...>   Append a task; phase fuzzy-matched or auto-created",
	"  /todo start  <task>                Mark task in_progress (fuzzy content match)",
	"  /todo done   [<task|phase>]        Mark task/phase/all completed",
	"  /todo drop   [<task|phase>]        Mark task/phase/all abandoned",
	"  /todo rm     [<task|phase>]        Remove task/phase/all",
].join("\n");

// =============================================================================
// Argument tokenizer (respects double-quoted strings)
// =============================================================================

function tokenize(input: string): string[] {
	const tokens: string[] = [];
	let cur = "";
	let inQuote = false;
	for (let i = 0; i < input.length; i++) {
		const ch = input[i];
		if (ch === "\\" && i + 1 < input.length) {
			cur += input[++i];
			continue;
		}
		if (ch === '"') {
			inQuote = !inQuote;
			continue;
		}
		if (!inQuote && /\s/.test(ch)) {
			if (cur) {
				tokens.push(cur);
				cur = "";
			}
			continue;
		}
		cur += ch;
	}
	if (cur) tokens.push(cur);
	return tokens;
}

// =============================================================================
// Name normalization
// =============================================================================

function titleCase(s: string): string {
	return s
		.split(/\s+/)
		.filter(Boolean)
		.map(word => word[0].toUpperCase() + word.slice(1))
		.join(" ");
}

// =============================================================================
// Fuzzy matching
// =============================================================================

function findPhaseFuzzy(phases: TodoPhase[], query: string): TodoPhase | undefined {
	const q = query.trim().toLowerCase();
	if (!q) return undefined;
	// Exact name (case-insensitive)
	const byName = phases.find(p => p.name.toLowerCase() === q);
	if (byName) return byName;
	// Substring (prefer prefix match)
	const prefixMatches = phases.filter(p => p.name.toLowerCase().startsWith(q));
	if (prefixMatches.length === 1) return prefixMatches[0];
	const subMatches = phases.filter(p => p.name.toLowerCase().includes(q));
	if (subMatches.length === 1) return subMatches[0];
	return undefined;
}

function findTaskFuzzy(phases: TodoPhase[], query: string): { task: TodoItem; phase: TodoPhase } | undefined {
	const q = query.trim().toLowerCase();
	if (!q) return undefined;
	// Exact content (case-insensitive)
	for (const phase of phases) {
		for (const task of phase.tasks) {
			if (task.content.toLowerCase() === q) return { task, phase };
		}
	}
	const matches: Array<{ task: TodoItem; phase: TodoPhase }> = [];
	for (const phase of phases) {
		for (const task of phase.tasks) {
			if (task.content.toLowerCase().includes(q)) {
				matches.push({ task, phase });
			}
		}
	}
	if (matches.length === 1) return matches[0];
	// Prefer single in_progress/pending hit when ambiguous
	const active = matches.filter(m => m.task.status === "in_progress" || m.task.status === "pending");
	if (active.length === 1) return active[0];
	return undefined;
}

// =============================================================================
// Build system reminder
// =============================================================================

function buildSystemReminder(action: string, phases: TodoPhase[], removed = false): string {
	const md = phases.length === 0 ? "(empty)" : phasesToMarkdown(phases).trimEnd();
	const lines = ["<system-reminder>", `The user manually modified the todo list (${action}).`];
	if (removed) {
		lines.push(
			phases.length === 0
				? "The user intentionally cleared the todo list. Do NOT recreate or re-populate it unless the user explicitly asks; continue the current request without a todo list."
				: "The user intentionally removed the entries no longer shown below. Do NOT re-add them unless the user explicitly asks.",
		);
	}
	lines.push("Current todo list:", "", md, "</system-reminder>");
	return lines.join("\n");
}

type TodoPlan = { phases: TodoPhase[]; action: string; status: string; removed?: boolean } | { error: string };

export class TodoCommandController {
	constructor(private readonly ctx: InteractiveModeContext) {}

	async handleTodoCommand(args: string): Promise<void> {
		const trimmed = args.trim();
		if (!trimmed) {
			this.#showCurrent();
			return;
		}

		const spaceIdx = trimmed.search(/\s/);
		const verb = (spaceIdx === -1 ? trimmed : trimmed.slice(0, spaceIdx)).toLowerCase();
		const rest = spaceIdx === -1 ? "" : trimmed.slice(spaceIdx + 1).trim();

		switch (verb) {
			case "expand":
				this.ctx.setTodoExpanded(true);
				return;
			case "collapse":
				if (this.ctx.todoExpanded) this.ctx.toggleTodoExpansion();
				return;
			case "edit":
				await this.#editInExternalEditor();
				return;
			case "copy":
				this.#copyMarkdown();
				return;
			case "export":
				await this.#exportToFile(rest);
				return;
			case "import":
				await this.#importFromFile(rest);
				return;
			case "help":
			case "?":
				this.ctx.showStatus(USAGE);
				return;
			case "append":
				await this.#edit(current => this.#append(rest, current));
				return;
			case "start":
				await this.#edit(current => this.#start(rest, current));
				return;
			case "done":
				await this.#edit(current => this.#mutateStatus(rest, "completed", current));
				return;
			case "drop":
				await this.#edit(current => this.#mutateStatus(rest, "abandoned", current));
				return;
			case "rm":
				await this.#edit(current => this.#remove(rest, current));
				return;
			default:
				this.ctx.showError(`Unknown /todo verb "${verb}".\n${USAGE}`);
		}
	}

	#showCurrent(): void {
		const phases = this.ctx.session.getTodoPhases();
		if (phases.length === 0) {
			this.ctx.showStatus("No todos. Use /todo append <task> to start one.");
			return;
		}
		this.ctx.showStatus(phasesToMarkdown(phases).trimEnd());
	}

	#copyMarkdown(): void {
		const phases = this.ctx.session.getTodoPhases();
		if (phases.length === 0) {
			this.ctx.showWarning("No todos to copy.");
			return;
		}
		try {
			copyToClipboard(phasesToMarkdown(phases));
			this.ctx.showStatus("Copied todos as Markdown to clipboard.");
		} catch (error) {
			this.ctx.showError(error instanceof Error ? error.message : String(error));
		}
	}

	#resolveTodoPath(rest: string): string {
		return resolveTodoMarkdownPath(rest, this.ctx.sessionManager.getCwd());
	}

	async #exportToFile(rest: string): Promise<void> {
		const phases = this.ctx.session.getTodoPhases();
		if (phases.length === 0) {
			this.ctx.showWarning("No todos to export.");
			return;
		}
		try {
			const target = this.#resolveTodoPath(rest);
			await fs.writeFile(target, phasesToMarkdown(phases), "utf8");
			this.ctx.showStatus(`Wrote todos to ${target}`);
		} catch (error) {
			this.ctx.showError(`Failed to write todos: ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	async #importFromFile(rest: string): Promise<void> {
		let source = "";
		let content: string;
		try {
			source = this.#resolveTodoPath(rest);
			content = await fs.readFile(source, "utf8");
		} catch (error) {
			this.ctx.showError(`Failed to read todos: ${error instanceof Error ? error.message : String(error)}`);
			return;
		}
		const { phases, errors } = markdownToPhases(content);
		if (errors.length > 0) {
			this.ctx.showError(`Could not parse ${source}:\n  ${errors.join("\n  ")}`);
			return;
		}
		const taskCount = phases.reduce((sum, p) => sum + p.tasks.length, 0);
		await this.#edit(() => ({
			phases,
			action: `/todo import ${source}`,
			status: `Imported ${phases.length} phase(s), ${taskCount} task(s) from ${source}.`,
		}));
	}

	// ------------------------------------------------------------- append

	#append(rest: string, current: TodoPhase[]): TodoPlan {
		const tokens = tokenize(rest);
		if (tokens.length === 0) {
			return { error: "Usage: /todo append [<phase>] <task...>" };
		}

		let phaseName: string | undefined;
		let content: string;

		if (tokens.length === 1) {
			content = tokens[0];
		} else {
			phaseName = tokens[0];
			content = tokens.slice(1).join(" ");
		}

		const next = current.map(phase => ({ ...phase, tasks: phase.tasks.slice() }));
		let targetPhase: TodoPhase | undefined;

		if (phaseName) {
			targetPhase = findPhaseFuzzy(next, phaseName);
			if (!targetPhase) {
				targetPhase = { name: titleCase(phaseName), tasks: [] };
				next.push(targetPhase);
			}
		} else if (next.length > 0) {
			targetPhase = next[next.length - 1];
		} else {
			targetPhase = { name: "Todos", tasks: [] };
			next.push(targetPhase);
		}

		const finalContent = titleCaseSentence(content);
		targetPhase.tasks.push({
			content: finalContent,
			status: "pending",
		});

		return {
			phases: next,
			action: `/todo append → ${targetPhase.name}`,
			status: `Appended to ${targetPhase.name}: ${finalContent}`,
		};
	}

	// ------------------------------------------------------------- start / done / drop / rm

	#start(rest: string, current: TodoPhase[]): TodoPlan {
		if (!rest) {
			return { error: "Usage: /todo start <task>" };
		}
		const hit = findTaskFuzzy(current, rest);
		if (!hit) {
			return { error: `No task matched "${rest}". Use /todo to list current tasks.` };
		}
		const { phases, errors } = applyOpsToPhases(current, [{ op: "start", task: hit.task.content }]);
		if (errors.length > 0) {
			return { error: errors.join("; ") };
		}
		return { phases, action: `/todo start ${hit.task.content}`, status: `Started: ${hit.task.content}` };
	}

	#mutateStatus(rest: string, target: "completed" | "abandoned", current: TodoPhase[]): TodoPlan {
		const op = target === "completed" ? "done" : "drop";
		const trimmed = rest.trim();
		if (!trimmed) {
			// no-arg: apply to all
			const { phases, errors } = applyOpsToPhases(current, [{ op }]);
			if (errors.length > 0) {
				return { error: errors.join("; ") };
			}
			return { phases, action: `/todo ${op} (all)`, status: `Marked all tasks ${target}.` };
		}

		const taskHit = findTaskFuzzy(current, trimmed);
		if (taskHit) {
			const { phases, errors } = applyOpsToPhases(current, [{ op, task: taskHit.task.content }]);
			if (errors.length > 0) {
				return { error: errors.join("; ") };
			}
			return {
				phases,
				action: `/todo ${op} ${taskHit.task.content}`,
				status: `Marked ${target}: ${taskHit.task.content}`,
			};
		}

		const phaseHit = findPhaseFuzzy(current, trimmed);
		if (phaseHit) {
			const { phases, errors } = applyOpsToPhases(current, [{ op, phase: phaseHit.name }]);
			if (errors.length > 0) {
				return { error: errors.join("; ") };
			}
			return { phases, action: `/todo ${op} ${phaseHit.name}`, status: `Marked phase ${phaseHit.name} ${target}.` };
		}

		return { error: `No task or phase matched "${trimmed}".` };
	}

	#remove(rest: string, current: TodoPhase[]): TodoPlan {
		const trimmed = rest.trim();
		if (!trimmed) {
			return { phases: [], action: "/todo rm (all)", removed: true, status: "Cleared all todos." };
		}
		const taskHit = findTaskFuzzy(current, trimmed);
		if (taskHit) {
			const { phases, errors } = applyOpsToPhases(current, [{ op: "rm", task: taskHit.task.content }]);
			if (errors.length > 0) {
				return { error: errors.join("; ") };
			}
			return {
				phases,
				action: `/todo rm ${taskHit.task.content}`,
				removed: true,
				status: `Removed: ${taskHit.task.content}`,
			};
		}
		const phaseHit = findPhaseFuzzy(current, trimmed);
		if (phaseHit) {
			const { phases, errors } = applyOpsToPhases(current, [{ op: "rm", phase: phaseHit.name }]);
			if (errors.length > 0) {
				return { error: errors.join("; ") };
			}
			return {
				phases,
				action: `/todo rm ${phaseHit.name}`,
				removed: true,
				status: `Removed phase: ${phaseHit.name}`,
			};
		}
		return { error: `No task or phase matched "${trimmed}".` };
	}

	// ------------------------------------------------------------- editor

	async #editInExternalEditor(): Promise<void> {
		const editorCmd = getEditorCommand();
		if (!editorCmd) {
			this.ctx.showWarning("No editor configured. Set $VISUAL or $EDITOR environment variable.");
			return;
		}

		const current = this.ctx.session.getTodoPhases();
		const initialMarkdown =
			current.length > 0 ? phasesToMarkdown(current) : "# Todos\n- [ ] (replace this with your tasks)\n";

		this.ctx.ui.stop();
		try {
			const result = await openInEditor(editorCmd, initialMarkdown, { extension: ".todo.md" });
			if (result === null) {
				this.ctx.showWarning("Editor exited without saving; todos unchanged.");
				return;
			}
			const { phases: parsed, errors } = markdownToPhases(result);
			if (errors.length > 0) {
				this.ctx.showError(`Could not parse Markdown:\n  ${errors.join("\n  ")}`);
				return;
			}
			const taskCount = parsed.reduce((sum, p) => sum + p.tasks.length, 0);
			await this.#edit(() => ({
				phases: parsed,
				action: "/todo edit",
				status: `Todos updated from editor: ${parsed.length} phase(s), ${taskCount} task(s).`,
			}));
		} catch (error) {
			this.ctx.showWarning(
				`Failed to open external editor: ${error instanceof Error ? error.message : String(error)}`,
			);
		} finally {
			this.ctx.ui.start();
			this.ctx.ui.requestRender();
		}
	}

	/** The user may focus another agent mid-commit, so the HUD only updates if the focused one is unchanged. */
	async #edit(compute: (current: TodoPhase[]) => TodoPlan): Promise<void> {
		const { viewSession } = this.ctx;
		// Commit first so HUD visibility binds to the new canonical source.
		const outcome = await commitTodoEdit(this.ctx.session, compute);
		if ("error" in outcome) {
			this.ctx.showError(outcome.error);
			return;
		}
		const { plan, committed } = outcome;
		// The HUD shows the focused agent's list; one focused mid-commit keeps it, and the main list returns on switching back.
		if (this.ctx.viewSession === viewSession) this.ctx.setTodos(committed);

		// Inject system reminder so the agent learns about the change next turn.
		// Removals carry explicit intent so the agent does not rebuild the
		// cleared/removed items on its next turn (issue #5258).
		const reminderText = buildSystemReminder(plan.action, committed, plan.removed ?? false);
		const message = {
			role: "developer" as const,
			content: [{ type: "text" as const, text: reminderText }],
			attribution: "user" as const,
			timestamp: Date.now(),
		};
		this.ctx.agent.appendMessage(message);
		this.ctx.sessionManager.appendMessage(message);
		this.ctx.showStatus(plan.status);
	}
}

/** Capitalize first letter only — keeps acronyms / casing in the rest of the sentence intact. */
function titleCaseSentence(s: string): string {
	const trimmed = s.trim();
	if (!trimmed) return trimmed;
	return trimmed[0].toUpperCase() + trimmed.slice(1);
}
