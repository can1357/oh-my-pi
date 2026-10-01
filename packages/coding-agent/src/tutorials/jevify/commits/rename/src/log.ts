type Level = "debug" | "info" | "warn" | "error";
type Fields = Record<string, unknown>;

function emit(level: Level, msg: string, fields: Fields = {}): void {
	console.log(JSON.stringify({ level, msg, ...fields, at: new Date().toISOString() }));
}

export const logger = {
	debug: (msg: string, fields?: Fields) => emit("debug", msg, fields),
	info: (msg: string, fields?: Fields) => emit("info", msg, fields),
	warn: (msg: string, fields?: Fields) => emit("warn", msg, fields),
	error: (msg: string, fields?: Fields) => emit("error", msg, fields),
};
