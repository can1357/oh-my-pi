export const zellijMultiplexer = {
	isInside(env: NodeJS.ProcessEnv = Bun.env): boolean {
		return Boolean(env.ZELLIJ);
	},
};
