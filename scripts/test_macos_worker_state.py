"""Guarded setup tests; no live tool installation or native Mac claim."""

import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import macos_worker_state as state


def python_inputs():
    for name in state.PYTHON_INPUTS:
        path = Path(name)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text("" if name.endswith("requirements.txt") else "fixture")


def python_outputs():
    for name in ("python", "python-release"):
        root = Path("vendor", name).resolve()
        root.mkdir(parents=True, exist_ok=True)
        (root / "libpython3.14t.a").write_bytes(b"fixture")
        executable = root / "python3.14t"
        executable.write_text("fixture")
        executable.chmod(0o755)
        (root / "stdlib.bin").write_bytes(b"fixture")
        (root / ".archive.stamp").write_text("fixture")
        (root / "pyo3-config.txt").write_text(f"lib_name=python3.14t\nlib_dir={root}\nexecutable={executable}\n")


class StateTests(unittest.TestCase):
    def test_refuses_non_native_and_unguarded_invocation(self):
        with patch.object(state.platform, "system", return_value="Linux"):
            with self.assertRaises(state.VerificationError):
                state.prepare({"MACOS_WORKER": "true"})
        with patch.object(state.platform, "system", return_value="Darwin"), patch.object(state.platform, "machine", return_value="arm64"):
            with self.assertRaises(state.VerificationError):
                state.prepare({})

    def test_hosted_preparation_scrubs_tokens_and_checks_linker(self):
        with tempfile.TemporaryDirectory() as temporary:
            previous = Path.cwd()
            try:
                os.chdir(temporary)
                python_inputs()
                calls = []
                def run(command, **kwargs):
                    calls.append(command)
                    self.assertNotIn("GH_TOKEN", kwargs["env"])
                    self.assertNotIn("GITHUB_TOKEN", kwargs["env"])
                    if command[:2] == ["bash", "crates/py/scripts/fetch-python.sh"]:
                        python_outputs()
                    class Result:
                        stdout = "LLD 22.1.2\n"
                    return Result()
                with patch.object(state.platform, "system", return_value="Darwin"), patch.object(state.platform, "machine", return_value="arm64"):
                    env = state.prepare({"MACOS_WORKER": "true", "RUNNER_ENVIRONMENT": "github-hosted",
                                         "GH_TOKEN": "fixture", "GITHUB_TOKEN": "fixture"}, run)
                self.assertEqual(calls[-1], ["bash", "crates/py/scripts/ld64.lld", "--version"])
                self.assertNotIn("GH_TOKEN", env)
            finally:
                os.chdir(previous)

    def _prepare_with_linker(self, shim_version):
        with tempfile.TemporaryDirectory() as temporary:
            previous = Path.cwd()
            try:
                os.chdir(temporary)
                python_inputs()
                calls = []
                def run(command, **kwargs):
                    calls.append(command)
                    if command[:2] == ["bash", "crates/py/scripts/fetch-python.sh"]:
                        python_outputs()
                    class Result:
                        # The unversioned Homebrew link drifted to a newer major.
                        stdout = ("Homebrew LLD 23.1.3\n" if command[0] == "/opt/homebrew/bin/ld64.lld"
                                  else shim_version)
                    return Result()
                with patch.object(state.platform, "system", return_value="Darwin"), patch.object(state.platform, "machine", return_value="arm64"):
                    state.prepare({"MACOS_WORKER": "true", "RUNNER_ENVIRONMENT": "github-hosted"}, run)
                return calls
            finally:
                os.chdir(previous)

    def test_linker_check_uses_the_build_shim_not_the_unversioned_link(self):
        calls = self._prepare_with_linker("Homebrew LLD 22.1.8\n")
        self.assertNotIn(["/opt/homebrew/bin/ld64.lld", "--version"], calls)
        self.assertIn(["bash", "crates/py/scripts/ld64.lld", "--version"], calls)

    def test_linker_check_refuses_a_shim_that_is_not_llvm22(self):
        with self.assertRaisesRegex(state.VerificationError, "LLVM22"):
            self._prepare_with_linker("Homebrew LLD 23.1.3\n")


    def test_hosted_cache_reuses_complete_matching_state_and_rebuilds_invalid_restores(self):
        with tempfile.TemporaryDirectory() as temporary:
            previous = Path.cwd()
            try:
                os.chdir(temporary)
                python_inputs()
                calls = []
                def fetch(command, **kwargs):
                    calls.append(command)
                    python_outputs()
                state.prepare_hosted_python({}, fetch)
                state.prepare_hosted_python({}, fetch)
                self.assertEqual(len(calls), 1)
                Path("crates/py/requirements.txt").write_text("# changed inputs\n")
                state.prepare_hosted_python({}, fetch)
                self.assertEqual(len(calls), 2)
                Path("vendor/python-release/stdlib.bin").unlink()
                state.prepare_hosted_python({}, fetch)
                self.assertEqual(len(calls), 3)
                config = Path("vendor/python/pyo3-config.txt")
                config.write_text(config.read_text().replace(str(Path.cwd()), "/different-workspace"))
                state.prepare_hosted_python({}, fetch)
                self.assertEqual(len(calls), 4)
                loop = Path("vendor/python/loop")
                loop.symlink_to("loop")
                config.write_text(config.read_text().replace("executable=", "ignored=") + f"executable={loop.absolute()}\n")
                state.prepare_hosted_python({}, fetch)
                self.assertEqual(len(calls), 5)
                state.PYTHON_MARKER.write_text("not JSON")
                state.prepare_hosted_python({}, fetch)
                self.assertEqual(len(calls), 6)
            finally:
                os.chdir(previous)

    def test_hosted_incomplete_preparation_cannot_publish_ready_marker(self):
        with tempfile.TemporaryDirectory() as temporary:
            previous = Path.cwd()
            try:
                os.chdir(temporary)
                python_inputs()
                with self.assertRaises(state.VerificationError):
                    state.prepare_hosted_python({}, lambda *args, **kwargs: None)
                self.assertFalse(state.PYTHON_MARKER.exists())
                Path("vendor").symlink_to(Path(temporary).parent, target_is_directory=True)
                with self.assertRaises(state.VerificationError):
                    state.prepare_hosted_python({}, lambda *args, **kwargs: None)
            finally:
                os.chdir(previous)

    def test_directory_does_not_follow_existing_symlink(self):
        with tempfile.TemporaryDirectory() as temporary:
            parent = Path(temporary).resolve()
            (parent / "target").mkdir()
            (parent / "link").symlink_to(parent / "target")
            with self.assertRaises(state.VerificationError):
                state.directory(parent / "link")

    def test_self_hosted_state_is_private_warm_and_does_not_delete_other_caches(self):
        with tempfile.TemporaryDirectory() as temporary:
            home = Path(temporary).resolve()
            source = home / "source"
            source.mkdir()
            previous = Path.cwd()
            try:
                os.chdir(source)
                for name in ("crates/py/scripts/fetch-python.sh", "crates/py/scripts/pack-pymodules.py",
                             "crates/py/scripts/gen-py-notices.py", "crates/py/requirements.txt",
                             "rust-toolchain.toml", "Cargo.lock"):
                    path = Path(name)
                    path.parent.mkdir(parents=True, exist_ok=True)
                    path.write_text("fixture")
                other = home / "unrelated-cache"
                other.write_text("preserve")
                calls = []
                def run(command, **kwargs):
                    calls.append(command)
                    if command[:2] == ["bash", "crates/py/scripts/fetch-python.sh"]:
                        config = Path(command[2]) / "python/pyo3-config.txt"
                        config.parent.mkdir(parents=True)
                        config.write_text("fixture")
                    class Result:
                        stdout = "LLD 22.1.2"
                    return Result()
                env = {"MACOS_WORKER": "true", "RUNNER_ENVIRONMENT": "self-hosted", "RUNNER_NAME": "test-mac"}
                with patch.object(state.platform, "system", return_value="Darwin"), patch.object(state.platform, "machine", return_value="arm64"), patch.object(state.Path, "home", return_value=home), patch.object(state.shutil, "disk_usage") as disk:
                    disk.return_value.free = 100 * 1024**3
                    first = state.prepare(env, run)
                    second = state.prepare(env, run)
                fetches = [c for c in calls if c[:2] == ["bash", "crates/py/scripts/fetch-python.sh"]]
                self.assertEqual(len(fetches), 1)
                self.assertEqual(first["CARGO_TARGET_DIR"], second["CARGO_TARGET_DIR"])
                self.assertIn("omp-macos-worker", first["CARGO_TARGET_DIR"])
                self.assertEqual(other.read_text(), "preserve")
                self.assertTrue(Path("vendor/python").is_symlink())
            finally:
                os.chdir(previous)

    def test_directory_refuses_shared_permissions(self):
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary).resolve() / "shared"
            path.mkdir(mode=0o755)
            path.chmod(0o755)
            with self.assertRaises(state.VerificationError):
                state.directory(path)

    def test_cache_key_changes_with_content_and_input_identity(self):
        with tempfile.TemporaryDirectory() as temporary:
            a, b = Path(temporary) / "a", Path(temporary) / "b"
            a.write_bytes(b"one")
            b.write_bytes(b"one")
            first = state.key([str(a)])
            self.assertNotEqual(first, state.key([str(b)]))
            a.write_bytes(b"two")
            self.assertNotEqual(first, state.key([str(a)]))


if __name__ == "__main__":
    unittest.main()
