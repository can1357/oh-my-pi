import { Container } from "../tui";
import { Spacer } from "../components/spacer";
import { TruncatedText } from "../components/truncated-text";
import { formatKeyHint, formatTooltipKey } from "../key-hint-format";
import type { KeyId } from "../keys";
import { kbd, node, text } from "../native/describe";
import type { NativeNode, NativeUiEvent } from "../native/node";
import { replaceTabs } from "../utils";
import { theme } from "../theme/theme";

/** Queued messages under one heading ("Steering", "After yield"). */
export interface QueuedMessageGroup {
	readonly label: string;
	readonly messages: readonly string[];
}

/**
 * Messages queued while the agent works, above the editor. ANSI: a heading
 * per group, numbered dim rows and the dequeue hint. Natively (§8.1): a
 * stack of pills, each `corner-down-right` · the text · `⌥↑ Edit`, the total
 * count in the first pill when more than one waits; the edit control sends
 * `queue.edit`, answered like the dequeue key.
 */
export class QueuedMessagesBand extends Container {
	readonly #native: NativeNode;

	constructor(
		groups: readonly QueuedMessageGroup[],
		dequeueKey: KeyId,
		private readonly onEdit: () => void,
	) {
		super();
		this.addChild(new Spacer(1));
		for (const group of groups) {
			const heading = theme.fg("muted", `${group.label}${theme.sep.dot}${group.messages.length}`);
			this.addChild(new TruncatedText(heading, 1, 0));
			for (let index = 0; index < group.messages.length; index++) {
				const message = replaceTabs(group.messages[index] ?? "").replace(/\r?\n/g, " ↵ ");
				this.addChild(new TruncatedText(theme.fg("dim", `  ${index + 1}. ${message}`), 1, 0));
			}
		}
		this.addChild(
			new TruncatedText(theme.fg("dim", `  ${theme.tree.hook} ${formatKeyHint(dequeueKey)} to edit`), 1, 0),
		);
		const editTitle = `Edit  ${formatTooltipKey(dequeueKey)}`;

		const count = groups.reduce((sum, group) => sum + group.messages.length, 0);
		const pills: NativeNode[] = [];
		for (const group of groups) {
			group.messages.forEach((message, index) => {
				const children: NativeNode[] = [
					node("icon", { name: "corner-down-right" }, undefined, "icon"),
					node(
						"text",
						{
							text: replaceTabs(message).replace(/\s*\r?\n\s*/g, " ↵ "),
							wrap: "none",
							truncate: "end",
							grow: 1,
						},
						undefined,
						"text",
					),
				];
				if (pills.length === 0 && count > 1) {
					children.push(node("badge", { text: `${count}`, role: "omp.queue.count" }, undefined, "count"));
				}
				children.push(
					node(
						"row",
						{
							role: "omp.queue.edit",
							gap: "xs",
							align: "center",
							title: editTitle,
							actions: { click: "queue.edit" },
						},
						[kbd(dequeueKey), text("Edit")],
						"edit",
					),
				);
				pills.push(
					node(
						"row",
						{ role: "omp.queue.item", align: "center", gap: "sm", title: group.label },
						children,
						`${group.label}/${index}`,
					),
				);
			});
		}
		this.#native = node("col", { role: "omp.queue", gap: "xs" }, pills);
	}

	override describe(): NativeNode {
		return this.#native;
	}

	/** The pills' Edit control: the dequeue key's path (queued messages back into the editor). */
	handleNativeEvent(event: NativeUiEvent): void {
		if (event.type === "action" && event.act === "queue.edit") this.onEdit();
	}
}
