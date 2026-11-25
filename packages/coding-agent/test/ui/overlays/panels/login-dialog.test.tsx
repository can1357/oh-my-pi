/** @jsxImportSource @oh-my-pi/pi-tui */
import { LoginDialog, LoginDialogState } from "../../../../src/ui/overlays/panels/login-dialog";
import { type Driver, panelSuite } from "./harness";

const URL_ =
	"https://auth.example.com/authorize?client_id=abc&redirect_uri=http%3A%2F%2F127.0.0.1%3A1455%2Fcallback&scope=openid+profile&state=xyzxyzxyzxyz";
const quiet = (p: Promise<unknown>) => void p.catch(() => {});
const type = (text: string) => (d: Driver) => {
	for (const ch of text) d.press(ch);
};

panelSuite({
	dir: "overlays/login-dialog",
	mount(caseName) {
		const state = new LoginDialogState(
			caseName === "empty" ? "unknown-provider" : "openai-codex",
			() => {},
			() => {},
		);
		const action = (act: string) => (d: Driver) => void d.emit({ type: "action", key: "", act, mods: [] });
		return {
			view: () => <LoginDialog state={state} />,
			focus: d => d.root,
			steps: {
				unfocus: () => state.focused.set(false),
				refocus: () => state.focused.set(true),
				"auth device": () => state.showAuth("https://github.com/login/device", "Enter code: ABCD-1234"),
				waiting: () => state.showWaiting("Waiting for authorization..."),
				progress: () =>
					state.showProgress(
						caseName === "multi-prompt"
							? "Validating..."
							: caseName === "device-flow"
								? "Checking token"
								: "Waiting for callback...",
					),
				"progress problem": () => state.showProgress("Token exchange failed, retrying..."),
				"progress unicode": () => state.showProgress("Récupération des modèles… 🚀"),
				"native cancel": action("cancel"),
				"auth launch": () => state.showAuth(URL_, undefined, "http://localhost:1455/start"),
				manual: () => quiet(state.showManualInput("Paste the authorization code, then press Enter:")),
				paste: d => d.paste("garbage"),
				"native submit": action("submit"),
				retry: () => quiet(state.showManualInput("Paste the authorization code, then press Enter:")),
				cursor: () => state.terminalCursor.set(true),
				type: type(caseName === "multi-prompt" ? "https://x.dev" : "abc"),
				"prompt 1": () =>
					quiet(state.showPrompt({ message: "Enter your API base URL:", placeholder: "https://api.example.com" })),
				"prompt secret": () => quiet(state.showPrompt({ message: "Enter your API key", secret: true })),
				"type secret": type("sk-123"),
				"prompt 3": () => quiet(state.showPrompt({ message: "Organisation (optional)" })),
				enter: d => d.press("\r"),
				"manual after prompts": () => quiet(state.showManualInput("\x1b[1mPaste\x1b[0m the code:")),
				"auth instructions": () => state.showAuth(URL_, "Sign in with your \x1b[33mwork\x1b[0m account...", URL_),
				"prompt after auth": () => quiet(state.showPrompt({ message: "Then press Enter to continue" })),
				esc: d => d.press("\x1b"),
			},
		};
	},
});
