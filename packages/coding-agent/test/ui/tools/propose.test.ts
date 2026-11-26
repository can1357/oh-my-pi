import "../../../src/ui/styles/tools/propose";
import { proposePresenter, reportIssuePresenter } from "../../../src/ui/tools/propose";
import { type ToolScreen, toolScreenSuite } from "./screens";

export const proposeScreen: ToolScreen = {
	dir: "tools/propose",
	name: "propose",
	presenter: proposePresenter,
};
export const reportIssueScreen: ToolScreen = {
	dir: "tools/report_issue",
	name: "report_issue",
	presenter: reportIssuePresenter,
};

toolScreenSuite(proposeScreen);
toolScreenSuite(reportIssueScreen);
