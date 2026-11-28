"""Maintainer-only: mint a Bun link kit from the stock upstream release build.

Usage: python3 scripts/linked-natives/prepare_kit.py <target-id> <kit-directory>

Builds the pinned, unmodified Bun revision for one target, audits it with upstream's verifier, then
captures the existing final-link inputs and flags from its Ninja graph (never a linked Bun image).
Compress the kit with `kit.py pack`. Refuses to run on CI: CI only consumes pinned kits.
"""

import json
import os
import re
import shutil
import sys
import tempfile
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from kit import Kit, digest, fetch
from pins import BUN_REVISION, BUN_VERSION, SOURCE_SHA256, Target
from toolchain import HOST_ARCH, bun, capture, run

CACHE = Path(__file__).resolve().parents[2] / "target" / "linked-natives"
VERIFIER_INPUTS = {
    "verify-binary.ts": "3f2c060781fee1d4bbe70a7e5ef8759f7ec36e4b294ae88c2d7c5737d99cac4f",
    "error.ts": "10829d372ff440be23a7c1e9e00b84e9e7b99acc55d11782f9762d3a950a80c6",
    "binary-expectations.ts": "f8ed0b0b43bc0aeb7e4e981dd01254e6a9f00ab0f6a43621362e3985e073844a",
}
AUX_INPUTS = {"symbols.txt", "symbols.def", "linker.lds", "exports.list", "linker.order"}


@dataclass
class Edge:
    """A `build` statement of upstream's Ninja graph."""

    rule: str = ""
    inputs: list[str] = field(default_factory=list)
    implicit_inputs: list[str] = field(default_factory=list)
    bindings: dict[str, str] = field(default_factory=dict)


def read_ninja(text: str) -> list[Edge]:
    """Read the build edges of a graph written by upstream's Ninja writer (its scripts/build/ninja.ts)."""
    # `$` + newline continues a statement; ninja drops the newline and the next
    # line's indentation. A `$$` is read first, so a trailing literal `$` does not continue.
    text = re.sub(r"\$\$|\$\r?\n[ \t]*", lambda m: m[0] if m[0] == "$$" else "", text)
    edges: list[Edge] = []
    edge: Edge | None = None
    for line in re.split(r"\r?\n", text):
        if line.startswith("#") or not line.strip():
            continue
        binding = re.match(r"\s+([a-zA-Z0-9_.-]+) = (.*)$", line)
        if binding:
            if edge:
                edge.bindings[binding[1]] = binding[2].replace("$$", "$")
            continue
        keyword, _, rest = line.partition(" ")
        edge = _read_build_line(rest) if keyword == "build" else None
        if edge:
            edges.append(edge)
    return edges


def _read_build_line(text: str) -> Edge:
    """`outs [| implicit outs]: rule [ins] [| implicit ins] [|| order-only ins] [|@ validations]`."""
    edge = Edge()
    outputs: list[str] = []
    ignored: list[str] = []
    into = outputs
    after_colon = False
    word = ""

    def end_word() -> None:
        nonlocal into, word
        if word == "|":
            into = edge.implicit_inputs if after_colon else ignored
        elif word in ("||", "|@"):
            into = ignored
        elif word and after_colon and not edge.rule:
            edge.rule = word
        elif word:
            into.append(word)
        word = ""

    chars = iter(text)
    for c in chars:
        if c == "$":
            escaped = next(chars, "")
            if escaped not in ("$", " ", ":"):
                raise ValueError(f"build.ninja: a path refers to a variable: {text}")
            word += escaped
        elif c == " ":
            end_word()
        elif c == ":" and not after_colon:
            end_word()
            after_colon = True
            into = edge.inputs
        else:
            word += c
    end_word()
    if not edge.rule or not outputs:
        raise ValueError(f"build.ninja: not a build statement: build {text}")
    return edge


def _unquote(m: re.Match[str]) -> str:
    single, double, escaped = m.groups()
    if single is not None:
        return single
    if double is not None:
        return re.sub(r'\\(["\\])', r"\1", double)
    return escaped


def words(text: str) -> list[str]:
    """Split upstream's quote()/quoteArgs() serialization. It is not a shell command: nothing expands."""
    if sys.platform == "win32":
        # Upstream uses cmd-style doubled quotes and leaves unquoted C:\... paths
        # alone on Windows. Backslash is NOT the shell's escape character there.
        tokens = re.findall(r'(?:[^\s"]|"(?:[^"]|"")*")+', text)
        return [re.sub(r'"((?:[^"]|"")*)"', lambda m: m[1].replace('""', '"'), t) for t in tokens]
    tokens = re.findall(r"""(?:[^\s'"\\]|\\.|'[^']*'|"(?:[^"\\]|\\.)*")+""", text)
    return [re.sub(r"""'([^']*)'|"((?:[^"\\]|\\.)*)"|\\(.)""", _unquote, t) for t in tokens]


