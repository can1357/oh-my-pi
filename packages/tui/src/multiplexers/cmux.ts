export const cmuxMultiplexer = {
	isInside(env: NodeJS.ProcessEnv = Bun.env): boolean {
		return Boolean(env.CMUX_WORKSPACE_ID || env.CMUX_SURFACE_ID || env.CMUX_REMOTE_TRANSPORT);
	},
};
