import { expect, test } from "bun:test";
import { staticEnvironment } from "@oh-my-pi/pi-tui/term/paint";
import { loadThemeSync } from "@oh-my-pi/pi-tui/theme/loader";
import "../../../src/ui/styles/tools/find";
import { findPresenter } from "../../../src/ui/tools/find";
import { ToolCall } from "../../../src/ui/transcript/tool-block";
import { toolScreenSuite } from "./presenter-corpus";
import { plainToolRows } from "./screens";

toolScreenSuite("find", "find", findPresenter);

test("find failures use one error prefix", () => {
	const env = staticEnvironment(loadThemeSync("dark", { symbolPreset: "ascii" }));
	const call = new ToolCall({ id: "find-1", name: "find", presenter: findPresenter, args: { query: "network" } });
	call.setExecutionStarted();
	call.updateResult({ content: [{ type: "text", text: "Error: index unavailable" }], isError: true }, false);
	expect(
		plainToolRows(call, env)
			.map(row => row.trimStart())
			.filter(Boolean),
	).toEqual(["[-] Error: index unavailable"]);
});
