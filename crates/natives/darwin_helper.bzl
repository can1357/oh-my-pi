"""Build embedded AppKit executables with the same flags as build.rs.

The helper compiles with the target cc toolchain's own compiler: the host Xcode
toolchain on mac hosts, //bazel/toolchains/darwin's clang + ld64.lld on linux
hosts.
"""

load("@rules_cc//cc:action_names.bzl", "ACTION_NAMES")
load("@rules_cc//cc:find_cc_toolchain.bzl", "find_cc_toolchain", "use_cc_toolchain")
load("@rules_cc//cc/common:cc_common.bzl", "cc_common")

def _darwin_helper_impl(ctx):
    cc_toolchain = find_cc_toolchain(ctx)
    features = cc_common.configure_features(
        ctx = ctx,
        cc_toolchain = cc_toolchain,
        requested_features = ctx.features,
        unsupported_features = ctx.disabled_features,
    )
    compiler = cc_common.get_tool_for_action(feature_configuration = features, action_name = ACTION_NAMES.c_compile)
    env = cc_common.get_environment_variables(
        feature_configuration = features,
        action_name = ACTION_NAMES.c_compile,
        variables = cc_common.empty_variables(),
    )
    out = ctx.actions.declare_file(ctx.label.name + ".bin")
    args = ctx.actions.args()
    args.add_all(["-x", "objective-c", "-fobjc-arc", "-fblocks", "-fno-ident", "-Os"])
    args.add("-mmacosx-version-min=" + ctx.attr.minimum_macos)
    for framework in ctx.attr.frameworks:
        args.add_all(["-framework", framework])
    args.add_all(["-Wl,-dead_strip", "-Wl,-adhoc_codesign", "-arch", ctx.attr.arch])
    args.add(ctx.file.src)
    args.add("-o", out)
    ctx.actions.run(
        executable = compiler,
        arguments = [args],
        inputs = depset([ctx.file.src], transitive = [cc_toolchain.all_files]),
        outputs = [out],
        env = env,
        mnemonic = "DarwinHelper",
        progress_message = "Compiling darwin helper %{label}",
    )
    return [DefaultInfo(files = depset([out]))]

_darwin_helper = rule(
    implementation = _darwin_helper_impl,
    attrs = {
        "arch": attr.string(mandatory = True, values = ["arm64", "x86_64"]),
        "frameworks": attr.string_list(),
        "minimum_macos": attr.string(mandatory = True),
        "src": attr.label(mandatory = True, allow_single_file = [".m"]),
    },
    fragments = ["cpp"],
    toolchains = use_cc_toolchain(),
)

def darwin_helper(name, src, frameworks = ["AppKit"], minimum_macos = "12.0"):
    _darwin_helper(
        name = name,
        src = src,
        arch = select({
            "//bazel/triples:aarch64-apple-darwin": "arm64",
            "//bazel/triples:x86_64-apple-darwin": "x86_64",
        }),
        frameworks = frameworks,
        minimum_macos = minimum_macos,
        target_compatible_with = ["@platforms//os:macos"],
    )
