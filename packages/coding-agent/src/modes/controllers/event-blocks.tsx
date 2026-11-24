/** @jsxImportSource @oh-my-pi/pi-tui */
/** Transcript blocks the event controller mounts for session events (recap, usage row, TTSR, todo reminder). */
import type { JSXNode, Reactive } from "@oh-my-pi/pi-tui";
import type { NotificationRule } from "../../session/transcript/ttsr-notification";
import { UsageRow, type UsageRowProps } from "../../ui/overlays/panels/usage-row";
import { Recap, type ReminderTodo, TodoReminder, TtsrNotice } from "../../ui/transcript/messages/notices";

/** The idle recap line. */
export function recapBlock(recap: string): JSXNode {
	return <Recap recap={recap} />;
}

/** A request's usage row (tokens, timing, throughput). */
export function usageRowBlock(props: UsageRowProps): JSXNode {
	return (
		<col>
			<UsageRow {...props} />
		</col>
	);
}

/**
 * Rules a stream rewind injected; `rules` grows while the block is the live tail.
 * Tool activity: hidden while `visible` is false.
 */
export function ttsrBlock(
	rules: Reactive<readonly NotificationRule[]>,
	expanded: Reactive<boolean>,
	visible: Reactive<boolean>,
): JSXNode {
	return <TtsrNotice rules={rules} expanded={expanded} visible={visible} />;
}

/** The agent stopped with open todos. Tool activity: hidden while `visible` is false. */
export function todoReminderBlock(
	todos: readonly ReminderTodo[],
	attempt: number,
	maxAttempts: number,
	visible: Reactive<boolean>,
): JSXNode {
	return <TodoReminder todos={todos} attempt={attempt} maxAttempts={maxAttempts} visible={visible} />;
}
