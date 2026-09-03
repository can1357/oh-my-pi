"""Harbor agent that runs the LOCAL oh-my-pi (`omp`) build inside task containers.

Unlike Harbor's built-in `pi` agent (which `npm i -g @mariozechner/pi-coding-agent`),
this runs the working tree at `/work/pi`. Install modes (`OMP_BENCH_INSTALL`):

  * `source` (default): the runner bind-mounts the repo read-only plus a
    prebuilt linux `node_modules` tree and a linux `bun` binary; omp runs
    straight from `packages/coding-agent/src/cli.ts`. Zero-network setup, and
    host TS edits apply to the next trial with no rebuild (Rust natives load
    from the in-tree `packages/natives/native/*.node` prebuilds).
  * `local`: the runner packs `packages/coding-agent` with `bun pm pack`
    (bundles every workspace TS package into `dist/cli.js`) and hands us the
    tarball path; we upload it, install Bun, `bun install` the bundle's
    external deps + the platform native addon, and run `bun .../dist/cli.js`.
  * binary (`--binary`): a self-contained compiled omp binary is uploaded.

Auth never enters the container: a generated `~/.omp/agent/models.yml` routes the
configured providers' `baseUrl` at the host's pm2 auth-gateway (default
`http://host.docker.internal:4000`, `transport: pi-native`), so the gateway
resolves credentials host-side. No provider API keys are passed in.

All knobs come from environment variables the runner sets on the `harbor` process
(see `OMP_BENCH_*` below); the agent reads them from `os.environ` directly.

Selected via `harbor run --agent-import-path omp_local:OmpLocal` with the
directory of this file on `PYTHONPATH`.
"""

from __future__ import annotations

import asyncio
import json
import os
import shlex
from dataclasses import dataclass
from pathlib import Path
from typing import override

from harbor.agents.installed.base import BaseInstalledAgent, with_prompt_template
from harbor.environments.base import BaseEnvironment
from harbor.models.agent.context import AgentContext


def _patch_harbor_cleanup_cancellation() -> None:
    """Keep Harbor's Docker cleanup alive when trial cancellation interrupts it."""
    from harbor.trial.trial import Trial

    if getattr(Trial, "_omp_cleanup_cancellation_patch", False):
        return

    async def _stop_agent_environment(self) -> None:
        if self._is_agent_environment_stopped:
            return

        stop_task = asyncio.create_task(
            self.agent_environment.stop(delete=self.config.environment.delete)
        )
        cancellation_logged = False
        while not stop_task.done():
            try:
                await asyncio.shield(stop_task)
            except asyncio.CancelledError:
                if not cancellation_logged:
                    self.logger.debug(
                        f"Cleanup cancellation delayed for {self.config.trial_name}; "
                        "waiting for agent environment stop to finish"
                    )
                    cancellation_logged = True
            except Exception:
                break
        try:
            await stop_task
            self._is_agent_environment_stopped = True
        except asyncio.CancelledError:
            self._is_agent_environment_stopped = True
            self.logger.debug(
                f"Agent environment stop was cancelled for {self.config.trial_name}"
            )
        except Exception as exc:
            self._is_agent_environment_stopped = True
            self.logger.debug(
                "Warning: Agent environment cleanup failed for "
                f"{self.config.trial_name}: {exc}"
            )
            self._record_exception(exc)

    Trial._stop_agent_environment = _stop_agent_environment
    Trial._omp_cleanup_cancellation_patch = True


def _patch_apple_container_dns() -> None:
    """Inject an explicit resolver into every Apple Container `container run`.

    Containers default to the vmnet gateway resolver (192.168.64.1:53), which is
    unreachable when VPN/DNS agents on the host intercept port 53. The runner
    sets OMP_BENCH_CONTAINER_DNS for apple-container jobs; absent, no-op.
    """
    dns = os.environ.get("OMP_BENCH_CONTAINER_DNS")
    if not dns:
        return
    from harbor.environments.apple_container import AppleContainerEnvironment

    if getattr(AppleContainerEnvironment, "_omp_dns_patch", False):
        return
    original = AppleContainerEnvironment._run_container_command

    async def _run_with_dns(self, args, *pargs, **kwargs):
        if args and args[0] == "run":
            args = ["run", "--dns", dns, *args[1:]]
        return await original(self, args, *pargs, **kwargs)

    AppleContainerEnvironment._run_container_command = _run_with_dns
    AppleContainerEnvironment._omp_dns_patch = True


