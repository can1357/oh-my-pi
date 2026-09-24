import { createI18n, type MessageKey } from "@oh-my-pi/pi-i18n";
import type { CommandMetadata } from "@oh-my-pi/pi-utils/cli";

const english = createI18n("en");

function help(key: MessageKey): CommandMetadata {
	return { description: english.t(key), descriptionKey: key };
}

export const acpHelp = help("codingAgent.command.acp");
export const agentsHelp = help("codingAgent.command.agents");
export const authBrokerHelp = help("codingAgent.command.authBroker");
export const authGatewayHelp = help("codingAgent.command.authGateway");
export const benchHelp = help("codingAgent.command.bench");
export const browserRelayHelp = help("codingAgent.command.browserRelay");
export const cleanseHelp = help("codingAgent.command.cleanse");
export const collabHelp = help("codingAgent.command.collab");
export const clipHelp = help("codingAgent.command.clip");
export const commitHelp = help("codingAgent.command.commit");
export const completionsHelp = help("codingAgent.command.completions");
export const completeHelp = { hidden: true } satisfies CommandMetadata;
export const compressHelp = help("codingAgent.command.compress");
export const configHelp = help("codingAgent.command.config");
export const dryBalanceHelp = help("codingAgent.command.dryBalance");
export const galleryHelp = help("codingAgent.command.gallery");
export const gcHelp = help("codingAgent.command.gc");
export const ifBenchHelp = help("codingAgent.command.ifBench");
export const gitHelp = help("codingAgent.command.git");
export const findHelp = help("codingAgent.command.find");
export const grepHelp = help("codingAgent.command.grep");
export const grievancesHelp = help("codingAgent.command.grievances");
export const loginHelp = help("codingAgent.command.login");
export const imagesHelp = help("codingAgent.command.images");
export const installHelp = help("codingAgent.command.install");
export const joinHelp = help("codingAgent.command.join");
export const modelsHelp = help("codingAgent.command.models");
export const pluginHelp = help("codingAgent.command.plugin");
export const playHelp = help("codingAgent.command.play");
export const psHelp = help("codingAgent.command.ps");
export const readHelp = help("codingAgent.command.read");
export const renderHelp = help("codingAgent.command.render");
export const sayHelp = help("codingAgent.command.say");
export const searchHelp = help("codingAgent.command.search");
export const shareHelp = help("codingAgent.command.share");
export const setupHelp = help("codingAgent.command.setup");
export const shellHelp = help("codingAgent.command.shell");
export const skillHelp = help("codingAgent.command.skill");
export const sshHelp = help("codingAgent.command.ssh");
export const statsHelp = help("codingAgent.command.stats");
export const streamHelp = help("codingAgent.command.stream");
export const tinyModelsHelp = help("codingAgent.command.tinyModels");
export const tokenHelp = help("codingAgent.command.token");
export const ttsrHelp = help("codingAgent.command.ttsr");
export const updateHelp = help("codingAgent.command.update");
export const usageHelp = help("codingAgent.command.usage");
export const worktreeHelp = help("codingAgent.command.worktree");
