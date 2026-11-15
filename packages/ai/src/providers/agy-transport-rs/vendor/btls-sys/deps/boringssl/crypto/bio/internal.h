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

#ifndef OPENSSL_HEADER_CRYPTO_BIO_INTERNAL_H
#define OPENSSL_HEADER_CRYPTO_BIO_INTERNAL_H

#include <openssl/bio.h>

#include <openssl/ex_data.h>

#include "../internal.h"

#if !defined(OPENSSL_NO_SOCK)
#if !defined(OPENSSL_WINDOWS)
#if defined(OPENSSL_PNACL)
// newlib uses u_short in socket.h without defining it.
typedef unsigned short u_short;
#endif
#include <sys/types.h>
#include <sys/socket.h>
#else
#include <winsock2.h>
typedef int socklen_t;
#endif
#endif  // !OPENSSL_NO_SOCK

#if defined(__cplusplus)
extern "C" {
#endif


struct bio_method_st {
  int type;
  const char *name;
  int (*bwrite)(BIO *, const char *, int);
  int (*bread)(BIO *, char *, int);
  int (*bgets)(BIO *, char *, int);
  long (*ctrl)(BIO *, int, long, void *);
  int (*create)(BIO *);
  int (*destroy)(BIO *);
  long (*callback_ctrl)(BIO *, int, BIO_info_cb *);
};

struct bio_st {
  const BIO_METHOD *method;
  CRYPTO_EX_DATA ex_data;

  // TODO(crbug.com/412269080): |init| and |shutdown| could be bitfields, or
  // integrated into |flags|, to save memory.

  // init is non-zero if this |BIO| has been initialised.
  int init;
  // shutdown is often used by specific |BIO_METHOD|s to determine whether
  // they own some underlying resource. This flag can often be controlled by
  // |BIO_set_close|. For example, whether an fd BIO closes the underlying fd
  // when it, itself, is closed.
  int shutdown;
  int flags;
  int retry_reason;
  // num is a BIO-specific value. For example, in fd BIOs it's used to store a
  // file descriptor.
  int num;
  CRYPTO_refcount_t references;
  void *ptr;
  // next_bio points to the next |BIO| in a chain. This |BIO| owns a reference
  // to |next_bio|.
  BIO *next_bio;  // used by filter BIOs
  uint64_t num_read, num_write;
};

#if !defined(OPENSSL_NO_SOCK)

// bio_ip_and_port_to_socket_and_addr creates a socket and fills in |*out_addr|
// and |*out_addr_length| with the correct values for connecting to |hostname|
// on |port_str|. It returns one on success or zero on error.
int bio_ip_and_port_to_socket_and_addr(int *out_sock,
                                       struct sockaddr_storage *out_addr,
                                       socklen_t *out_addr_length,
                                       const char *hostname,
                                       const char *port_str);

// bio_socket_nbio sets whether |sock| is non-blocking. It returns one on
// success and zero otherwise.
int bio_socket_nbio(int sock, int on);

// bio_clear_socket_error clears the last system socket error.
//
// TODO(fork): remove all callers of this.
void bio_clear_socket_error(void);

// bio_sock_error returns the last socket error on |sock|.
int bio_sock_error(int sock);

// bio_socket_should_retry returns non-zero if |return_value| indicates an error
// and the last socket error indicates that it's non-fatal.
int bio_socket_should_retry(int return_value);

#endif  // !OPENSSL_NO_SOCK

// bio_errno_should_retry returns non-zero if |return_value| indicates an error
// and |errno| indicates that it's non-fatal.
int bio_errno_should_retry(int return_value);


#if defined(__cplusplus)
}  // extern C
#endif

#endif  // OPENSSL_HEADER_CRYPTO_BIO_INTERNAL_H
