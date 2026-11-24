/** @jsxImportSource @oh-my-pi/pi-tui */
import { signal } from "@oh-my-pi/pi-tui";
import {
	CustomMessageBlock,
	type FramedMessage,
	type FrameRenderer,
	HookMessageBlock,
	MessageFrame,
} from "../../../../src/ui/transcript/messages/frame";
import { region, screenSuite } from "./harness";

interface FrameInputs {
	message: FramedMessage;
	role: string;
	collapseAfterLines?: number;
	icon?: string;
	hideHeader?: boolean;
	borderColor?: string;
	customRenderer?: string;
}

/** The capture's renderers, by how the inputs describe them. */
function renderer(doc: string | undefined): FrameRenderer | undefined {
	if (!doc || doc.startsWith("returns undefined")) return undefined;
	if (doc.startsWith("throws")) {
		return () => {
			throw new Error("boom");
		};
	}
	if (doc.startsWith("always")) {
		const same = <text spans={[{ t: "custom same" }]} wrap="word" />;
		return () => same;
	}
	const flip = doc.startsWith("undefined while collapsed");
	return expanded =>
		flip && !expanded ? undefined : (
			<text spans={[{ t: `custom ${expanded ? "expanded" : "collapsed"}`, s: "accent" }]} wrap="word" />
		);
}

/** Stage labels of the frame cases. */
function frameStage(expanded: { set(value: boolean): void }, label: string): void {
	if (label === "expanded") expanded.set(true);
	else if (label === "native toggle collapsed") expanded.set(false);
	else throw new Error(`unknown stage ${label}`);
}

screenSuite("message-frame", corpusCase => {
	const inputs = corpusCase.inputs as FrameInputs;
	const expanded = signal(false);
	const icon = inputs.icon === "<icon.package>" ? { icon: "icon.package" } : inputs.icon ? { glyph: inputs.icon } : {};
	return {
		node: region(
			<MessageFrame
				message={inputs.message}
				role={inputs.role}
				{...icon}
				hideHeader={inputs.hideHeader}
				borderColor={inputs.borderColor}
				collapseAfterLines={inputs.collapseAfterLines}
				renderer={renderer(inputs.customRenderer)}
				expanded={expanded}
				onToggle={open => expanded.set(open)}
			/>,
		),
		apply: label => frameStage(expanded, label),
	};
});

screenSuite("custom-message", corpusCase => {
	const inputs = corpusCase.inputs as {
		message: FramedMessage & { role: string };
	};
	const expanded = signal(false);
	return {
		node: region(<CustomMessageBlock message={inputs.message} expanded={expanded} />),
		apply: label => frameStage(expanded, label),
	};
});

screenSuite("hook-message", corpusCase => {
	const inputs = corpusCase.inputs as { message: FramedMessage };
	const expanded = signal(false);
	return {
		node: region(<HookMessageBlock message={inputs.message} expanded={expanded} />),
		apply: label => frameStage(expanded, label),
	};
});