def _slash(p: str) -> str:
    return p.replace("\\", "/") if sys.platform == "win32" else p


def _bundle_verifier(source: Path, dest: Path) -> None:
    """Bundle upstream's executable verifier with only its two read-only symbol-list readers.

    The full configuration module would also flatten two other CLI dispatchers (fetch and stream)
    into the bundle; on Windows they can mistake the verifier's argv[1] for their own entry point.
    """
    src = source / "scripts" / "build"
    for name, sha in VERIFIER_INPUTS.items():
        if digest(src / name) != sha:
            raise RuntimeError(f"Unexpected pinned verifier module: {name}")
    text = (src / "binary-expectations.ts").read_text(encoding="utf-8")
    readers = []
    for name in ("symbolList", "versionScriptGlobals"):
        reader = re.search(rf"^export function {name}\([\s\S]*?^\}}", text, re.M)
        if not reader:
            raise RuntimeError(f"Missing pinned symbol reader: {name}")
        readers.append(reader[0])
    with tempfile.TemporaryDirectory() as scratch:
        tmp = Path(scratch)
        for name in ("verify-binary.ts", "error.ts"):
            shutil.copyfile(src / name, tmp / name)
        reduced = 'import { readFileSync } from "node:fs";\n' + "\n".join(readers)
        (tmp / "binary-expectations.ts").write_text(reduced, encoding="utf-8", newline="")
        # Minified whitespace also drops the publisher's paths from module-boundary comments.
        entry = tmp / "verify-binary.ts"
        run(bun(), "build", entry, "--target=bun", "--format=esm", "--minify-whitespace", f"--outfile={dest}")


