// Copyright 2023 The BoringSSL Authors
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     https://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

#include "file_util.h"

#include <stdlib.h>

#if defined(OPENSSL_WINDOWS)
#include <windows.h>
#else
#include <fcntl.h>
#include <sys/stat.h>
#include <unistd.h>
#endif

#include <openssl/rand.h>

#include "test_util.h"


BSSL_NAMESPACE_BEGIN

#if defined(OPENSSL_WINDOWS)
static void PrintLastError(const char *s) {
  DWORD error = GetLastError();
  char *buffer;
  DWORD len = FormatMessageA(
      FORMAT_MESSAGE_FROM_SYSTEM | FORMAT_MESSAGE_ALLOCATE_BUFFER, 0, error, 0,
      reinterpret_cast<char *>(&buffer), 0, nullptr);
  std::string msg = "unknown error";
  if (len > 0) {
    msg.assign(buffer, len);
    while (!msg.empty() && (msg.back() == '\r' || msg.back() == '\n')) {
      msg.resize(msg.size() - 1);
    }
  }
  LocalFree(buffer);
  fprintf(stderr, "%s: %s (0x%lx)\n", s, msg.c_str(), error);
}
#endif  // OPENSSL_WINDOWS

// GetTempDir returns the path to the temporary directory, or the empty string
// on error. On success, the result will include the directory separator.
static std::string GetTempDir() {
#if defined(OPENSSL_WINDOWS)
  char buf[MAX_PATH + 1];
  DWORD len = GetTempPathA(sizeof(buf), buf);
  return std::string(buf, len);
#else
  const char *tmpdir = getenv("TMPDIR");
  if (tmpdir != nullptr && *tmpdir != '\0') {
    std::string ret = tmpdir;
    if (ret.back() != '/') {
      ret.push_back('/');
    }
    return ret;
  }
#if defined(OPENSSL_ANDROID)
  return "/data/local/tmp/";
#else
  return "/tmp/";
#endif
#endif
}

bool SkipTempFileTests() {
#if defined(OPENSSL_ANDROID)
  // When running in an APK context, /data/local/tmp is unreadable. Android
  // versions before https://android-review.googlesource.com/c/1821337 do not
  // set TMPDIR to a suitable replacement.
  if (getenv("TMPDIR") == nullptr) {
    static bool should_skip = [] {
      TemporaryFile file;
      return !file.Init();
    }();
    if (should_skip) {
      fprintf(stderr, "Skipping tests with temporary files.\n");
      return true;
    }
  }
#endif
  return false;
}

TemporaryFile::~TemporaryFile() {
#if defined(OPENSSL_WINDOWS)
  if (!path_.empty() && !DeleteFileA(path_.c_str())) {
    PrintLastError("Could not delete file");
  }
#else
  if (!path_.empty() && unlink(path_.c_str()) != 0) {
    perror("Could not delete file");
  }
#endif
}

bool TemporaryFile::Init(bssl::Span<const uint8_t> content) {
  std::string temp_dir = GetTempDir();
  if (temp_dir.empty()) {
    return false;
  }

#if defined(OPENSSL_WINDOWS)
  char path[MAX_PATH];
  if (GetTempFileNameA(temp_dir.c_str(), "bssl",
                       /*uUnique=*/0, path) == 0) {
    PrintLastError("Could not create temporary");
    return false;
  }
  path_ = path;
#else
  std::string path = temp_dir + "bssl_tmp_file.XXXXXX";
  int fd = mkstemp(path.data());
  if (fd < 0) {
    perror("Could not create temporary file");
    return false;
  }
  close(fd);
  path_ = std::move(path);
#endif

  ScopedFILE file = Open("wb");
  if (file == nullptr) {
    perror("Could not open temporary file");
    return false;
  }
  if (!content.empty() &&
      fwrite(content.data(), content.size(), /*nitems=*/1, file.get()) != 1) {
    perror("Could not write temporary file");
    return false;
  }
  return true;
}

ScopedFILE TemporaryFile::Open(const char *mode) const {
  if (path_.empty()) {
    return nullptr;
  }
  return ScopedFILE(fopen(path_.c_str(), mode));
}

ScopedFD TemporaryFile::OpenFD(int flags) const {
  if (path_.empty()) {
    return ScopedFD();
  }
#if defined(OPENSSL_WINDOWS)
  return ScopedFD(_open(path_.c_str(), flags));
#else
  return ScopedFD(open(path_.c_str(), flags));
#endif
}

TemporaryDirectory::~TemporaryDirectory() {
  if (path_.empty()) {
    return;
  }

#if defined(OPENSSL_WINDOWS)
  for (const auto &file : files_) {
    if (!DeleteFileA(GetFilePath(file).c_str())) {
      PrintLastError("Could not delete file");
    }
  }
  if (!RemoveDirectoryA(path_.c_str())) {
    PrintLastError("Could not delete directory");
  }
#else
  for (const auto &file : files_) {
    if (unlink(GetFilePath(file).c_str()) != 0) {
      perror("Could not delete file");
    }
  }
  if (rmdir(path_.c_str()) != 0) {
    perror("Could not delete directory");
  }
#endif
}

bool TemporaryDirectory::Init() {
  std::string path = GetTempDir();
  if (path.empty()) {
    return false;
  }

#if defined(OPENSSL_WINDOWS)
  // For simplicity, just try the first candidate and assume the directory
  // doesn't exist. 128 bits of cryptographically secure randomness is plenty.
  uint8_t buf[16];
  RAND_bytes(buf, sizeof(buf));
  path += "bssl_tmp_dir." + EncodeHex(buf);
  if (!CreateDirectoryA(path.c_str(), /*lpSecurityAttributes=*/nullptr)) {
    perror("Could not make temporary directory");
    return false;
  }
#else
  path += "bssl_tmp_dir.XXXXXX";
  if (mkdtemp(path.data()) == nullptr) {
    perror("Could not make temporary directory");
    return false;
  }
#endif

  path_ = std::move(path);
  return true;
}

bool TemporaryDirectory::AddFile(const std::string &filename,
                                 bssl::Span<const uint8_t> content) {
  if (path_.empty()) {
    return false;
  }

  ScopedFILE file(fopen(GetFilePath(filename).c_str(), "wb"));
  if (file == nullptr) {
    perror("Could not open temporary file");
    return false;
  }
  if (!content.empty() &&
      fwrite(content.data(), content.size(), /*nitems=*/1, file.get()) != 1) {
    perror("Could not write temporary file");
    return false;
  }

  files_.insert(filename);
  return true;
}

BSSL_NAMESPACE_END
