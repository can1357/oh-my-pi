const activeOwnerCommands = new WeakSet<object>();

export function beginOwnerCommand(owner: object): boolean {
	if (activeOwnerCommands.has(owner)) return false;
	activeOwnerCommands.add(owner);
	return true;
}

export function finishOwnerCommand(owner: object): void {
	activeOwnerCommands.delete(owner);
}

export function isOwnerCommandInFlight(owner: object): boolean {
	return activeOwnerCommands.has(owner);
}
