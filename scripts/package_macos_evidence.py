#!/usr/bin/env python3
"""Record and validate package provenance; optionally publish those exact assets.

The manifest records workflow observations, not a signature or verification gate.
Only the workflow that ran install-smoke may create it after that check succeeds.
"""

import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tomllib


MANIFEST = "package-provenance.json"
SHA = re.compile(r"[0-9a-f]{40}\Z")
COMMAND = ["cargo", "build", "-p", "omp-app", "--bin", "omp", "--release", "--locked"]
INPUTS = ["Cargo.toml", "Cargo.lock", "rust-toolchain.toml", ".cargo/config.toml",
          "scripts/package-macos.sh", "scripts/install-smoke-macos.sh",
          "crates/py/requirements.txt", "crates/py/scripts/fetch-python.sh",
          "vendor/python-release/pyo3-config.txt"]
FIELDS = {"schema", "source_sha", "run_id", "run_attempt", "target", "build_command",
          "release_profile", "build_overrides", "rustc", "python_config", "input_sha256",
          "install_smoke", "artifacts"}


def unique_object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError("ambiguous package manifest")
        result[key] = value
    return result


def digest(path):
    result = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            result.update(block)
    return result.hexdigest()


def regular(path):
    if path.is_symlink() or not path.is_file():
        raise ValueError("package evidence must contain regular files")
    return path


def identity(source_sha, run_id, run_attempt):
    if not SHA.fullmatch(source_sha) or run_id <= 0 or run_attempt <= 0:
        raise ValueError("invalid source/run identity")
    return {"source_sha": source_sha, "run_id": run_id, "run_attempt": run_attempt}


def record(directory, source_sha, run_id, run_attempt, run=subprocess.check_output):
    expected = identity(source_sha, run_id, run_attempt)
    actual = run(["git", "rev-parse", "HEAD"], text=True).strip()
    if actual != source_sha:
        raise ValueError("checkout does not match requested source")
    # Reject changed build inputs rather than attaching the original commit's name.
    subprocess.run(["git", "diff", "--exit-code", "HEAD", "--"], check=True,
                   stdout=subprocess.DEVNULL)
    prefix = "omp-" + run(["git", "rev-parse", "--short", "HEAD"], text=True).strip() + "-aarch64-apple-darwin"
    assets = [prefix + suffix for suffix in (".tar.gz", ".pkg", ".sha256")]
    hashes = {name: digest(regular(directory / name)) for name in assets}
    profile = tomllib.loads(Path("Cargo.toml").read_text())["profile"]["release"]
    overrides = {name: value for name, value in os.environ.items()
                 if name in ("RUSTFLAGS", "CARGO_ENCODED_RUSTFLAGS", "CARGO_BUILD_TARGET",
                             "CARGO_BUILD_RUSTFLAGS", "CARGO_BUILD_JOBS")
                 or name.startswith("CARGO_PROFILE_RELEASE_")}
    value = {"schema": 1, **expected, "target": "aarch64-apple-darwin",
             "build_command": COMMAND, "release_profile": profile,
             "build_overrides": overrides,
             "rustc": run(["rustc", "-Vv"], text=True).strip(),
             "python_config": "vendor/python-release/pyo3-config.txt",
             "input_sha256": {name: digest(regular(Path(name))) for name in INPUTS},
             "install_smoke": "passed", "artifacts": hashes}
    (directory / MANIFEST).write_text(json.dumps(value, indent=2, sort_keys=True) + "\n")
    return validate(directory, source_sha, run_id, run_attempt)


