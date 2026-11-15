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

//go:build ignore

// make_basic_constraints.go generates self-signed certificates with the basic
// constraints extension.
package main

import (
	"crypto/ecdsa"
	"crypto/rand"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/pem"
	"fmt"
	"math/big"
	"os"
	"time"
)

func main() {
	key := ecdsaKeyFromPEMOrPanic(keyPEM)

	notBefore, err := time.Parse(time.RFC3339, "2000-01-01T00:00:00Z")
	if err != nil {
		panic(err)
	}
	notAfter, err := time.Parse(time.RFC3339, "2100-01-01T00:00:00Z")
	if err != nil {
		panic(err)
	}

	baseTemplate := x509.Certificate{
		SerialNumber:       new(big.Int).SetInt64(1),
		Subject:            pkix.Name{CommonName: "Basic Constraints"},
		NotBefore:          notBefore,
		NotAfter:           notAfter,
		SignatureAlgorithm: x509.ECDSAWithSHA256,
	}

	certs := []struct {
		name                  string
		basicConstraintsValid bool
		isCA                  bool
		maxPathLen            int
		maxPathLenZero        bool
	}{
		{name: "none"},
		{name: "leaf", basicConstraintsValid: true},
		{name: "ca", basicConstraintsValid: true, isCA: true},
		{name: "ca_pathlen_0", basicConstraintsValid: true, isCA: true, maxPathLenZero: true},
		{name: "ca_pathlen_1", basicConstraintsValid: true, isCA: true, maxPathLen: 1},
		{name: "ca_pathlen_10", basicConstraintsValid: true, isCA: true, maxPathLen: 10},
	}
	for _, cert := range certs {
		template := baseTemplate
		template.BasicConstraintsValid = cert.basicConstraintsValid
		template.IsCA = cert.isCA
		template.MaxPathLen = cert.maxPathLen
		template.MaxPathLenZero = cert.maxPathLenZero

		certBytes, err := x509.CreateCertificate(rand.Reader, &template, &template, &key.PublicKey, key)
		if err != nil {
			panic(err)
		}

		certPEM := pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: certBytes})
		if err := os.WriteFile(fmt.Sprintf("basic_constraints_%s.pem", cert.name), certPEM, 0666); err != nil {
			panic(err)
		}
	}
}

const keyPEM = `-----BEGIN PRIVATE KEY-----
MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQgoPUXNXuH9mgiS/nk
024SYxryxMa3CyGJldiHymLxSquhRANCAASRKti8VW2Rkma+Kt9jQkMNitlCs0l5
w8u3SSwm7HZREvmcBCJBjVIREacRqI0umhzR2V5NLzBBP9yPD/A+Ch5X
-----END PRIVATE KEY-----`

func ecdsaKeyFromPEMOrPanic(in string) *ecdsa.PrivateKey {
	keyBlock, _ := pem.Decode([]byte(in))
	if keyBlock == nil || keyBlock.Type != "PRIVATE KEY" {
		panic("could not decode private key")
	}
	key, err := x509.ParsePKCS8PrivateKey(keyBlock.Bytes)
	if err != nil {
		panic(err)
	}
	return key.(*ecdsa.PrivateKey)
}