def create(target: Target, source: Path, output: Path) -> None:
    """Capture the pinned graph's existing link inputs and flags for `target` into the new kit `output`."""
    source = source.resolve()
    output = Path(os.path.abspath(output))
    if (source / ".omp-bun-revision").read_text(encoding="utf-8").strip() != BUN_REVISION:
        raise RuntimeError(f"Unexpected Bun revision: {source}")
    build_dir = source / "build" / target.id
    config = json.loads((build_dir / "configure.json").read_text(encoding="utf-8"))
    o = config["overrides"]
    if (
        config["profile"] != "release"
        or o.get("lto") is not False
        or o.get("canary") is not False
        or o.get("os") != ("windows" if target.platform == "win32" else target.platform)
        or o.get("arch") != ("aarch64" if target.arch == "arm64" else "x64")
        or o.get("baseline") != (target.arch == "x64")
        or (target.platform == "linux" and o.get("abi") != ("musl" if target.musl else "gnu"))
        or (target.platform == "darwin" and o.get("osxDeploymentTarget") != "13.0")
    ):
        raise RuntimeError(f"Not the {target.id} release graph: {build_dir}")
    graph = read_ninja((build_dir / "build.ninja").read_text(encoding="utf-8"))

    def edge(rule: str) -> Edge:
        hits = [e for e in graph if e.rule == rule]
        if len(hits) != 1:
            raise RuntimeError(f"Expected one {rule} in {build_dir}, found {len(hits)}")
        return hits[0]

    link = edge("link")
    # The upstream graph has no OMP inputs. The native archive precedes system libraries at the final link.
    flags = ["{native}", *words(link.bindings["ldflags"])]
    output.parent.mkdir(parents=True, exist_ok=True)
    tmp = Path(tempfile.mkdtemp(prefix=".kit-", dir=output.parent))
    try:
        (tmp / "files").mkdir()
        files: dict[str, str] = {}
        stored: dict[str, str] = {}

        def resolved(file: str) -> str:
            return os.path.abspath(os.path.join(build_dir, file))

        def store(file: str) -> str:
            file = resolved(file)
            if file in stored:
                return stored[file]
            name = f"files/{len(stored)}-{os.path.basename(file)}"
            shutil.copyfile(file, tmp / name)  # never publish symlinks or thin-archive references
            with (tmp / name).open("rb") as f:
                if f.read(8) == b"!<thin>\n":
                    raise RuntimeError(f"Thin archive is not self-contained: {file}")
            files[name] = digest(tmp / name)
            stored[file] = name
            return name

        audit = []
        for input in edge("duplicate_symbols").inputs:
            # This is an affirmative payload allowlist. No SDK, linker binary,
            # upstream source tree, OMP archive, or prelinked runtime may enter it.
            p = input.replace("\\", "/")
            if not re.fullmatch(r"obj/.*\.(?:obj|o)|rust-target/.*\.rlib|windows-app-info\.res", p) and not re.search(
                r"(?:^|/)webkit-[a-f0-9]+(?:-[^/]+)?/lib/[^/]+\.(?:a|lib)$", p
            ):
                raise RuntimeError(f"Unclassified Bun link input: {p}")
            audit.append(store(input))

        def input_name(input: str) -> str:
            name = stored.get(resolved(input))
            if not name:
                raise RuntimeError(f"Input missing from upstream duplicate audit: {input}")
            return name

        eager = [input_name(i) for i in link.inputs]
        lazy: list[str] = []
        if group := link.bindings.get("lazy"):
            rsp = re.fullmatch(r"(?:/clang:)?-Wl,@(bun-profile(?:\.exe)?\.lazy\.rsp)", group)
            if not rsp:
                raise RuntimeError(f"Unknown lazy linker group: {group}")
            lines = (build_dir / rsp[1]).read_text(encoding="utf-8").strip().split("\n")
            if (
                not re.fullmatch(r"(?:--|/)start-lib", lines.pop(0))
                or not lines
                or not re.fullmatch(r"(?:--|/)end-lib", lines.pop())
            ):
                raise RuntimeError("Invalid lazy link group")
            lazy = [input_name(re.sub(r'^"(.*)"$', r"\1", line)) for line in lines]
        if len({*eager, *lazy}) != len(set(audit)):
            raise RuntimeError("Incomplete native link edge capture")
        aux: dict[str, str] = {}
        for input in link.implicit_inputs:
            file = resolved(input)
            name = os.path.basename(file)
            if file in stored or input.startswith("toolchain-identity/") or name.endswith(".lazy.rsp"):
                continue
            if name not in AUX_INPUTS:
                raise RuntimeError(f"Unclassified implicit linker input: {file}")
            aux[file] = "{kit}/" + store(file)
        out_prefix = _slash(str(build_dir)) + "/"
        for i, flag in enumerate(flags):
            f = _slash(flag)
            for src, dest in aux.items():
                f = f.replace(_slash(src), dest, 1)
            if i > 0 and flags[i - 1] == "-isysroot":
                f = "{sdk}"
            elif f.startswith("--sysroot="):
                f = "--sysroot={sdk}"
            elif f.startswith("--ld-path="):
                f = "--ld-path={lld}"
            elif f.startswith("/winsysroot:"):
                f = "/winsysroot:{sdk}"
            elif re.fullmatch(r"/libpath:.*[\\/]ucrt-servicing-[\d.]+[\\/](?:x64|arm64)", f, re.I | re.A):
                f = "/libpath:{ucrt}"
            else:
                f = f.replace(out_prefix, "{out}/", 1)
            if re.search(r"([=,:@]|^)(?:/(?![A-Za-z]+:)[^ ,]+/|[A-Za-z]:[\\/])", f):
                raise RuntimeError(f"Unclassified absolute path in linker flag: {f}")
            flags[i] = f

        def kit_spec(name: str) -> dict[str, Any]:
            spec = json.loads((build_dir / f"{name}.verify.json").read_text(encoding="utf-8"))
            spec.pop("tools", None)
            if name == "bun-profile":
                spec["exe"] = "bun-profile.exe" if target.platform == "win32" else "bun-profile"
            else:
                spec["exe"] = store(spec["exe"])
            exports = spec["expect"]["exports"]
            for key in ("symbolList", "versionScript"):
                if exports.get(key):
                    exports[key] = store(exports[key])
            return spec

        stripflags = [] if target.platform == "win32" else words(edge("strip").bindings["stripflags"])
        kit: Kit = {
            "format": 1,
            "target": target.id,
            "bun": BUN_VERSION,
            "revision": BUN_REVISION,
            "files": files,
            "eager": eager,
            "lazy": lazy,
            "audit": audit,
            "ldflags": flags,
            "stripflags": stripflags,
            "profile": kit_spec("bun-profile"),
        }
        if target.platform == "win32":
            kit["shim"] = kit_spec("bun-shim-impl")
        _bundle_verifier(source, tmp / "verify.mjs")
        shutil.copyfile(source / "LICENSE.md", tmp / "LICENSE.md")
        for name in ("LICENSE.md", "verify.mjs"):
            files[name] = digest(tmp / name)
        manifest = json.dumps(kit, separators=(",", ":"), ensure_ascii=False) + "\n"
        (tmp / "kit.json").write_text(manifest, encoding="utf-8", newline="")
        tmp.rename(output)
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


