"""Build embedded AppKit executables with the same flags as build.rs."""

def darwin_helper(name, src, frameworks = ["AppKit"], minimum_macos = "12.0"):
    flags = "-x objective-c -fobjc-arc -fblocks -fno-ident -Os -mmacosx-version-min=" + minimum_macos
    flags += " " + " ".join(["-framework " + framework for framework in frameworks])
    flags += " -Wl,-dead_strip -Wl,-adhoc_codesign"
    command = "/usr/bin/xcrun clang " + flags + " -arch {arch} $(location " + src + ") -o $@"
    native.genrule(
        name = name,
        srcs = [src],
        outs = [name + ".bin"],
        cmd = select({
            "//bazel/triples:aarch64-apple-darwin": command.format(arch = "arm64"),
            "//bazel/triples:x86_64-apple-darwin": command.format(arch = "x86_64"),
            "//conditions:default": "echo 'AppKit helper selected for a non-macOS target' >&2; exit 1",
        }),
        target_compatible_with = ["@platforms//os:macos"],
    )
