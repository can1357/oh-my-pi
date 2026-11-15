// Copyright 2024 The BoringSSL Authors
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

#include <openssl/rsa.h>

int RSA_blinding_on(RSA *rsa, BN_CTX *ctx) { return 1; }

void RSA_blinding_off(RSA *rsa) {}

const RSA_PSS_PARAMS *RSA_get0_pss_params(const RSA *rsa) {
  // We do not currently implement this function. By default, we will not parse
  // |EVP_PKEY_RSA_PSS|. Callers that opt in with a BoringSSL-specific API are
  // currently assumed to not need this function. Callers that need that opt-in
  // and this functionality should contact the BoringSSL team.
  //
  // If we do add support later, the |maskHash| field should be filled in for
  // OpenSSL compatibility.
  return nullptr;
}
