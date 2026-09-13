/**
 * Every settings domain, in settings-panel order. Importing this module registers every setting;
 * {@link orderedSettings} lists them by domain order, then declaration order within a domain;
 * `PLACED_DOMAINS` splice a domain into another domain's rows.
 */
import { all, type AnySetting, Setting } from "./registry";
import * as modesSettings from "../modes/settings";
import * as sessionSettings from "../session/settings";
import * as advisorSettings from "../advisor/settings";
import * as configModelSettings from "./model-settings";
import * as sessionContextSettings from "../session/context-settings";
import * as sessionStorageSettings from "../session/storage-settings";
import * as memoryBackendSettings from "../memory-backend/settings";
import * as memoriesSettings from "../memories/settings";
import * as sharpshooterSettings from "../sharpshooter/settings";
import * as autolearnSettings from "../autolearn/settings";
import * as mnemopiSettings from "../mnemopi/settings";
import * as hindsightSettings from "../hindsight/settings";
import * as exportTtsrSettings from "../export/ttsr-settings";
import * as editSettings from "../edit/settings";
import * as toolsSettings from "../tools/settings";
import * as lspSettings from "../lsp/settings";
import * as execSettings from "../exec/settings";
import * as evalSettings from "../eval/settings";
import * as taskSettings from "../task/settings";
import * as planModeSettings from "../plan-mode/settings";
import * as goalsSettings from "../goals/settings";
import * as extensibilitySettings from "../extensibility/settings";
import * as webSettings from "../web/settings";
import * as toolsBrowserSettings from "../tools/browser/settings";
import * as idaSettings from "../ida/settings";
import * as mcpSettings from "../mcp/settings";
import * as blobBrokerSettings from "../blob-broker/settings";
import * as secretsSettings from "../secrets/settings";
import * as ttsSettings from "../tts/settings";
import * as sttSettings from "../stt/settings";
import * as liveSettings from "../live/settings";
import * as collabSettings from "../collab/settings";
import * as commandsSettings from "../commands/settings";
import * as streamSettings from "../stream/settings";
import * as commitSettings from "../commit/settings";
import * as cliGcSettings from "../cli/gc-settings";

const DOMAINS: readonly Readonly<Record<string, unknown>>[] = [
	configModelSettings,
	modesSettings,
	sessionSettings,
	advisorSettings,
	sessionContextSettings,
	sessionStorageSettings,
	memoryBackendSettings,
	memoriesSettings,
	sharpshooterSettings,
	autolearnSettings,
	mnemopiSettings,
	hindsightSettings,
	exportTtsrSettings,
	editSettings,
	toolsSettings,
	lspSettings,
	execSettings,
	evalSettings,
	taskSettings,
	planModeSettings,
	goalsSettings,
	extensibilitySettings,
	webSettings,
	toolsBrowserSettings,
	idaSettings,
	mcpSettings,
	blobBrokerSettings,
	secretsSettings,
	sttSettings,
	collabSettings,
	commandsSettings,
	streamSettings,
	commitSettings,
	cliGcSettings,
];

/** Domains listed immediately before `before` (a setting of a DOMAINS entry) instead of in DOMAINS order. */
const PLACED_DOMAINS: readonly { domain: Readonly<Record<string, unknown>>; before: AnySetting }[] = [
	{ domain: liveSettings, before: sessionSettings.cfgProvidersFetch },
	{ domain: ttsSettings, before: sessionSettings.cfgProvidersFetch },
];

let ordered: readonly AnySetting[] | undefined;

/** Every registered setting: domains in panel order, each in declaration order. */
export function orderedSettings(): readonly AnySetting[] {
	if (ordered) return ordered;
	const sequence = new Map(all().map((handle, index) => [handle, index]));
	const seen = new Set<AnySetting>();
	const domainHandles = (domain: Readonly<Record<string, unknown>>): AnySetting[] => {
		const handles: AnySetting[] = [];
		const collect = (value: unknown) => {
			if (value instanceof Setting) {
				if (!seen.has(value)) {
					seen.add(value);
					handles.push(value);
				}
			} else if (value && typeof value === "object" && !Array.isArray(value)) {
				for (const nested of Object.values(value)) collect(nested);
			}
		};
		for (const key in domain) collect(domain[key]);
		return handles.sort((a, b) => (sequence.get(a) ?? 0) - (sequence.get(b) ?? 0));
	};
	const placedBefore = new Map<AnySetting, AnySetting[]>();
	for (const { domain, before } of PLACED_DOMAINS) {
		const placed = placedBefore.get(before) ?? [];
		placed.push(...domainHandles(domain));
		placedBefore.set(before, placed);
	}
	const result: AnySetting[] = [];
	for (const domain of DOMAINS) {
		for (const handle of domainHandles(domain)) {
			const placed = placedBefore.get(handle);
			if (placed) result.push(...placed);
			result.push(handle);
		}
	}
	ordered = result;
	return result;
}
