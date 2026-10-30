import type { CSSProperties, ReactNode } from "react";

export interface CardProps {
	title?: ReactNode;
	description?: ReactNode;
	/** Right-aligned header controls (segmented toggles, selects, buttons). */
	actions?: ReactNode;
	/** Body without padding — for full-bleed tables and lists. */
	flush?: boolean;
	footer?: ReactNode;
	className?: string;
	/** Stagger index for the entrance animation. */
	index?: number;
	/** Dim the body while previous data is on screen (see `useQuery().stale`). */
	stale?: boolean;
	children: ReactNode;
}

/** The dashboard's container: top-lit hairline edge, optional header and footer. */
export function Card({ title, description, actions, flush, footer, className, index, stale, children }: CardProps) {
	const hasHeader = title !== undefined || description !== undefined || actions !== undefined;
	return (
		<section
			className={className ? `card rise ${className}` : "card rise"}
			style={index !== undefined ? ({ "--i": index } as CSSProperties) : undefined}
		>
			{hasHeader && (
				<header className="card-header">
					<div className="card-titles">
						{title !== undefined && <h2 className="card-title">{title}</h2>}
						{description !== undefined && <p className="card-description">{description}</p>}
					</div>
					{actions !== undefined && <div className="card-actions">{actions}</div>}
				</header>
			)}
			<div className="card-body" data-flush={flush ?? false} data-stale={stale ?? false}>
				{children}
			</div>
			{footer !== undefined && <footer className="card-footer">{footer}</footer>}
		</section>
	);
}

export interface PageHeaderProps {
	title: ReactNode;
	description?: ReactNode;
	actions?: ReactNode;
}

/** Title band at the top of every page. */
export function PageHeader({ title, description, actions }: PageHeaderProps) {
	return (
		<header className="page-header rise">
			<div>
				<h1 className="page-title">{title}</h1>
				{description !== undefined && <p className="page-description">{description}</p>}
			</div>
			{actions !== undefined && <div className="page-actions">{actions}</div>}
		</header>
	);
}
