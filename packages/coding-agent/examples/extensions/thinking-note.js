import { Container, Text } from "@oh-my-pi/pi-tui";
const extension = pi => {
    pi.setLabel("Thinking note");
    pi.registerAssistantThinkingRenderer((context, theme) => {
        const container = new Container();
        container.addChild(new Text(theme.fg("dim", `thinking chars: ${context.text.length}`), 1, 0));
        return container;
    });
};
export default extension;
