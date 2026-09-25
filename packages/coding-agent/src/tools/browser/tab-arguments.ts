import { ToolError } from "@oh-my-pi/pi-tui/tools/tool-errors";

export function assertTabPressArgs(key: unknown, options?: unknown): void {
	if (typeof options === "string") {
		throw new ToolError(
			`tab.press() takes (key, options) but was called as (selector, key). ` +
				`Did you mean tab.press(${JSON.stringify(options)}, { selector: ${JSON.stringify(key)} })?`,
		);
	}
}
