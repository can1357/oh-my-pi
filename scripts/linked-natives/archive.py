"""Build pi-natives as one link-ready archive for Bun's final link.

Cargo compiles the omp-natives staticlib. Its definitions are then isolated without changing any
system imports. Darwin and ELF support a partial link; lld-link does not, so on COFF the object
symbols are namespaced before the final link and SDK import records stay unmodified. Only
initializer-bearing objects load eagerly: forcing every member of Rust's compiler_builtins or a
vendored C archive is not linker-equivalent. Results are cached by their inputs and stamped with
the pi-natives package version.

Usage: python3 scripts/linked-natives/archive.py <target-id>  (prints the link manifest)
"""

import collections
import hashlib
import itertools
import json
import os
import re
import shutil
import struct
import subprocess
import sys
import tempfile
from collections.abc import Iterator
from pathlib import Path
from typing import BinaryIO, TypedDict

from pins import Target
from toolchain import HOST_ARCH, bun, capture, run, tool

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
ENTRY = "napi_register_module_v1"
PRIVATE_ENTRY = "omp_" + ENTRY


class Native(TypedDict):
    """The packaged archive, force-loaded at the final link, then `linkArgs` in order."""

    archive: str
    linkArgs: list[str]


def rust_triple(target: Target) -> str:
    if target.platform == "darwin":
        return f"{target.cpu}-apple-darwin"
    if target.platform == "win32":
        return f"{target.cpu}-pc-windows-msvc"
    return f"{target.cpu}-unknown-linux-{'musl' if target.musl else 'gnu'}"


def _cargo_staticlib(target: Target) -> tuple[Path, list[str], dict[str, Path]]:
    """Compile the staticlib; returns it, rustc's native-static-libs, and those found as archives."""
    triple = rust_triple(target)
    rustflags = []
    if target.arch == "x64":
        rustflags.append("-Ctarget-cpu=x86-64-v2")
    if target.platform == "win32":
        rustflags.append("-Ctarget-feature=+crt-static")
    if target.musl:
        rustflags.append("-Ctarget-feature=-crt-static")
    env = dict(os.environ)
    if target.id == "win32-arm64":
        # cmake-rs prefers the hyphenated triple over underscored and generic
        # names. Wrap (don't replace) the caller's SDK toolchain for ARM64 Opus.
        key = f"CMAKE_TOOLCHAIN_FILE_{triple}"
        native = sys.platform == target.platform and HOST_ARCH == target.arch
        names = [key, key.replace("-", "_"), f"{'HOST' if native else 'TARGET'}_CMAKE_TOOLCHAIN_FILE"]
        base = next((env[n] for n in [*names, "CMAKE_TOOLCHAIN_FILE"] if n in env), None)
        env[key] = str(HERE / "opus-win32-arm64.cmake")
        if base:
            env["OMP_NATIVE_CMAKE_TOOLCHAIN"] = os.path.abspath(base)
    env["OMP_LINKED_NATIVES"] = "1"
    if target.platform == "darwin":
        env["MACOSX_DEPLOYMENT_TARGET"] = "13.0"
    if rustflags:
        env["CARGO_ENCODED_RUSTFLAGS"] = "\x1f".join(rustflags)
    # The partial link consumes machine objects, not linker-plugin bitcode.
    env["CARGO_PROFILE_CI_LTO"] = "false"
    cargo = [
        *("cargo", "rustc", "--locked", "-p", "omp-natives", "--lib", "--profile", "ci", "--target", triple),
        *("--crate-type", "staticlib", "--message-format=json", "--", "--print", "native-static-libs"),
    ]
    staticlib: str | None = None
    libs: list[str] | None = None
    searches: dict[str, None] = {}
    with subprocess.Popen(cargo, cwd=ROOT, env=env, stdout=subprocess.PIPE, text=True) as proc:
        assert proc.stdout is not None
        for line in proc.stdout:
            if not line.strip():
                continue
            msg = json.loads(line)
            if msg["reason"] == "compiler-artifact" and msg.get("target", {}).get("name") == "pi_natives":
                staticlib = next((f for f in msg.get("filenames", []) if re.search(r"\.(a|lib)$", f)), None)
            elif msg["reason"] == "compiler-message":
                text = msg["message"]["message"]
                if text.startswith("native-static-libs: "):
                    libs = text.removeprefix("native-static-libs: ").split()
                elif msg["message"]["level"] == "error":
                    print(msg["message"].get("rendered") or text, file=sys.stderr)
            elif msg["reason"] == "build-script-executed":
                for entry in msg.get("linked_paths", []):
                    searches[re.sub(r"^(native|framework|dependency|all)=", "", entry)] = None
    if proc.returncode or staticlib is None or libs is None:
        raise RuntimeError(f"Cargo failed to emit the {triple} staticlib and its native-static-libs list")

    # rustc bundles static C libraries, but e.g. windows-targets requests its
    # import library by basename. Carry such archives into the partial link.
    # Never expose the entire -L list: Bun could pick the addon's copy of one
    # of its own libraries. Leave SDK-provided libraries in their original order.
    extra: dict[str, Path] = {}
    for arg in libs:
        if target.platform == "win32":
            names = [arg] if re.fullmatch(r"[^/\\:]+\.lib", arg, re.I) else []
        else:
            names = [f"lib{arg[2:]}.a"] if arg.startswith("-l") else []
        for name in names:
            for directory in searches:
                file = os.path.abspath(os.path.join(directory, name))
                if os.path.isfile(file):
                    extra[arg] = Path(file)
                    break
    return Path(staticlib), libs, extra


