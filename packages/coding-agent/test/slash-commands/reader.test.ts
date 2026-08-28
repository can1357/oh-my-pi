import { describe, expect, it, vi } from "bun:test";
import { COLLAB_GUEST_ALLOWED_COMMANDS } from "@oh-my-pi/pi-coding-agent/collab/guest";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import { executeBuiltinSlashCommand } from "@oh-my-pi/pi-coding-agent/slash-commands/builtin-registry";

describe("/reader slash command", () => {
	it("opens the latest final-answer reader and clears the editor", async () => {
		const setText = vi.fn();
		const showCurrentTranscript = vi.fn();
		const runtime = {
			ctx: {
				editor: { setText } as unknown as InteractiveModeContext["editor"],
				showCurrentTranscript,
			} as unknown as InteractiveModeContext,
		};

		expect(await executeBuiltinSlashCommand("/reader", runtime)).toBe(true);
		expect(showCurrentTranscript).toHaveBeenCalledTimes(1);
		expect(setText).toHaveBeenCalledWith("");
	});

	it("is available to collaboration guests", () => {
		expect(COLLAB_GUEST_ALLOWED_COMMANDS.reader).toBe(true);
	});
});
