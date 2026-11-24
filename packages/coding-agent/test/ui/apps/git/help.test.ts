import { GitHelp } from "../../../../src/ui/apps/git";
import { appSuite } from "../harness";

appSuite({
	dir: "apps/git-help",
	mount: () => ({ view: () => GitHelp({ onClose: () => {} }) }),
});
