"""Run a metaharness Harbor agent's config writers and `run()` without Harbor or a container.

Harbor is not installed in this repository, so its modules are stubbed. Every container
command the agent issues runs on this host through /bin/sh, with HOME at the request's
root and the working directory at its `cwd`; file uploads copy into the root. The agent's
own write path therefore runs unchanged. The final `run()` command is recorded, not run:
it would start the agent under test.

argv[1]: JSON {"agent": "omp_local" | "pi_upstream", "root": str, "cwd": str, "env": {str: str},
               "install": bool (optional), "rootRefused": bool (optional)}
stdout:  JSON {"runEnv": {str: str}, "runCommand": str}; with "install", the agent's real
         `install()` and version command run instead (their tools must be stubs on PATH)
         and stdout is JSON {"installed": true}. With "rootRefused", every command the agent
         runs as root fails before it starts, as when the environment cannot exec as root.
"""

import asyncio
import atexit
import importlib
import json
import os
import shutil
import subprocess
import sys
import tempfile
import types
import typing
from pathlib import Path


def _stub(name: str, **attrs: object) -> None:
    module = types.ModuleType(name)
    module.__dict__.update(attrs)
    sys.modules[name] = module


class _BaseInstalledAgent:
    def __init__(self, *args: object, **kwargs: object) -> None:
        pass


for _name in ("harbor", "harbor.agents", "harbor.agents.installed", "harbor.environments"):
    _stub(_name)
for _name in ("harbor.models", "harbor.models.agent", "harbor.trial"):
    _stub(_name)
_stub(
    "harbor.agents.installed.base",
    BaseInstalledAgent=_BaseInstalledAgent,
    with_prompt_template=lambda fn: fn,
)
_stub("harbor.environments.base", BaseEnvironment=object)
_stub("harbor.models.agent.context", AgentContext=object)
_stub("harbor.trial.trial", Trial=type("Trial", (), {"_omp_cleanup_cancellation_patch": True}))
if not hasattr(typing, "override"):  # Python < 3.12; the agents target 3.12.
    typing.override = lambda fn: fn  # type: ignore[attr-defined]

request = json.loads(sys.argv[1])
root = Path(request["root"])
os.environ.update(request["env"])
# The runner hands the agents the gateway token as a private file, never as a variable;
# a request's OMP_BENCH_GATEWAY_TOKEN becomes that file.
if "OMP_BENCH_GATEWAY_TOKEN" in os.environ:
    token_dir = Path(tempfile.mkdtemp(prefix="harness-token-"))
    atexit.register(shutil.rmtree, token_dir, True)
    (token_dir / "gateway-token").write_text(os.environ.pop("OMP_BENCH_GATEWAY_TOKEN"), encoding="utf-8")
    os.environ["OMP_BENCH_GATEWAY_TOKEN_FILE"] = str(token_dir / "gateway-token")
sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "agent"))
module = importlib.import_module(request["agent"])

# Container-side staging paths land under the root instead of the host's /tmp.
staging = root / "staging"
staging.mkdir()
for constant in ("_MODELS_DST", "_CONFIG_DST", "_SYSTEM_DST", "_TOKEN_DST"):
    if hasattr(module, constant):
        setattr(module, constant, str(staging / Path(getattr(module, constant)).name))


class _Environment:
    async def upload_file(self, source_path: str, target_path: str) -> None:
        shutil.copyfile(source_path, target_path)


class _Result:
    def __init__(self, stdout: str) -> None:
        self.stdout = stdout


recorded: dict[str, object] = {}


async def _exec_as_agent(
    environment: object,
    command: str,
    env: dict[str, str] | None = None,
    timeout_sec: int | None = None,
) -> _Result:
    if recorded.get("recording"):
        recorded["runCommand"] = command
        recorded["runEnv"] = env or {}
        return _Result("")
    completed = subprocess.run(
        ["/bin/sh", "-c", command],
        cwd=request["cwd"],
        env={"PATH": os.environ.get("PATH", "/usr/bin:/bin"), "HOME": str(root), **(env or {})},
        capture_output=True,
        text=True,
        check=False,
    )
    if completed.returncode != 0:
        raise RuntimeError(f"container command failed ({completed.returncode}): {completed.stderr}")
    return _Result(completed.stdout)


async def _refused(environment: object, command: str, **kwargs: object) -> _Result:
    raise RuntimeError("exec as root refused")


async def _main() -> None:
    agent = module.OmpLocal() if request["agent"] == "omp_local" else module.PiUpstream()
    agent._home = str(root)
    agent.model_name = "openrouter/test-model"
    agent.exec_as_agent = _exec_as_agent
    agent.exec_as_root = _refused if request.get("rootRefused") else _exec_as_agent
    environment = _Environment()
    if request.get("install"):
        await agent.install(environment)
        await _exec_as_agent(environment, agent.get_version_command())
        print(json.dumps({"installed": True}))
        return
    if request["agent"] == "omp_local":
        if agent._gateway_on:
            await agent._write_models_yaml(environment)
        await agent._write_config(environment)
    else:
        await agent._write_models_json(environment)
        await agent._write_system_prompt(environment)
    recorded["recording"] = True
    await agent.run("prompt", environment, None)
    print(json.dumps({"runEnv": recorded["runEnv"], "runCommand": recorded["runCommand"]}))


asyncio.run(_main())
