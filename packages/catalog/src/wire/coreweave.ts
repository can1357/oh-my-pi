export const COREWEAVE_PROJECT_HEADER = "OpenAI-Project" as const;

export interface CoreWeaveProjectEnv {
	[key: string]: string | undefined;
	COREWEAVE_PROJECT?: string;
	WANDB_INFERENCE_PROJECT?: string;
	WANDB_ENTITY?: string;
	WANDB_PROJECT?: string;
}

function cleanEnvValue(value: string | undefined): string | undefined {
	const trimmed = value?.trim();
	return trimmed ? trimmed : undefined;
}

export function resolveCoreWeaveProject(env: CoreWeaveProjectEnv): string | undefined {
	const explicitProject = cleanEnvValue(env.COREWEAVE_PROJECT) ?? cleanEnvValue(env.WANDB_INFERENCE_PROJECT);
	if (explicitProject) {
		return explicitProject;
	}

	const wandbProject = cleanEnvValue(env.WANDB_PROJECT);
	if (!wandbProject) {
		return undefined;
	}
	if (wandbProject.includes("/")) {
		return wandbProject;
	}

	const wandbEntity = cleanEnvValue(env.WANDB_ENTITY);
	return wandbEntity ? `${wandbEntity}/${wandbProject}` : undefined;
}

export function coreWeaveProjectHeaders(env: CoreWeaveProjectEnv): Record<string, string> | undefined {
	const project = resolveCoreWeaveProject(env);
	return project ? { [COREWEAVE_PROJECT_HEADER]: project } : undefined;
}

export function hasCoreWeaveProjectHeader(headers: Record<string, string>): boolean {
	const normalized = COREWEAVE_PROJECT_HEADER.toLowerCase();
	return Object.keys(headers).some(header => header.toLowerCase() === normalized);
}
