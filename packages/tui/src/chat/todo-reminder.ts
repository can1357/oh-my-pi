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

	constructor(todos: TodoItem[], attempt: number, maxAttempts: number, unverifiedMerge = false) {
		super();
		this.#notice = new MessageNoticeComponent({
			presentation: () => {
				const count = todos.length;
				const label = count === 1 ? "todo" : "todos";
				const suffix = `reminder ${attempt}/${maxAttempts}`;
				const header = unverifiedMerge
					? count > 0
						? `${count} incomplete ${label} + unverified merge - ${suffix}`
						: `merged changes need verification - ${suffix}`
					: `${count} incomplete ${label} - ${suffix}`;
				const todoList = todos.map(todo => `  ${theme.checkbox.unchecked} ${todo.content}`).join("\n");
				const bodyText =
					unverifiedMerge && count === 0
						? "run the parent verification (tests/checks) before settling"
						: todoList;
				return { icon: theme.icon.warning, header, body: new Text(theme.italic(bodyText), 0, 0) };
			},
		});
		this.addChild(this.#notice);
	}

	setToolActivityVisible(visible: boolean): void {
		this.#notice.setToolActivityVisible(visible);
	}
}
