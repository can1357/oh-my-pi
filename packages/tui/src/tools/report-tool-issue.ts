import { textArgumentRenderer } from "./resolve";

/** Command name for automatic tool issue reports. */
export const REPORT_ISSUE_COMMAND_NAME = "report_issue";

/** Renders `report_issue` calls: the `<tool>: <description>` report, then the acknowledgement. */
export const reportIssueRenderer = textArgumentRenderer("Report Tool Issue", "report");
