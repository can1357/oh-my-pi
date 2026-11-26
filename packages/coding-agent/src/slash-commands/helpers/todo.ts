import { errorMessage } from "@oh-my-pi/pi-utils";
import type { TodoPhase } from "../../tools/details/todo";
import {
	getLatestTodoPhasesFromEntries,
	markdownToPhases,
	phasesToMarkdown,
	resolveTodoMarkdownPath,
} from "../../tools/todo";
import {
	applyTodoMutation,
	applyTodoStart,
	commitTodoUserEdit,
	findPhaseFuzzy,
	tokenize,
	type TodoCommandOutcome,
	type TodoMutationVerb,
	type TodoUserEditHost,
} from "../../tools/todo-command";
import type { ParsedSlashCommand, SlashCommandResult, SlashCommandRuntime } from "../types";
import { commandConsumed, parseSubcommand, usage } from "./parse";

export function titleCaseWords(text: string): string {
	return text
		.split(/\s+/)
		.filter(Boolean)
		.map(word => word[0].toUpperCase() + word.slice(1))
		.join(" ");
}

/** Capitalize first letter only — keeps acronyms / casing in the rest of the sentence intact. */
export function titleCaseSentence(text: string): string {
	const trimmed = text.trim();
	if (!trimmed) return trimmed;
	return trimmed[0].toUpperCase() + trimmed.slice(1);
}

function todoEditHost(runtime: SlashCommandRuntime): TodoUserEditHost {
	return {
		commitTodoPhases: phases => runtime.session.commitTodoPhases(phases),
		appendMessage: message => {
			runtime.session.agent.appendMessage(message);
			runtime.sessionManager.appendMessage(message);
		},
	};
}

function commitTodos(runtime: SlashCommandRuntime, phases: TodoPhase[], action: string): void {
	commitTodoUserEdit(todoEditHost(runtime), phases, action);
}

async function presentTodoOutcome(
	outcome: TodoCommandOutcome,
	runtime: SlashCommandRuntime,
): Promise<SlashCommandResult> {
	if (!outcome.ok) return usage(outcome.error, runtime);
	await runtime.output(outcome.status);
	return commandConsumed();
}

function currentPhases(runtime: SlashCommandRuntime): TodoPhase[] {
	const fromEntries = getLatestTodoPhasesFromEntries(runtime.sessionManager.getBranch());
	return fromEntries.length > 0 ? fromEntries : runtime.session.getTodoPhases();
}

const TODO_HELP_TEXT = [
	"Usage: /todo <verb> [args]",
	"  /todo                              Show current todos",
	"  /todo edit                         (TUI only) open in $EDITOR",
	"  /todo copy                         Print todos as Markdown",
	"  /todo expand                       (TUI only) expand the sticky HUD",
	"  /todo collapse                     (TUI only) collapse the sticky HUD",
	"  /todo export [<path>]              Write todos to file (default: TODO.md)",
	"  /todo import [<path>]              Replace todos from file (default: TODO.md)",
	"  /todo append [<phase>] <task...>   Append a task",
	"  /todo start  <task>                Mark task in_progress (fuzzy match)",
	"  /todo done   [<task|phase>]        Mark task/phase/all completed",
	"  /todo drop   [<task|phase>]        Mark task/phase/all abandoned",
	"  /todo rm     [<task|phase>]        Remove task/phase/all",
].join("\n");

async function handleTodoCopyCommand(runtime: SlashCommandRuntime): Promise<SlashCommandResult> {
	const phases = currentPhases(runtime);
	const markdown = phases.length === 0 ? "" : phasesToMarkdown(phases).trimEnd();
	await runtime.output(`Copy not available in ACP mode; printing instead:\n\n${markdown || "No todos."}`);
	return commandConsumed();
}

async function handleTodoExportCommand(restArgs: string, runtime: SlashCommandRuntime): Promise<SlashCommandResult> {
	const phases = currentPhases(runtime);
	if (phases.length === 0) {
		await runtime.output("No todos to export.");
		return commandConsumed();
	}
	let target: string;
	try {
		target = resolveTodoMarkdownPath(restArgs, runtime.sessionManager.getCwd());
		await Bun.write(target, phasesToMarkdown(phases));
	} catch (err) {
		return usage(`Failed to write todos: ${errorMessage(err)}`, runtime);
	}
	await runtime.output(`Wrote todos to ${target}`);
	return commandConsumed();
}

async function handleTodoImportCommand(restArgs: string, runtime: SlashCommandRuntime): Promise<SlashCommandResult> {
	let target: string;
	let content: string;
	try {
		target = resolveTodoMarkdownPath(restArgs, runtime.sessionManager.getCwd());
		content = await Bun.file(target).text();
	} catch (err) {
		return usage(`Failed to read todos: ${errorMessage(err)}`, runtime);
	}
	const { phases, errors } = markdownToPhases(content);
	if (errors.length > 0) return usage(`Could not parse ${target}:\n  ${errors.join("\n  ")}`, runtime);
	commitTodos(runtime, phases, `/todo import ${target}`);
	const taskCount = phases.reduce((sum, phase) => sum + phase.tasks.length, 0);
	await runtime.output(`Imported ${phases.length} phase(s), ${taskCount} task(s) from ${target}.`);
	return commandConsumed();
}

async function handleTodoAppendCommand(restArgs: string, runtime: SlashCommandRuntime): Promise<SlashCommandResult> {
	const tokens = tokenize(restArgs);
	if (tokens.length === 0) return usage("Usage: /todo append [<phase>] <task...>", runtime);

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
	commitTodos(runtime, next, `/todo append → ${targetPhase.name}`);
	await runtime.output(`Appended to ${targetPhase.name}: ${finalContent}`);
	return commandConsumed();
}

async function handleTodoStartCommand(restArgs: string, runtime: SlashCommandRuntime): Promise<SlashCommandResult> {
	return presentTodoOutcome(applyTodoStart(todoEditHost(runtime), currentPhases(runtime), restArgs), runtime);
}

async function handleTodoMutationCommand(
	verb: TodoMutationVerb,
	restArgs: string,
	runtime: SlashCommandRuntime,
): Promise<SlashCommandResult> {
	return presentTodoOutcome(applyTodoMutation(todoEditHost(runtime), currentPhases(runtime), verb, restArgs), runtime);
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
			phases.length === 0 ? "No todos. Use /todo append <task> to start one." : phasesToMarkdown(phases).trimEnd(),
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
			return usage(`/todo ${verb} controls the interactive HUD and is unavailable in this mode.`, runtime);
		case "help":
		case "?":
			await runtime.output(TODO_HELP_TEXT);
			return commandConsumed();
		default:
			return usage("Unknown /todo subcommand. Use append, start, done, drop, rm, copy, export, import.", runtime);
	}
}
