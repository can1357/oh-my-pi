"""Final link: a verified Bun kit plus this build's pi-natives archive (archive.py).

The executable registers its own Node-API module: self-register.c exports `napi_register_module_v1`,
so Bun's ordinary `process.dlopen` of the running image loads pi-natives without a `.node` file.
There is no Bun source or fallback compiler path.

Usage: python3 scripts/linked-natives/link.py <target-id> <kit-directory> <native-manifest.json>
"""

import json
import os
import re
import shutil
import sys
import tempfile
from pathlib import Path

from archive import Native
from kit import Kit, digest
from pins import BUN_REVISION, BUN_VERSION, Target
from toolchain import HOST_ARCH, capture, run, tool
from verify import verify_link_outputs

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
EXPORT = "napi_register_module_v1"


def _rsp_path(file: str) -> str:
    # Use slash separators even on Windows. Both MSVC and GNU response files
    # understand quoted paths, without GNU interpreting backslashes as escapes.
    return '"' + file.replace(os.sep, "/").replace('"', '\\"') + '"'


def _archive_args(platform: str, native: Native) -> list[str]:
    archive = native["archive"]
    if platform == "darwin":
        load = ["-Xlinker", "-force_load", "-Xlinker", archive]
    elif platform == "win32":
        load = [f"/WHOLEARCHIVE:{archive}"]
    else:
        load = ["-Wl,--whole-archive", archive, "-Wl,--no-whole-archive"]
    return [*load, *native["linkArgs"]]