def build(target: Target) -> Native:
    """Build (or reuse) the stamped archive for `target`."""
    staticlib, libs, extra = _cargo_staticlib(target)
    version = json.loads((ROOT / "packages" / "natives" / "package.json").read_text(encoding="utf-8")).get("version")
    if not isinstance(version, str) or not version:
        raise RuntimeError("packages/natives/package.json has no string version")
    key = hashlib.sha256(json.dumps([target.id, version, libs, list(extra)]).encode())
    for file in [HERE / "archive.py", staticlib, *extra.values()]:
        with file.open("rb") as f:
            while block := f.read(1 << 20):
                key.update(block)
    cache = ROOT / "target" / "linked-natives" / "archive" / target.id
    out = cache / key.hexdigest()
    name = "omp-natives.lib" if target.platform == "win32" else "libomp-natives.a"
    archive = out / name
    system = [arg for arg in libs if arg not in extra]
    if target.platform == "win32":
        link_args = [str(out / "omp-deps.lib"), str(out / "omp-imports.lib"), *system]
    else:
        link_args = system
    if not archive.exists():
        cache.mkdir(parents=True, exist_ok=True)
        tmp = Path(tempfile.mkdtemp(prefix="pack-", dir=cache))
        try:
            with tempfile.TemporaryDirectory(dir=tmp) as scratch:
                if target.platform == "win32":
                    coff(staticlib, tmp, Path(scratch), target.arch, list(extra.values()))
                else:
                    partial_link(staticlib, tmp, Path(scratch), target.platform, target.arch, list(extra.values()))
            # The shared stamper also versions npm and Nix addons.
            stamper = ROOT / "scripts" / "stamp-native-version.ts"
            run(bun(), stamper, "--no-sign", "--version", version, tmp / name)
            try:
                tmp.rename(out)
            except OSError:
                if not archive.exists():
                    raise
        finally:
            shutil.rmtree(tmp, ignore_errors=True)
    return {"archive": str(archive), "linkArgs": link_args}


def lines(*argv: str | Path) -> Iterator[str]:
    """Stream a tool's stdout; archive listings can be very large."""
    with subprocess.Popen([os.fspath(a) for a in argv], stdout=subprocess.PIPE, text=True) as proc:
        assert proc.stdout is not None
        yield from proc.stdout
        if proc.wait():
            raise RuntimeError(f"{argv[0]} failed on {argv[-1]}")


