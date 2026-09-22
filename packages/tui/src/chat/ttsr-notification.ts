import { Text } from "../components/text";
import { type Component, Container } from "../tui";
import { MessageNoticeComponent, type MessageNoticePresentation } from "../chrome/message-notice";
import { theme } from "../theme";

/** Rule fields shown in rewind notifications. */
export interface NotificationRule {
	name: string;
	description?: string;
	content?: string;
}

/** Collapsed view shows at most this many rules before eliding the rest. */
const MAX_COLLAPSED_RULES = 4;

/**
 * Component that renders a TTSR (Time Traveling Stream Rules) notification.
 * Shows when a rule violation is detected and the stream is being rewound.
 * One block can carry several rules: a single event may match multiple rules,
 * and consecutive notifications merge into the previous block via
 * {@link addRules} while it is still the live transcript tail.
 */
export class TtsrNotificationComponent extends Container {
	#rules: NotificationRule[];
	readonly #notice: MessageNoticeComponent;

	constructor(rules: NotificationRule[]) {
		super();
		this.#rules = [...rules];
		this.#notice = new MessageNoticeComponent({
			presentation: context => this.#presentation(context.expanded),
		});
		this.addChild(this.#notice);
	}

	setToolActivityVisible(visible: boolean): void {
		this.#notice.setToolActivityVisible(visible);
	}

	/** Merge additional rules into this block (deduped by rule name). */
	addRules(rules: NotificationRule[]): void {
		let changed = false;
		for (const rule of rules) {
			if (this.#rules.some(existing => existing.name === rule.name)) continue;
			this.#rules.push(rule);
			changed = true;
		}
		if (changed) this.#notice.refresh();
	}

	setExpanded(expanded: boolean): void {
		this.#notice.setExpanded(expanded);
	}

	isExpanded(): boolean {
		return this.#notice.isExpanded();
	}

	#presentation(expanded: boolean): MessageNoticePresentation {
		// fg colors conflict with inverse, so styling inside the block is limited
		// to bold (names) and italic (descriptions).
		if (this.#rules.length === 1) {
			return this.#presentationSingle(this.#rules[0]!, expanded);
		}
		return this.#presentationMulti(expanded);
	}

	#presentationSingle(rule: NotificationRule, expanded: boolean): MessageNoticePresentation {
		const header = `Injecting rule: ${theme.bold(rule.name)}  ${theme.icon.rewind}`;

		const desc = (rule.description || rule.content)?.trim();
		if (!desc) return { icon: theme.icon.warning, header };

		let displayText = desc;
		let truncated = false;
		if (!expanded) {
			const lines = desc.split("\n");
			if (lines.length > 2) {
				displayText = `${lines.slice(0, 2).join("\n")}…`;
				truncated = true;
			}
		}

		const body: Component[] = [new Text(theme.italic(displayText), 0, 0)];
		if (truncated) {
			body.push(new Text(theme.italic(" (ctrl+o to expand)"), 0, 0));
		}
		return { icon: theme.icon.warning, header, body };
	}

	#presentationMulti(expanded: boolean): MessageNoticePresentation {
		const header = `Injecting ${this.#rules.length} rules:  ${theme.icon.rewind}`;

		const visible = expanded ? this.#rules : this.#rules.slice(0, MAX_COLLAPSED_RULES);
		const body: Component[] = [];
		let elidedDetail = false;
		for (const rule of visible) {
			const desc = (rule.description || rule.content)?.trim();
			let line = theme.bold(rule.name);
			if (desc) {
				let displayText = desc;
				if (!expanded) {
					// One line per rule when collapsed; full description when expanded.
					const newline = desc.indexOf("\n");
					if (newline !== -1) {
						displayText = `${desc.slice(0, newline).trimEnd()}…`;
						elidedDetail = true;
					}
				}
				line += `: ${theme.italic(displayText)}`;
			}
			body.push(new Text(line, 0, 0));
		}

		const hidden = this.#rules.length - visible.length;
		if (hidden > 0) {
			body.push(new Text(theme.italic(`… +${hidden} more (ctrl+o to expand)`), 0, 0));
		} else if (elidedDetail) {
			body.push(new Text(theme.italic(" (ctrl+o to expand)"), 0, 0));
		}
		return { icon: theme.icon.warning, header, body };
	}
}
