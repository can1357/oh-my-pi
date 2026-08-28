export default function (pi) {
    pi.on("session_before_switch", async (event, ctx) => {
        if (!ctx.hasUI)
            return;
        if (event.reason === "new") {
            const confirmed = await ctx.ui.confirm("Clear session?", "This will delete all messages in the current session.");
            if (!confirmed) {
                ctx.ui.notify("Clear cancelled", "info");
                return { cancel: true };
            }
            return;
        }
        // reason === "resume" - check if there are unsaved changes (messages since last assistant response)
        const entries = ctx.sessionManager.getEntries();
        const hasUnsavedWork = entries.some((e) => e.type === "message" && e.message.role === "user");
        if (hasUnsavedWork) {
            const confirmed = await ctx.ui.confirm("Switch session?", "You have messages in the current session. Switch anyway?");
            if (!confirmed) {
                ctx.ui.notify("Switch cancelled", "info");
                return { cancel: true };
            }
        }
    });
    pi.on("session_before_branch", async (event, ctx) => {
        if (!ctx.hasUI)
            return;
        const choice = await ctx.ui.select(`Branch from entry ${event.entryId.slice(0, 8)}?`, [
            "Yes, create branch",
            "No, stay in current session",
        ]);
        if (choice !== "Yes, create branch") {
            ctx.ui.notify("Branch cancelled", "info");
            return { cancel: true };
        }
    });
}
