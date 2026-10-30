import { t as __ompTranslate } from "@oh-my-pi/pi-utils/i18n";
import type { Component } from "../index";
import type { Theme } from "../theme/theme";
import type { NativeToolView } from "./renderer";
import { describeDeviceCallPreview, renderDeviceCallPreview } from "./resolve";

/** Call preview for an `xd://report_issue` write. */
export function renderReportIssueDeviceCall(content: unknown, uiTheme: Theme): Component {
	return renderDeviceCallPreview(__ompTranslate("Report Tool Issue"), content, uiTheme);
}

/** Native call preview for an `xd://report_issue` write. */
export function describeReportIssueDeviceCall(content: unknown): NativeToolView {
	return describeDeviceCallPreview(__ompTranslate("Report Tool Issue"), content);
}

/** Device name for automatic tool issue reports. */
export const REPORT_ISSUE_DEVICE_NAME = "report_issue";
/** Internal device URL for automatic tool issue reports. */
export const REPORT_ISSUE_DEVICE_PATH = `xd://${REPORT_ISSUE_DEVICE_NAME}`;
