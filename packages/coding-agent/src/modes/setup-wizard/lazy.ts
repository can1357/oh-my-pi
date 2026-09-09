import type { InteractiveModeContext } from "../types";

export async function runProviderSetupWizard(ctx: InteractiveModeContext): Promise<void> {
	// Keep the full setup wizard behind the existing cold-start boundary; a static
	// import here would load provider/OAuth/search/theme setup deps on every TUI startup.
	const { ALL_SCENES, runSetupWizard } = await import("./index");
	const providersScene = ALL_SCENES.find(scene => scene.id === "providers");
	if (!providersScene) {
		ctx.showError("Provider setup is unavailable.");
		return;
	}
	await runSetupWizard(ctx, [providersScene], {
		markComplete: false,
		playWelcomeIntro: false,
	});
}
