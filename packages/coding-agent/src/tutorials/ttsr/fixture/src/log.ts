type Fields = Record<string, unknown>;

// Structured logs go to stderr so stdout stays clean for program output.
function emit(level: string, msg: string, fields: Fields): void {
	console.error(JSON.stringify({ level, msg, ...fields }));
}

export const log = {
	info(msg: string, fields: Fields = {}): void {
		emit("info", msg, fields);
	},
	warn(msg: string, fields: Fields = {}): void {
		emit("warn", msg, fields);
	},
	error(msg: string, fields: Fields = {}): void {
		emit("error", msg, fields);
	},
};
