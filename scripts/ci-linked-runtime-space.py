"""Make room for a cold link on a disposable GitHub-hosted runner, never a developer machine."""

import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile


if os.environ.get("GITHUB_ACTIONS") != "true" or os.environ.get("RUNNER_ENVIRONMENT") != "github-hosted":
    sys.exit("linked runtime scratch setup is only for disposable GitHub-hosted runners")

workspace = Path(os.environ["GITHUB_WORKSPACE"])
volumes = [workspace]
if os.name == "nt":
    # Windows workspaces and the user profile can live on separate disks.
    volumes.extend([Path(os.environ["RUNNER_TEMP"]), Path(os.environ["LOCALAPPDATA"])])


def free(path):
    return shutil.disk_usage(path).free


# Only a cleanup threshold, not a space requirement. The uncompressed kit
# (~1.7 GiB), Rust archive, SDK, LLVM and link scratch compete for the same
# volume; standard hosted runners only guarantee 14 GB free.
headroom = 16 * 1024 ** 3
if max(map(free, volumes)) < headroom:
    android = {
        "linux": Path("/usr/local/lib/android/sdk"),
        "darwin": Path.home() / "Library/Android/sdk",
        "win32": Path(r"C:\Android\android-sdk"),
    }[sys.platform]
    if (android / "platform-tools").is_dir():
        if os.name == "nt":
            try:
                shutil.rmtree(android)
            except OSError as error:
                print(f"Could not remove unused Android SDK: {error}", file=sys.stderr)
        else:
            subprocess.run(["sudo", "rm", "-rf", "--", android], check=False)
    if sys.platform == "darwin" and free(workspace) < headroom:
        # Only simulator disk images; keep the selected Xcode, SDK, and tools.
        subprocess.run(["xcrun", "simctl", "runtime", "delete", "all"], check=False)

scratch = workspace / "target"
best = max(volumes, key=free)
if os.name == "nt" and best.drive != workspace.drive and free(workspace) < headroom:
    external = tempfile.mkdtemp(prefix="omp-runtime-", dir=best)
    subprocess.run(["cmd.exe", "/d", "/c", "mklink", "/j", scratch, external], check=True)
scratch.mkdir(exist_ok=True)
print(f"Runtime work volume: {scratch.resolve()} ({free(scratch) / 1024**3:.1f} GiB free)")
with open(os.environ["GITHUB_ENV"], "a", encoding="utf-8") as env:
    for name, directory in (("CARGO_HOME", "cargo-home"), ("RUSTUP_HOME", "rustup-home")):
        print(f"{name}={scratch / directory}", file=env)
