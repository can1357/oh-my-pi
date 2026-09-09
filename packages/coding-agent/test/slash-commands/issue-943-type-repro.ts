import { executeBuiltinSlashCommand } from "@oh-my-pi/pi-coding-agent/slash-commands/builtin-registry";

// Importing the builtin registry makes strict TypeScript check the registry
// assignment where async no-return handlers must satisfy BuiltinSlashCommandSpec.
void executeBuiltinSlashCommand;
