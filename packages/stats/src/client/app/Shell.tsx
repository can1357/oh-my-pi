import { Menu } from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";
import { rangeMeta, TIME_RANGES } from "../data/range";
import { useLive } from "../data/live";
import type { TimeRange } from "../types";
import { Segmented } from "../ui";
import { LiveChip } from "./LiveChip";
import { type DashboardSection, NAV } from "./nav";
import { ThemeToggle } from "./ThemeToggle";

export interface ShellProps {
	section: DashboardSection;
	onSectionChange: (section: DashboardSection) => void;
	range: TimeRange;
	onRangeChange: (range: TimeRange) => void;
	children: ReactNode;
}

const RANGE_OPTIONS = TIME_RANGES.map((range, i) => ({
	value: range,
	label: rangeMeta(range).label,
	title: `${rangeMeta(range).windowLabel} (${i + 1})`,
}));

/**
 * Fixed glass topbar + naked sidebar framing one inset content panel. Owns
 * the global keyboard shortcuts: `1`–`6` pick a range, `g` then a letter jumps
 * to a page.
 */
export function Shell({ section, onSectionChange, range, onRangeChange, children }: ShellProps) {
	const [menuOpen, setMenuOpen] = useState(false);
	const scrolled = useScrolled();
	const { sync } = useLive();
	useShortcuts(onSectionChange, onRangeChange);

	const go = (next: DashboardSection) => {
		onSectionChange(next);
		setMenuOpen(false);
		window.scrollTo({ top: 0 });
	};

	const progress = sync.phase === "syncing" ? (sync.total > 0 ? sync.current / sync.total : null) : undefined;

	return (
		<>
			<div className="shell-ambient" />
			<header className="topbar" data-scrolled={scrolled}>
				<button
					type="button"
					className="btn topbar-menu"
					data-variant="ghost"
					data-icon="true"
					onClick={() => setMenuOpen(true)}
					aria-label="Open navigation"
				>
					<Menu size={16} />
				</button>
				<div className="topbar-brand">
					<svg className="topbar-mark" viewBox="0 0 64 64" width="22" height="22" aria-hidden="true">
						<defs>
							<linearGradient id="omp-mark-grad" x1="0" y1="0" x2="1" y2="1">
								<stop offset="0" stopColor="oklch(0.7 0.24 340)" />
								<stop offset=".5" stopColor="oklch(0.62 0.21 295)" />
								<stop offset="1" stopColor="oklch(0.81 0.14 200)" />
							</linearGradient>
						</defs>
						<path fill="url(#omp-mark-grad)" d="M10 14h44v9H43v33h-9V23h-9v22h-9V23H10z" />
					</svg>
					<span>omp</span>
					<span className="topbar-slash">/</span>
					<span className="topbar-title">stats</span>
				</div>
				<div className="topbar-spacer" />
				<div className="topbar-actions">
					<span className="topbar-hide-narrow">
						<LiveChip />
					</span>
					<Segmented options={RANGE_OPTIONS} value={range} onChange={onRangeChange} aria-label="Time range" />
					<ThemeToggle />
				</div>
				{progress !== undefined && (
					<div className="topbar-progress">
						<div
							className="topbar-progress-fill"
							data-indeterminate={progress === null}
							style={{ width: `${(progress ?? 0) * 100}%` }}
						/>
					</div>
				)}
			</header>

			{menuOpen && <div className="drawer-scrim" onClick={() => setMenuOpen(false)} role="presentation" />}
			<nav className="sidebar" data-open={menuOpen} aria-label="Pages">
				{NAV.map(group => (
					<div key={group.heading} className="nav-group">
						<div className="nav-heading">{group.heading}</div>
						{group.items.map(item => (
							<button
								key={item.id}
								type="button"
								className="nav-row"
								data-active={item.id === section}
								aria-current={item.id === section ? "page" : undefined}
								onClick={() => go(item.id)}
							>
								<item.icon size={15} />
								<span className="nav-row-label">{item.label}</span>
								<kbd>G {item.hotkey.toUpperCase()}</kbd>
							</button>
						))}
					</div>
				))}
				<div className="sidebar-foot micro">
					<span>
						<span className="kbd">1</span>–<span className="kbd">6</span> range
					</span>
					<span>
						<span className="kbd">G</span> then letter to jump
					</span>
				</div>
			</nav>

			<main className="shell-panel">
				<div className="shell-content">{children}</div>
			</main>
		</>
	);
}

function useScrolled(): boolean {
	const [scrolled, setScrolled] = useState(false);
	useEffect(() => {
		const onScroll = () => setScrolled(window.scrollY > 4);
		onScroll();
		window.addEventListener("scroll", onScroll, { passive: true });
		return () => window.removeEventListener("scroll", onScroll);
	}, []);
	return scrolled;
}

function useShortcuts(onSection: (section: DashboardSection) => void, onRange: (range: TimeRange) => void): void {
	useEffect(() => {
		let pendingG = 0;
		const onKey = (e: KeyboardEvent) => {
			if (e.metaKey || e.ctrlKey || e.altKey || e.defaultPrevented) return;
			const target = e.target;
			if (
				target instanceof HTMLElement &&
				(target.isContentEditable ||
					target.tagName === "INPUT" ||
					target.tagName === "TEXTAREA" ||
					target.tagName === "SELECT")
			) {
				return;
			}
			if (document.querySelector('[aria-modal="true"]')) return;
			const key = e.key.toLowerCase();
			if (pendingG && Date.now() - pendingG < 1200) {
				pendingG = 0;
				const item = NAV.flatMap(group => group.items).find(i => i.hotkey === key);
				if (item) {
					e.preventDefault();
					onSection(item.id);
					window.scrollTo({ top: 0 });
				}
				return;
			}
			if (key === "g") {
				pendingG = Date.now();
				return;
			}
			const index = Number(key) - 1;
			if (Number.isInteger(index) && index >= 0 && index < TIME_RANGES.length) {
				e.preventDefault();
				onRange(TIME_RANGES[index]);
			}
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [onSection, onRange]);
}
