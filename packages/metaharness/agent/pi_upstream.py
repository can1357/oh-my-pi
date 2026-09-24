"""Harbor agent that runs the upstream `@earendil-works/pi-coding-agent` npm package.

Comparison baseline for `omp_local.py`: same task containers, same host auth
gateway, same output/usage accounting, but the agent under test is upstream pi
installed from npm on top of a downloaded Node runtime.

Model routing goes through a generated `~/.pi/agent/models.json`: one custom
provider per gateway provider, `baseUrl` at the host gateway, and models whose
`id` is the provider-qualified `provider/model` string the gateway resolves
(bare ids fall through to whichever credentialed provider bundles the model
first). Anthropic routes use `anthropic-messages` (`/v1/messages`); everything
else uses `openai-responses` (`/v1/responses`).

The default upstream system prompt names pi and links its docs, which Anthropic
classifies as a third-party client on OAuth accounts (billed to extra usage).
`~/.pi/agent/SYSTEM.md` replaces it with the same text minus the identity line
and the docs section (`OMP_BENCH_PI_SYSTEM_PROMPT` supplies the template; the
`{{CWD}}` placeholder is rendered per trial).

Env knobs (set by the runner; `OMP_BENCH_*` are shared with `omp_local.py`):
`OMP_BENCH_GATEWAY_URL`, `OMP_BENCH_GATEWAY_TOKEN`, `OMP_BENCH_PI_MODELS`
(JSON array of model specs), `OMP_BENCH_PI_SYSTEM_PROMPT` (host path),
`OMP_BENCH_PI_VERSION`, `OMP_BENCH_NODE_VERSION`, `OMP_BENCH_THINKING`,
`OMP_BENCH_TOOLS`, `OMP_BENCH_AGENT_ARGS`, `OMP_BENCH_FORWARD_ENV`.

Selected via `harbor run --agent-import-path pi_upstream:PiUpstream`.
"""

from __future__ import annotations

import json
import os
import shlex
from pathlib import Path
from typing import override

from harbor.agents.installed.base import BaseInstalledAgent, with_prompt_template
from harbor.environments.base import BaseEnvironment
from harbor.models.agent.context import AgentContext

from omp_local import _Usage, _env, _loads

_OUTPUT_FILENAME = "pi.txt"
_MODELS_DST = "/tmp/pi-models.json"
_SYSTEM_DST = "/tmp/pi-SYSTEM.md"
_NODE_DIST = "https://nodejs.org/dist"


def _gateway_provider_name(provider: str) -> str:
    return f"gw-{provider}"


