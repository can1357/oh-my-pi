import type { Model } from "@oh-my-pi/pi-ai";
import { getSupportedEfforts } from "@oh-my-pi/pi-catalog/model-thinking";
import {
	formatModelSelectorValue,
	formatModelStringWithRouting,
	resolveModelRoleValue,
} from "../config/model-resolver";
import type { Settings } from "../config/settings";
import type { ExtensionCommandContext, ExtensionContext } from "../extensibility/extensions/types";
import { AUTO_THINKING, type ConfiguredThinkingLevel, getConfiguredThinkingLevelMetadata } from "../thinking";

export interface CodeModelSelection {
	model: Model;
	effort: ConfiguredThinkingLevel;
}

type MenuContext = Pick<ExtensionContext, "hasUI" | "models" | "ui">;
type Language = "en" | "zh";

interface Messages {
	help: string;
	menuTitle: string;
	tabProvider: string;
	tabModel: string;
	tabEffort: string;
	tabSave: string;
	selectProviderTitle: string;
	selectModelTitleAll: string;
	selectModelTitleProvider: (provider: string) => string;
	selectEffortTitle: (provider: string, id: string) => string;
	effortDescription: (effort: string) => string;
	modelsCount: (count: number) => string;
	notSelected: string;
	pendingSelection: string;
	showNotice: (selection: string, scope: string) => string;
	savedNotice: (selection: string, scope: string) => string;
	errCheckProvider: string;
	errConflict: string;
	errSelectProvider: string;
	errSelectModel: string;
	errSelectEffort: string;
	errSelectFirst: string;
	errInteractiveOnly: string;
	errUsage: string;
	errInvalidOption: string;
}

export const MESSAGES: Record<Language, Messages> = {
	en: {
		help: "Use arrow keys to navigate, Enter to select, and Escape to cancel. Usage limits depend on the account provider.",
		menuTitle: "Code Model Configuration",
		tabProvider: "Provider",
		tabModel: "Model",
		tabEffort: "Effort",
		tabSave: "Save and Apply",
		selectProviderTitle: "Select Provider · Available Providers",
		selectModelTitleAll: "Select Model · All Available Models",
		selectModelTitleProvider: provider => `Select Model · ${provider}`,
		selectEffortTitle: (provider, id) => `Select Effort · ${provider}/${id}`,
		effortDescription: effort => (effort === AUTO_THINKING ? "Auto-detect per prompt" : `${effort} reasoning level`),
		modelsCount: count => `${count} models`,
		notSelected: "Select an option",
		pendingSelection: "Complete the selection",
		showNotice: (selection, scope) =>
			`Coding model: ${selection}. It applies to coding phases in this conversation. Storage: ${scope}.`,
		savedNotice: (selection, scope) =>
			`Saved coding model: ${selection}. It applies to the next coding phase. Storage: ${scope}.`,
		errCheckProvider: "Check authentication and the model catalogue for the selected provider.",
		errConflict:
			"The coding model setting changed while this menu was open. Reopen /code-model and review the current value.",
		errSelectProvider: "Select a provider from the catalogue.",
		errSelectModel: "Select a model from the catalogue.",
		errSelectEffort: "Select an effort supported by the current model.",
		errSelectFirst: "Select a provider and model first.",
		errInteractiveOnly: "Open this menu in interactive OMP mode.",
		errUsage:
			"Use /code-model to configure, /code-model show to inspect, or /code-model models to browse all models.",
		errInvalidOption: "Select an option from the menu.",
	},
	zh: {
		help: "使用上下方向键选择，Enter 确认，Escape 返回。额度以账户服务为准。",
		menuTitle: "同会话编码模型设置",
		tabProvider: "提供商",
		tabModel: "模型",
		tabEffort: "Effort",
		tabSave: "保存并使用",
		selectProviderTitle: "选择提供商 · 全部可用提供商",
		selectModelTitleAll: "选择模型 · 全部可用模型",
		selectModelTitleProvider: provider => `选择模型 · ${provider}`,
		selectEffortTitle: (provider, id) => `选择 Effort · ${provider}/${id}`,
		effortDescription: effort => (effort === AUTO_THINKING ? "按每个提示自动判断" : `${effort} 推理等级`),
		modelsCount: count => `${count} 个模型`,
		notSelected: "请选择",
		pendingSelection: "请完成选择",
		showNotice: (selection, scope) => `当前编码模型：${selection}。用于本对话的编码阶段。存储范围：${scope}。`,
		savedNotice: (selection, scope) => `已保存编码模型：${selection}。下一次编码阶段生效。存储范围：${scope}。`,
		errCheckProvider: "请检查所选提供商的认证和模型目录。",
		errConflict: "菜单打开期间，编码模型设置已发生变化。请重新打开 /code-model 并核对当前值。",
		errSelectProvider: "请选择目录中的提供商。",
		errSelectModel: "请选择模型目录中的选项。",
		errSelectEffort: "请选择当前模型支持的 Effort。",
		errSelectFirst: "请先选择提供商和模型。",
		errInteractiveOnly: "请在交互式 OMP 中打开设置菜单。",
		errUsage: "使用 /code-model 配置，/code-model show 查看，或 /code-model models 浏览全部模型。",
		errInvalidOption: "请选择菜单中的选项。",
	},
};

