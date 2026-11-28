"""Hermetic repository rule fetching pinned rusty_v8 v152.2.0 prebuilt archives.

`v8`'s build script checks `RUSTY_V8_ARCHIVE` (when pointing at a directory)
for `librusty_v8_release_<target>.a.gz` / `rusty_v8_release_<target>.lib.gz`
and `src_binding_release_<target>.rs` without hitting the network.
"""

_RELEASE_TAG = "v152.2.0"

_PREBUILTS = {
    "librusty_v8_release_x86_64-unknown-linux-gnu.a.gz": "b6683e9afcb77fbd8cb2c3acf45d34d52029ab216b332522c95179c12f0fed3c",
    "librusty_v8_release_aarch64-unknown-linux-gnu.a.gz": "c40196bbf182532e583f65b7daf0196fdbb3354e6fac59b31d0539c20f931f3d",
    "librusty_v8_release_x86_64-apple-darwin.a.gz": "04cbc1c36c4cd5459c54049775d92889337c69d936fb0b011f9b26f1d454610d",
    "librusty_v8_release_aarch64-apple-darwin.a.gz": "a4a5484444ad4b5f10dc7bed141236dd9dbeabf2006d14520f19b935d4db4227",
    "rusty_v8_release_x86_64-pc-windows-msvc.lib.gz": "0b17ca072bae37dd4ff00e6014d2b413becb031c9342ee11cb8226a5881f62b2",
    "src_binding_release_x86_64-unknown-linux-gnu.rs": "3e4d5fecdbe0f98a6017e69d7ca82519a77fb032c5eb5e4cdbecdd3e2ec519d5",
    "src_binding_release_aarch64-unknown-linux-gnu.rs": "3e4d5fecdbe0f98a6017e69d7ca82519a77fb032c5eb5e4cdbecdd3e2ec519d5",
    "src_binding_release_x86_64-apple-darwin.rs": "b9d5652ebca515eb2bf4c2ee4a6551b2567117b5aa720f430d2032616dd7e3b5",
    "src_binding_release_aarch64-apple-darwin.rs": "b9d5652ebca515eb2bf4c2ee4a6551b2567117b5aa720f430d2032616dd7e3b5",
    "src_binding_release_x86_64-pc-windows-msvc.rs": "4fbdc0fbb831ff7b26962f0273d77a66fbc3bbb596fbe9e9022c0128f8c88099",
}

_BUILD = """\
package(default_visibility = ["//visibility:public"])

exports_files(glob(["*"]))

filegroup(
    name = "all",
    srcs = glob(["*.a.gz", "*.lib.gz", "*.rs"]),
)
"""

def _rusty_v8_prebuilt_impl(rctx):
    base_url = "https://github.com/denoland/rusty_v8/releases/download/" + _RELEASE_TAG + "/"
    for filename, sha256 in _PREBUILTS.items():
        rctx.download(
            url = base_url + filename,
            output = filename,
            sha256 = sha256,
        )
    rctx.file("BUILD.bazel", _BUILD)
    return rctx.repo_metadata(reproducible = True)

rusty_v8_prebuilt_repository = repository_rule(
    implementation = _rusty_v8_prebuilt_impl,
    doc = "Pinned rusty_v8 v152.2.0 prebuilt archives and bindings for hermetic v8 builds.",
)
