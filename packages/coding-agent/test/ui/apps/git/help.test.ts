import { expect, test } from "bun:test";
import { staticEnvironment } from "@oh-my-pi/pi-tui/term/paint";
import { loadThemeSync } from "@oh-my-pi/pi-tui/theme/loader";
import { GitHelp } from "../../../../src/ui/apps/git";
import { appSuite, paintAppRows } from "../harness";

test("Git help paints navigation and dismissal with ASCII key names", () => {
	const env = staticEnvironment(loadThemeSync("dark", { symbolPreset: "ascii" }));
	const rows = paintAppRows(() => GitHelp({ onClose: () => {} }), env, 100);
	expect(rows.find(row => row.includes("Move the selection"))).toContain("Up Down");
	expect(rows.at(-1)?.trim()).toBe("Esc close");
});

appSuite({
	dir: "apps/git-help",
	mount: () => ({ view: () => GitHelp({ onClose: () => {} }) }),
});
