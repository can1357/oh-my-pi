/** Cached author photos supplied by the command host. */
export interface AvatarSource {
	get(email: string, cwd: string): string | null | undefined;
}
