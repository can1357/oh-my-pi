// Copyright 2018 The BoringSSL Authors
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

#include "./wycheproof_util.h"

#include <limits.h>
#include <stdlib.h>

#include <algorithm>

#include <openssl/bn.h>
#include <openssl/digest.h>
#include <openssl/ec.h>
#include <openssl/nid.h>

#include "./file_test.h"


bool WycheproofResult::IsValid(
    const std::vector<std::string> &acceptable_flags) const {
  switch (raw_result) {
    case WycheproofRawResult::kValid:
      return true;
    case WycheproofRawResult::kInvalid:
      return false;
    case WycheproofRawResult::kAcceptable:
      for (const auto &flag : flags) {
        if (std::find(acceptable_flags.begin(), acceptable_flags.end(), flag) ==
            acceptable_flags.end()) {
          return false;
        }
      }
      return true;
  }

  abort();
}

bool GetWycheproofResult(FileTest *t, WycheproofResult *out) {
  std::string result;
  if (!t->GetAttribute(&result, "result")) {
    return false;
  }
  if (result == "valid") {
    out->raw_result = WycheproofRawResult::kValid;
  } else if (result == "invalid") {
    out->raw_result = WycheproofRawResult::kInvalid;
  } else if (result == "acceptable") {
    out->raw_result = WycheproofRawResult::kAcceptable;
  } else {
    t->PrintLine("Bad result string '%s'", result.c_str());
    return false;
  }

  out->flags.clear();
  if (t->HasAttribute("flags")) {
    std::string flags = t->GetAttributeOrDie("flags");
    size_t idx = 0;
    while (idx < flags.size()) {
      size_t comma = flags.find(',', idx);
      if (comma == std::string::npos) {
        comma = flags.size();
      }
      out->flags.push_back(flags.substr(idx, comma - idx));
      idx = comma + 1;
    }
  }
  return true;
}

const EVP_MD *GetWycheproofDigest(FileTest *t, const char *key,
                                  bool instruction) {
  std::string name;
  bool ok =
      instruction ? t->GetInstruction(&name, key) : t->GetAttribute(&name, key);
  if (!ok) {
    return nullptr;
  }
  if (name == "SHA-1") {
    return EVP_sha1();
  }
  if (name == "SHA-224") {
    return EVP_sha224();
  }
  if (name == "SHA-256") {
    return EVP_sha256();
  }
  if (name == "SHA-384") {
    return EVP_sha384();
  }
  if (name == "SHA-512") {
    return EVP_sha512();
  }
  t->PrintLine("Unknown digest '%s'", name.c_str());
  return nullptr;
}

const EC_GROUP *GetWycheproofCurve(FileTest *t, const char *key,
                                   bool instruction) {
  std::string name;
  bool ok =
      instruction ? t->GetInstruction(&name, key) : t->GetAttribute(&name, key);
  if (!ok) {
    return nullptr;
  }
  if (name == "secp224r1") {
    return EC_group_p224();
  }
  if (name == "secp256r1") {
    return EC_group_p256();
  }
  if (name == "secp384r1") {
    return EC_group_p384();
  }
  if (name == "secp521r1") {
    return EC_group_p521();
  }
  t->PrintLine("Unknown curve '%s'", name.c_str());
  return nullptr;
}

bssl::UniquePtr<BIGNUM> GetWycheproofBIGNUM(FileTest *t, const char *key,
                                            bool instruction) {
  std::string value;
  bool ok = instruction ? t->GetInstruction(&value, key)
                        : t->GetAttribute(&value, key);
  if (!ok) {
    return nullptr;
  }
  BIGNUM *bn = nullptr;
  if (value.size() > INT_MAX ||
      BN_hex2bn(&bn, value.c_str()) != static_cast<int>(value.size())) {
    BN_free(bn);
    t->PrintLine("Could not decode value '%s'", value.c_str());
    return nullptr;
  }
  bssl::UniquePtr<BIGNUM> ret(bn);
  if (!value.empty()) {
    // If the high bit is one, this is a negative number in Wycheproof.
    // Wycheproof's tests generally mimic Java APIs, including all their
    // mistakes. See
    // https://github.com/google/wycheproof/blob/0329f5b751ef102bd6b7b7181b6e049522a887f5/java/com/google/security/wycheproof/JsonUtil.java#L62.
    if ('0' > value[0] || value[0] > '7') {
      bssl::UniquePtr<BIGNUM> tmp(BN_new());
      if (!tmp ||  //
          value.size() > INT_MAX / 4 ||
          !BN_set_bit(tmp.get(), static_cast<int>(value.size() * 4)) ||
          !BN_sub(ret.get(), ret.get(), tmp.get())) {
        return nullptr;
      }
    }
  }
  return ret;
}