def validate(directory, source_sha, run_id, run_attempt):
    expected = identity(source_sha, run_id, run_attempt)
    path = regular(directory / MANIFEST)
    if path.stat().st_size > 65536:
        raise ValueError("package manifest exceeds size limit")
    value = json.loads(path.read_text(), object_pairs_hook=unique_object)
    if (not isinstance(value, dict) or set(value) != FIELDS
            or type(value.get("schema")) is not int or value.get("schema") != 1
            or type(value.get("run_id")) is not int or type(value.get("run_attempt")) is not int
            or any(value.get(key) != item for key, item in expected.items())
            or value.get("target") != "aarch64-apple-darwin"
            or value.get("install_smoke") != "passed" or value.get("build_command") != COMMAND):
        raise ValueError("package provenance identity or validation mismatch")
    if (not isinstance(value["release_profile"], dict)
            or not isinstance(value["build_overrides"], dict)
            or any(not isinstance(key, str) or not isinstance(item, str)
                   for key, item in value["build_overrides"].items())
            or not isinstance(value["rustc"], str)
            or "host: aarch64-apple-darwin" not in value["rustc"].splitlines()
            or value["python_config"] != "vendor/python-release/pyo3-config.txt"
            or not isinstance(value["input_sha256"], dict)
            or set(value["input_sha256"]) != set(INPUTS)
            or any(not isinstance(item, str) or not re.fullmatch(r"[0-9a-f]{64}", item)
                   for item in value["input_sha256"].values())):
        raise ValueError("missing or invalid build provenance")
    hashes = value.get("artifacts")
    if not isinstance(hashes, dict) or len(hashes) != 3:
        raise ValueError("expected exactly three package assets")
    prefixes = set()
    suffixes = set()
    for name, checksum in hashes.items():
        match = re.fullmatch(r"(omp-([0-9a-f]{7,40})-aarch64-apple-darwin)(\.tar\.gz|\.pkg|\.sha256)", name)
        if (match is None or not source_sha.startswith(match[2])
                or not isinstance(checksum, str) or not re.fullmatch(r"[0-9a-f]{64}", checksum)):
            raise ValueError("unexpected package asset or checksum")
        prefixes.add(match[1])
        suffixes.add(match[3])
        if digest(regular(directory / name)) != checksum:
            raise ValueError("package checksum mismatch")
    if len(prefixes) != 1 or suffixes != {".tar.gz", ".pkg", ".sha256"}:
        raise ValueError("incomplete package asset set")
    if {item.name for item in directory.iterdir()} != set(hashes) | {MANIFEST}:
        raise ValueError("unexpected files in validated package directory")
    return value


def publish(directory, source_sha, run_id, run_attempt, run=subprocess.run):
    value = validate(directory, source_sha, run_id, run_attempt)
    if (os.environ.get("GITHUB_REPOSITORY") != "blyzer/oh-my-pi"
            or os.environ.get("GITHUB_REF") != "refs/heads/omp2"
            or os.environ.get("GITHUB_EVENT_NAME") != "workflow_dispatch"
            or os.environ.get("GITHUB_ACTOR") != "blyzer"):
        raise ValueError("draft publication requires an owner dispatch on omp2")
    tag = "omp-macos-" + source_sha
    # Never replace an existing tag/release or attach packages to another source.
    existing = run(["gh", "api", "--include", "repos/blyzer/oh-my-pi/git/ref/tags/" + tag],
                   capture_output=True, text=True)
    status = (existing.stdout or "").splitlines()
    if (existing.returncode == 0 or not status
            or not re.fullmatch(r"HTTP/(?:1\.[01]|2(?:\.0)?|3(?:\.0)?) 404(?: .*)?", status[0])):
        raise ValueError("release tag exists or its absence cannot be established")
    assets = [str(directory / name) for name in sorted(value["artifacts"])] + [str(directory / MANIFEST)]
    run(["gh", "release", "create", tag, "--repo", "blyzer/oh-my-pi", "--target", source_sha,
         "--draft", "--title", "OMP macOS " + source_sha[:12], "--notes",
         "Validated packages from https://github.com/blyzer/oh-my-pi/actions/runs/" + str(run_id)
         + ". Source: " + source_sha + ". Ad-hoc signed; not Apple-notarized.", *assets], check=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=("record", "validate", "publish"))
    parser.add_argument("directory", type=Path)
    parser.add_argument("--source-sha", required=True)
    parser.add_argument("--run-id", required=True, type=int)
    parser.add_argument("--run-attempt", required=True, type=int)
    args = parser.parse_args()
    {"record": record, "validate": validate, "publish": publish}[args.action](
        args.directory, args.source_sha, args.run_id, args.run_attempt)


if __name__ == "__main__":
    try:
        main()
    except (ValueError, OSError, subprocess.SubprocessError):
        print("package evidence validation or publication failed", file=sys.stderr)
        sys.exit(1)
