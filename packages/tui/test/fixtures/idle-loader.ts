import { Loader, type LoaderMessageColorFn } from "../../src/components/loader";
import { ProcessTerminal } from "../../src/terminal";
import { TUI } from "../../src/tui";

const ui = new TUI(new ProcessTerminal());
const color = ((text: string) =>
	`\x1b[38;5;${100 + (Math.floor(Date.now() / 34) % 100)}m${text}\x1b[0m`) as LoaderMessageColorFn & {
	animated: true;
};
color.animated = true;
// The working row uses an interrupt affordance instead of a second spinner.
const loader = new Loader(ui, text => text, color, "Working…", ["Esc"]);
ui.addChild(loader);
ui.start();
const job = Bun.spawn(["sleep", "2"], { stdout: "ignore", stderr: "ignore" });
await job.exited;
loader.stop();
await Bun.sleep(100);
process.stdout.write("IDLE-BEGIN");
await Bun.sleep(250);
process.stdout.write("IDLE-END");
ui.stop();
