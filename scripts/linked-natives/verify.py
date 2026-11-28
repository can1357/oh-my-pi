"""Strict audit of a linked runtime: upstream Bun's verifier with tight OMP deltas.

The kit's verify.mjs scans exports, libraries, imports, initializers, hardening and duplicate
symbols. The policy below only admits what pi-natives needs and never learns an allowance from the
binary being verified.
"""

import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path
from typing import Any

from archive import Native
from pins import Target
from toolchain import bun, capture, run

_MAC_FRAMEWORKS = [
    "CoreServices",
    "CoreFoundation",
    "ApplicationServices",
    "AppKit",
    "CoreVideo",
    "CoreData",
    "CoreText",
    "CoreImage",
    "CoreGraphics",
    "Metal",
    "CloudKit",
    "QuartzCore",
    "Foundation",
    "AudioToolbox",
    "Carbon",
    "DeviceCheck",
    "Security",
    "IOKit",
]


def apply_native_policy(spec: dict[str, Any], target: Target) -> None:
    """Extend the pinned upstream expectations by exactly what pi-natives links."""
    e = spec["expect"]
    fmt = {"darwin": "macho", "linux": "elf", "win32": "pe"}[target.platform]
    if e["format"] != fmt:
        raise RuntimeError(f"Expected {fmt} verification spec for {target.id}, got {e['format']}")
    needed = e["neededLibs"]
    if fmt == "pe":
        # Both MSVC targets use WS2_32 rather than the Winsock 1 compatibility DLL.
        needed["names"] = [name for name in needed["names"] if name.lower() != "wsock32.dll"]
        # Native shell, clipboard/graphics, display scaling, process/session, property and crypto APIs.
        needed["names"] += [
            "shlwapi.dll",
            "combase.dll",
            "gdi32.dll",
            "dwmapi.dll",
            "api-ms-win-shcore-scaling-l1-1-1.dll",
            "wtsapi32.dll",
            "bcrypt.dll",
            "propsys.dll",
            "psapi.dll",
            "version.dll",
        ]
        return
    if e.get("staticInitializers") is None:
        raise RuntimeError(f"Expected upstream initializer audit for {target.id}")
    # Rust v0 symbols vary in crate disambiguators, module paths and generated binding IDs.
    # Permit only napi-rs registrations *in pi_natives*, with ctor's exact generated leaf,
    # and the one explicit startup hook in crates/natives (not arbitrary Rust constructors).
    e["staticInitializers"] += [
        f"_RNvNvNvNv{nested}Cs*_10pi_natives*___napi_register__*__18___CTOR_PRIVATE_REF14___ctor_private"
        for nested in ("", "Nt", "NtNt", "NtNtNt")
    ]
    e["staticInitializers"].append(
        "_RNvNvNvNvCs*_10pi_natives28install_native_crash_handler1__18___CTOR_PRIVATE_REF14___ctor_private"
    )
    if fmt == "macho":
        # System SDK install names pulled in by pi_natives' UI, media, spell-check and OS integrations.
        # These are full paths: a Homebrew dylib or an @rpath lookalike must still fail.
        needed["names"] += ["/usr/lib/libiconv.2.dylib", "/usr/lib/libobjc.A.dylib"]
        for f in _MAC_FRAMEWORKS:
            abi = "C" if f in ("AppKit", "Foundation") else "A"
            needed["names"].append(f"/System/Library/Frameworks/{f}.framework/Versions/{abi}/{f}")
    elif target.musl:
        # Alpine's libgcc supplies Rust's unwinder. Its aarch64 port kept a
        # historical GLIBC_2.0 version tag for four frame-registration functions.
        # Check the actual provider and symbol names below, not just this ceiling.
        needed["names"].append("libgcc_s.so.1")
        e["maxSymbolVersions"] = {"GCC": "4.2.0", "GLIBC": "2.0"} if target.arch == "arm64" else {"GCC": "4.2.0"}
        return
    else:
        # The Rust addon's unwinder imports libgcc_s. Keep Bun's glibc shipping floor even
        # when a local (no sysroot) Ninja graph would leave version ceilings unchecked.
        needed["names"].append("libgcc_s.so.1")
        e["maxSymbolVersions"] = {"GLIBC": "2.17", "GCC": "4.2.0"}
    # Rust unwinding is intentional; none of Bun's other forbidden imports (C++
    # throw path, emulated TLS, libatomic, etc.) are relaxed.
    e["forbiddenImports"] = [symbol for symbol in e["forbiddenImports"] if symbol != "_Unwind_Resume"]


