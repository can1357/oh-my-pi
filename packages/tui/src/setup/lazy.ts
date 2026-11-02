import type { SetupHost } from "./scenes/types";

/** Load and run provider setup without completing onboarding or replaying the welcome intro. */
export async function runProviderSetupWizard(ctx: SetupHost): Promise<void> {
	// Keep the full setup wizard behind the existing cold-start boundary; a static
	// import here would load provider/OAuth/search/theme setup deps on every TUI startup.
	const { ALL_SCENES, runSetupWizard } = await import("./wizard");
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
