declare module "omp-legacy-pi-modules" {
	/** Lazy host package namespace loaders retained for compiled legacy extensions. */
	export const BUNDLED_PI_MODULE_LOADERS: Readonly<Record<string, () => Promise<Readonly<Record<string, unknown>>>>>;
}
