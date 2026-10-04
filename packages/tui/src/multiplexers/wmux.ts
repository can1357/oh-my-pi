export const wmuxMultiplexer = {
	isInside(env: NodeJS.ProcessEnv = Bun.env): boolean {
		return env.WMUX === "1" || Boolean(env.WMUX_SURFACE_ID);
	},
};
