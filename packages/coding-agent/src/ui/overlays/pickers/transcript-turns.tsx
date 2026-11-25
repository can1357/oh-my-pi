/** @jsxImportSource @oh-my-pi/pi-tui */
/**
 * Turns of a transcript selector (`/rewind`, `/copy`) drawn by the
 * transcript's own blocks: a prompt's bubble, a reply then a card per tool
 * call with its result (consecutive reads as one read group). The terminal
 * looks paint these nodes; they never join the screen's native tree.
 */
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import {
	type Accessor,
	getOwner,
	type JSXNode,
	type Owner,
	resolveChildren,
	runWithOwner,
	signal,
	type UiNode,
	untrack,
} from "@oh-my-pi/pi-tui";
import type { InternalUrlRouter } from "../../../internal-urls/router";
import { readArgsCollapseIntoGroup } from "../../../session/transcript/read-tool-group";
import { textContent } from "../../../session/transcript/transcript-entry";
import "../../tools";
import { AssistantMessageBlock } from "../../transcript/messages/assistant-message";
import { UserMessage } from "../../transcript/messages/user-message";
import { ReadGroup, ReadGroupBlock } from "../../transcript/read-group";
import { ToolBlock, ToolCall } from "../../transcript/tool-block";

/** What ^O expands. */
interface Expandable {
	setExpanded(expanded: boolean): void;
}

/** One turn's blocks (`messages`: the prompt, or the reply then its tool results). */
function TurnBlocks(props: {
	readonly messages: readonly AgentMessage[];
	readonly expanded: Accessor<boolean>;
	/** Takes each tool card and read group created. */
	readonly onExpandable: (item: Expandable) => void;
	/** The session's URL router: decides which reads join a read group. */
	readonly router: InternalUrlRouter;
}): JSXNode {
	const [message, ...results] = props.messages;
	if (message?.role === "user") {
		const text = typeof message.content === "string" ? message.content : textContent(message.content, "\n");
		return <UserMessage model={{ text, promptZones: false }} />;
	}
	if (message?.role !== "assistant") return null;
	const expanded = untrack(props.expanded);
	const resultOf = (id: string) =>
		results.find(
			(entry): entry is Extract<AgentMessage, { role: "toolResult" }> =>
				entry.role === "toolResult" && entry.toolCallId === id,
		);
	const blocks: JSXNode[] = [
		<AssistantMessageBlock model={{ message, finalized: true, expandThinking: props.expanded }} />,
	];
	let reads: ReadGroup | undefined;
	for (const part of message.content) {
		if (part.type !== "toolCall") continue;
		const result = resultOf(part.id);
		if (part.name === "read" && readArgsCollapseIntoGroup(part.arguments, props.router)) {
			if (!reads) {
				const group = new ReadGroup();
				group.setExpanded(expanded);
				props.onExpandable(group);
				blocks.push(<col>{ReadGroupBlock({ group })}</col>);
				reads = group;
			}
			reads.updateArgs(part.arguments, part.id);
			if (result) reads.updateResult(result, false, part.id);
			continue;
		}
		reads?.seal();
		reads = undefined;
		const call = new ToolCall({ id: part.id, name: part.name, args: part.arguments });
		call.setArgsComplete();
		call.setExpanded(expanded);
		if (result) {
			call.updateResult({ content: result.content, details: result.details, isError: result.isError }, false);
			call.seal();
		}
		props.onExpandable(call);
		blocks.push(<ToolBlock call={call} />);
	}
	reads?.seal();
	return blocks;
}

/**
 * The nodes a selector's look draws (turns, block previews), built on first
 * draw and owned by the screen that created this (not by the draw that
 * needed them); ^O expands every turn.
 */
export class TurnViews {
	readonly #owner: Owner | null = getOwner();
	readonly #views = new Map<string, Accessor<readonly UiNode[]>>();
	readonly #expanded = signal(false);
	readonly #expandables: Expandable[] = [];
	readonly #router: InternalUrlRouter;

	/** `router`: the session's, deciding which reads join a read group. */
	constructor(router: InternalUrlRouter) {
		this.#router = router;
	}

	/** The blocks of the turn keyed `key` drawing `messages`. */
	blocks(key: string, messages: readonly AgentMessage[]): readonly UiNode[] {
		return this.nodes(key, () => (
			<TurnBlocks
				messages={messages}
				expanded={this.#expanded}
				onExpandable={item => this.#expandables.push(item)}
				router={this.#router}
			/>
		));
	}

	/** The nodes `view` builds, built once per `key`. */
	nodes(key: string, view: () => JSXNode): readonly UiNode[] {
		let nodes = this.#views.get(key);
		if (!nodes) {
			nodes = runWithOwner(this.#owner, () => untrack(() => resolveChildren(view())));
			this.#views.set(key, nodes);
		}
		return nodes();
	}

	/** Expand or fold every turn's tool output and thinking. */
	toggleExpanded(): void {
		const expanded = !this.#expanded.peek();
		this.#expanded.set(expanded);
		for (const item of this.#expandables) item.setExpanded(expanded);
	}
}