def pinned_source() -> Path:
    """Extract the verified upstream source tarball once; concurrent targets share the tree."""
    source = CACHE / f"upstream-source-{BUN_REVISION}"
    marker = source / ".omp-bun-revision"
    if marker.exists():
        if marker.read_text(encoding="utf-8").strip() != BUN_REVISION:
            raise RuntimeError(f"Unexpected Bun source revision in {source}")
        return source
    CACHE.mkdir(parents=True, exist_ok=True)
    tmp = Path(tempfile.mkdtemp(prefix="fetch-", dir=CACHE))
    try:
        archive = tmp / "source.tar.gz"
        fetch(f"https://codeload.github.com/oven-sh/bun/tar.gz/{BUN_REVISION}", archive, SOURCE_SHA256)
        run("tar", "-xzf", archive, "--strip-components=1", cwd=tmp)
        archive.unlink()
        (tmp / ".omp-bun-revision").write_text(f"{BUN_REVISION}\n", encoding="utf-8", newline="")
        try:
            tmp.rename(source)
        except OSError:
            # Another target may have published the exact same completed tree first.
            if not marker.exists() or marker.read_text(encoding="utf-8").strip() != BUN_REVISION:
                raise
    finally:
        shutil.rmtree(tmp, ignore_errors=True)
    return source


def main() -> None:
    if len(sys.argv) != 3:
        sys.exit("usage: prepare_kit.py <target-id> <kit-directory>")
    if os.environ.get("GITHUB_ACTIONS") == "true":
        sys.exit("Mint Bun kits off CI; CI uses pinned kits from kits.json")
    target = Target.parse(sys.argv[1])
    if capture(bun(), "-p", "Bun.version + ' ' + Bun.revision") != f"{BUN_VERSION} {BUN_REVISION}":
        sys.exit(f"Use stock Bun {BUN_VERSION} ({BUN_REVISION}) to compile standalone bytecode for this runtime")
    # On these native hosts upstream uses the native compiler/SDK architecture. Its
    # supported cross-OS path (LLVM + target sysroot on Linux) sets the target triple.
    if target.platform != "linux" and sys.platform == target.platform and HOST_ARCH != target.arch:
        sys.exit(f"Build {target.id} on a matching {target.platform} host or a configured Linux cross-build host")
    source = pinned_source()
    relative = os.path.join("build", target.id)
    manifest = (source / "rust-toolchain.toml").read_text(encoding="utf-8")
    channel = re.search(r'^\[toolchain\][^\[]*?^channel\s*=\s*"([^"]+)"', manifest, re.M)
    if not channel:
        raise RuntimeError("Pinned Bun source does not declare its Rust toolchain channel")
    jobs = os.environ.get("CMAKE_BUILD_PARALLEL_LEVEL", "")
    run(
        bun(),
        "scripts/build.ts",
        "--profile=release",
        "--lto=off",
        "--canary=off",
        f"--os={'windows' if target.platform == 'win32' else target.platform}",
        f"--arch={'aarch64' if target.arch == 'arm64' else 'x64'}",
        *([f"--abi={'musl' if target.musl else 'gnu'}"] if target.platform == "linux" else []),
        # The local profile otherwise embeds the build host's macOS major
        # as its minimum. Match pinned Bun's shipping floor on all hosts.
        *(["--osx-deployment-target=13.0"] if target.platform == "darwin" else []),
        f"--baseline={'on' if target.arch == 'x64' else 'off'}",
        f"--build-dir={relative}",
        f"--target={'bun.exe' if target.platform == 'win32' else 'bun'}",
        *([f"-j{jobs}"] if re.fullmatch(r"[1-9][0-9]*", jobs) else []),
        cwd=source,
        env={
            **os.environ,
            "RUSTUP_TOOLCHAIN": channel[1],
            # getGitRevision prefers this over GITHUB_SHA/GIT_SHA. Those identify
            # omp on its release runner, not the Bun checkout being compiled.
            "BUILDKITE_COMMIT": BUN_REVISION,
            # The upstream CI entrypoint dumps its environment and looks for oven-sh's
            # private build artifacts. We need its local Release graph.
            "CI": "false",
            "GITHUB_ACTIONS": "false",
            "BUILDKITE": "false",
        },
    )
    verifier = source / "scripts" / "build" / "verify-binary.ts"
    run(bun(), verifier, "binary", "bun-profile.verify.json", cwd=source / relative)
    create(target, source, Path(sys.argv[2]))


if __name__ == "__main__":
    main()
