import {
	Activity,
	CircleAlert,
	Coins,
	Cpu,
	FolderGit2,
	Frown,
	LayoutGrid,
	type LucideIcon,
	PlugZap,
	Sparkles,
	SquareChartGantt,
	Wrench,
} from "lucide-react";

export type DashboardSection =
	| "overview"
	| "models"
	| "providers"
	| "costs"
	| "requests"
	| "errors"
	| "traces"
	| "tools"
	| "frustration"
	| "projects"
	| "gain";

export interface NavItem {
	id: DashboardSection;
	label: string;
	icon: LucideIcon;
	/** Second key of the `g <key>` jump shortcut. */
	hotkey: string;
}

export interface NavGroup {
	heading: string;
	items: readonly NavItem[];
}

/** Sidebar structure; the order here is the order on screen. */
export const NAV: readonly NavGroup[] = [
	{
		heading: "Usage",
		items: [
			{ id: "overview", label: "Overview", icon: LayoutGrid, hotkey: "o" },
			{ id: "models", label: "Models", icon: Cpu, hotkey: "m" },
			{ id: "providers", label: "Providers", icon: PlugZap, hotkey: "p" },
			{ id: "costs", label: "Costs", icon: Coins, hotkey: "c" },
		],
	},
	{
		heading: "Activity",
		items: [
			{ id: "requests", label: "Requests", icon: Activity, hotkey: "r" },
			{ id: "errors", label: "Errors", icon: CircleAlert, hotkey: "e" },
			{ id: "traces", label: "Traces", icon: SquareChartGantt, hotkey: "t" },
		],
	},
	{
		heading: "Insights",
		items: [
			{ id: "tools", label: "Tools", icon: Wrench, hotkey: "l" },
			{ id: "frustration", label: "Frustration", icon: Frown, hotkey: "f" },
			{ id: "projects", label: "Projects", icon: FolderGit2, hotkey: "j" },
			{ id: "gain", label: "Gain", icon: Sparkles, hotkey: "g" },
		],
	},
];

export const NAV_ITEMS: readonly NavItem[] = NAV.flatMap(group => group.items);

export const SECTIONS: readonly DashboardSection[] = NAV_ITEMS.map(item => item.id);

export function navItem(section: DashboardSection): NavItem {
	return NAV_ITEMS.find(item => item.id === section) ?? NAV_ITEMS[0];
}
