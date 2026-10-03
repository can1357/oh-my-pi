import { Text } from "../components/text";
import { Container } from "../tui";
import { MessageNoticeComponent } from "../chrome/message-notice";
import { theme } from "../theme";
import { type TodoItem, todoChecklistPhases } from "../tools/todo";
import { node, span, withHidden } from "../native/describe";
import type { DescribeContext, NativeNode } from "../native/node";

/**
 * Component that renders a todo completion reminder notification, committed into
 * the transcript like a TTSR notification so it stays anchored in history rather
 * than floating above the editor.
 * Shows when the agent stops with incomplete todos.
 */
export class TodoReminderComponent extends Container {
	readonly #notice: MessageNoticeComponent;
	readonly #todos: TodoItem[];
	readonly #note: string;
	#hidden = false;

	constructor(todos: TodoItem[], attempt: number, maxAttempts: number) {
		super();
		this.#todos = todos;
		this.#note = `reminder ${attempt}/${maxAttempts}`;
		const count = todos.length;
		const header = `${count} incomplete ${count === 1 ? "todo" : "todos"} - reminder ${attempt}/${maxAttempts}`;
		this.#notice = new MessageNoticeComponent({
			presentation: () => {
				const todoList = todos.map(todo => `  ${theme.checkbox.unchecked} ${todo.content}`).join("\n");
				return { icon: theme.icon.warning, header, body: new Text(theme.italic(todoList), 0, 0) };
			},
			nativePresentation: () => ({
				head: [span(`${theme.icon.warning} ${header}`)],
				body: [
					node(
						"list",
						{},
						todos.map((todo, index) =>
							node("item", { label: [span(todo.content, "em")], tone: "pending" }, [], `t${index}`),
						),
					),
				],
			}),
			role: "omp.notice.todo",
		});
		this.addChild(this.#notice);
	}

	setToolActivityVisible(visible: boolean): void {
		this.#hidden = !visible;
		this.#notice.setToolActivityVisible(visible);
	}

	/** A `checklist` reminder of the open items where the terminal lists the kind (§7.5); else the notice card. */
	override describe(cx?: DescribeContext): NativeNode {
		if (cx?.supports("checklist") !== true) return this.#notice.describe();
		const phases = todoChecklistPhases([{ name: "", tasks: this.#todos }]);
		return withHidden(
			node("checklist", { mode: "reminder", phases, note: this.#note, role: "omp.notice.todo" }),
			this.#hidden,
		);
	}
}
