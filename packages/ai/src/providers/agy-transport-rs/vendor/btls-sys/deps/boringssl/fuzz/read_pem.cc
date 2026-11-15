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

#include <openssl/bio.h>
#include <openssl/err.h>
#include <openssl/mem.h>
#include <openssl/pem.h>


extern "C" int LLVMFuzzerTestOneInput(const uint8_t *buf, size_t len) {
  char *name, *header;
  uint8_t *pem_data;
  long pem_len;

  BIO *bio = BIO_new_mem_buf(buf, len);

  if (PEM_read_bio(bio, &name, &header, &pem_data, &pem_len) == 1) {
    OPENSSL_free(name);
    OPENSSL_free(header);
    OPENSSL_free(pem_data);
  }

  BIO_free(bio);

  ERR_clear_error();
  return 0;
}
