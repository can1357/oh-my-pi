"""Run the downloaded release binary outside the checkout, without a native addon cache."""

import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile


with tempfile.TemporaryDirectory(prefix="omp-release-") as temp:
    root = Path(temp)
    source = Path(sys.argv[1]).resolve(strict=True)
    binary = root / "bin" / source.name
    binary.parent.mkdir()
    shutil.copy2(source, binary)
    if os.name != "nt":
        binary.chmod(0o755)
    cwd = root / "cwd"
    cwd.mkdir()
    env = os.environ.copy()
    for key, directory in {
        "HOME": "home", "USERPROFILE": "home", "APPDATA": "roaming", "LOCALAPPDATA": "local",
        "TMPDIR": "tmp", "TEMP": "tmp", "TMP": "tmp", "XDG_DATA_HOME": "data",
        "XDG_CACHE_HOME": "cache", "XDG_CONFIG_HOME": "config", "XDG_STATE_HOME": "state",
    }.items():
        path = root / directory
        path.mkdir(exist_ok=True)
        env[key] = str(path)
    # ENOTDIR, even as root in Alpine: chmod alone cannot prevent extraction there.
    blocker = root / "not-a-directory"
    blocker.touch()
    env["PI_NATIVES_DIR"] = str(blocker / "natives")

    for flag in ("--smoke-test-linked-natives", "--version", "--smoke-test"):
        linked = flag == "--smoke-test-linked-natives"
        result = subprocess.run([binary, flag], cwd=cwd, env=env, check=True, timeout=120,
                                stdout=subprocess.PIPE if linked else None, text=True)
        if linked and "linked-natives: ok" not in result.stdout.splitlines():
            sys.exit(f"compiled CLI did not confirm main + Worker native calls: {result.stdout!r}")
        for path in root.rglob("*"):
            if "pi_natives" in path.name.lower() or path.suffix.lower() == ".node":
                sys.exit(f"{flag} left a native addon sidecar: {path.relative_to(root)}")
