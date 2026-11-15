// Copyright 1995-2016 The OpenSSL Project Authors. All Rights Reserved.
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

#include <openssl/ssl.h>

#if !defined(OPENSSL_WINDOWS) && !defined(OPENSSL_PNACL) && \
    !defined(OPENSSL_NO_FILESYSTEM)

#include <dirent.h>
#include <errno.h>
#include <string.h>

#include <openssl/err.h>
#include <openssl/mem.h>


int SSL_add_dir_cert_subjects_to_stack(STACK_OF(X509_NAME) *stack,
                                       const char *path) {
  DIR *dir = opendir(path);
  if (dir == nullptr) {
    OPENSSL_PUT_ERROR(SSL, ERR_R_SYS_LIB);
    ERR_add_error_data(3, "opendir('", dir, "')");
    return 0;
  }

  int ret = 0;
  for (;;) {
    // |readdir| may fail with or without setting |errno|.
    errno = 0;
    struct dirent *dirent = readdir(dir);
    if (dirent == nullptr) {
      if (errno) {
        OPENSSL_PUT_ERROR(SSL, ERR_R_SYS_LIB);
        ERR_add_error_data(3, "readdir('", path, "')");
      } else {
        ret = 1;
      }
      break;
    }

    char buf[1024];
    if (strlen(path) + strlen(dirent->d_name) + 2 > sizeof(buf)) {
      OPENSSL_PUT_ERROR(SSL, SSL_R_PATH_TOO_LONG);
      break;
    }

    int r = snprintf(buf, sizeof(buf), "%s/%s", path, dirent->d_name);
    if (r <= 0 ||
        r >= (int)sizeof(buf) ||
        !SSL_add_file_cert_subjects_to_stack(stack, buf)) {
      break;
    }
  }

  closedir(dir);
  return ret;
}

#endif  // !WINDOWS && !PNACL && !OPENSSL_NO_FILESYSTEM
