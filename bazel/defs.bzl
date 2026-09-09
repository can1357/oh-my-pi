"""Rules for producing release-grade, canonically named pi_natives addons.

`native_addon` transitions //crates/pi-natives:pi_natives onto a shipping
platform with the release codegen profile (opt, thin LTO, cgu=16, stripped —
mirrors the cargo `ci` profile) and renames the produced shared library to the
loader's canonical `pi_natives.<platform>-<arch>[-<variant>].node` filename.

Encoding the profile in the transition means `bazel build //:natives-<t>` is
always release-grade regardless of -c, and every addon shares one cache entry
per (platform, source) pair.
"""

_ADDON_RUSTC_FLAGS = [
    "-Ccodegen-units=16",
    "-Cstrip=symbols",
]

def _addon_transition_impl(settings, attr):
    # Statically link the MSVC CRT for the shipped win32 addon: rustc gets
    # +crt-static via the crate's rustc_flags select, and the C dependencies
    # (opus/cmake, tree-sitter, blake3, ring) must move to /MT in lock-step so
    # the final .node imports no VCRUNTIME140.dll from the Visual C++
    # Redistributable (absent on a clean Windows install -> dlopen error 126).
    # The static_link_msvcrt cc feature flips the toolchain compile flags that
    # rules_rust forwards to cc-rs/cmake as CFLAGS/CXXFLAGS; it is inert for the
    # zig/darwin toolchains, so scoping it to win32 is belt-and-suspenders.
    features = list(settings["//command_line_option:features"])
    if "win32" in str(attr.platform):
        features = features + ["static_link_msvcrt"]
    return {
        "//command_line_option:platforms": str(attr.platform),
        "//command_line_option:compilation_mode": "opt",
        "//command_line_option:features": features,
        "@rules_rust//rust/settings:lto": "thin",
        "@rules_rust//rust/settings:extra_rustc_flags": _ADDON_RUSTC_FLAGS,
    }

_addon_transition = transition(
    implementation = _addon_transition_impl,
    inputs = ["//command_line_option:features"],
    outputs = [
        "//command_line_option:platforms",
        "//command_line_option:compilation_mode",
        "//command_line_option:features",
        "@rules_rust//rust/settings:lto",
        "@rules_rust//rust/settings:extra_rustc_flags",
    ],
)

_SHARED_LIB_EXTENSIONS = ("so", "dylib", "dll")

def _native_addon_impl(ctx):
    libs = [
        f
        for f in ctx.attr.lib[0][DefaultInfo].files.to_list()
        if f.extension in _SHARED_LIB_EXTENSIONS
    ]
    if len(libs) != 1:
        fail("expected exactly one shared library from {}, got: {}".format(
            ctx.attr.lib[0].label,
            [f.short_path for f in libs],
        ))
    # Scope under the rule name: gnu and musl addons share canonical filenames
    # (the loader never sees both), so bare package-level outputs would collide.
    out = ctx.actions.declare_file(ctx.label.name + "/" + ctx.attr.out)
    ctx.actions.symlink(output = out, target_file = libs[0])
    return [DefaultInfo(files = depset([out]))]

native_addon = rule(
    implementation = _native_addon_impl,
    doc = "Release build of the pi_natives cdylib for one shipping platform, " +
          "renamed to the loader's canonical .node filename.",
    attrs = {
        "lib": attr.label(
            cfg = _addon_transition,
            mandatory = True,
            doc = "The rust_shared_library target (//crates/pi-natives:pi_natives).",
        ),
        "platform": attr.label(
            mandatory = True,
            doc = "//bazel/platforms platform to build for.",
        ),
        "out": attr.string(
            mandatory = True,
            doc = "Canonical addon filename, e.g. pi_natives.linux-x64-baseline.node.",
        ),
        "_allowlist_function_transition": attr.label(
            default = "@bazel_tools//tools/allowlists/function_transition_allowlist",
        ),
    },
)
