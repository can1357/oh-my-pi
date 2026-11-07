/** A recipient refused a new delivery because its pending queue is full. */
export class IrcQueueFullError extends Error {
	constructor() {
		super("recipient queue full");
		this.name = "IrcQueueFullError";
	}
}
