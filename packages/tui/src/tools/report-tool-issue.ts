import { type Component, Text } from "../index";
import type { Theme } from "../theme/theme";
import { renderStatusLine, truncateToWidth } from "../render/index";
import { replaceTabs } from "../render/render-utils";

/** Call preview for an `xd://report_issue` write. */
export function renderReportIssueDeviceCall(content: unknown, uiTheme: Theme): Component {
	const body = typeof content === "string" ? replaceTabs(content.trim().split("\n")[0] ?? "") : "";
	const text = renderStatusLine(
		{
			icon: "pending",
			title: "Report Tool Issue",
			description: body ? truncateToWidth(body, 72) : undefined,
		},
		uiTheme,
	);
	return new Text(text, 0, 0);
}

/** Device name for automatic tool issue reports. */
export const REPORT_ISSUE_DEVICE_NAME = "report_issue";
/** Internal device URL for automatic tool issue reports. */
export const REPORT_ISSUE_DEVICE_PATH = `xd://${REPORT_ISSUE_DEVICE_NAME}`;
