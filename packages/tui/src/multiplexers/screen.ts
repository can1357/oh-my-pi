export const screenMultiplexer = {
	isInside(env: NodeJS.ProcessEnv = Bun.env): boolean {
		return Boolean(env.STY);
	},
};
