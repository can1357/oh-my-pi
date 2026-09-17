import { Text } from "../components/text";
import { Container } from "../tui";
import { MessageNoticeComponent } from "../chrome/message-notice";
import { theme } from "../theme";
import type { TodoItem } from "../tools/todo";

/**
 * Component that renders a todo completion reminder notification, committed into
 * the transcript like a TTSR notification so it stays anchored in history rather
 * than floating above the editor.
 * Shows when the agent stops with incomplete todos.
 */
export class TodoReminderComponent extends Container {
	readonly #notice: MessageNoticeComponent;

	constructor(todos: TodoItem[], attempt: number, maxAttempts: number) {
		super();
		this.#notice = new MessageNoticeComponent({
			presentation: () => {
				const count = todos.length;
				const label = count === 1 ? "todo" : "todos";
				const header = `${count} incomplete ${label} - reminder ${attempt}/${maxAttempts}`;
				const todoList = todos.map(todo => `  ${theme.checkbox.unchecked} ${todo.content}`).join("\n");
				return { icon: theme.icon.warning, header, body: new Text(theme.italic(todoList), 0, 0) };
			},
		});
		this.addChild(this.#notice);
	}

	setToolActivityVisible(visible: boolean): void {
		this.#notice.setToolActivityVisible(visible);
	}
}