_patch_harbor_cleanup_cancellation()
_patch_apple_container_dns()

# Container-side staging paths (absolute; never depend on $HOME at write time).
_TARBALL_DST = "/tmp/omp-local.tgz"
_MODELS_DST = "/tmp/omp-models.yml"
_CONFIG_DST = "/tmp/omp-config.yml"
_OUTPUT_FILENAME = "omp.txt"

# Provider → host env vars used in --no-gateway (direct-auth) mode only.
_PROVIDER_KEYS: dict[str, list[str]] = {
    "amazon-bedrock": ["AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_REGION"],
    "anthropic": ["ANTHROPIC_API_KEY", "ANTHROPIC_OAUTH_TOKEN"],
    "github-copilot": ["GITHUB_TOKEN"],
    "google": [
        "GEMINI_API_KEY",
        "GOOGLE_GENERATIVE_AI_API_KEY",
        "GOOGLE_API_KEY",
        "GOOGLE_APPLICATION_CREDENTIALS",
        "GOOGLE_CLOUD_PROJECT",
        "GOOGLE_CLOUD_LOCATION",
        "GOOGLE_GENAI_USE_VERTEXAI",
    ],
    "groq": ["GROQ_API_KEY"],
    "huggingface": ["HF_TOKEN"],
    "mistral": ["MISTRAL_API_KEY"],
    "openai": ["OPENAI_API_KEY"],
    "openrouter": ["OPENROUTER_API_KEY"],
    "xai": ["XAI_API_KEY"],
}


def _env(name: str, default: str = "") -> str:
    value = os.environ.get(name)
    return value if value is not None and value != "" else default


def _truthy(value: str) -> bool:
    return value.strip().lower() in ("1", "true", "yes", "on")


def _loads(line: str) -> dict | None:
    line = line.strip()
    if not line.startswith("{"):
        return None
    try:
        value = json.loads(line)
    except (json.JSONDecodeError, ValueError):
        return None
    return value if isinstance(value, dict) else None


@dataclass
class _Usage:
    """Running sum of token/cost usage across assistant turns."""

    in_tok: int = 0
    out_tok: int = 0
    cache_read: int = 0
    cache_write: int = 0
    cost: float = 0.0

    def add(self, usage: object) -> None:
        if not isinstance(usage, dict):
            return
        self.in_tok += int(usage.get("input", 0) or 0)
        self.out_tok += int(usage.get("output", 0) or 0)
        self.cache_read += int(usage.get("cacheRead", 0) or 0)
        self.cache_write += int(usage.get("cacheWrite", 0) or 0)
        cost = usage.get("cost")
        if isinstance(cost, dict):
            self.cost += float(cost.get("total", 0.0) or 0.0)

    def empty(self) -> bool:
        return self.in_tok == 0 and self.out_tok == 0 and self.cost == 0.0


