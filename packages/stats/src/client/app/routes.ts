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
	shortLabel?: string;
	icon: React.ComponentType<{ size?: number; className?: string }>;
}

export const routes: DashboardRoute[] = [
	{
		id: "overview",
		label: "Overview",
		icon: LayoutDashboard,
	},
	{
		id: "requests",
		label: "Requests",
		icon: Activity,
	},
	{
		id: "traces",
		label: "Traces",
		icon: ListTree,
	},
	{
		id: "errors",
		label: "Errors",
		icon: AlertCircle,
	},
	{
		id: "models",
		label: "Models",
		icon: Cpu,
	},
	{
		id: "providers",
		label: "Providers",
		icon: Plug,
	},
	{
		id: "tools",
		label: "Tools",
		icon: Wrench,
	},
	{
		id: "costs",
		label: "Costs",
		icon: Coins,
	},
	{
		id: "behavior",
		label: "Behavior",
		shortLabel: "Behavior",
		icon: Smile,
	},
	{
		id: "projects",
		label: "Projects",
		icon: Folder,
	},
	{
		id: "gain",
		label: "Gain",
		icon: TrendingUp,
	},
];
