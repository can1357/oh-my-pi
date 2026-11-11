# publish

> Publish a local HTML or Markdown file as a hosted web page — on claude.ai Artifacts or through the configured blob destinations — and manage published pages.

## Source

- Entry: `packages/coding-agent/src/tools/publish.ts`
- Model-facing prompt: `packages/coding-agent/src/prompts/tools/publish.md`
- Page store and host selection: `packages/coding-agent/src/publish/pages.ts`
- claude.ai Artifacts client: `packages/coding-agent/src/publish/claude-artifacts.ts`
- Markdown page shell: `packages/coding-agent/src/publish/markdown-page.html.txt`
- Settings: `packages/coding-agent/src/publish/settings.ts` (`publish.backends`)
- Uploaders: `packages/coding-agent/src/blob-broker/uploaders*.ts`

The tool is registered while `publish.backends` is non-empty or an Anthropic OAuth credential is stored. It is `discoverable` (mounted under `xd://publish` when xdev is on).

## Hosts

- **claude.ai Artifacts** — used for new pages when `publish.backends` is empty. Authenticates with the Anthropic OAuth access token (an API key cannot publish) against the frame API on `api.anthropic.com` (`POST /api/frame/deploy/direct`, `DELETE /api/frame/<slug>`, `POST|DELETE /api/frame/favorite/<slug>`), sending Claude Code's client headers. The page records the account and organization that created it; update, pin and delete use exactly that login and fail if it is no longer stored. Pages are private to that claude.ai account until shared there and live at `https://claude.ai/code/artifact/<slug>`. Updates keep the URL and send the last published version as `baseVersion`; if the artifact changed on claude.ai since, the publish fails unless `force` adopts the live version as the base. Content without a doctype gets `<!DOCTYPE html>` prepended. No separate assets. The tool appears while an Anthropic OAuth credential is stored and follows sign-in/sign-out within a session.
- **Object storage** — `publish.backends` is an ordered list of destinations for new pages; a non-empty list overrides claude.ai. Only destinations whose uploaders replace an object in place and delete it with current credentials qualify: `amazon-s3`, `r2`, `tigris`, `minio`, `garage`, `google-cloud-storage`, `azure-storage`, and `backblaze-b2` with S3-compatible keys (native B2 keys create a new version per upload and are rejected). Options and credentials come from `images.urls.options.<destination>` and `images.urls.credentials.<destination>`, the same records image URL backends use.

A page is bound to the host that created it: the claude.ai account, or the blob destination recorded on the page. Updates, assets and deletes always go there; changing `publish.backends` affects only new pages, and a failing destination fails the operation instead of moving the page.

Example blob configuration (Cloudflare R2 with a public bucket domain):

```yaml
publish:
  backends: [r2]
images:
  urls:
    options:
      r2: { accountId: "<account>", bucket: pages, publicBaseUrl: "https://pages.example.com", keyPrefix: omp }
    credentials:
      r2: { accessKeyId: "<key>", secretAccessKey: "<secret>" }
```

## Inputs

| Field     | Type                                                                          | Required | Description                                                                  |
| --------- | ----------------------------------------------------------------------------- | -------: | ---------------------------------------------------------------------------- |
| `action`  | `publish` \| `upload_asset` \| `list` \| `read` \| `delete` \| `pin` \| `unpin` |       No | Defaults to `publish`.                                                       |
| `path`    | `string`                                                                      |   Varies | `publish`: `.html`/`.htm`/`.md`/`.markdown`; `upload_asset`: any file. Resolved against cwd. |
| `page`    | `string`                                                                      |   Varies | Page id or any URL the page or its assets were served at.                     |
| `title`   | `string`                                                                      |       No | Title override.                                                              |
| `version` | `number.integer >= 1`                                                         |       No | `read`: version whose stored HTML path to return; defaults to latest. The tool returns the shortened path for the regular `read` tool, not the HTML itself. |
| `scope`   | `project` \| `all`                                                            |       No | `list`: defaults to pages created from the current project.                  |
| `force`   | `boolean`                                                                     |       No | `publish`: overwrite a claude.ai version changed elsewhere.                  |

## Flow

1. `publish` renders Markdown with `Bun.markdown.html` into the page shell; HTML is published verbatim. Title precedence: `title`, then the existing page's title on updates, then `<title>` / first `#` heading, then the filename.
2. claude.ai pages deploy as described under Hosts. Blob pages are one object at `<keyPrefix>/<pageId>/index.html`, with assets at `<keyPrefix>/<pageId>/<name>`; each version and each re-uploaded asset overwrites its object, so URLs are stable and relative asset references resolve.
3. A new blob page goes to the first destination in `publish.backends` that accepts it; when all fail, every failure is aggregated into the error.
4. Each version's HTML and metadata are stored under `~/.omp/agent/published/<pageId>/` (`page.json`, `v<N>.html`).
5. `delete` deletes the claude.ai artifact as its owning account, or the page object and every asset with the destination's current credentials. The local record is kept when any deletion fails, so `delete` can be retried.

## Approval

`publish`, `upload_asset`, and `delete` are `exec` tier with a reason; `pin`/`unpin` are `write`; `list`/`read` are `read`.

## Notes

- Page ids are 128-bit random hex, so object-storage URLs are unguessable but readable by anyone holding the link.
- Pinned pages list first and refuse `delete` until unpinned; pinning a claude.ai page also pins it to the claude.ai sidebar.
- Network operations follow the tool call's cancellation and give up after 120 seconds.
