export class SmitheryConnectError extends Error {
	status: number;

	constructor(message: string, status: number) {
		super(message);
		this.name = "SmitheryConnectError";
		this.status = status;
	}
}
