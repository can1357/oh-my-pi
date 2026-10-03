import { Input, ProcessTerminal, Text, TUI } from "@oh-my-pi/pi-tui";
import { fatal } from "@oh-my-pi/pi-utils/postmortem";

const tui = new TUI(new ProcessTerminal(), false);
const input = new Input();
input.prompt = "╰─ ";
// The harness sends Enter once it has observed the composer boundary on the
// PTY, so the fatal path always races against a fully painted frame.
input.onSubmit = () => {
	void fatal(new Error("fatal PTY fixture"));
};

tui.addChild(new Text("safe transcript", 0, 0));
tui.addChild(input);
tui.setFocus(input);
tui.start({ clearScrollback: true });
