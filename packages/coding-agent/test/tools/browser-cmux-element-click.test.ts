import { expect, it, spyOn } from "bun:test";
import { CmuxTab } from "@oh-my-pi/pi-coding-agent/tools/browser/cmux/cmux-tab";
import { CmuxSocketClient } from "@oh-my-pi/pi-coding-agent/tools/browser/cmux/socket-client";
import { ToolError } from "@oh-my-pi/pi-tui/tools/tool-errors";

it("cmux element click refuses a button or click count it cannot press instead of clicking once", async () => {
	const methods: string[] = [];
	const request = spyOn(CmuxSocketClient.prototype, "request").mockImplementation(async (method: string) => {
		methods.push(method);
		return {};
	});
	try {
		const tab = new CmuxTab({
			client: new CmuxSocketClient({ socketPath: "/tmp/unused-cmux-element-click.sock" }),
			surfaceId: "element-click",
		});
		const handle = await tab.waitFor("#menu");

		await handle.click();
		await expect(handle.click({ button: "right" })).rejects.toBeInstanceOf(ToolError);
		await expect(handle.click({ count: 2 })).rejects.toBeInstanceOf(ToolError);
		expect(methods).toEqual(["browser.wait", "browser.click"]);
	} finally {
		request.mockRestore();
	}
});
