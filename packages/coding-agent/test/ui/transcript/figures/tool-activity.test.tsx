/** @jsxImportSource @oh-my-pi/pi-tui */
import { signal } from "@oh-my-pi/pi-tui";
import { ToolActivity } from "../../../../src/ui/transcript/messages/panel";
import { single } from "../messages/harness";
import { figureSuite } from "./harness";

figureSuite("tool-activity", corpusCase => {
	const visible = signal(true);
	const expanded = signal(false);
	const children = corpusCase.inputs as { children: string[] };
	const blocks =
		children.children.length === 0
			? []
			: children.children.length === 1
				? [<text spans={[{ t: "one" }]} wrap="word" />]
				: [
						<spacer size="sm" />,
						<text spans={[{ t: "tool warning ".repeat(8), s: "warning" }]} wrap="word" />,
						<text
							spans={() => [{ t: expanded() ? "expanded body\nline two\nthree" : "collapsed" }]}
							wrap="word"
						/>,
					];
	return {
		node: single(<ToolActivity visible={visible}>{blocks}</ToolActivity>),
		apply(label) {
			if (label === "expanded") expanded.set(true);
			else if (label === "collapsed while hidden") expanded.set(false);
			else if (label === "tool activity hidden") visible.set(false);
			else if (label === "tool activity shown") visible.set(true);
			else throw new Error(`unknown stage ${label}`);
		},
	};
});