def ctor_members(archive: Path, platform: str, arch: str) -> list[str]:
    # Scan section headers, not symbol-name heuristics. Constructors in transitive
    # crates (including ones with no other live reference) are roots too.
    expected = {
        "darwin": ("mach-o arm64", "mach-o 64-bit arm64")
        if arch == "arm64"
        else ("mach-o 64-bit x86-64", "mach-o x86-64"),
        "linux": ("elf64-littleaarch64",) if arch == "arm64" else ("elf64-x86-64",),
        "win32": ("coff-arm64",) if arch == "arm64" else ("coff-x86-64",),
    }[platform]
    current = None
    roots = set()
    members: collections.Counter[str] = collections.Counter()
    initializer = re.compile(
        r"^\s*\d+\s+(?:__mod_init_func|\.init_array(?:\.\S+)?|\.ctors(?:\.\S+)?|\.CRT\$X\S+)\s+"
        r"[0-9a-fA-F]*[1-9a-fA-F][0-9a-fA-F]*\s"
    )
    for line in lines(tool("llvm-objdump"), "-h", archive):
        header = re.match(r"^.*\(([^()]*)\):\s+file format (.+)$", line)
        if header:
            current, fmt = header.groups()
            if fmt.rstrip() not in expected:
                raise RuntimeError(f"{current}: {fmt} is not a {platform}-{arch} object")
            members[current] += 1
        elif current and initializer.match(line):
            roots.add(current)
    if not roots:
        raise RuntimeError(f"no initializer-bearing objects in {archive}")
    if any(members[m] != 1 for m in roots):
        raise RuntimeError("ambiguous initializer member name in staticlib")
    return sorted(roots)


def partial_link(archive: Path, out: Path, tmp: Path, platform: str, arch: str, extra: list[Path]) -> None:
    roots = ctor_members(archive, platform, arch)
    ar = tool("llvm-ar")
    run(ar, "x", archive, *roots, cwd=tmp)
    inputs = [tmp / Path(name).name for name in roots]
    obj = tmp / "omp.o"
    if platform == "darwin":
        # Apple's ld implements -r; ld64.lld does not. The export list on this
        # partial link turns everything else into local symbols, including Rust's
        # allocator/panic machinery, before the upstream Bun link sees it.
        ld = os.environ.get("DARWIN_LD") or capture("xcrun", "--find", "ld")
        cpu = "arm64" if arch == "arm64" else "x86_64"
        alias = ("-u", "_" + ENTRY, "-alias", "_" + ENTRY, "_" + PRIVATE_ENTRY, "-exported_symbol", "_" + PRIVATE_ENTRY)
        run(ld, "-r", "-arch", cpu, *alias, *inputs, archive, *extra, "-o", obj)
    else:
        merged = tmp / "merged.o"
        # Do not leave COMDAT signatures for the final linker to coalesce with
        # Bun's copies of the same Rust/C++ inline routines after localization.
        run(tool("ld.lld"), "-r", "--force-group-allocation", "-u", ENTRY, *inputs, archive, *extra, "-o", merged)
        rename = ("--keep-global-symbol", ENTRY, "--redefine-sym", f"{ENTRY}={PRIVATE_ENTRY}")
        run(tool("llvm-objcopy"), *rename, merged, obj)
    run(ar, "rcs", out / "libomp-natives.a", obj)


def archive_members(file: Path) -> Iterator[tuple[bytes, bytes]]:
    """Stream ar members by value, including duplicate COFF import-member names."""
    names = b""
    with file.open("rb") as f:
        if f.read(8) != b"!<arch>\n":
            raise ValueError(f"not an archive: {file}")
        while header := f.read(60):
            if len(header) != 60 or header[-2:] != b"`\n":
                raise ValueError(f"bad archive header in {file}")
            name = header[:16].rstrip()
            size = int(header[48:58])
            data = f.read(size)
            if len(data) != size:
                raise ValueError(f"truncated archive member in {file}")
            if size % 2:
                f.read(1)
            if name == b"//":
                names = data
                continue
            if name in (b"/", b"/SYM64/", b"/<ECSYMBOLS>/"):
                continue
            if name.startswith(b"/") and name[1:].isdigit():
                start = int(name[1:])
                end = re.compile(rb"/\n|\x00").search(names, start)
                if end is None:
                    raise ValueError("invalid long archive member name")
                name = names[start : end.start()]
            elif name.startswith(b"#1/"):
                count = int(name[3:])
                name, data = data[:count].rstrip(b"\0"), data[count:]
            else:
                name = name.removesuffix(b"/")
            if not name.startswith(b"__.SYMDEF"):
                yield name, data


