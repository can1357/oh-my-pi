import * as path from "node:path";
import { type } from "@oh-my-pi/omptype";
import type { AgentTool, AgentToolResult, ToolApprovalDecision } from "@oh-my-pi/pi-agent-core";
import { ToolError } from "@oh-my-pi/pi-tui/tools/tool-errors";
import { shortenPath } from "@oh-my-pi/pi-tui/render/render-utils";
import { isEnoent } from "@oh-my-pi/pi-utils";
import publishDescription from "../prompts/tools/publish.md" with { type: "text" };
import { ClaudeArtifactsClient } from "../publish/claude-artifacts";
import { assetName, PagePublisher, type PublishedPage, renderPageSource } from "../publish/pages";
import type { ToolSession } from ".";
import { resolveToCwd } from "./path-utils";

const publishSchema = type({
	"action?": type("'publish' | 'upload_asset' | 'list' | 'read' | 'delete' | 'pin' | 'unpin'").describe(
		"defaults to publish",
	),
	"path?": type("string").describe("publish: .html/.htm/.md/.markdown file; upload_asset: file to upload"),
	"page?": type("string").describe("existing page id or URL"),
	"title?": type("string").describe("page title override"),
	"version?": type("number.integer >= 1").describe("read: version number; defaults to latest"),
	"scope?": type("'project' | 'all'").describe("list: defaults to project"),
	"force?": type("boolean").describe("publish: overwrite a claude.ai version changed elsewhere"),
});

export type PublishParams = typeof publishSchema.infer;

export interface PublishToolDetails {
	action: NonNullable<PublishParams["action"]>;
	pageId?: string;
	url?: string;
}

function describePage(page: PublishedPage): string {
	const latest = page.versions[page.versions.length - 1];
	const pin = page.pinned ? " [pinned]" : "";
	const lines = [
		`${page.title}${pin} (${page.id}, v${latest.version} on ${page.claudeSlug ? "claude.ai" : page.destination}, updated ${new Date(page.updatedAt).toISOString()})`,
		`  ${latest.url}`,
	];
	for (const asset of page.assets) lines.push(`  asset ${asset.name}: ${asset.publication.url}`);
	return lines.join("\n");
}

async function readSource<T>(
	file: Bun.BunFile,
	displayPath: string,
	read: (file: Bun.BunFile) => Promise<T>,
): Promise<T> {
	try {
		return await read(file);
	} catch (error) {
		if (isEnoent(error)) throw new ToolError(`File not found: ${displayPath}`);
		throw error;
	}
}

/** Publishes local HTML/Markdown files as hosted pages on claude.ai or through `publish.backends`. */
export class PublishTool implements AgentTool<typeof publishSchema, PublishToolDetails> {
	readonly name = "publish";
	readonly label = "Publish";
	readonly description = publishDescription.trim();
	readonly parameters = publishSchema;
	readonly strict = true;
	readonly loadMode = "discoverable" as const;
	readonly summary = "Publish an HTML or Markdown file as a hosted web page";
	/** Uploading and deleting reach the network and expose content; listing and reading stay local. */
	readonly approval = (args: unknown): ToolApprovalDecision => {
		const action = (args as Partial<PublishParams>).action ?? "publish";
		if (action === "list" || action === "read") return "read";
		if (action === "pin" || action === "unpin") return "write";
		return {
			tier: "exec",
			reason: action === "delete" ? "Deletes a published page" : "Uploads content to a hosted page",
		};
	};

	#publisher: PagePublisher;

	constructor(private readonly session: ToolSession) {
		const auth = session.authStorage;
		const claude = auth
			? new ClaudeArtifactsClient(async owner => {
					if (!owner) {
						const access = await auth.oauth.access("anthropic", session.getSessionId?.() ?? undefined);
						if (!access) return undefined;
						const { accessToken, accountId, orgId, email } = access;
						return { token: accessToken, account: { accountId, orgId, email } };
					}
					// An artifact belongs to one account and organization: reach exactly that login.
					const login = auth.oauth
						.accounts("anthropic")
						.find(account => account.accountId === owner.accountId && account.orgId === owner.orgId);
					const access = login && (await auth.oauth.accessById("anthropic", login.credentialId));
					return access?.ok ? { token: access.accessToken, account: owner } : undefined;
				})
			: undefined;
		this.#publisher = new PagePublisher(session.settings, { claude });
	}

	async execute(_toolCallId: string, params: PublishParams): Promise<AgentToolResult<PublishToolDetails>> {
		const action = params.action ?? "publish";
		switch (action) {
			case "publish":
				return this.#publish(params);
			case "upload_asset":
				return this.#uploadAsset(params);
			case "list":
				return this.#list(params);
			case "read":
				return this.#read(params);
			case "delete":
				return this.#delete(params);
			case "pin":
			case "unpin":
				return this.#pin(params, action === "pin");
		}
	}

