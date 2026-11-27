import { createSurface, startHost } from "@oh-my-pi/pi-tui";
import { jsx } from "@oh-my-pi/pi-tui/jsx-runtime";
import { loadThemeSync } from "@oh-my-pi/pi-tui/theme/loader";
import { fatal, installProcessHandlers } from "@oh-my-pi/pi-utils/postmortem";

const native = process.argv.includes("--native");
const fullscreen = process.argv.includes("--fullscreen");
if (native) installProcessHandlers();

const theme = loadThemeSync("dark");
const surface = createSurface(() => ({
	main: jsx("text", { text: "safe transcript" }),
	dock: jsx("text", { text: "╰─ " }),
}));

const host = await startHost({
	screen: () => (fullscreen ? "fullscreen" : "inline"),
	surface,
	theme: () => theme,
	native,
	// The PTY sends Enter only after a painted composer row or a native surface frame.
	onKey: key => {
		if (key.id !== "enter") return false;
		if (native) void Promise.reject(new Error("unhandled native PTY fixture"));
		else void fatal(new Error("fatal PTY fixture"));
		return true;
	},
});

if (fullscreen) host.setMouse("drag");