def add_member(f: BinaryIO, name: bytes, data: bytes) -> None:
    # Short synthetic names keep duplicate-basename objects distinct. llvm-ar s
    # builds the archive index; the member name is not an external symbol.
    assert len(name) <= 15
    f.write((name + b"/").ljust(16) + b"0           0     0     100644  " + str(len(data)).encode().ljust(10) + b"`\n")
    f.write(data)
    if len(data) % 2:
        f.write(b"\n")


def directives(data: bytes, renames: dict[bytes, bytes]) -> bytes:
    # COFF .drectve embeds /INCLUDE, /ALTERNATENAME, and /EXPORT as plain text;
    # llvm-objcopy renames the symbol table but cannot see these references.
    big = data[:4] == b"\x00\x00\xff\xff"
    if big:
        offset, sections = 56, struct.unpack_from("<I", data, 44)[0]
    else:
        sections, optional = struct.unpack_from("<H12xH", data, 2)
        offset = 20 + optional

    def rename_option(m: re.Match[bytes]) -> bytes:
        raw = m[0]
        option, _, arg = raw.replace(b'"', b"").partition(b":")
        kind = option[1:].lower() if option[:1] in (b"/", b"-") else b""
        if kind == b"export":
            # /EXPORT:public[=implementation][,@ordinal][,DATA] roots
            # the implementation. Preserve that root, not its DLL ABI.
            # A symbol outside the addon is owned by the host instead.
            target = arg.split(b",", 1)[0].split(b"=")[-1]
            return b"/INCLUDE:" + renames[target] if target in renames else raw
        if kind in (b"include", b"alternatename"):
            prefix, _, operands = raw.partition(b":")
            return prefix + b":" + re.sub(rb'[^="]+', lambda s: renames.get(s[0], s[0]), operands)
        return raw

    for i in range(sections):
        h = offset + 40 * i
        if data[h : h + 8] == b".drectve":
            size, at = struct.unpack_from("<II", data, h + 16)
            old = data[at : at + size]
            new = re.sub(rb'(?:[^\s"\x00]|"[^"\x00]*")+', rename_option, old)
            if new != old:
                buf = bytearray(data)
                struct.pack_into("<II", buf, h + 16, len(new), len(buf))
                buf.extend(new)
                data = bytes(buf)
    return data


def local_import_cells(code: Path, imports: Path, renames: dict[bytes, bytes], tmp: Path, arch: str) -> list[Path]:
    # C shims can compile against a dllimport declaration while Rust supplies
    # the actual function in the same archive. Their COFF references address a
    # pointer, not the function. Put each read-only pointer in its own lazy
    # member so a reference pulls exactly its owning definition, not every C
    # API. lld's local-import fallback does not extract lazy definitions.
    def import_symbols(lib: Path, selection: str) -> set[bytes]:
        listing = lines(tool("llvm-nm"), "--extern-only", selection, "--format=just-symbols", lib)
        return {line.strip().encode() for line in listing if line.startswith("__imp_")}

    candidates = import_symbols(code, "--undefined-only") - import_symbols(imports, "--defined-only")
    cpu = "aarch64" if arch == "arm64" else "x86_64"
    assembler = tool("llvm-mc")
    cells = []
    for ptr in sorted(candidates):
        definition = renames.get(ptr[len(b"__imp_") :])
        if not definition or ptr in renames:
            continue
        alias = b"__imp_" + definition
        renames[ptr] = alias
        cell = tmp / f"iat{len(cells):x}.obj"
        asm = b'.section .rdata,"dr"\n.p2align 3\n.globl ' + alias + b"\n" + alias + b":\n.quad " + definition + b"\n"
        run(assembler, "-triple", f"{cpu}-pc-windows-msvc", "-filetype=obj", "-o", cell, input=asm)
        cells.append(cell)
    return cells


