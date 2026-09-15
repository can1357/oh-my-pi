import { afterEach, describe, expect, it, vi } from "bun:test";
import * as customShare from "@oh-my-pi/pi-coding-agent/export/custom-share";
import * as share from "@oh-my-pi/pi-coding-agent/export/share";
import { CommandController } from "@oh-my-pi/pi-coding-agent/modes/controllers/command-controller";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";

function createContext(confirmed: boolean) {
	const showHookConfirm = vi.fn(async () => confirmed);
	const showError = vi.fn();
	const ctx = {
		showHookConfirm,
		showError,
	} as unknown as InteractiveModeContext;
	return { ctx, showHookConfirm, showError };
}

describe("CommandController /share", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("does not load or upload session data when the operator declines", async () => {
		const loadCustomShare = vi.spyOn(customShare, "loadCustomShare");
		const shareSession = vi.spyOn(share, "shareSession");
		const { ctx, showHookConfirm } = createContext(false);

		await new CommandController(ctx).handleShareCommand();

		expect(showHookConfirm).toHaveBeenCalledTimes(1);
		expect(loadCustomShare).not.toHaveBeenCalled();
		expect(shareSession).not.toHaveBeenCalled();
	});

	it("continues to the existing share flow after approval", async () => {
		const loadCustomShare = vi
			.spyOn(customShare, "loadCustomShare")
			.mockRejectedValue(new Error("share setup reached"));
		const shareSession = vi.spyOn(share, "shareSession");
		const { ctx, showHookConfirm, showError } = createContext(true);

		await new CommandController(ctx).handleShareCommand();

		expect(showHookConfirm).toHaveBeenCalledTimes(1);
		expect(loadCustomShare).toHaveBeenCalledTimes(1);
		expect(shareSession).not.toHaveBeenCalled();
		expect(showError).toHaveBeenCalledWith("share setup reached");
	});
});
