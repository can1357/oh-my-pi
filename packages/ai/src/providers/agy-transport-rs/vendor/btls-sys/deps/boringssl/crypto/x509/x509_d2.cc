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

#include <openssl/err.h>
#include <openssl/x509.h>


int X509_STORE_set_default_paths(X509_STORE *ctx) {
  X509_LOOKUP *lookup;

  lookup = X509_STORE_add_lookup(ctx, X509_LOOKUP_file());
  if (lookup == nullptr) {
    return 0;
  }
  X509_LOOKUP_load_file(lookup, nullptr, X509_FILETYPE_DEFAULT);

  lookup = X509_STORE_add_lookup(ctx, X509_LOOKUP_hash_dir());
  if (lookup == nullptr) {
    return 0;
  }
  X509_LOOKUP_add_dir(lookup, nullptr, X509_FILETYPE_DEFAULT);

  // clear any errors
  ERR_clear_error();

  return 1;
}

int X509_STORE_load_locations(X509_STORE *ctx, const char *file,
                              const char *path) {
  X509_LOOKUP *lookup;

  if (file != nullptr) {
    lookup = X509_STORE_add_lookup(ctx, X509_LOOKUP_file());
    if (lookup == nullptr) {
      return 0;
    }
    if (X509_LOOKUP_load_file(lookup, file, X509_FILETYPE_PEM) != 1) {
      return 0;
    }
  }
  if (path != nullptr) {
    lookup = X509_STORE_add_lookup(ctx, X509_LOOKUP_hash_dir());
    if (lookup == nullptr) {
      return 0;
    }
    if (X509_LOOKUP_add_dir(lookup, path, X509_FILETYPE_PEM) != 1) {
      return 0;
    }
  }
  if ((path == nullptr) && (file == nullptr)) {
    return 0;
  }
  return 1;
}
