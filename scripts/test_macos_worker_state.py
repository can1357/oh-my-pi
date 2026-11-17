"""Guarded setup tests; no live tool installation or native Mac claim."""

import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import macos_worker_state as state


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
                calls = []
                def run(command, **kwargs):
                    calls.append(command)
                    self.assertNotIn("GH_TOKEN", kwargs["env"])
                    self.assertNotIn("GITHUB_TOKEN", kwargs["env"])
                    if command[:2] == ["bash", "crates/py/scripts/fetch-python.sh"]:
                        config = Path("vendor/python/pyo3-config.txt")
                        config.parent.mkdir(parents=True)
                        config.write_text("fixture")
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
