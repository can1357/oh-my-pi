/** @jsxImportSource @oh-my-pi/pi-tui */
/**
 * The MCP OAuth fallback block: always the full authorization URL as the
 * primary target (it works from any machine, including SSH/WSL/headless
 * sessions where the flow's loopback `/launch` URL would resolve against the
 * user's own browser and fail), plus that `/launch` shortcut for local users.
 * Natively the link opens on click and the URLs copy on click.
 *
 * Terminal look: `src/ui/styles/messages/mcp-auth.ts`.
 */
import type { JSXNode } from "@oh-my-pi/pi-tui";
import "../../styles/messages/mcp-auth";

/** A labelled URL that copies on click and wraps anywhere, so no parameter is hidden. */
function UrlCopyRow(props: { readonly label: string; readonly url: string }): JSXNode {
	return (
		<text
			spans={[
				{ t: `${props.label} `, s: "muted" },
				{ t: props.url, s: "mono", href: props.url },
			]}
			wrap="char"
			href={props.url}
			actions={{ click: "copy", menu: ["copy", "open"] }}
			title="Copy URL"
		/>
	);
}

export function McpAuthorizationLink(props: { readonly url: string; readonly launchUrl?: string }): JSXNode {
	const launchUrl = props.launchUrl && props.launchUrl !== props.url ? props.launchUrl : undefined;
	return (
		<col role="omp.mcp.auth-link" gap="xs" term={{ url: props.url, launchUrl }}>
			<text spans={[{ t: "Open authorization URL:", s: "success" }]} />
			<text
				spans={[{ t: "Click here to authorize", s: "link", href: props.url }]}
				href={props.url}
				actions={{ click: "open", menu: ["open", "copy"] }}
			/>
			<UrlCopyRow label="Copy URL:" url={props.url} />
			{launchUrl && <UrlCopyRow label="Local shortcut (this machine only):" url={launchUrl} />}
		</col>
	);
}
