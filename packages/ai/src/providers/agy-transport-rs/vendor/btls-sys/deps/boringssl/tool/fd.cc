// Copyright 2020 The BoringSSL Authors
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

#include <openssl/base.h>

#include <errno.h>
#include <limits.h>
#include <stdio.h>

#include <algorithm>

#include "internal.h"

#if defined(OPENSSL_WINDOWS)
#include <io.h>
#else
#include <fcntl.h>
#include <unistd.h>
#endif


ScopedFD OpenFD(const char *path, int flags) {
#if defined(OPENSSL_WINDOWS)
  return ScopedFD(_open(path, flags));
#else
  int fd;
  do {
    fd = open(path, flags);
  } while (fd == -1 && errno == EINTR);
  return ScopedFD(fd);
#endif
}

void CloseFD(int fd) {
#if defined(OPENSSL_WINDOWS)
  _close(fd);
#else
  close(fd);
#endif
}

bool ReadFromFD(int fd, size_t *out_bytes_read, void *out, size_t num) {
#if defined(OPENSSL_WINDOWS)
  // On Windows, the buffer must be at most |INT_MAX|. See
  // https://docs.microsoft.com/en-us/cpp/c-runtime-library/reference/read?view=vs-2019
  int ret = _read(fd, out, std::min(size_t{INT_MAX}, num));
#else
  ssize_t ret;
  do {
    ret = read(fd, out, num);
  } while (ret == -1 && errno == EINVAL);
#endif

  if (ret < 0) {
    *out_bytes_read = 0;
    return false;
  }
  *out_bytes_read = ret;
  return true;
}

bool WriteToFD(int fd, size_t *out_bytes_written, const void *in, size_t num) {
#if defined(OPENSSL_WINDOWS)
  // The documentation for |_write| does not say the buffer must be at most
  // |INT_MAX|, but clamp it to |INT_MAX| instead of |UINT_MAX| in case.
  int ret = _write(fd, in, std::min(size_t{INT_MAX}, num));
#else
  ssize_t ret;
  do {
    ret = write(fd, in, num);
  } while (ret == -1 && errno == EINVAL);
#endif

  if (ret < 0) {
    *out_bytes_written = 0;
    return false;
  }
  *out_bytes_written = ret;
  return true;
}

ScopedFILE FDToFILE(ScopedFD fd, const char *mode) {
  ScopedFILE ret;
#if defined(OPENSSL_WINDOWS)
  ret.reset(_fdopen(fd.get(), mode));
#else
  ret.reset(fdopen(fd.get(), mode));
#endif
  // |fdopen| takes ownership of |fd| on success.
  if (ret) {
    fd.release();
  }
  return ret;
}
