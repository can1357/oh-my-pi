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

- **claude.ai Artifacts** — used for new pages when `publish.backends` is empty. Authenticates with the Anthropic OAuth access token (an API key cannot publish) against the frame API on `api.anthropic.com` (`POST /api/frame/deploy/direct`, `DELETE /api/frame/<slug>`, `POST|DELETE /api/frame/favorite/<slug>`), sending Claude Code's client headers. Pages are private to the user's claude.ai account until shared there and live at `https://claude.ai/code/artifact/<slug>`. Updates keep the URL and send the last published version as `baseVersion`; if the artifact changed on claude.ai since, the publish fails unless `force` adopts the live version as the base. Content without a doctype gets `<!DOCTYPE html>` prepended. No separate assets.
- **Blob destinations** — `publish.backends` is an ordered list of blob destinations; a non-empty list overrides claude.ai for new pages. Destination options and credentials come from `images.urls.options.<destination>` and `images.urls.credentials.<destination>`, the same records image URL backends use. Serving/tunnel destinations, provider files, image/video hosts, and messaging targets are excluded: their URLs either die with the omp process or cannot serve HTML.

A page stays on the host it was created on: changing `publish.backends` affects only new pages.

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
| `version` | `number.integer >= 1`                                                         |       No | `read`: version to return; defaults to latest.                               |
| `scope`   | `project` \| `all`                                                            |       No | `list`: defaults to pages created from the current project.                  |
| `force`   | `boolean`                                                                     |       No | `publish`: overwrite a claude.ai version changed elsewhere.                  |

## Flow

1. `publish` renders Markdown with `Bun.markdown.html` into the page shell; HTML is published verbatim. Title precedence: `title`, then the existing page's title on updates, then `<title>` / first `#` heading, then the filename.
2. claude.ai pages deploy as described under Hosts. Blob uploads go to `<keyPrefix>/<pageId>/index.html` (assets `<keyPrefix>/<pageId>/<name>`) with `text/html; charset=utf-8`. Object storage destinations (S3, R2, Tigris, MinIO, Garage, B2, GCS, Azure) overwrite that object, so the URL is stable across versions and relative asset references resolve. Flat destinations return a new URL per upload; the result reports the change.
3. The blob chain is tried in order; an update tries the page's current destination first. Every failure is aggregated into the thrown error.
4. Each version's HTML and metadata are stored under `~/.omp/agent/published/<pageId>/` (`page.json`, `v<N>.html`).
5. `delete` deletes the claude.ai artifact, or every distinct remote blob object: destinations with live-credential deletion (S3 family) re-sign the request; others replay the delete request captured at upload. Objects whose destination offers no deletion are reported as still online. The local record is kept when any deletion fails.

## Approval

`publish`, `upload_asset`, and `delete` are `exec` tier with a reason; `pin`/`unpin` are `write`; `list`/`read` are `read`.

## Notes

- Page ids are 128-bit random hex, so object-storage URLs are unguessable but readable by anyone holding the link.
- Pinned pages list first and refuse `delete` until unpinned; pinning a claude.ai page also pins it to the claude.ai sidebar.
