// Copyright 2025 The BoringSSL Authors
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

// make-chain generates a test certificate chain.
package main

import (
	"crypto/ecdsa"
	"crypto/rand"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/asn1"
	"encoding/pem"
	"math/big"
	"os"
	"time"
)

var leafKey, intermediateKey, rootKey *ecdsa.PrivateKey

func init() {
	leafKey = mustParseECDSAKey(leafKeyPEM)
	intermediateKey = mustParseECDSAKey(intermediateKeyPEM)
	rootKey = mustParseECDSAKey(rootKeyPEM)
}

type templateAndKey struct {
	template x509.Certificate
	key      *ecdsa.PrivateKey
}

func mustStartChain(path string, subject, issuer *templateAndKey) []byte {
	cert, err := x509.CreateCertificate(rand.Reader, &subject.template, &issuer.template, &subject.key.PublicKey, issuer.key)
	if err != nil {
		panic(err)
	}
	file, err := os.OpenFile(path, os.O_TRUNC|os.O_CREATE|os.O_WRONLY, 0644)
	if err != nil {
		panic(err)
	}
	defer file.Close()
	err = pem.Encode(file, &pem.Block{Type: "CERTIFICATE", Bytes: cert})
	if err != nil {
		panic(err)
	}
	file.Close()
	return cert
}

func mustAppendToChain(path string, subject, issuer *templateAndKey) []byte {
	cert, err := x509.CreateCertificate(rand.Reader, &subject.template, &issuer.template, &subject.key.PublicKey, issuer.key)
	if err != nil {
		panic(err)
	}
	file, err := os.OpenFile(path, os.O_APPEND|os.O_WRONLY, 0644)
	if err != nil {
		panic(err)
	}
	defer file.Close()
	err = pem.Encode(file, &pem.Block{Type: "CERTIFICATE", Bytes: cert})
	if err != nil {
		panic(err)
	}
	file.Close()
	return cert
}

func main() {
	notBefore, err := time.Parse(time.RFC3339, "0000-01-01T00:00:00Z")
	if err != nil {
		panic(err)
	}
	notAfter, err := time.Parse(time.RFC3339, "9999-12-31T23:59:59Z")
	if err != nil {
		panic(err)
	}

	root := templateAndKey{
		template: x509.Certificate{
			SerialNumber:          new(big.Int).SetInt64(1),
			Subject:               pkix.Name{CommonName: "C2PA Cert Root"},
			NotBefore:             notBefore,
			NotAfter:              notAfter,
			BasicConstraintsValid: true,
			IsCA:                  true,
			KeyUsage:              x509.KeyUsageCertSign,
			SignatureAlgorithm:    x509.ECDSAWithSHA256,
			SubjectKeyId:          []byte("root"),
		},
		key: rootKey,
	}
	intermediate := templateAndKey{
		template: x509.Certificate{
			SerialNumber:          new(big.Int).SetInt64(2),
			Subject:               pkix.Name{CommonName: "C2PA Cert Intermediate"},
			NotBefore:             notBefore,
			NotAfter:              notAfter,
			BasicConstraintsValid: true,
			IsCA:                  true,
			KeyUsage:              x509.KeyUsageCertSign,
			SignatureAlgorithm:    x509.ECDSAWithSHA256,
			SubjectKeyId:          []byte("intermediate"),
			UnknownExtKeyUsage:    []asn1.ObjectIdentifier{[]int{2, 23, 146, 2, 1, 3}},
		},
		key: intermediateKey,
	}

	leaf := templateAndKey{
		template: x509.Certificate{
			SerialNumber:          new(big.Int).SetInt64(3),
			Subject:               pkix.Name{CommonName: "C2PA Cert Leaf"},
			NotBefore:             notBefore,
			NotAfter:              notAfter,
			BasicConstraintsValid: true,
			IsCA:                  false,
			KeyUsage:              x509.KeyUsageDigitalSignature,
			ExtKeyUsage:           []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth, x509.ExtKeyUsageEmailProtection},
			SignatureAlgorithm:    x509.ECDSAWithSHA256,
			SubjectKeyId:          []byte("leaf"),
		},
		key: leafKey,
	}

	// Generate a valid certificate chain from the templates.
	mustStartChain("chain.pem", &leaf, &intermediate)
	mustAppendToChain("chain.pem", &intermediate, &root)
	mustAppendToChain("chain.pem", &root, &root)
}

const leafKeyPEM = `-----BEGIN PRIVATE KEY-----
MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQgoPUXNXuH9mgiS/nk
024SYxryxMa3CyGJldiHymLxSquhRANCAASRKti8VW2Rkma+Kt9jQkMNitlCs0l5
w8u3SSwm7HZREvmcBCJBjVIREacRqI0umhzR2V5NLzBBP9yPD/A+Ch5X
-----END PRIVATE KEY-----`

const intermediateKeyPEM = `-----BEGIN PRIVATE KEY-----
MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQgWHKCKgY058ahE3t6
vpxVQgzlycgCVMogwjK0y3XMNfWhRANCAATiOnyojN4xS5C8gJ/PHL5cOEsMbsoE
Y6KT9xRQSh8lEL4d1Vb36kqUgkpqedEImo0Og4Owk6VWVVR/m4Lk+yUw
-----END PRIVATE KEY-----`

const rootKeyPEM = `-----BEGIN PRIVATE KEY-----
MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQgBwND/eHytW0I417J
Hr+qcPlp5N1jM3ACXys57bPujg+hRANCAAQmdqXYl1GvY7y3jcTTK6MVXIQr44Tq
ChRYI6IeV9tIB6jIsOY+Qol1bk8x/7A5FGOnUWFVLEAPEPSJwPndjolt
-----END PRIVATE KEY-----`

func mustParseECDSAKey(in string) *ecdsa.PrivateKey {
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
