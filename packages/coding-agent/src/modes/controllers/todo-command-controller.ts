import * as fs from "node:fs/promises";
import {
	getLatestTodoPhasesFromEntries,
	markdownToPhases,
	phasesToMarkdown,
	resolveTodoMarkdownPath,
} from "../../tools/todo";
import type { TodoPhase } from "../../tools/details/todo";
import { titleCaseSentence, titleCaseWords } from "../../slash-commands/helpers/todo";
import {
	applyTodoMutation,
	applyTodoStart,
	commitTodoUserEdit,
	findPhaseFuzzy,
	tokenize,
	type TodoCommandOutcome,
	type TodoUserEditHost,
} from "../../tools/todo-command";
import { copyToClipboard } from "../../utils/clipboard";
import { getEditorCommand, openInEditor } from "../../utils/external-editor";
import type { InteractiveModeContext } from "../types";

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

export class TodoCommandController {
	constructor(private readonly ctx: InteractiveModeContext) {}

	/**
	 * True latest todo state for the user-facing /todo verbs. Reads from session
	 * entries or falls back to the active session state.
	 */
	#currentPhases(): TodoPhase[] {
		const fromEntries = getLatestTodoPhasesFromEntries(this.ctx.sessionManager.getBranch());
		if (fromEntries.length > 0) return fromEntries;
		return this.ctx.session.getTodoPhases();
	}

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
				this.#append(rest);
				return;
			case "start":
				this.#start(rest);
				return;
			case "done":
				this.#mutateStatus(rest, "completed");
				return;
			case "drop":
				this.#mutateStatus(rest, "abandoned");
				return;
			case "rm":
				this.#remove(rest);
				return;
			default:
				this.ctx.showError(`Unknown /todo verb "${verb}".\n${USAGE}`);
		}
	}

	#showCurrent(): void {
		const phases = this.#currentPhases();
		if (phases.length === 0) {
			this.ctx.showStatus("No todos. Use /todo append <task> to start one.");
			return;
		}
		this.ctx.showStatus(phasesToMarkdown(phases).trimEnd());
	}

	#copyMarkdown(): void {
		const phases = this.#currentPhases();
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
		const phases = this.#currentPhases();
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
		this.#commit(phases, `/todo import ${source}`);
		const taskCount = phases.reduce((sum, p) => sum + p.tasks.length, 0);
		this.ctx.showStatus(`Imported ${phases.length} phase(s), ${taskCount} task(s) from ${source}.`);
	}

	// ------------------------------------------------------------- append

	#append(rest: string): void {
		const tokens = tokenize(rest);
		if (tokens.length === 0) {
			this.ctx.showError("Usage: /todo append [<phase>] <task...>");
			return;
		}

		const current = this.#currentPhases();
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
				targetPhase = { name: titleCaseWords(phaseName), tasks: [] };
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

		this.#commit(next, `/todo append → ${targetPhase.name}`);
		this.ctx.showStatus(`Appended to ${targetPhase.name}: ${finalContent}`);
	}

	// ------------------------------------------------------------- start / done / drop / rm

	#start(rest: string): void {
		this.#show(applyTodoStart(this.#editHost(), this.#currentPhases(), rest));
	}

	#mutateStatus(rest: string, target: "completed" | "abandoned"): void {
		this.#show(
			applyTodoMutation(this.#editHost(), this.#currentPhases(), target === "completed" ? "done" : "drop", rest),
		);
	}

	#remove(rest: string): void {
		this.#show(applyTodoMutation(this.#editHost(), this.#currentPhases(), "rm", rest));
	}

	// ------------------------------------------------------------- editor

	async #editInExternalEditor(): Promise<void> {
		const editorCmd = getEditorCommand();
		if (!editorCmd) {
			this.ctx.showWarning("No editor configured. Set $VISUAL or $EDITOR environment variable.");
			return;
		}

		const current = this.#currentPhases();
		const initialMarkdown =
			current.length > 0 ? phasesToMarkdown(current) : "# Todos\n- [ ] (replace this with your tasks)\n";

		try {
			const result = await this.ctx.suspend(() =>
				openInEditor(editorCmd, initialMarkdown, { extension: ".todo.md" }),
			);
			if (result === null) {
				this.ctx.showWarning("Editor exited without saving; todos unchanged.");
				return;
			}
			const { phases: parsed, errors } = markdownToPhases(result);
			if (errors.length > 0) {
				this.ctx.showError(`Could not parse Markdown:\n  ${errors.join("\n  ")}`);
				return;
			}
			this.#commit(parsed, "/todo edit");
			const taskCount = parsed.reduce((sum, p) => sum + p.tasks.length, 0);
			this.ctx.showStatus(`Todos updated from editor: ${parsed.length} phase(s), ${taskCount} task(s).`);
		} catch (error) {
			this.ctx.showWarning(
				`Failed to open external editor: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	}

	#show(outcome: TodoCommandOutcome): void {
		if (!outcome.ok) {
			this.ctx.showError(outcome.error);
			return;
		}
		this.ctx.showStatus(outcome.status);
	}

	#editHost(): TodoUserEditHost {
		return {
			commitTodoPhases: phases => this.ctx.session.commitTodoPhases(phases),
			setTodos: phases => this.ctx.setTodos(phases),
			appendMessage: message => {
				this.ctx.agent.appendMessage(message);
				this.ctx.sessionManager.appendMessage(message);
			},
		};
	}

	#commit(nextPhases: TodoPhase[], action: string): void {
		// Commit first so HUD visibility binds to the new canonical source.
		commitTodoUserEdit(this.#editHost(), nextPhases, action);
	}
}