export function resolveCodeModelLanguage(env: Record<string, string | undefined> = process.env): Language {
	const locale = env.CODE_MODEL_LANG ?? env.LC_ALL ?? env.LANG ?? "";
	return locale.toLowerCase().startsWith("zh") ? "zh" : "en";
}

export function availableCodeModels(ctx: Pick<ExtensionContext, "models">): Model[] {
	return [
		...new Map(
			ctx.models
				.list()
				.filter(model => model.input.includes("text") && model.supportsTools !== false)
				.map(model => [`${model.provider}/${model.id}`, model]),
		).values(),
	].sort((a, b) => `${a.provider}/${a.id}`.localeCompare(`${b.provider}/${b.id}`));
}

export function resolveCodeModelSelection(settings: Settings, models: Model[]): CodeModelSelection | undefined {
	const resolved = resolveModelRoleValue(settings.getModelRole("code"), models, { settings });
	if (!resolved.model || resolved.model.supportsTools === false || !resolved.model.input.includes("text"))
		return undefined;
	return {
		model: resolved.model,
		effort: resolved.explicitThinkingLevel ? (resolved.thinkingLevel ?? AUTO_THINKING) : AUTO_THINKING,
	};
}

function describeSelection(selection: CodeModelSelection): string {
	return `${formatModelStringWithRouting(selection.model)} · ${selection.effort}`;
}

function storageScope(settings: Settings): "global" | "project" {
	return settings.get("modelRoleStorage") === "project" ? "project" : "global";
}

export async function saveCodeModelSelection(
	settings: Settings,
	selection: CodeModelSelection,
	expectedRoleValue: string | undefined,
): Promise<void> {
	if (settings.getModelRole("code") !== expectedRoleValue) throw new Error("CODE_MODEL_CONFIG_CONFLICT");
	const value = formatModelSelectorValue(formatModelStringWithRouting(selection.model), selection.effort);
	if (storageScope(settings) === "project") settings.setProjectModelRole("code", value);
	else settings.setModelRole("code", value);
	await settings.flush();
}

function effortsFor(model: Model): ConfiguredThinkingLevel[] {
	return [AUTO_THINKING, ...getSupportedEfforts(model)];
}

async function pickProvider(
	ctx: MenuContext,
	current: CodeModelSelection | undefined,
	t: Messages,
): Promise<string | undefined> {
	const models = availableCodeModels(ctx);
	if (models.length === 0) throw new Error(t.errCheckProvider);
	const providers = [...new Set(models.map(model => model.provider))].sort();
	const selected = await ctx.ui.select(
		t.selectProviderTitle,
		providers.map(provider => ({
			label: provider,
			description: t.modelsCount(models.filter(model => model.provider === provider).length),
		})),
		{ initialIndex: Math.max(0, providers.indexOf(current?.model.provider ?? "")), helpText: t.help },
	);
	if (selected === undefined) return undefined;
	if (!providers.includes(selected)) throw new Error(t.errSelectProvider);
	return selected;
}

async function pickModel(
	ctx: MenuContext,
	current: CodeModelSelection | undefined,
	t: Messages,
	options: { all?: boolean; provider?: string } = {},
): Promise<Model | undefined> {
	const available = availableCodeModels(ctx);
	const models =
		options.all || !options.provider ? available : available.filter(model => model.provider === options.provider);
	if (models.length === 0) throw new Error(t.errCheckProvider);
	const labels = models.map(model => `${model.provider}/${model.id}`);
	const selected = await ctx.ui.select(
		options.all || !options.provider ? t.selectModelTitleAll : t.selectModelTitleProvider(options.provider),
		models.map((model, index) => ({ label: labels[index], description: model.name ?? model.id })),
		{
			initialIndex: Math.max(
				0,
				models.findIndex(model => model.provider === current?.model.provider && model.id === current?.model.id),
			),
			helpText: t.help,
		},
	);
	if (selected === undefined) return undefined;
	const picked = models[labels.indexOf(selected)];
	if (!picked) throw new Error(t.errSelectModel);
	return picked;
}

