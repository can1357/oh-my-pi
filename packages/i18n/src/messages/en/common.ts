export const common = {
	greeting: "Hello, {name}",
	fileCount: {
		one: "{count} file",
		other: "{count} files",
	},
	cancel: "Cancel",
	language: "Language",
	languageDescription: "Choose the language used by the interface",
	cli: {
		usage: "USAGE",
		commands: "COMMANDS",
		arguments: "ARGUMENTS",
		flags: "FLAGS",
		examples: "EXAMPLES",
		unknownCommand: "Unknown command: {command}",
		commandNotFound: "Error: command {command} not found",
		usageError: "error: {message}",
		runHelp: "Run `{command} {name} --help` for details.",
	},
} as const;
