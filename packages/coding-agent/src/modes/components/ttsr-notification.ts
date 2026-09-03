import { Box, Container, Spacer, Text } from "@oh-my-pi/pi-tui";
import type { Rule } from "../../capability/rule";
import { theme } from "../../modes/theme/theme";

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
	#box: Box;
	#expanded = false;
	#rules: Rule[];
	#toolActivityVisible = true;

	constructor(rules: Rule[]) {
		super();
		this.#rules = [...rules];

		this.addChild(new Spacer(1));

		// Use inverse warning color for yellow background effect
		this.#box = new Box(1, 1, t => theme.inverse(theme.fg("warning", t)));
		this.#box.setIgnoreTight(true);
		this.addChild(this.#box);

		this.#rebuild();
	}

	setToolActivityVisible(visible: boolean): void {
		if (this.#toolActivityVisible === visible) return;
		this.#toolActivityVisible = visible;
		this.invalidate();
	}

	override render(width: number): readonly string[] {
		if (!this.#toolActivityVisible) return [];
		return super.render(width);
	}

	/** Merge additional rules into this block (deduped by rule name). */
	addRules(rules: Rule[]): void {
		let changed = false;
		for (const rule of rules) {
			if (this.#rules.some(existing => existing.name === rule.name)) continue;
			this.#rules.push(rule);
			changed = true;
		}
		if (changed) this.#rebuild();
	}

	setExpanded(expanded: boolean): void {
		if (this.#expanded !== expanded) {
			this.#expanded = expanded;
			this.#rebuild();
		}
	}

	isExpanded(): boolean {
		return this.#expanded;
	}

	#rebuild(): void {
		this.#box.clear();
		// fg colors conflict with inverse, so styling inside the block is limited
		// to bold (names) and italic (descriptions).
		if (this.#rules.length === 1) {
			this.#rebuildSingle(this.#rules[0]!);
		} else {
			this.#rebuildMulti();
		}
	}

	#rebuildSingle(rule: Rule): void {
		const header = `${theme.icon.warning} Injecting rule: ${theme.bold(rule.name)}  ${theme.icon.rewind}`;
		this.#box.addChild(new Text(header, 0, 0));

		const desc = (rule.description || rule.content)?.trim();
		if (!desc) return;

		let displayText = desc;
		let truncated = false;
		if (!this.#expanded) {
			const lines = desc.split("\n");
			if (lines.length > 2) {
				displayText = `${lines.slice(0, 2).join("\n")}…`;
				truncated = true;
			}
		}

		this.#box.addChild(new Spacer(1));
		this.#box.addChild(new Text(theme.italic(displayText), 0, 0));
		if (truncated) {
			this.#box.addChild(new Text(theme.italic(" (ctrl+o to expand)"), 0, 0));
		}
	}

	#rebuildMulti(): void {
		const header = `${theme.icon.warning} Injecting ${this.#rules.length} rules:  ${theme.icon.rewind}`;
		this.#box.addChild(new Text(header, 0, 0));
		this.#box.addChild(new Spacer(1));

		const visible = this.#expanded ? this.#rules : this.#rules.slice(0, MAX_COLLAPSED_RULES);
		let elidedDetail = false;
		for (const rule of visible) {
			const desc = (rule.description || rule.content)?.trim();
			let line = theme.bold(rule.name);
			if (desc) {
				let displayText = desc;
				if (!this.#expanded) {
					// One line per rule when collapsed; full description when expanded.
					const newline = desc.indexOf("\n");
					if (newline !== -1) {
						displayText = `${desc.slice(0, newline).trimEnd()}…`;
						elidedDetail = true;
					}
				}
				line += `: ${theme.italic(displayText)}`;
			}
			this.#box.addChild(new Text(line, 0, 0));
		}

		const hidden = this.#rules.length - visible.length;
		if (hidden > 0) {
			this.#box.addChild(new Text(theme.italic(`… +${hidden} more (ctrl+o to expand)`), 0, 0));
		} else if (elidedDetail) {
			this.#box.addChild(new Text(theme.italic(" (ctrl+o to expand)"), 0, 0));
		}
	}
}
