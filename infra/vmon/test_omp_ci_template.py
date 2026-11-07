"""The xwin layer reads its pins from two files at the built ref, so a pin
holding `$(…)` must reach curl and xwin as text rather than run while the
template builds."""

from __future__ import annotations

import subprocess
from pathlib import Path

import omp_ci_template

SHA = "0" * 40
DIGEST = "a" * 64
STUBBED = ("curl", "xwin", "sha256sum", "tar", "mkdir", "du")


def _generate(monkeypatch, version: str, arch: str, manifest: str, sdk: str) -> str:
    sources = {
        "bazel/toolchains/msvc/sysroot.bzl": (
            f'_XWIN_VERSION = "{version}"\n'
            f'_XWIN_MANIFEST_VERSION = "{manifest}"\n'
            f'"linux-x64": ("x86_64-unknown-linux-musl", "{DIGEST}")\n'
        ),
        "MODULE.bazel": f'xwin_sysroot(arch = "{arch}", sdk_version = "{sdk}")\n',
    }
    monkeypatch.setattr(
        omp_ci_template,
        "fetch",
        lambda url: next(body for suffix, body in sources.items() if url.endswith(suffix)),
    )
    return omp_ci_template.xwin_download(SHA)


def _run(script: str, workdir: Path) -> tuple[subprocess.CompletedProcess[str], list[str]]:
    """Run the generated script with every external tool replaced by a stub
    that records the arguments it was given."""
    stubs = workdir / "bin"
    stubs.mkdir()
    recorder = workdir / "argv"
    for name in STUBBED:
        stub = stubs / name
        stub.write_text(f'#!/bin/sh\nprintf "{name} %s\\n" "$@" >> {recorder}\n')
        stub.chmod(0o755)
    result = subprocess.run(
        ["bash", "--noprofile", "--norc", "-c", script],
        cwd=workdir,
        env={"PATH": f"{stubs}:/usr/bin:/bin"},
        capture_output=True,
        text=True,
    )
    recorded = recorder.read_text().splitlines() if recorder.exists() else []
    return result, recorded


def test_file_sourced_pins_reach_the_tools_as_arguments(tmp_path, monkeypatch):
    marker = tmp_path / "marker"
    # Backticks, not `$(…)`: the generator finds a call with `xwin_sysroot\((.*?)\)`,
    # so a parenthesis in a pin would end the match early.
    payload = f"`printf PWNED > {marker}`"
    version, arch = f"0.6.6{payload}", f"x86_64{payload}"
    manifest, sdk = f"17{payload}", f"10{payload}"
    script = _generate(monkeypatch, version=version, arch=arch, manifest=manifest, sdk=sdk)

    result, recorded = _run(script, tmp_path)

    assert not marker.exists()
    assert result.returncode == 0, result.stderr
    url = (
        f"https://github.com/Jake-Shadle/xwin/releases/download/{version}"
        f"/xwin-{version}-x86_64-unknown-linux-musl.tar.gz"
    )
    assert url in _words(recorded, "curl")
    assert arch in _words(recorded, "xwin")
    assert manifest in _words(recorded, "xwin")
    assert sdk in _words(recorded, "xwin")


def _words(recorded: list[str], tool: str) -> list[str]:
    """Every argument the stub for `tool` recorded, one per line."""
    return [line[len(tool) + 1 :] for line in recorded if line.startswith(f"{tool} ")]