class PiUpstream(BaseInstalledAgent):
    CLI_FLAGS = []  # type: ignore[assignment]
    ENV_VARS = []  # type: ignore[assignment]

    def __init__(self, *args, **kwargs) -> None:
        super().__init__(*args, **kwargs)
        self._pkg_version = _env("OMP_BENCH_PI_VERSION", "latest")
        self._node_version = _env("OMP_BENCH_NODE_VERSION", "22.14.0")
        self._gateway_url = _env("OMP_BENCH_GATEWAY_URL", "http://host.docker.internal:4000")
        self._gateway_token = _env("OMP_BENCH_GATEWAY_TOKEN", "no-auth")
        self._model_specs = json.loads(_env("OMP_BENCH_PI_MODELS", "[]"))
        self._system_prompt_path = _env("OMP_BENCH_PI_SYSTEM_PROMPT")
        self._thinking = _env("OMP_BENCH_THINKING")
        self._tools = [t for t in _env("OMP_BENCH_TOOLS", "").split(",") if t]
        raw_args = _env("OMP_BENCH_AGENT_ARGS")
        self._agent_args = [str(a) for a in json.loads(raw_args)] if raw_args else []
        raw_env = _env("OMP_BENCH_FORWARD_ENV")
        self._forward_env = {str(k): str(v) for k, v in json.loads(raw_env).items()} if raw_env else {}
        self._home = "/root"
        self._node_dir = "/root/.pi-bench/node"
        self._app_dir = "/root/.pi-bench/app"

    @staticmethod
    @override
    def name() -> str:
        return "pi-upstream"

    @override
    def version(self) -> str | None:
        return self._pkg_version

    @override
    def get_version_command(self) -> str | None:
        return self._wrap(f"{self._pi()} --version")

    @override
    def parse_version(self, stdout: str) -> str:
        return stdout.strip().splitlines()[-1].strip() if stdout.strip() else self._pkg_version

    def _pi(self) -> str:
        return f"node {shlex.quote(self._app_dir + '/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js')}"

    def _wrap(self, command: str) -> str:
        return f'export PATH="{self._node_dir}/bin:$PATH"; {command}'

    # ------------------------------------------------------------------ install

    @override
    async def install(self, environment: BaseEnvironment) -> None:
        home = (await self.exec_as_agent(environment, command='printf %s "$HOME"')).stdout
        self._home = (home or "/root").strip() or "/root"
        self._node_dir = f"{self._home}/.pi-bench/node"
        self._app_dir = f"{self._home}/.pi-bench/app"

        await self.exec_as_root(
            environment,
            command=(
                "set -e; "
                "if ! command -v curl >/dev/null 2>&1 || ! command -v tar >/dev/null 2>&1; then "
                "  if command -v apt-get >/dev/null 2>&1; then apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y curl ca-certificates tar xz-utils; "
                "  elif command -v apk >/dev/null 2>&1; then apk add --no-cache curl ca-certificates tar xz; "
                "  elif command -v dnf >/dev/null 2>&1; then dnf install -y curl tar xz; "
                "  elif command -v yum >/dev/null 2>&1; then yum install -y curl tar xz; fi; "
                "fi; "
                "command -v xz >/dev/null 2>&1 || { if command -v apt-get >/dev/null 2>&1; then apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y xz-utils; fi; }"
            ),
        )
        q = shlex.quote
        await self.exec_as_agent(
            environment,
            command=(
                "set -e; "
                'arch=$(uname -m); case "$arch" in aarch64|arm64) na=arm64 ;; x86_64|amd64) na=x64 ;; '
                '*) echo "unsupported arch $arch" >&2; exit 4 ;; esac; '
                f"mkdir -p {q(self._node_dir)} {q(self._app_dir)}; "
                f'curl -fsSL "{_NODE_DIST}/v{self._node_version}/node-v{self._node_version}-linux-$na.tar.xz" '
                f"| tar -xJ -C {q(self._node_dir)} --strip-components=1; "
                f'export PATH="{self._node_dir}/bin:$PATH"; node --version; '
                f"cd {q(self._app_dir)}; printf '{{}}' > package.json; "
                f"npm install --silent --no-audit --no-fund {q('@earendil-works/pi-coding-agent@' + self._pkg_version)}; "
                f"{self._pi()} --version"
            ),
            timeout_sec=900,
        )
        await self._write_models_json(environment)
        await self._write_system_prompt(environment)

    def _generate_models_json(self) -> str:
        providers: dict[str, dict] = {}
        for spec in self._model_specs:
            provider = spec["provider"]
            api = "anthropic-messages" if spec.get("api") == "anthropic-messages" else "openai-responses"
            base = self._gateway_url.rstrip("/")
            entry = providers.setdefault(
                _gateway_provider_name(provider),
                {
                    "baseUrl": base if api == "anthropic-messages" else f"{base}/v1",
                    "api": api,
                    "apiKey": self._gateway_token,
                    "models": [],
                },
            )
            entry["models"].append(
                {
                    "id": f"{provider}/{spec['id']}",
                    "name": spec["id"],
                    "reasoning": bool(spec.get("reasoning", False)),
                    "input": spec.get("input") or ["text"],
                    "contextWindow": spec.get("contextWindow") or 128000,
                    "maxTokens": spec.get("maxTokens") or 16384,
                    "cost": spec.get("cost") or {"input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0},
                }
            )
        return json.dumps({"providers": providers}, indent=2)

    async def _write_models_json(self, environment: BaseEnvironment) -> None:
        content = self._generate_models_json()
        await self.exec_as_agent(
            environment,
            command=(
                f"cat > {_MODELS_DST} <<'PI_MODELS_EOF'\n{content}\nPI_MODELS_EOF\n"
                f'mkdir -p "$HOME/.pi/agent"; cp {_MODELS_DST} "$HOME/.pi/agent/models.json"'
            ),
        )

    async def _write_system_prompt(self, environment: BaseEnvironment) -> None:
        if not self._system_prompt_path:
            return
        await environment.upload_file(self._system_prompt_path, _SYSTEM_DST)

    # ---------------------------------------------------------------------- run

    @with_prompt_template
    @override
    async def run(
        self,
        instruction: str,
        environment: BaseEnvironment,
        context: AgentContext,
    ) -> None:
        if not self.model_name or "/" not in self.model_name:
            raise ValueError("model must be 'provider/model' (e.g. anthropic/claude-sonnet-5)")
        provider, model = self.model_name.split("/", 1)
        parts = [
            self._pi(),
            "--print",
            "--mode json",
            "--no-session",
            f"--provider {shlex.quote(_gateway_provider_name(provider))}",
            f"--model {shlex.quote(f'{provider}/{model}')}",
        ]
        if self._thinking:
            parts.append(f"--thinking {shlex.quote(self._thinking)}")
        if self._tools:
            parts.append(f"--tools {shlex.quote(','.join(self._tools))}")
        parts.extend(shlex.quote(arg) for arg in self._agent_args)
        parts.append("--")
        parts.append(shlex.quote(instruction))
        # Render the neutral system prompt with the trial's working directory so
        # it matches what the default prompt would have reported.
        prelude = ""
        if self._system_prompt_path:
            prelude = (
                f'mkdir -p "$HOME/.pi/agent"; '
                f'sed "s|{{{{CWD}}}}|$PWD|" {_SYSTEM_DST} > "$HOME/.pi/agent/SYSTEM.md"; '
            )
        run = prelude + " ".join(parts) + f" < /dev/null > /logs/agent/{_OUTPUT_FILENAME} 2>&1"
        await self.exec_as_agent(
            environment,
            command=self._wrap(run),
            env=self._forward_env or None,
        )

    @override
    def populate_context_post_run(self, context: AgentContext) -> None:
        acc = _Usage()
        path = Path(self.logs_dir) / _OUTPUT_FILENAME
        if not path.exists():
            return
        with path.open(errors="replace") as fh:
            for line in fh:
                event = _loads(line)
                if not event or event.get("type") != "message_end":
                    continue
                message = event.get("message")
                if isinstance(message, dict) and message.get("role") == "assistant":
                    acc.add(message.get("usage"))
        if acc.empty():
            return
        context.n_input_tokens = acc.in_tok + acc.cache_read
        context.n_output_tokens = acc.out_tok
        context.n_cache_tokens = acc.cache_read
        context.cost_usd = acc.cost if acc.cost > 0 else None
        context.metadata = {**(context.metadata or {}), "cache_write_tokens": acc.cache_write}