async function pickEffort(
	ctx: MenuContext,
	model: Model,
	current: ConfiguredThinkingLevel | undefined,
	t: Messages,
): Promise<ConfiguredThinkingLevel | undefined> {
	const efforts = effortsFor(model);
	const selected = await ctx.ui.select(
		t.selectEffortTitle(model.provider, model.id),
		efforts.map(effort => ({
			label: getConfiguredThinkingLevelMetadata(effort).label,
			description: t.effortDescription(effort),
		})),
		{ initialIndex: Math.max(0, efforts.indexOf(current ?? AUTO_THINKING)), helpText: t.help },
	);
	if (selected === undefined) return undefined;
	const effort = efforts.find(value => getConfiguredThinkingLevelMetadata(value).label === selected);
	if (!effort) throw new Error(t.errSelectEffort);
	return effort;
}

export async function runCodeModelMenu(args: string, ctx: ExtensionCommandContext, settings: Settings): Promise<void> {
	const t = MESSAGES[resolveCodeModelLanguage()];
	try {
		const words = args.trim().split(/\s+/).filter(Boolean);
		const initialRoleValue = settings.getModelRole("code");
		const initial = resolveCodeModelSelection(settings, availableCodeModels(ctx));
		if (words[0] === "show" && words.length === 1) {
			ctx.ui.notify(
				initial ? t.showNotice(describeSelection(initial), storageScope(settings)) : t.errSelectFirst,
				initial ? "info" : "error",
			);
			return;
		}
		const browseAll = words[0] === "models" && words.length === 1;
		if (words.length > 1 || (words.length === 1 && !browseAll)) throw new Error(t.errUsage);
		if (!ctx.hasUI) {
			if (browseAll) throw new Error(t.errInteractiveOnly);
			ctx.ui.notify(
				initial ? t.showNotice(describeSelection(initial), storageScope(settings)) : t.errSelectFirst,
				initial ? "info" : "error",
			);
			return;
		}

		let staged = initial;
		let provider = staged?.model.provider;
		let menuIndex = 0;
		if (browseAll) {
			const picked = await pickModel(ctx, staged, t, { all: true });
			if (!picked) return;
			provider = picked.provider;
			staged = {
				model: picked,
				effort: effortsFor(picked).includes(staged?.effort ?? AUTO_THINKING)
					? (staged?.effort ?? AUTO_THINKING)
					: AUTO_THINKING,
			};
			menuIndex = 2;
		}

		while (true) {
			const action = await ctx.ui.select(
				t.menuTitle,
				[
					{ label: t.tabProvider, description: provider ?? t.notSelected },
					{ label: t.tabModel, description: staged ? formatModelStringWithRouting(staged.model) : t.notSelected },
					{ label: t.tabEffort, description: staged?.effort ?? t.notSelected },
					{ label: t.tabSave, description: staged ? describeSelection(staged) : t.pendingSelection },
				],
				{ initialIndex: menuIndex, helpText: t.help },
			);
			if (action === undefined) return;

			if (action === t.tabProvider) {
				menuIndex = 0;
				const picked = await pickProvider(ctx, staged, t);
				if (picked !== undefined) {
					if (picked !== provider) staged = undefined;
					provider = picked;
					menuIndex = 1;
				}
				continue;
			}
			if (action === t.tabModel) {
				if (!provider) {
					ctx.ui.notify(t.errSelectFirst, "error");
					menuIndex = 0;
					continue;
				}
				const picked = await pickModel(ctx, staged, t, { provider });
				if (picked) {
					const effort = effortsFor(picked).includes(staged?.effort ?? AUTO_THINKING)
						? (staged?.effort ?? AUTO_THINKING)
						: AUTO_THINKING;
					staged = { model: picked, effort };
					menuIndex = 2;
				}
				continue;
			}
			if (action === t.tabEffort) {
				if (!staged) {
					ctx.ui.notify(t.errSelectFirst, "error");
					menuIndex = provider ? 1 : 0;
					continue;
				}
				const effort = await pickEffort(ctx, staged.model, staged.effort, t);
				if (effort) {
					staged = { ...staged, effort };
					menuIndex = 3;
				}
				continue;
			}
			if (action === t.tabSave) {
				if (!staged) {
					ctx.ui.notify(t.errSelectFirst, "error");
					menuIndex = provider ? 1 : 0;
					continue;
				}
				try {
					await saveCodeModelSelection(settings, staged, initialRoleValue);
				} catch (error) {
					if (error instanceof Error && error.message === "CODE_MODEL_CONFIG_CONFLICT")
						throw new Error(t.errConflict);
					throw error;
				}
				ctx.ui.notify(t.savedNotice(describeSelection(staged), storageScope(settings)), "info");
				return;
			}
			throw new Error(t.errInvalidOption);
		}
	} catch (error) {
		ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
	}
}
