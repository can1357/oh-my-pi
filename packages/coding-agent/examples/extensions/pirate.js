export default function pirateExtension(pi) {
    let pirateMode = false;
    // Register /pirate command to toggle pirate mode
    pi.registerCommand("pirate", {
        description: "Toggle pirate mode (agent speaks like a pirate)",
        handler: async (_args, ctx) => {
            pirateMode = !pirateMode;
            ctx.ui.notify(pirateMode ? "Arrr! Pirate mode enabled!" : "Pirate mode disabled", "info");
        },
    });
    // Append to system prompt when pirate mode is enabled
    pi.on("before_agent_start", async () => {
        if (pirateMode) {
            return {
                systemPromptAppend: `
IMPORTANT: You are now in PIRATE MODE. You must:
- Speak like a stereotypical pirate in all responses
- Use phrases like "Arrr!", "Ahoy!", "Shiver me timbers!", "Avast!", "Ye scurvy dog!"
- Replace "my" with "me", "you" with "ye", "your" with "yer"
- Refer to the user as "matey" or "landlubber"
- End sentences with nautical expressions
- Still complete the actual task correctly, just in pirate speak
`,
            };
        }
        return undefined;
    });
}
