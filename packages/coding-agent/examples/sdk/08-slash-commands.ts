/**
 * Slash Commands
 *
 * File-based commands that inject content when invoked with /commandname.
 * Note: File-based slash commands are now called "prompt templates".
 */
import {
	createAgentSession,
	discoverPromptTemplates,
	type PromptTemplate,
	SessionManager,
} from "@oh-my-pi/pi-coding-agent";

// Discover prompt templates from cwd/.pi/prompts/ and ~/.pi/agent/prompts/
const discovered = await discoverPromptTemplates();
console.log("Discovered prompt templates:");
for (const cmd of discovered) {
	console.log(`  /${cmd.name}: ${cmd.description}`);
}

// Define custom prompt templates
const deployCommand: PromptTemplate = {
	name: "deploy",
	description: "Deploy the application",
	source: "(custom)",
	content: `# Deploy Instructions

1. Build: npm run build
2. Test: npm test
3. Deploy: npm run deploy`,
};

// Note: slashCommands is now managed by the agent session automatically.
// Custom commands can be loaded via discoverCustomTSCommands() for TypeScript commands.
// For file-based markdown commands, use promptTemplates instead.

// Convert file-based slash commands to prompt templates
await createAgentSession({
	promptTemplates: [...discovered, deployCommand],
	sessionManager: SessionManager.inMemory(),
});

console.log(`Session created with ${discovered.length + 1} prompt templates`);

// Disable prompt templates:
// promptTemplates: []
