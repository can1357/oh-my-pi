import { t as __ompTranslate } from "@oh-my-pi/pi-utils/i18n";
import type { TodoPhase } from "@oh-my-pi/pi-tui/tools/todo";
import {
	applyOpsToPhases,
	getLatestTodoPhasesFromEntries,
	markdownToPhases,
	phasesToMarkdown,
	resolveTodoMarkdownPath,
	USER_TODO_EDIT_CUSTOM_TYPE,
} from "../../tools/todo";
import type { ParsedSlashCommand, SlashCommandResult, SlashCommandRuntime } from "../types";
import { commandConsumed, errorMessage, parseSubcommand, usage } from "./parse";

type TodoMutationVerb = "done" | "drop" | "rm";

interface TodoTaskMatch {
	task: { content: string; status: string };
	phase: TodoPhase;
}

function tokenize(input: string): string[] {
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

function titleCaseWords(text: string): string {
	return text
		.split(/\s+/)
		.filter(Boolean)
		.map(word => word[0].toUpperCase() + word.slice(1))
		.join(" ");
}

function titleCaseSentence(text: string): string {
	const trimmed = text.trim();
	if (!trimmed) return trimmed;
	return trimmed[0].toUpperCase() + trimmed.slice(1);
}

function findPhaseFuzzy(phases: TodoPhase[], query: string): TodoPhase | undefined {
	const normalizedQuery = query.trim().toLowerCase();
	if (!normalizedQuery) return undefined;
	const exact = phases.find(phase => phase.name.toLowerCase() === normalizedQuery);
	if (exact) return exact;
	const prefixMatches = phases.filter(phase => phase.name.toLowerCase().startsWith(normalizedQuery));
	if (prefixMatches.length === 1) return prefixMatches[0];
	const substringMatches = phases.filter(phase => phase.name.toLowerCase().includes(normalizedQuery));
	if (substringMatches.length === 1) return substringMatches[0];
	return undefined;
}

function findTaskFuzzy(phases: TodoPhase[], query: string): TodoTaskMatch | undefined {
	const normalizedQuery = query.trim().toLowerCase();
	if (!normalizedQuery) return undefined;
	for (const phase of phases) {
		for (const task of phase.tasks) {
			if (task.content.toLowerCase() === normalizedQuery) return { task, phase };
		}
	}
	const matches: TodoTaskMatch[] = [];
	for (const phase of phases) {
		for (const task of phase.tasks) {
			if (task.content.toLowerCase().includes(normalizedQuery)) matches.push({ task, phase });
		}
	}
	if (matches.length === 1) return matches[0];
	const active = matches.filter(match => match.task.status === "in_progress" || match.task.status === "pending");
	if (active.length === 1) return active[0];
	return undefined;
}

function currentPhases(runtime: SlashCommandRuntime): TodoPhase[] {
	const fromEntries = getLatestTodoPhasesFromEntries(runtime.sessionManager.getBranch());
	return fromEntries.length > 0 ? fromEntries : runtime.session.getTodoPhases();
}

function commitTodos(runtime: SlashCommandRuntime, phases: TodoPhase[]): void {
	runtime.session.setTodoPhases(phases);
	runtime.sessionManager.appendCustomEntry(USER_TODO_EDIT_CUSTOM_TYPE, { phases });
}

const TODO_HELP_TEXT = [
	__ompTranslate("Usage: /todo <verb> [args]"),
	__ompTranslate("  /todo                              Show current todos"),
	__ompTranslate("  /todo edit                         (TUI only) open in $EDITOR"),
	__ompTranslate("  /todo copy                         Print todos as Markdown"),
	__ompTranslate("  /todo expand                       (TUI only) expand the sticky HUD"),
	__ompTranslate("  /todo collapse                     (TUI only) collapse the sticky HUD"),
	__ompTranslate("  /todo export [<path>]              Write todos to file (default: TODO.md)"),
	__ompTranslate("  /todo import [<path>]              Replace todos from file (default: TODO.md)\u0004todo.help"),
	__ompTranslate("  /todo append [<phase>] <task...>   Append a task"),
	__ompTranslate("  /todo start  <task>                Mark task in_progress (fuzzy match)"),
	__ompTranslate("  /todo done   [<task|phase>]        Mark task/phase/all completed"),
	__ompTranslate("  /todo drop   [<task|phase>]        Mark task/phase/all abandoned"),
	__ompTranslate("  /todo rm     [<task|phase>]        Remove task/phase/all\u0004todo.help"),
].join("\n");

async function handleTodoCopyCommand(runtime: SlashCommandRuntime): Promise<SlashCommandResult> {
	const phases = currentPhases(runtime);
	const markdown = phases.length === 0 ? "" : phasesToMarkdown(phases).trimEnd();
	await runtime.output(
		__ompTranslate(
			"Copy not available in ACP mode; printing instead:\n\n{0}",
			`${markdown || __ompTranslate("No todos.")}`,
		),
	);
	return commandConsumed();
}

async function handleTodoExportCommand(restArgs: string, runtime: SlashCommandRuntime): Promise<SlashCommandResult> {
	const phases = currentPhases(runtime);
	if (phases.length === 0) {
		await runtime.output(__ompTranslate("No todos to export."));
		return commandConsumed();
	}
	let target: string;
	try {
		target = resolveTodoMarkdownPath(restArgs, runtime.sessionManager.getCwd());
		await Bun.write(target, phasesToMarkdown(phases));
	} catch (err) {
		return usage(
			__ompTranslate("Failed to write todos: {0}\u0004todo.export.status", `${errorMessage(err)}`),
			runtime,
		);
	}
	await runtime.output(__ompTranslate("Wrote todos to {0}\u0004todo.export.status", `${target}`));
	return commandConsumed();
}

async function handleTodoImportCommand(restArgs: string, runtime: SlashCommandRuntime): Promise<SlashCommandResult> {
	let target: string;
	let content: string;
	try {
		target = resolveTodoMarkdownPath(restArgs, runtime.sessionManager.getCwd());
		content = await Bun.file(target).text();
	} catch (err) {
		return usage(
			__ompTranslate("Failed to read todos: {0}\u0004todo.import.status", `${errorMessage(err)}`),
			runtime,
		);
	}
	const { phases, errors } = markdownToPhases(content);
	if (errors.length > 0)
		return usage(
			__ompTranslate("Could not parse {0}:\n  {1}\u0004todo.import.status", `${target}`, `${errors.join("\n  ")}`),
			runtime,
		);
	commitTodos(runtime, phases);
	const taskCount = phases.reduce((sum, phase) => sum + phase.tasks.length, 0);
	await runtime.output(`Imported ${phases.length} phase(s), ${taskCount} task(s) from ${target}.`);
	return commandConsumed();
}

async function handleTodoAppendCommand(restArgs: string, runtime: SlashCommandRuntime): Promise<SlashCommandResult> {
	const tokens = tokenize(restArgs);
	if (tokens.length === 0) return usage(__ompTranslate("Usage: /todo append [<phase>] <task...>"), runtime);

	const current = currentPhases(runtime);
	const phaseName = tokens.length === 1 ? undefined : tokens[0];
	const content = tokens.length === 1 ? tokens[0]! : tokens.slice(1).join(" ");
	const next = current.map(phase => ({ ...phase, tasks: phase.tasks.slice() }));
	let targetPhase: TodoPhase;

	if (phaseName) {
		const existing = findPhaseFuzzy(next, phaseName);
		targetPhase = existing ?? { name: titleCaseWords(phaseName), tasks: [] };
		if (!existing) next.push(targetPhase);
	} else if (next.length > 0) {
		targetPhase = next[next.length - 1]!;
	} else {
		targetPhase = { name: "Todos", tasks: [] };
		next.push(targetPhase);
	}

	const finalContent = titleCaseSentence(content);
	targetPhase.tasks.push({ content: finalContent, status: "pending" });
	commitTodos(runtime, next);
	await runtime.output(__ompTranslate("Appended to {0}: {1}", `${targetPhase.name}`, `${finalContent}`));
	return commandConsumed();
}

async function handleTodoStartCommand(restArgs: string, runtime: SlashCommandRuntime): Promise<SlashCommandResult> {
	if (!restArgs) return usage(__ompTranslate("Usage: /todo start <task>"), runtime);
	const current = currentPhases(runtime);
	const query = tokenize(restArgs).join(" ") || restArgs;
	const hit = findTaskFuzzy(current, query);
	if (!hit)
		return usage(
			__ompTranslate(
				'No task matched "{0}". Use /todo to list current tasks.\u0004todo.start.not-found',
				`${restArgs}`,
			),
			runtime,
		);
	const { phases } = applyOpsToPhases(current, [{ op: "start", task: hit.task.content }]);
	commitTodos(runtime, phases);
	await runtime.output(__ompTranslate("Started: {0}", `${hit.task.content}`));
	return commandConsumed();
}

async function handleTodoMutationCommand(
	verb: TodoMutationVerb,
	restArgs: string,
	runtime: SlashCommandRuntime,
): Promise<SlashCommandResult> {
	const current = currentPhases(runtime);
	const trimmedArg = restArgs.trim();
	if (!trimmedArg) {
		if (verb === "rm") {
			commitTodos(runtime, []);
			await runtime.output(__ompTranslate("Cleared all todos."));
			return commandConsumed();
		}
		const { phases } = applyOpsToPhases(current, [{ op: verb }]);
		commitTodos(runtime, phases);
		await runtime.output(
			verb === "done"
				? __ompTranslate("Marked all tasks completed.")
				: __ompTranslate("Marked all tasks abandoned."),
		);
		return commandConsumed();
	}

	const taskHit = findTaskFuzzy(current, trimmedArg);
	if (taskHit) {
		const { phases } = applyOpsToPhases(current, [{ op: verb, task: taskHit.task.content }]);
		commitTodos(runtime, phases);
		const label =
			verb === "done"
				? __ompTranslate("Marked completed")
				: verb === "drop"
					? __ompTranslate("Marked abandoned")
					: __ompTranslate("Removed");
		await runtime.output(`${label}: ${taskHit.task.content}`);
		return commandConsumed();
	}

	const phaseHit = findPhaseFuzzy(current, trimmedArg);
	if (phaseHit) {
		const { phases } = applyOpsToPhases(current, [{ op: verb, phase: phaseHit.name }]);
		commitTodos(runtime, phases);
		const message =
			verb === "done"
				? __ompTranslate("Marked phase {0} completed.", `${phaseHit.name}`)
				: verb === "drop"
					? __ompTranslate("Marked phase {0} abandoned.", `${phaseHit.name}`)
					: __ompTranslate("Removed phase: {0}\u0004todo.phase.removed", `${phaseHit.name}`);
		await runtime.output(message);
		return commandConsumed();
	}

	return usage(
		__ompTranslate('No task or phase matched "{0}".\u0004todo.mutation.not-found', `${trimmedArg}`),
		runtime,
	);
}

/** ACP/text-mode `/todo` handler. Shared by both dispatchers via the spec. */
export async function handleTodoAcp(
	command: ParsedSlashCommand,
	runtime: SlashCommandRuntime,
): Promise<SlashCommandResult> {
	const trimmed = command.args.trim();
	if (!trimmed) {
		const phases = currentPhases(runtime);
		await runtime.output(
			phases.length === 0
				? __ompTranslate("No todos. Use /todo append <task> to start one.")
				: phasesToMarkdown(phases).trimEnd(),
		);
		return commandConsumed();
	}

	const { verb, rest } = parseSubcommand(trimmed);
	switch (verb) {
		case "copy":
			return await handleTodoCopyCommand(runtime);
		case "export":
			return await handleTodoExportCommand(rest, runtime);
		case "import":
			return await handleTodoImportCommand(rest, runtime);
		case "append":
			return await handleTodoAppendCommand(rest, runtime);
		case "start":
			return await handleTodoStartCommand(rest, runtime);
		case "done":
		case "drop":
		case "rm":
			return await handleTodoMutationCommand(verb, rest, runtime);
		case "edit":
			return usage(
				"/todo edit requires the TUI editor; use /todo export then /todo import for non-interactive edits.",
				runtime,
			);
		case "expand":
		case "collapse":
			return usage(
				__ompTranslate("/todo {0} controls the interactive HUD and is unavailable in this mode.", `${verb}`),
				runtime,
			);
		case "help":
		case "?":
			await runtime.output(TODO_HELP_TEXT);
			return commandConsumed();
		default:
			return usage(
				__ompTranslate("Unknown /todo subcommand. Use append, start, done, drop, rm, copy, export, import."),
				runtime,
			);
	}
}
