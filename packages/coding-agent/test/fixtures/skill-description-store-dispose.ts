import * as fs from "node:fs";
import * as path from "node:path";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { getSkillDescriptionsDbPath, TempDir } from "@oh-my-pi/pi-utils";
import { ModelRegistry } from "../../src/config/model-registry";
import { Settings } from "../../src/config/settings";
import { cfgSkillsCompressDescriptions } from "../../src/extensibility/settings";
import { createAgentSession } from "../../src/sdk";
import { AuthStorage } from "../../src/session/auth-storage";
import { SessionManager } from "../../src/session/session-manager";

// Run as `bun <this-file>`, not under `bun test`: the SDK disables its description store in Bun's
// test runtime. Prints whether the session's own skill-description database was opened.
using dir = TempDir.createSync("@omp-skill-store-dispose-");
const auth = await AuthStorage.create(path.join(dir.path(), "auth.db"));
try {
	// No credentials: compression has no model to call, so the probe stays offline.
	const settings = Settings.isolated({ "skills.compressDescriptions": false, "marketplace.autoUpdate": "off" });
	const sessionManager = SessionManager.inMemory(dir.path());
	const { session } = await createAgentSession({
		cwd: dir.path(),
		// Not the process agent dir: the session keeps its own store, opened by the first build that compresses.
		agentDir: dir.path(),
		sessionManager,
		authStorage: auth,
		modelRegistry: new ModelRegistry(auth, path.join(dir.path(), "models.yml"), { settings }),
		settings,
		model: getBundledModel("openai", "gpt-4o-mini"),
		disableExtensionDiscovery: true,
		enableMCP: false,
		enableLsp: false,
		skipPythonPreflight: true,
		cacheWarming: false,
		contextFiles: [],
		promptTemplates: [],
		slashCommands: [],
		skills: [
			{
				name: "attribution",
				description:
					"Use when a change needs attribution in the changelog and the PR description; do not use for internal refactors without user-visible effect.",
				filePath: path.join(dir.path(), "SKILL.md"),
				baseDir: dir.path(),
				source: "native:project",
			},
		],
	});
	// The prompt rebuild reads the session cwd after its disposal check and before it renders the
	// skill catalog: disposing there is a teardown racing a rebuild already under way.
	const getCwd = sessionManager.getCwd.bind(sessionManager);
	let disposed: Promise<void> | undefined;
	sessionManager.getCwd = () => {
		disposed ??= session.dispose();
		return getCwd();
	};
	// Switching compression on rebuilds the prompt, and that build is the first to need the store.
	cfgSkillsCompressDescriptions.override(settings, true);
	await Promise.resolve();
	await session.runToolRegistryMutation(async () => undefined);
	if (!disposed) throw new Error("The prompt rebuild never read the session cwd");
	await disposed;
	console.log(JSON.stringify({ opened: fs.existsSync(getSkillDescriptionsDbPath(dir.path())) }));
} finally {
	auth.close();
}