	async #requirePage(ref: string | undefined, action: string): Promise<PublishedPage> {
		if (!ref?.trim()) throw new ToolError(`page is required for ${action}`);
		const page = await this.#publisher.store.find(ref);
		if (!page) throw new ToolError(`No published page matches ${ref}; use action list to find it`);
		return page;
	}

	#sourcePath(params: PublishParams, action: string): string {
		if (!params.path?.trim()) throw new ToolError(`path is required for ${action}`);
		return resolveToCwd(params.path, this.session.cwd);
	}

	async #publish(params: PublishParams): Promise<AgentToolResult<PublishToolDetails>> {
		const absolute = this.#sourcePath(params, "publish");
		const existing = params.page ? await this.#requirePage(params.page, "publish") : undefined;
		const text = await readSource(Bun.file(absolute), params.path!, file => file.text());
		const rendered = renderPageSource(absolute, text, params.title ?? existing?.title);
		const { page, version } = await this.#publisher.publish({
			html: rendered.html,
			title: rendered.title,
			source: absolute,
			projectDir: path.resolve(this.session.cwd),
			existing,
			force: params.force,
		});
		const lines = [`Published "${page.title}" v${version.version} (${page.id}): ${version.url}`];
		if (page.claudeSlug && !existing) {
			lines.push("The artifact is private to the user's claude.ai account until they share it.");
		}
		return {
			content: [{ type: "text", text: lines.join("\n") }],
			details: { action: "publish", pageId: page.id, url: version.url },
		};
	}

	async #uploadAsset(params: PublishParams): Promise<AgentToolResult<PublishToolDetails>> {
		const absolute = this.#sourcePath(params, "upload_asset");
		const page = await this.#requirePage(params.page, "upload_asset");
		const file = Bun.file(absolute);
		const bytes = await readSource(file, params.path!, source => source.bytes());
		const asset = await this.#publisher.uploadAsset(page, assetName(absolute), bytes, file.type);
		return {
			content: [{ type: "text", text: `Uploaded ${asset.name} to page ${page.id}: ${asset.publication.url}` }],
			details: { action: "upload_asset", pageId: page.id, url: asset.publication.url },
		};
	}

	async #list(params: PublishParams): Promise<AgentToolResult<PublishToolDetails>> {
		const projectDir = path.resolve(this.session.cwd);
		const pages = (await this.#publisher.store.list())
			.filter(page => params.scope === "all" || page.projectDir === projectDir)
			.sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.updatedAt - a.updatedAt);
		const text =
			pages.length === 0
				? params.scope === "all"
					? "No published pages."
					: "No published pages in this project; scope all lists every project."
				: pages.map(describePage).join("\n");
		return { content: [{ type: "text", text }], details: { action: "list" } };
	}

	async #read(params: PublishParams): Promise<AgentToolResult<PublishToolDetails>> {
		const page = await this.#requirePage(params.page, "read");
		const version = page.versions[(params.version ?? page.versions.length) - 1];
		if (!version) throw new ToolError(`Page ${page.id} has versions 1-${page.versions.length}`);
		const file = shortenPath(this.#publisher.store.versionPath(page.id, version.version));
		return {
			content: [
				{
					type: "text",
					text: `${describePage(page)}\nv${version.version} was published from ${shortenPath(version.source)}; its HTML is at ${file} (open it with the read tool).`,
				},
			],
			details: { action: "read", pageId: page.id, url: version.url },
		};
	}

	async #delete(params: PublishParams): Promise<AgentToolResult<PublishToolDetails>> {
		const page = await this.#requirePage(params.page, "delete");
		if (page.pinned) throw new ToolError(`Page ${page.id} is pinned; unpin it before deleting`);
		const result = await this.#publisher.remove(page);
		const lines = [
			result.removed
				? `Deleted "${page.title}" (${page.id}).`
				: `Kept the record of "${page.title}" (${page.id}) because some deletions failed; retry delete.`,
		];
		for (const url of result.deleted) lines.push(`removed ${url}`);
		for (const error of result.errors) lines.push(`failed ${error}`);
		return {
			content: [{ type: "text", text: lines.join("\n") }],
			details: { action: "delete", pageId: page.id },
			...(result.removed ? {} : { isError: true }),
		};
	}

	async #pin(params: PublishParams, pinned: boolean): Promise<AgentToolResult<PublishToolDetails>> {
		const page = await this.#requirePage(params.page, pinned ? "pin" : "unpin");
		await this.#publisher.setPinned(page, pinned);
		return {
			content: [{ type: "text", text: `${pinned ? "Pinned" : "Unpinned"} "${page.title}" (${page.id}).` }],
			details: { action: pinned ? "pin" : "unpin", pageId: page.id },
		};
	}
}