def _check_musl_arm64_unwind(spec: dict[str, Any]) -> None:
    """A version tag alone does not identify its provider. In particular, *no* glibc DSO is permitted on Alpine."""
    exe = spec["exe"]
    text = capture(spec["tools"]["readobj"], "--version-info", "--dyn-symbols", exe)
    sections = re.split(r"^VersionRequirements \[\r?$", text, flags=re.M)
    if len(sections) < 2:
        raise RuntimeError(f"Missing ELF version requirements: {exe}")
    providers = 0
    for dep in re.split(r"^  Dependency \{\r?$", sections[1], flags=re.M)[1:]:
        tags = re.findall(r"^\s+Name: (GLIBC_\S+)", dep, re.M)
        if not tags:
            continue
        provider = re.search(r"^\s+FileName: (\S+)", dep, re.M)
        if not provider or provider[1] != "libgcc_s.so.1" or ",".join(tags) != "GLIBC_2.0":
            raise RuntimeError(f"Unexpected GLIBC version provider in {exe}: {dep.strip()}")
        providers += 1
    expected = {"__register_frame", "__deregister_frame", "__register_frame_info", "__deregister_frame_info"}
    for name, version in re.findall(r"^\s+Name: (\S+?)@(GLIBC_\S+) \(\d+\)", text, re.M):
        if version != "GLIBC_2.0" or name not in expected:
            raise RuntimeError(f"Unexpected musl versioned import in {exe}: {name}@{version}")
        expected.remove(name)
    if providers != 1 or expected:
        raise RuntimeError(f"Unexpected musl arm64 frame-registration ABI: {exe}")


def _check_pe_sections(spec: dict[str, Any], target: Target) -> None:
    """Upstream verifies PE loader flags (including DEP), not each section's own protection."""
    exe = spec["exe"]
    text = capture(spec["tools"]["readobj"], "--sections", exe)
    sections = re.findall(r"^\s*Section \{([^}]+)\}", text, re.M)
    arch = re.search(r"^Arch:\s+(\S+)", text, re.M)
    if not arch or arch[1] != target.cpu or not sections:
        raise RuntimeError(f"Expected a {target.id} PE image with sections: {exe}")
    for section in sections:
        flags = re.search(r"Characteristics \[ \(0x([0-9a-f]+)\)", section, re.I)
        if not flags:
            raise RuntimeError(f"Missing section characteristics in {exe}")
        value = int(flags[1], 16)
        if value & 0x80000000 and value & 0x20000000:
            name = re.search(r"Name: (\S+)", section)
            raise RuntimeError(f"Writable executable PE section in {exe}: {name[1] if name else '?'}")


def verify_link_outputs(build_dir: Path, target: Target, script: Path, inputs: list[Path], native: Native) -> None:
    """Strictly audit the linked profile, the shipped runtime and every native link input."""

    def check(*args: str | Path) -> None:
        try:
            run(bun(), script, *args, cwd=build_dir)
        except subprocess.CalledProcessError as err:
            raise RuntimeError(f"Linked runtime audit failed: {target.id} ({args[0]} {args[1]})") from err

    # The stock verifier only emits this spec when *all* its LLVM tools exist.
    # Treat missing tools/specs as failures. Never accept a previous warning-only stamp.
    spec = json.loads((build_dir / "bun-profile.verify.json").read_text(encoding="utf-8"))
    apply_native_policy(spec, target)
    tmp = Path(tempfile.mkdtemp(prefix="omp-verify-", dir=build_dir))
    try:
        spec_file = tmp / "spec.json"

        def audit_image() -> None:
            spec_file.write_text(json.dumps(spec), encoding="utf-8", newline="")
            check("binary", spec_file)
            if target.id == "linux-musl-arm64":
                _check_musl_arm64_unwind(spec)

        audit_image()
        # The profile retains symbol/debug data needed for the above scan. Also verify
        # the actual stripped artifact passed to Bun.build: loader ABI, W^X, exports, etc.
        spec["exe"] = str(build_dir / ("bun.exe" if target.platform == "win32" else "bun"))
        spec["expect"].pop("staticInitializers", None)
        spec["expect"].pop("debugInfo", None)
        audit_image()
        if target.platform == "win32":
            _check_pe_sections(spec, target)
            check("binary", build_dir / "bun-shim-impl.verify.json")
        if target.platform == "darwin" and target.arch == "arm64" and sys.platform == "darwin":
            try:
                run("/usr/bin/codesign", "--verify", "--strict", spec["exe"])
            except subprocess.CalledProcessError as err:
                raise RuntimeError(f"Invalid Mach-O runtime signature: {spec['exe']}") from err

        # The native archive is passed as a flag, outside the upstream duplicate edge.
        # COFF's second implementation archive is lazy; audit it as well. Do not
        # treat omp-imports.lib as implementation objects: it is SDK import stubs
        # and repeated DLL descriptors, just like the system import libraries. The
        # final binary's exact DLL imports were checked above.
        libraries = [
            arg
            for arg in native["linkArgs"]
            if os.path.isabs(arg) and re.search(r"\.(lib|a)$", arg, re.I) and os.path.basename(arg) != "omp-imports.lib"
        ]
        rsp = tmp / "inputs.rsp"
        rsp.write_text("\n".join([*map(str, inputs), native["archive"], *libraries]), encoding="utf-8", newline="")
        objdump = [spec["tools"]["objdump"]] if target.platform == "win32" else []
        check("duplicates", spec["tools"]["nm"], rsp, tmp / "duplicates.txt", *objdump)
    finally:
        shutil.rmtree(tmp, ignore_errors=True)
