export default function myPlugin(pi) {
    pi.on("session_start", async (_event, ctx) => {
        ctx.ui.notify("my-plugin loaded from example marketplace!", "info");
    });
}
