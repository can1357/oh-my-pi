"""Toolchain and rule building the Apple Foundation Models bridge dylib.

`applefm_bridge` runs crates/pi-natives/src/applefm/build-bridge.sh with the
toolchain resolved for `//bazel/toolchains/swift:toolchain_type`:

    mac exec hosts    the host Xcode / Command Line Tools Swift that the
                      @applefm_swift repository rule detected (toolchain.txt;
                      empty when no Swift 6.4 with the macOS 27 SDK exists)
    linux exec hosts  the pinned swift.org toolchain (@swift_linux), @macos_sdk
                      and @llvm_darwin_tools' ld64.lld, all declared inputs

Toolchains exist only for arm64 targets (Foundation Models needs Apple
silicon); with none resolved the rule writes an empty file, which the addon
reports as "bridge not built".
"""

def _applefm_toolchain_impl(ctx):
    if ctx.file.toolchain_file:
        return [platform_common.ToolchainInfo(args = [], files = depset([ctx.file.toolchain_file]), toolchain_file = ctx.file.toolchain_file)]
    swiftc = ctx.executable.swiftc
    sdk = ctx.file.sdk_settings.dirname
    swift_root = swiftc.dirname.rsplit("/", 2)[0]  # <repo>/usr/bin/swiftc -> <repo>
    args = [
        swiftc.path,
        sdk,
        # See //bazel/toolchains/swift:linux.bzl for why each of these is needed.
        "-resource-dir",
        swift_root + "/darwin",
        "-I",
        sdk + "/usr/lib/swift/shims",
        "-ld-path=" + ctx.file.ld.path,
        "-Xclang-linker",
        "-mlinker-version=907",
    ]
    return [platform_common.ToolchainInfo(args = args, files = depset(ctx.files.srcs), toolchain_file = None)]

applefm_toolchain = rule(
    implementation = _applefm_toolchain_impl,
    doc = "A Swift toolchain able to build bridge.swift: either a detected host one (toolchain_file) or a hermetic one.",
    attrs = {
        "ld": attr.label(allow_single_file = True, cfg = "exec", doc = "ld64.lld the Swift driver links with."),
        "sdk_settings": attr.label(allow_single_file = True, doc = "SDKSettings.json of the macOS SDK; its directory is the SDK."),
        "srcs": attr.label_list(allow_files = True, cfg = "exec", doc = "Every file the compile and link read."),
        "swiftc": attr.label(allow_single_file = True, cfg = "exec", executable = True),
        "toolchain_file": attr.label(allow_single_file = True, doc = "@applefm_swift//:toolchain.txt (mac hosts)."),
    },
)

_TOOLCHAIN_TYPE = "//bazel/toolchains/swift:toolchain_type"

def _applefm_bridge_impl(ctx):
    out = ctx.actions.declare_file(ctx.attr.out)
    toolchain = ctx.toolchains[_TOOLCHAIN_TYPE]
    if not toolchain:
        ctx.actions.write(out, "")
        return [DefaultInfo(files = depset([out]))]
    if toolchain.toolchain_file:
        # "<swiftc>\t<sdk>\t<fingerprint>": the first two columns, or nothing.
        command = '/bin/sh "$1" build "$2" arm64 $(cut -f1,2 "$3")'
        arguments = [ctx.file.script.path, out.path, toolchain.toolchain_file.path]
    else:
        command = 'script=$1 out=$2; shift 2; exec /bin/sh "$script" build "$out" arm64 "$@"'
        arguments = [ctx.file.script.path, out.path] + toolchain.args
    ctx.actions.run_shell(
        command = command,
        arguments = arguments,
        inputs = depset([ctx.file.script, ctx.file.src], transitive = [toolchain.files]),
        outputs = [out],
        mnemonic = "AppleFmBridge",
        progress_message = "Building the Apple Foundation Models bridge %{output}",
    )
    return [DefaultInfo(files = depset([out]))]

applefm_bridge = rule(
    implementation = _applefm_bridge_impl,
    doc = "The bridge.swift dylib the pi-natives addon embeds, or an empty file without a toolchain.",
    attrs = {
        "out": attr.string(mandatory = True),
        "script": attr.label(mandatory = True, allow_single_file = [".sh"]),
        "src": attr.label(mandatory = True, allow_single_file = [".swift"]),
    },
    toolchains = [config_common.toolchain_type(_TOOLCHAIN_TYPE, mandatory = False)],
)
