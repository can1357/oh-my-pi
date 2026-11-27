/** @jsxImportSource @oh-my-pi/pi-tui */
/**
 * `setup/<scene>` corpus: each onboarding scene's body mounted the way the
 * wizard mounts it, with the body budget (`maxLines`) the case records.
 */
import { afterAll } from "bun:test";
import type { StaticEnvironment } from "@oh-my-pi/pi-tui/term/paint";
import { listThemes, loadThemeSync } from "@oh-my-pi/pi-tui/theme/loader";
import { currentTheme, setCurrentTheme } from "@oh-my-pi/pi-tui/theme/runtime";
import { setAgentDir } from "@oh-my-pi/pi-utils/dirs";
import type { OAuthLoginCallbacks } from "@oh-my-pi/pi-ai/oauth/types";
import type { CorpusCase } from "@oh-my-pi/pi-tui/testing/corpus";
import {
	composerScene,
	modelScene,
	type SceneView,
	signInScene,
	glyphScene,
	type SetupScene,
	type ThemeLook,
	themeScene,
	updatesScene,
} from "../../../src/ui/setup";
import { corpusSuite, type Driver, type Mounted, settle } from "./harness";
import { corpusModel, type FakeHostOptions, fakeHost, sceneContext } from "./host";

// This file publishes corpus themes as the active theme; put the previous one back for later files.
const restoreTheme = currentTheme();
afterAll(() => setCurrentTheme(restoreTheme));

interface SceneInputs {
	readonly maxLines: number | null;
	readonly host: { readonly composerShape: string; readonly autoUpdate: boolean };
}

function mountScene(
	scene: SetupScene,
	corpusCase: CorpusCase,
	options: FakeHostOptions = {},
	steps: (view: SceneView) => Mounted["steps"] = () => ({}),
): Mounted {
	const inputs = corpusCase.inputs as SceneInputs;
	const host = fakeHost({ composerShape: inputs.host.composerShape, autoUpdate: inputs.host.autoUpdate, ...options });
	const view = scene.mount(sceneContext(host, inputs.maxLines ?? undefined));
	return {
		view: () => view.body,
		steps: steps(view),
		focus: driver => view.focusTarget?.(driver.root) ?? driver.root,
		events: () => host.events.splice(0),
		dispose: () => view.dispose?.(),
	};
}

corpusSuite({ dir: "setup/glyph", mount: (_name, corpusCase) => mountScene(glyphScene, corpusCase) });
corpusSuite({ dir: "setup/updates", mount: (_name, corpusCase) => mountScene(updatesScene, corpusCase) });
corpusSuite({ dir: "setup/composer", mount: (_name, corpusCase) => mountScene(composerScene, corpusCase) });

/** Previews apply to the whole UI: the paint environment and the runtime theme the scene's texts read. */
function lookHost(env: StaticEnvironment): FakeHostOptions {
	const apply = (look: ThemeLook | null): void => {
		const name = look === null || look.theme === "auto" ? "dark" : look.theme;
		const theme = loadThemeSync(name, {
			symbolPreset: look?.symbols ?? "unicode",
			colorBlindMode: look?.colorBlind ?? false,
		});
		env.setTheme(theme);
		setCurrentTheme(theme);
	};
	apply(null);
	return { previewTheme: apply, listThemes: () => listThemes() };
}

corpusSuite({
	dir: "setup/theme",
	mount: (_name, corpusCase, env) =>
		mountScene(themeScene, corpusCase, lookHost(env), () => ({
			// The capture painted before the theme list loaded.
			"key enter (loading themes)": driver => driver.press("\r"),
			"themes loaded": settle,
		})),
});

setAgentDir("/corpus-home/.omp/agent");

type Login = NonNullable<FakeHostOptions["login"]>;

const LOGINS: Record<string, Login> = {
	"pending-browser-auth": async (_provider, callbacks) => {
		const cb = callbacks as OAuthLoginCallbacks;
		cb.onAuth({ url: "https://example.com/oauth/authorize?state=pending&very=long&query=string&for=wrapping" });
		cb.onProgress?.("Waiting for the browser…");
		const pending = Promise.withResolvers<void>();
		cb.signal?.addEventListener("abort", () => pending.reject(new Error("Login cancelled")));
		await pending.promise;
	},
	success: async (_provider, callbacks) => {
		(callbacks as OAuthLoginCallbacks).onAuth({ url: "https://example.com/oauth/authorize?state=ok" });
	},
	failure: async () => {
		throw new Error("token exchange failed — ünïcode détail");
	},
};

corpusSuite({
	dir: "setup/sign-in",
	mount: (name, corpusCase) => {
		const flow = name.replace(/-(unbounded|maxlines-\d+)$/, "");
		return mountScene(signInScene, corpusCase, { login: LOGINS[flow] });
	},
});

const MODELS = [
	corpusModel("anthropic", "claude-sonnet"),
	corpusModel("anthropic", "claude-opus"),
	corpusModel("openai", "gpt-5"),
	corpusModel("openai", "gpt-5-mini"),
	corpusModel("google", "gemini-pro-ünïcode-very-long-model-name-that-overflows-the-columns"),
];
const never = () => new Promise<void>(() => {});
const fail = async () => {
	throw new Error("network down");
};

const MODEL_HOSTS: Record<string, FakeHostOptions> = {
	"listed-current-gpt-5-saving": { models: MODELS, current: MODELS[2], selectModel: never },
	"save-fails": { models: MODELS, selectModel: fail },
	"save-fails-small-budget": { models: MODELS, selectModel: fail },
	"discovery-fails-empty": { models: [], refreshModels: fail },
	"discovery-fails-models-listed": { models: MODELS, refreshModels: fail },
	discovering: { models: [], refreshModels: never },
	"retry-and-skip-after-failed-discovery": { models: [], refreshModels: fail },
	"escape-skips": { models: MODELS },
};

const action = (act: string) => (driver: Driver) => void driver.emit({ type: "action", key: "picker", act, mods: [] });

corpusSuite({
	dir: "setup/model",
	mount: (name, corpusCase) => {
		return mountScene(modelScene, corpusCase, MODEL_HOSTS[name], view => ({
			"onMount (discovery starts)": () => view.onMount?.(),
			"discovery settled": settle,
			"discovery pending": settle,
			"retry settled": settle,
			"save settled": settle,
			"native picker clear": action("clear"),
			"native picker select openai/gpt-5": driver =>
				void driver.emit({ type: "select", key: "picker", item: "openai/gpt-5" }),
			"native select on another key (ignored)": driver =>
				void driver.emit({ type: "select", key: "other", item: "openai/gpt-5-mini" }),
			"native picker save": action("save"),
			"native picker retry": action("retry"),
			"native picker skip": action("skip"),
		}));
	},
});
