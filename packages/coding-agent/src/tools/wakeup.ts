import { type } from "@oh-my-pi/omptype";
import type { AgentTool, AgentToolResult } from "@oh-my-pi/pi-agent-core";
import { MAX_WAKEUPS, type WakeupRecord } from "../async/wakeup-manager";
import wakeupDescription from "../prompts/tools/wakeup.md" with { type: "text" };
import type { ToolSession } from ".";

const boundedSeconds = type("number.integer").atLeast(1).atMost(86_400);
const wakeupSchema = type({
	delaySeconds: boundedSeconds,
	prompt: "string",
	"check?": { command: "string", maxWaitSeconds: boundedSeconds },
});

/** Schedule a durable one-shot follow-up in the owning persistent interactive session. */
export class WakeupTool implements AgentTool<typeof wakeupSchema, WakeupRecord> {
	readonly name = "wakeup";
	readonly label = "Wakeup";
	readonly summary = "Schedule a one-shot delayed checkback, optionally when a shell check changes";
	readonly description = wakeupDescription;
	readonly parameters = wakeupSchema;
	readonly strict = false;
	readonly approval = "write";
	readonly loadMode = "discoverable";

	constructor(private readonly session: ToolSession) {}

	static createIf(session: ToolSession): WakeupTool | null {
		return session.wakeupManager &&
			session.tuiTranscript === true &&
			(session.taskDepth ?? 0) === 0 &&
			session.getSessionFile()
			? new WakeupTool(session)
			: null;
	}

	async execute(
		_id: string,
		input: typeof wakeupSchema.infer,
		signal?: AbortSignal,
	): Promise<AgentToolResult<WakeupRecord>> {
		const manager = this.session.wakeupManager;
		if (
			!manager ||
			this.session.isDisposed?.() ||
			this.session.tuiTranscript !== true ||
			(this.session.taskDepth ?? 0) !== 0 ||
			!this.session.getSessionFile()
		)
			throw new Error("Wakeups are unavailable for this session");
		const record = await manager.schedule(input, signal);
		return {
			content: [
				{
					type: "text",
					text: `Scheduled ${record.id}; next check ${new Date(record.dueAt).toISOString()}. Read proc://${record.id}; cancel with write proc://${record.id}/kill (no content). ${MAX_WAKEUPS} timers maximum. Finish this turn; wait does not wait for timers. OMP must be running in this same session to fire.`,
				},
			],
			details: record,
		};
	}
}
