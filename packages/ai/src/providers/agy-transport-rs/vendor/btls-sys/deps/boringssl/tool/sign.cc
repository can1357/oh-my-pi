// Copyright 2017 The BoringSSL Authors
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

#include <map>
#include <vector>

#include <openssl/bio.h>
#include <openssl/evp.h>
#include <openssl/pem.h>

#include "internal.h"


static const struct argument kArguments[] = {
    {"-key", kRequiredArgument, "The private key, in PEM format, to sign with"},
    {"-digest", kOptionalArgument, "The digest algorithm to use"},
    {"", kOptionalArgument, ""},
};

bool Sign(const std::vector<std::string> &args) {
  std::map<std::string, std::string> args_map;
  if (!ParseKeyValueArguments(&args_map, args, kArguments)) {
    PrintUsage(kArguments);
    return false;
  }

  // Load the private key.
  bssl::UniquePtr<BIO> bio(BIO_new(BIO_s_file()));
  if (!bio || !BIO_read_filename(bio.get(), args_map["-key"].c_str())) {
    return false;
  }
  bssl::UniquePtr<EVP_PKEY> key(
      PEM_read_bio_PrivateKey(bio.get(), nullptr, nullptr, nullptr));
  if (!key) {
    return false;
  }

  const EVP_MD *md = nullptr;
  if (args_map.count("-digest")) {
    md = EVP_get_digestbyname(args_map["-digest"].c_str());
    if (md == nullptr) {
      fprintf(stderr, "Unknown digest algorithm: %s\n",
              args_map["-digest"].c_str());
      return false;
    }
  }

  bssl::ScopedEVP_MD_CTX ctx;
  if (!EVP_DigestSignInit(ctx.get(), nullptr, md, nullptr, key.get())) {
    return false;
  }

  std::vector<uint8_t> data;
  if (!ReadAll(&data, stdin)) {
    fprintf(stderr, "Error reading input.\n");
    return false;
  }

  size_t sig_len = EVP_PKEY_size(key.get());
  auto sig = std::make_unique<uint8_t[]>(sig_len);
  if (!EVP_DigestSign(ctx.get(), sig.get(), &sig_len, data.data(),
                      data.size())) {
    return false;
  }

  if (fwrite(sig.get(), 1, sig_len, stdout) != sig_len) {
    fprintf(stderr, "Error writing signature.\n");
    return false;
  }

  return true;
}
