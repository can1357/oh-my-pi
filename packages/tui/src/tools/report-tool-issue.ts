import type { Component } from "../index";
import type { Theme } from "../theme/theme";
import { renderDeviceCallPreview } from "./resolve";

/** Call preview for an `xd://report_issue` write. */
export function renderReportIssueDeviceCall(content: unknown, uiTheme: Theme): Component {
	return renderDeviceCallPreview("Report Tool Issue", content, uiTheme);
}

/** Device name for automatic tool issue reports. */
export const REPORT_ISSUE_DEVICE_NAME = "report_issue";
/** Internal device URL for automatic tool issue reports. */
export const REPORT_ISSUE_DEVICE_PATH = `xd://${REPORT_ISSUE_DEVICE_NAME}`;
