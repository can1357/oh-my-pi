# Environments-cloud (pkscloudenvs) routing from OMPK

## Purpose

On MSI-1, **mesh / cloud / auth / codespace-style remote launch** is not owned by OMPK phase-1 Docker remote-workspace. The source of truth is:

| | |
| --- | --- |
| **MSI-local canonical root** | `C:\dev\desktop-infra\environments-cloud` |
| **Upstream** | [kingkillery/pkscloudenvs](https://github.com/kingkillery/pkscloudenvs) |
| **Override env** | `OMPK_ENVIRONMENTS_CLOUD_ROOT` (or `PKS_ENVIRONMENTS_CLOUD_ROOT`) |

`packages/remote-workspace` is local Docker sandbox jobs only.

## Session / skill routing

```text
C:\dev\desktop-infra\environments-cloud\.agents\skills\
  mesh-orchestrator\SKILL.md
  colab-warmup\SKILL.md
```

**Automatic:** `loadSkills()` includes that directory when it exists (`packages/coding-agent/src/config/environments-cloud-skills.ts`).

**Library / CLI:**

```sh
cd packages/remote-workspace
bun src/cli.ts environments
bun src/cli.ts environments skill mesh-orchestrator
bun src/cli.ts environments handoff mesh status
bun src/cli.ts environments handoff cloud status
```

```ts
import {
	resolveEnvironmentsCloudRoot,
	resolveMeshHandoff,
	environmentsCloudSkillCustomDirectories,
} from "@pk-nerdsaver-ai/pi-remote-workspace";
```

## Auth / launch handoff entrypoints

Under `{root}/.agents/bin/`: `cloud`, `mesh`, `mesh-run`, `mesh-sync`, `mesh-ci`, `colab`, `colab-kill-all`.

Spawn the argv returned by `resolveMeshHandoff` — do not invent a parallel cloud stack inside OMPK.

## Related

- Package README: `packages/remote-workspace/README.md`
- Wiki: `.wiki/concepts/environments-cloud-routing.md`
- Skills discovery: `docs/skills.md`