def coff(archive: Path, out: Path, tmp: Path, arch: str, extra: list[Path]) -> None:
    ar = tool("llvm-ar")
    code = tmp / "code.lib"
    imports = out / "omp-imports.lib"
    archives = [archive, *extra]
    import_names = set()
    for a in archives:
        for name, data in archive_members(a):
            # IMPORT_OBJECT_HEADER (not a COFF bigobj, whose version is 2).
            # The other descriptor/thunk objects carry this same member name.
            # Import targets include .cpl/.sys/.ax, not just ordinary DLLs.
            if data.startswith(b"\0\0\xff\xff\0\0"):
                import_names.add(name)
                module = data[20:].split(b"\0", 2)[1].lower()
                if module in (b"node.exe", b"node.dll", b"libnode.dll"):
                    raise ValueError(f"unexpected N-API DLL import {module!r} in staticlib")
    with code.open("wb") as ordinary, imports.open("wb") as system:
        ordinary.write(b"!<arch>\n")
        system.write(b"!<arch>\n")
        members = itertools.chain.from_iterable(archive_members(a) for a in archives)
        for idx, (name, data) in enumerate(members):
            # Windows raw-dylib and windows-targets imports are a group of
            # descriptors plus short-import records. Namespacing even one of
            # these changes the DLL lookup, so keep that library lazy and intact.
            dest = system if name in import_names else ordinary
            add_member(dest, f"{idx:x}.obj".encode(), data)
    run(ar, "s", imports)
    roots = {s.encode() for s in ctor_members(code, "win32", arch)}
    renames: dict[bytes, bytes] = {}
    for line in lines(tool("llvm-nm"), "--no-sort", "--extern-only", "--defined-only", "--format=posix", code):
        fields = line.rstrip().rsplit(maxsplit=3)
        if len(fields) != 4:
            continue  # empty line or member name
        name = fields[0].encode()
        if name not in renames:
            private = PRIVATE_ENTRY if name == ENTRY.encode() else f"__omp_private_{len(renames):x}"
            renames[name] = private.encode()
    if ENTRY.encode() not in renames:
        raise ValueError("N-API entry point missing from staticlib")
    cells = local_import_cells(code, imports, renames, tmp, arch)
    symbol_map = tmp / "symbols"
    with symbol_map.open("wb") as f:
        for name, new in renames.items():
            f.write(name + b" " + new + b"\n")
    # Keep the stamp and all napi constructors in the eagerly loaded archive;
    # remaining members are indexed and extracted on reference, as in Rust's
    # cdylib link. The real process imports are resolved at module registration
    # by the locked napi-sys 3.4.1 (not by a DllMain callback).
    eager, lazy = tmp / "eager.lib", tmp / "lazy.lib"
    with eager.open("wb") as r, lazy.open("wb") as d:
        r.write(b"!<arch>\n")
        d.write(b"!<arch>\n")
        for name, data in archive_members(code):
            dest = r if name in roots or b"PI_NATIVES_VERSION_STAMP:" in data else d
            add_member(dest, name, directives(data, renames))
    for src, dest in [(eager, out / "omp-natives.lib"), (lazy, out / "omp-deps.lib")]:
        run(tool("llvm-objcopy"), "--redefine-syms", symbol_map, src, dest)
        if src == lazy and cells:
            run(ar, "rs", dest, *cells)
        else:
            run(ar, "s", dest)


if __name__ == "__main__":
    if len(sys.argv) != 2:
        sys.exit("usage: archive.py <target-id>")
    print(json.dumps(build(Target.parse(sys.argv[1]))))