class OmpLocal(BaseInstalledAgent):
    # No declarative CLI flags: the run command is built by hand so model/thinking
    # routing stays in one place.
    CLI_FLAGS = []  # type: ignore[assignment]
    ENV_VARS = []  # type: ignore[assignment]

    def __init__(self, *args, **kwargs) -> None:  # noqa: D401 - thin wrapper
        super().__init__(*args, **kwargs)
        self._install_mode = _env("OMP_BENCH_INSTALL", "source")
        self._tarball = _env("OMP_BENCH_TARBALL")
        self._pkg_version = _env("OMP_BENCH_VERSION", "latest")
        self._models_yaml_path = _env("OMP_BENCH_MODELS_YAML")
        self._gateway_url = _env(
            "OMP_BENCH_GATEWAY_URL", "http://host.docker.internal:4000"
        )
        self._gateway_token = _env("OMP_BENCH_GATEWAY_TOKEN", "no-auth-dummy")
        self._gateway_providers = [
            p.strip()
            for p in _env(
                "OMP_BENCH_GATEWAY_PROVIDERS", "anthropic,openai-codex"
            ).split(",")
            if p.strip()
        ]
        self._thinking = _env("OMP_BENCH_THINKING")
        self._auto_approve = _truthy(_env("OMP_BENCH_AUTO_APPROVE", "1"))
        # Extra CLI args forwarded verbatim to the in-container omp invocation,
        # JSON-array-encoded by the runner (OMP_BENCH_AGENT_ARGS) so multi-word
        # values survive without a second layer of shell quoting.
        self._agent_args = self._parse_agent_args()
        self._bun_version = _env("OMP_BENCH_BUN_VERSION", "1.4.0")
        self._gateway_on = _env("OMP_BENCH_GATEWAY", "1") != "0"

        # web_search auth can't route through the gateway (dedicated provider creds);
        # off by default so search-using tasks don't false-negative on 401s.
        self._web_search = _truthy(_env("OMP_BENCH_WEB_SEARCH", "0"))
        # Extra env (PI_* dialect knobs, explicit --env) the runner forwards into
        # the in-container omp run, JSON-encoded in OMP_BENCH_FORWARD_ENV.
        self._forward_env = self._parse_forward_env()
        # Source-mount paths (defaults must match the runner's compose overlay).
        self._source_dir = _env("OMP_BENCH_SOURCE_DIR", "/opt/omp/src")
        self._source_bun = _env("OMP_BENCH_SOURCE_BUN", "/opt/omp/bin/bun")
        self._source_arch = _env("OMP_BENCH_SOURCE_ARCH")
        # Resolved during install(); reused by version + run commands.
        self._home = "/root"
        self._bun = "/root/.bun/bin/bun"
        self._cli = "/root/.omp-bench/app/dist/cli.js"
        self._binary_arm64 = _env("OMP_BENCH_BINARY_ARM64")
        self._binary_x64 = _env("OMP_BENCH_BINARY_X64")
        self._binary = bool(self._binary_arm64 or self._binary_x64)

    @staticmethod
    @override
    def name() -> str:
        return "omp"

    @override
    def version(self) -> str | None:
        return self._version

    @override
    def get_version_command(self) -> str | None:
        if self._binary:
            return f"{shlex.quote(self._cli)} --version"
        return self._wrap(
            f"{shlex.quote(self._bun)} {shlex.quote(self._cli)} --version"
        )

    @override
    def parse_version(self, stdout: str) -> str:
        return stdout.strip().splitlines()[-1].strip() if stdout.strip() else "local"

    # ------------------------------------------------------------------ install

    def _wrap(self, command: str) -> str:
        """Prefix a command with the Bun runtime on PATH.

        omp spawns Bun worker subprocesses at runtime, so `bun` must resolve on
        PATH during `run()` too — not just for the entrypoint.
        """
        bun_dir = os.path.dirname(self._bun)
        return (
            f"export BUN_INSTALL={shlex.quote(self._home + '/.bun')}; "
            f'export PATH="{bun_dir}:$PATH"; '
            f"{command}"
        )

    @override
    async def install(self, environment: BaseEnvironment) -> None:
        # Resolve the agent user's HOME first (root vs non-root tasks differ).
        home = (
            await self.exec_as_agent(environment, command='printf %s "$HOME"')
        ).stdout
        self._home = (home or "/root").strip() or "/root"

        if self._binary:
            # Self-contained binary mode: upload + chmod only. No apt/curl/bun/npm, so
            # trial setup needs zero outbound network (no_network tasks set up cleanly).
            await self._install_binary(environment)
        elif self._install_mode == "source":
            # Everything is bind-mounted by the runner; nothing to download.
            self._cli = await self._install_source(environment)
        else:
            # 1) System deps (root). curl+unzip for the Bun installer; ca-certs for TLS.
            await self.exec_as_root(
                environment,
                command=(
                    "set -e; "
                    "if command -v apt-get >/dev/null 2>&1; then "
                    "  apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y curl unzip ca-certificates tar; "
                    "elif command -v apk >/dev/null 2>&1; then "
                    "  echo 'ERROR: Alpine/musl base image; @oh-my-pi/pi-natives ships no musl prebuilt' >&2; exit 3; "
                    "elif command -v dnf >/dev/null 2>&1; then dnf install -y curl unzip tar; "
                    "elif command -v yum >/dev/null 2>&1; then yum install -y curl unzip tar; "
                    "fi"
                ),
            )
            # 2) Bun (agent user).
            await self.exec_as_agent(
                environment,
                command=(
                    "set -e; "
                    f"export BUN_INSTALL={shlex.quote(self._home + '/.bun')}; "
                    f'curl -fsSL https://bun.sh/install | bash -s "bun-v{self._bun_version}"; '
                    f"{shlex.quote(self._home + '/.bun/bin/bun')} --version"
                ),
            )
            self._bun = f"{self._home}/.bun/bin/bun"
            if self._install_mode == "published":
                self._cli = await self._install_published(environment)
            else:
                self._cli = await self._install_local(environment)

        # 3) Auth + model config under $HOME/.omp/agent.
        if self._gateway_on:
            # Gateway routing — no provider keys ever enter the container.
            await self._write_models_yaml(environment)
        await self._write_config(environment)

    async def _install_source(self, environment: BaseEnvironment) -> str:
        """Verify the read-only repo + linux deps mounts and run omp from TS source.

        The runner mounts the repo at `self._source_dir`, shadows every host
        `node_modules` with a linux tree, and mounts a linux `bun` binary — so
        setup needs zero outbound network and no rebuild for TS changes.
        """
        arch = (
            await self.exec_as_agent(environment, command="uname -m")
        ).stdout.strip()
        norm = {
            "aarch64": "arm64",
            "arm64": "arm64",
            "x86_64": "x64",
            "amd64": "x64",
        }.get(arch)
        if self._source_arch and norm != self._source_arch:
            raise RuntimeError(
                f"source mode: container arch {arch!r} != mounted deps tree arch "
                f"({self._source_arch}); use --binary for emulated-arch tasks"
            )
        self._bun = self._source_bun
        cli = f"{self._source_dir}/packages/coding-agent/src/cli.ts"
        q = shlex.quote
        await self.exec_as_agent(
            environment,
            command=(
                "set -e; "
                f"test -x {q(self._source_bun)} || {{ echo 'omp source mode: bun mount missing' >&2; exit 5; }}; "
                f"test -f {q(cli)} || {{ echo 'omp source mode: repo mount missing' >&2; exit 5; }}; "
                f"test -d {q(self._source_dir + '/node_modules/@oh-my-pi')} || "
                "{ echo 'omp source mode: linux deps mount missing' >&2; exit 5; }; "
                f"{q(self._source_bun)} --version"
            ),
        )
        return cli

    async def _install_local(self, environment: BaseEnvironment) -> str:
        if not self._tarball:
            raise RuntimeError(
                "OMP_BENCH_INSTALL=local requires OMP_BENCH_TARBALL (host tarball path)"
            )
        await environment.upload_file(self._tarball, _TARBALL_DST)
        app = f"{self._home}/.omp-bench/app"
        await self.exec_as_agent(
            environment,
            command=self._wrap(
                "set -e; "
                f"mkdir -p {shlex.quote(app)}; "
                f"tar xzf {_TARBALL_DST} -C {shlex.quote(app)} --strip-components=1; "
                f"cd {shlex.quote(app)}; "
                # Bundle inlines workspace TS; only externalized deps are needed.
                # Skip heavy optionals (transformers/sherpa) but add the native addon.
                "bun install --production --omit=optional; "
                "arch=$(uname -m); "
                'case "$arch" in aarch64|arm64) na=arm64 ;; x86_64|amd64) na=x64 ;; '
                '*) echo "unsupported arch $arch" >&2; exit 4 ;; esac; '
                # Native leaf MUST match the bundle version exactly (loader/API skew
                # otherwise). Read it straight from the packed package.json.
                'ver=$(bun -e "process.stdout.write(require(\\"./package.json\\").version)"); '
                'echo "pinning native @oh-my-pi/pi-natives-linux-$na@$ver"; '
                'bun add --production "@oh-my-pi/pi-natives-linux-$na@$ver"'
            ),
            timeout_sec=900,
        )
        return f"{app}/dist/cli.js"

    async def _install_binary(self, environment: BaseEnvironment) -> str:
        """Probe container arch, upload only the matching self-contained omp binary."""
        arch = (
            await self.exec_as_agent(environment, command="uname -m")
        ).stdout.strip()
        if arch in ("aarch64", "arm64"):
            hostbin = self._binary_arm64
        elif arch in ("x86_64", "amd64"):
            hostbin = self._binary_x64
        else:
            raise RuntimeError(f"binary mode: unsupported container arch {arch!r}")
        if not hostbin:
            raise RuntimeError(
                f"binary mode: no omp binary provided for container arch {arch}"
            )
        app_dir = f"{self._home}/.omp-bench"
        dst = f"{app_dir}/omp"
        staging = "/tmp/omp-bin"
        await self.exec_as_agent(
            environment, command=f"mkdir -p {shlex.quote(app_dir)}"
        )
        await environment.upload_file(hostbin, staging)
        await self.exec_as_agent(
            environment,
            command=f"cp {shlex.quote(staging)} {shlex.quote(dst)} && chmod +x {shlex.quote(dst)}",
        )
        self._cli = dst
        return dst

    async def _install_published(self, environment: BaseEnvironment) -> str:
        app = f"{self._home}/.omp-bench/app"
        spec = f"@oh-my-pi/pi-coding-agent@{self._pkg_version}"
        await self.exec_as_agent(
            environment,
            command=self._wrap(
                "set -e; "
                f"mkdir -p {shlex.quote(app)}; cd {shlex.quote(app)}; "
                'printf "{}" > package.json; '
                f"bun add {shlex.quote(spec)}"
            ),
            timeout_sec=900,
        )
        return f"{app}/node_modules/@oh-my-pi/pi-coding-agent/dist/cli.js"

    async def _write_models_yaml(self, environment: BaseEnvironment) -> None:
        if self._models_yaml_path and os.path.isfile(self._models_yaml_path):
            await environment.upload_file(self._models_yaml_path, _MODELS_DST)
            staged = _MODELS_DST
        else:
            content = self._generate_models_yaml()
            staged = _MODELS_DST
            heredoc = (
                f"cat > {_MODELS_DST} <<'OMP_MODELS_EOF'\n{content}\nOMP_MODELS_EOF"
            )
            await self.exec_as_agent(environment, command=heredoc)
        await self.exec_as_agent(
            environment,
            command=(
                f'mkdir -p "$HOME/.omp/agent"; '
                f'cp {shlex.quote(staged)} "$HOME/.omp/agent/models.yml"'
            ),
        )

    def _generate_models_yaml(self) -> str:
        lines = [
            "# Generated by metaharness runner — routes auth via host gateway.",
            "providers:",
        ]
        for provider in self._gateway_providers:
            lines += [
                f"  {provider}:",
                f"    baseUrl: {self._gateway_url}",
                "    auth: oauth",
                "    transport: pi-native",
                f"    apiKey: {self._gateway_token}",
            ]
        return "\n".join(lines)

    async def _write_config(self, environment: BaseEnvironment) -> None:
        """Write $HOME/.omp/agent/config.yml: the web_search toggle.

        web_search can't authenticate through the gateway, so it's off by default.
        """
        lines = [
            "# Generated by metaharness runner.",
            "web_search:",
            f"  enabled: {'true' if self._web_search else 'false'}",
        ]
        content = "\n".join(lines)
        heredoc = f"cat > {_CONFIG_DST} <<'OMP_CONFIG_EOF'\n{content}\nOMP_CONFIG_EOF"
        await self.exec_as_agent(environment, command=heredoc)
        await self.exec_as_agent(
            environment,
            command=(
                f'mkdir -p "$HOME/.omp/agent"; '
                f'cp {shlex.quote(_CONFIG_DST)} "$HOME/.omp/agent/config.yml"'
            ),
        )

    @staticmethod
    def _parse_forward_env() -> dict[str, str]:
        """Extra run-time env from the runner (OMP_BENCH_FORWARD_ENV = JSON object)."""
        raw = _env("OMP_BENCH_FORWARD_ENV")
        if not raw:
            return {}
        try:
            parsed = json.loads(raw)
        except (json.JSONDecodeError, ValueError):
            return {}
        if not isinstance(parsed, dict):
            return {}
        return {str(key): str(value) for key, value in parsed.items()}

    @staticmethod
    def _parse_agent_args() -> list[str]:
        """Extra CLI args from the runner (OMP_BENCH_AGENT_ARGS = JSON array)."""
        raw = _env("OMP_BENCH_AGENT_ARGS")
        if not raw:
            return []
        try:
            parsed = json.loads(raw)
        except (json.JSONDecodeError, ValueError):
            return []
        if not isinstance(parsed, list):
            return []
        return [str(item) for item in parsed]

    def _collect_provider_keys(self, provider: str) -> dict[str, str]:
        """Host env vars for the primary model's provider (direct-auth mode only)."""
        env: dict[str, str] = {}
        for key in _PROVIDER_KEYS.get(provider, []):
            value = os.environ.get(key)
            if value:
                env[key] = value
        return env

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
            raise ValueError(
                "model must be 'provider/model' (e.g. anthropic/claude-sonnet-4-6)"
            )
        provider, model = self.model_name.split("/", 1)

        if self._binary:
            parts = [shlex.quote(self._cli)]
        else:
            parts = [shlex.quote(self._bun), shlex.quote(self._cli)]
        parts += [
            "--print",
            "--mode json",
            f"--provider {shlex.quote(provider)}",
            f"--model {shlex.quote(model)}",
            "--no-session",
        ]
        if self._auto_approve:
            parts.append("--auto-approve")
        if self._thinking:
            parts.append(f"--thinking {shlex.quote(self._thinking)}")
        parts.extend(shlex.quote(arg) for arg in self._agent_args)
        # POSIX positional separator: some task prompts start with "-" (e.g. a
        # markdown bullet, as in pytorch-model-recovery). Without this, omp parses
        # the prompt as an unknown flag and exits 2. `--` forces positional mode.
        parts.append("--")
        parts.append(shlex.quote(instruction))
        # No pipes/stdbuf (absent in minimal images): redirect raw JSONL to the
        # mounted agent log dir; populate_context_post_run parses it on the host.
        run = " ".join(parts) + f" > /logs/agent/{_OUTPUT_FILENAME} 2>&1"
        # Exec env for the omp run. Direct-auth (no-gateway) mode contributes the
        # selected providers' keys (via exec env, never argv); forwarded PI_* /
        # --env knobs apply last so an explicit --env always wins.
        run_env: dict[str, str] = {}
        if not self._gateway_on:
            run_env.update(self._collect_provider_keys(provider))
        run_env.update(self._forward_env)
        await self.exec_as_agent(
            environment,
            command=run if self._binary else self._wrap(run),
            env=run_env or None,
        )

    @override
    def populate_context_post_run(self, context: AgentContext) -> None:
        main = _Usage()
        self._sum_main(self.logs_dir / _OUTPUT_FILENAME, main)
        if main.empty():
            return
        context.n_input_tokens = main.in_tok + main.cache_read
        context.n_output_tokens = main.out_tok
        context.n_cache_tokens = main.cache_read
        context.cost_usd = main.cost if main.cost > 0 else None
        context.metadata = {
            **(context.metadata or {}),
            "cache_write_tokens": main.cache_write,
        }

    def _sum_main(self, path: Path, acc: "_Usage") -> None:
        """Sum assistant `message_end` usage from omp's stdout JSONL.

        Streams line-by-line: a runaway transcript must not OOM the host-side
        post-run parse.
        """
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
