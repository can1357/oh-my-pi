import { buildSampleImage } from "../../../../src/modes/view-model/apps/debug/protocol-probe";
import { ProtocolProbe } from "../../../../src/ui/apps/protocol-probe";
import { appSuite } from "../harness";

const image = buildSampleImage(8, 8);

appSuite({
	dir: "apps/protocol-probe",
	mount(caseName) {
		const rich = caseName.startsWith("text-sizing-and-hyperlinks");
		const capabilities = { hyperlinks: rich, textSizing: rich, trueColor: true, images: null };
		const notificationSuppressed = caseName.endsWith("-suppressed");
		return { view: () => ProtocolProbe({ image, capabilities, notificationSuppressed }) };
	},
});