def link(target: Target, kit_dir: Path, native: Native) -> Path:
    """Link and audit the runtime template for `target`; returns the stripped executable."""
    kit_dir = kit_dir.resolve()
    kit: Kit = json.loads((kit_dir / "kit.json").read_text(encoding="utf-8"))
    if (kit["format"], kit["target"], kit["revision"], kit["bun"]) != (1, target.id, BUN_REVISION, BUN_VERSION):
        raise RuntimeError(f"Incompatible {target.id} Bun link kit at {kit_dir}")
    for name, sha in kit["files"].items():
        if (
            not re.fullmatch(r"files/[\w.+-]+|LICENSE\.md|verify\.mjs", name, re.ASCII)
            or not re.fullmatch(r"[a-f0-9]{64}", sha)
            or digest(kit_dir / name) != sha
        ):
            raise RuntimeError(f"Invalid link kit file: {name}")

    def payload(name: str) -> Path:
        if name not in kit["files"]:
            raise RuntimeError(f"Unverified kit input: {name}")
        return kit_dir / name

    cache = ROOT / "target" / "linked-natives" / "linked" / target.id
    cache.mkdir(parents=True, exist_ok=True)
    out = Path(tempfile.mkdtemp(prefix="link-", dir=cache))
    try:
        windows = target.platform == "win32"
        darwin = target.platform == "darwin"
        if darwin and sys.platform != "darwin":
            raise RuntimeError("The Apple ld release kit requires a Darwin linker host")
        if darwin:
            sdk = os.environ.get("SDKROOT") or capture("xcrun", "--sdk", "macosx", "--show-sdk-path")
        elif windows:
            sdk = os.environ.get("WINDOWS_SYSROOT")
        else:
            sdk = os.environ.get("LINUX_MUSL_SYSROOT" if target.musl else "LINUX_GLIBC_SYSROOT")
        clang = tool("clang-cl" if windows else "clang++")
        if not re.search(r"clang version 23\.", capture(clang, "--version")):
            raise RuntimeError("Bun link kits require LLVM 23")
        (out / "obj").mkdir()

        if windows:
            triple = f"{target.cpu}-pc-windows-msvc"
        elif darwin:
            triple = f"{target.cpu}-apple-macos13.0"
        else:
            triple = f"{target.cpu}-linux-{'musl' if target.musl else 'gnu'}"
        registration = "self-register.obj" if windows else "self-register.o"
        sysroot = [f"--sysroot={sdk}"] if not windows and sdk else []
        compile_flags = [f"--target={triple}", "-Os", "-fvisibility=hidden", "-ffreestanding", *sysroot]
        run(tool("clang"), *compile_flags, "-c", HERE / "self-register.c", "-o", registration, cwd=out)
        symbol_list = kit["profile"]["expect"]["exports"].get("symbolList")
        darwin_exports: Path | None = None
        if darwin:
            if not symbol_list:
                raise RuntimeError("Darwin link kit is missing its export list")
            # Keep the verified kit immutable. Expose exactly the Node-API entry in addition to Bun's exports.
            darwin_exports = out / "omp-symbols.txt"
            symbols = payload(symbol_list).read_text(encoding="utf-8")
            darwin_exports.write_text(f"{symbols.rstrip()}\n_{EXPORT}\n", encoding="utf-8", newline="")

        profile = out / kit["profile"]["exe"]
        runtime = out / ("bun.exe" if windows else "bun")
        args: list[str] = []
        if windows:
            lld = os.path.dirname(tool("lld-link"))
            args += ["/nologo", "-fuse-ld=lld", f"/clang:-B{lld}", f"/clang:--target={target.cpu}-pc-windows-msvc"]
        if darwin:
            args.append(f"--target={'arm64' if target.arch == 'arm64' else 'x86_64'}-apple-darwin")
        # clang-cl interprets an absolute POSIX path beginning with "/" as an
        # option even inside its rsp file. Use paths relative to the link cwd.
        eager = "\n".join(_rsp_path(os.path.relpath(payload(f), out)) for f in kit["eager"])
        (out / "inputs.rsp").write_text(eager, encoding="utf-8", newline="")
        args += ["@inputs.rsp", registration]
        if kit["lazy"]:
            group = [_rsp_path(str(payload(f))) for f in kit["lazy"]]
            start, end = ("/start-lib", "/end-lib") if windows else ("--start-lib", "--end-lib")
            (out / "lazy.rsp").write_text("\n".join([start, *group, end]) + "\n", encoding="utf-8", newline="")
            args.append("/clang:-Wl,@lazy.rsp" if windows else "-Wl,@lazy.rsp")
        if windows:
            args += [f"/Fe{profile}", "/link", f"/EXPORT:{EXPORT}"]
        if target.platform == "linux":
            args.append("-Wl,--wrap=dlopen")

        def placeholder(m: re.Match[str]) -> str:
            key = m[1]
            if key == "kit":
                value = str(kit_dir)
            elif key == "out":
                value = str(out)
            elif key == "sdk":
                value = sdk
            elif key == "lld":
                value = tool("ld.lld")
            elif key == "ucrt":
                value = os.environ.get("BUN_LINK_KIT_UCRT_LIB")
            else:
                value = None
            if not value:
                raise RuntimeError(f"Missing {key} for {target.id} linker input {m.string}")
            return value

        for flag in kit["ldflags"]:
            if darwin_exports and flag == f"{{kit}}/{symbol_list}":
                args.append(str(darwin_exports))
            elif flag == "{native}":
                args += _archive_args(target.platform, native)
            elif flag == "/winsysroot:{sdk}" and not sdk and sys.platform == "win32" and os.environ.get("LIB"):
                continue
            else:
                args.append(re.sub(r"\{(\w+)\}", placeholder, flag, flags=re.ASCII))
        if not windows:
            args += ["-o", str(profile)]
        run(clang, *args, cwd=out)

        if windows:
            shutil.copyfile(profile, runtime)
        else:
            if darwin:
                strip = tool("llvm-strip")
            else:
                # Upstream uses GNU binutils on ELF. llvm-strip accepts these flags
                # but can retain megabytes of holes when removing unwind sections.
                # A libc choice does not affect binutils' CPU-specific ELF backend.
                prefixed = f"{target.cpu}-linux-gnu-strip"
                native_strip = sys.platform == "linux" and HOST_ARCH == target.arch
                gnu = shutil.which(prefixed) or (shutil.which("strip") if native_strip else None)
                if not gnu or not capture(gnu, "--version").startswith("GNU strip"):
                    raise RuntimeError(f"Install target GNU binutils ({prefixed}) for {target.id}")
                strip = gnu
            run(strip, *kit["stripflags"], profile, "-o", runtime, cwd=out)

        tools = {
            "nm": tool("llvm-nm"),
            "objdump": tool("llvm-objdump"),
            "readobj": tool("llvm-readobj"),
            "cxxfilt": tool("llvm-cxxfilt"),
        }
        for name, spec in (("bun-profile", kit["profile"]), ("bun-shim-impl", kit.get("shim"))):
            if not spec:
                continue
            exports = spec["expect"]["exports"]
            for key in ("symbolList", "versionScript"):
                if exports.get(key):
                    custom = key == "symbolList" and darwin_exports
                    exports[key] = str(darwin_exports) if custom else str(payload(exports[key]))
            exe = str(profile) if name == "bun-profile" else str(payload(spec["exe"]))
            spec_json = json.dumps({**spec, "exe": exe, "tools": tools})
            (out / f"{name}.verify.json").write_text(spec_json, encoding="utf-8", newline="")
        inputs = [*map(payload, kit["audit"]), out / registration]
        verify_link_outputs(out, target, payload("verify.mjs"), inputs, native)
        # Drop transient debug data/maps (often multiple GB); keep just the verified runtime.
        for entry in out.iterdir():
            if entry.name == runtime.name:
                continue
            if entry.is_dir():
                shutil.rmtree(entry)
            else:
                entry.unlink()
        return runtime
    except BaseException:
        shutil.rmtree(out, ignore_errors=True)
        raise


if __name__ == "__main__":
    if len(sys.argv) != 4:
        sys.exit("usage: link.py <target-id> <kit-directory> <native-manifest.json>")
    manifest: Native = json.loads(Path(sys.argv[3]).read_text(encoding="utf-8"))
    print(link(Target.parse(sys.argv[1]), Path(sys.argv[2]), manifest))
