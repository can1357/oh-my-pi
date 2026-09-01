import { Input, ProcessTerminal, Text, TUI } from "@oh-my-pi/pi-tui";
import { fatal } from "@oh-my-pi/pi-utils/postmortem";

const tui = new TUI(new ProcessTerminal(), false);
const input = new Input();
input.prompt = "╰─ ";

tui.addChild(new Text("safe transcript", 0, 0));
tui.addChild(input);
tui.setFocus(input);
tui.start({ clearScrollback: true });

await Bun.sleep(100);
await fatal(new Error("fatal PTY fixture"));
