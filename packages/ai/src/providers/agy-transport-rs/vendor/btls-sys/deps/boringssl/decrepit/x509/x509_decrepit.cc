// Copyright 2016 The BoringSSL Authors
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

#include <openssl/x509.h>

#include <assert.h>

#include <openssl/conf.h>


X509_EXTENSION *X509V3_EXT_conf_nid(CRYPTO_MUST_BE_NULL *conf,
                                    const X509V3_CTX *ctx, int ext_nid,
                                    const char *value) {
  assert(conf == nullptr);
  return X509V3_EXT_nconf_nid(nullptr, ctx, ext_nid, value);
}
