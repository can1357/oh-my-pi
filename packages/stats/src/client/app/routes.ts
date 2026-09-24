import {
	Activity,
	AlertCircle,
	Coins,
	Cpu,
	Folder,
	LayoutDashboard,
	ListTree,
	Plug,
	Smile,
	TrendingUp,
	Wrench,
} from "lucide-react";
import type React from "react";
import type { MessageKey } from "@oh-my-pi/pi-i18n";

export type DashboardSection =
	| "overview"
	| "requests"
	| "traces"
	| "errors"
	| "models"
	| "providers"
	| "tools"
	| "costs"
	| "behavior"
	| "projects"
	| "gain";

export interface DashboardRoute {
	id: DashboardSection;
	label: string;
	labelKey: MessageKey;
	shortLabel?: string;
	icon: React.ComponentType<{ size?: number; className?: string }>;
}

export const routes: DashboardRoute[] = [
	{
		id: "overview",
		label: "Overview",
		labelKey: "stats.nav.overview",
		icon: LayoutDashboard,
	},
	{
		id: "requests",
		label: "Requests",
		labelKey: "stats.nav.requests",
		icon: Activity,
	},
	{
		id: "traces",
		label: "Traces",
		labelKey: "stats.nav.traces",
		icon: ListTree,
	},
	{
		id: "errors",
		label: "Errors",
		labelKey: "stats.nav.errors",
		icon: AlertCircle,
	},
	{
		id: "models",
		label: "Models",
		labelKey: "stats.nav.models",
		icon: Cpu,
	},
	{
		id: "providers",
		label: "Providers",
		labelKey: "stats.nav.providers",
		icon: Plug,
	},
	{
		id: "tools",
		label: "Tools",
		labelKey: "stats.nav.tools",
		icon: Wrench,
	},
	{
		id: "costs",
		label: "Costs",
		labelKey: "stats.nav.costs",
		icon: Coins,
	},
	{
		id: "behavior",
		label: "Behavior",
		labelKey: "stats.nav.behavior",
		shortLabel: "Behavior",
		icon: Smile,
	},
	{
		id: "projects",
		label: "Projects",
		labelKey: "stats.nav.projects",
		icon: Folder,
	},
	{
		id: "gain",
		label: "Gain",
		labelKey: "stats.nav.gain",
		icon: TrendingUp,
	},
];
