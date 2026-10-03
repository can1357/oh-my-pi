export const herdrMultiplexer = {
	isInside(env: NodeJS.ProcessEnv = Bun.env): boolean {
		// Identity vars survive env-sanitizing launchers that drop HERDR_ENV.
		// Client-only socket, binary, session, and config overrides are not proof
		// that this process runs inside a pane.
		return env.HERDR_ENV === "1" || Boolean(env.HERDR_PANE_ID || env.HERDR_TAB_ID || env.HERDR_WORKSPACE_ID);
	},
};
