package main

import (
	"crypto"
	"crypto/aes"
	"crypto/cipher"
	"crypto/des"
	"crypto/hmac"
	_ "crypto/md5"
	"crypto/rc4"
	_ "crypto/sha1"
	_ "crypto/sha256"
	_ "crypto/sha512"
	"encoding/hex"
	"flag"
	"fmt"
	"os"
)

var bulkCipher *string = flag.String("cipher", "", "The bulk cipher to use")
var mac *string = flag.String("mac", "", "The hash function to use in the MAC")
var implicitIV *bool = flag.Bool("implicit-iv", false, "If true, generate tests for a cipher using a pre-TLS-1.0 implicit IV")

// rc4Stream produces a deterministic stream of pseudorandom bytes. This is to
// make this script idempotent.
type rc4Stream struct {
	cipher *rc4.Cipher
}

func newRc4Stream(seed string) (*rc4Stream, error) {
	cipher, err := rc4.NewCipher([]byte(seed))
	if err != nil {
		return nil, err
	}
	return &rc4Stream{cipher}, nil
}

func (rs *rc4Stream) fillBytes(p []byte) {
	for i := range p {
		p[i] = 0
	}
	rs.cipher.XORKeyStream(p, p)
}

func getHash(name string) (crypto.Hash, bool) {
	switch name {
	case "md5":
		return crypto.MD5, true
	case "sha1":
		return crypto.SHA1, true
	case "sha256":
		return crypto.SHA256, true
	case "sha384":
		return crypto.SHA384, true
	default:
		return 0, false
	}
}

func getKeySize(name string) int {
	switch name {
	case "aes128":
		return 16
	case "aes256":
		return 32
	case "3des":
		return 24
	default:
		return 0
	}
}

func newBlockCipher(name string, key []byte) (cipher.Block, error) {
	switch name {
	case "aes128":
		return aes.NewCipher(key)
	case "aes256":
		return aes.NewCipher(key)
	case "3des":
		return des.NewTripleDESCipher(key)
	default:
		return nil, fmt.Errorf("unknown cipher '%s'", name)
	}
}

type testCase struct {
	digest     []byte
	key        []byte
	nonce      []byte
	input      []byte
	ad         []byte
	ciphertext []byte
	tag        []byte
	tag_len    int
	noSeal     bool
	fails      bool
}

// options adds additional options for a test.
type options struct {
	// extraPadding causes an extra block of padding to be added.
	extraPadding bool
	// maximalPadding causes the maximum allowed amount of padding to be added.
	maximalPadding bool
	// wrongPadding causes one of the padding bytes to be wrong.
	wrongPadding bool
	// wrongPaddingOffset specifies the byte offset of the incorrect padding
	// byte.
	wrongPaddingOffset int
	// noPadding causes padding is to be omitted. The plaintext + MAC must
	// be a multiple of the block size.
	noPadding bool
	// omitMAC causes the MAC to be omitted.
	omitMAC bool
}

func makeTestCase(length int, options options) (*testCase, error) {
	rand, err := newRc4Stream("input stream")
	if err != nil {
		return nil, err
	}

	input := make([]byte, length)
	rand.fillBytes(input)

	adFull := make([]byte, 13)
	ad := adFull[:len(adFull)-2]
	rand.fillBytes(ad)
	adFull[len(adFull)-2] = uint8(length >> 8)
	adFull[len(adFull)-1] = uint8(length & 0xff)

	hash, ok := getHash(*mac)
	if !ok {
		return nil, fmt.Errorf("unknown hash function '%s'", *mac)
	}

	macKey := make([]byte, hash.Size())
	rand.fillBytes(macKey)

	h := hmac.New(hash.New, macKey)
	h.Write(adFull)
	h.Write(input)
	digest := h.Sum(nil)

	size := getKeySize(*bulkCipher)
	if size == 0 {
		return nil, fmt.Errorf("unknown cipher '%s'", *bulkCipher)
	}
	encKey := make([]byte, size)
	rand.fillBytes(encKey)

	var fixedIV []byte
	var nonce []byte
	var sealed []byte
	var noSeal, fails bool
	block, err := newBlockCipher(*bulkCipher, encKey)
	if err != nil {
		return nil, err
	}

	iv := make([]byte, block.BlockSize())
	rand.fillBytes(iv)
	if *implicitIV {
		fixedIV = iv
	} else {
		nonce = iv
	}

	cbc := cipher.NewCBCEncrypter(block, iv)

	sealed = make([]byte, 0, len(input)+len(digest)+cbc.BlockSize())
	sealed = append(sealed, input...)
	if options.omitMAC {
		noSeal = true
		fails = true
	} else {
		sealed = append(sealed, digest...)
	}
	paddingLen := cbc.BlockSize() - len(sealed)%cbc.BlockSize()
	if options.noPadding {
		if paddingLen != cbc.BlockSize() {
			return nil, fmt.Errorf("invalid length for noPadding")
		}
		noSeal = true
		fails = true
	} else {
		if options.extraPadding || options.maximalPadding {
			if options.extraPadding {
				paddingLen += cbc.BlockSize()
			} else {
				if 256%cbc.BlockSize() != 0 {
					panic("256 is not a whole number of blocks")
				}
				paddingLen = 256 - len(sealed)%cbc.BlockSize()
			}
			noSeal = true
		}
		pad := make([]byte, paddingLen)
		for i := range pad {
			pad[i] = byte(paddingLen - 1)
		}
		sealed = append(sealed, pad...)
		if options.wrongPadding {
			if options.wrongPaddingOffset >= paddingLen {
				return nil, fmt.Errorf("invalid wrongPaddingOffset")
			}
			sealed[len(sealed)-paddingLen+options.wrongPaddingOffset]++
			noSeal = true
			// TLS specifies the all the padding bytes.
			fails = true
		}
	}
	cbc.CryptBlocks(sealed, sealed)

	key := make([]byte, 0, len(macKey)+len(encKey)+len(fixedIV))
	key = append(key, macKey...)
	key = append(key, encKey...)
	key = append(key, fixedIV...)
	t := &testCase{
		digest:     digest,
		key:        key,
		nonce:      nonce,
		input:      input,
		ad:         ad,
		ciphertext: sealed[:len(input)],
		tag:        sealed[len(input):],
		tag_len:    hash.Size(),
		noSeal:     noSeal,
		fails:      fails,
	}
	return t, nil
}

func printTestCase(t *testCase) {
	fmt.Printf("# DIGEST: %s\n", hex.EncodeToString(t.digest))
	fmt.Printf("KEY: %s\n", hex.EncodeToString(t.key))
	fmt.Printf("NONCE: %s\n", hex.EncodeToString(t.nonce))
	fmt.Printf("IN: %s\n", hex.EncodeToString(t.input))
	fmt.Printf("AD: %s\n", hex.EncodeToString(t.ad))
	fmt.Printf("CT: %s\n", hex.EncodeToString(t.ciphertext))
	fmt.Printf("TAG: %s\n", hex.EncodeToString(t.tag))
	fmt.Printf("TAG_LEN: %d\n", t.tag_len)
	if t.noSeal {
		fmt.Printf("NO_SEAL: 01\n")
	}
	if t.fails {
		fmt.Printf("FAILS: 01\n")
	}
}

func addTestCase(length int, options options) {
	t, err := makeTestCase(length, options)
	if err != nil {
		fmt.Fprintf(os.Stderr, "%s\n", err)
		os.Exit(1)
	}
	printTestCase(t)
	fmt.Printf("\n")
}

func main() {
	flag.Parse()

	commandLine := fmt.Sprintf("go run make_legacy_aead_tests.go -cipher %s -mac %s", *bulkCipher, *mac)
	if *implicitIV {
		commandLine += " -implicit-iv"
	}
	fmt.Printf("# Generated by\n")
	fmt.Printf("#   %s\n", commandLine)
	fmt.Printf("#\n")
	fmt.Printf("# Note: aead_test's input format splits the ciphertext and tag positions of the\n")
	fmt.Printf("# sealed input. But these legacy AEADs are MAC-then-encrypt and so the 'TAG' may\n")
	fmt.Printf("# also include padding. We write the byte length of the MAC to 'TAG_LEN' and\n")
	fmt.Printf("# include the unencrypted MAC in the 'DIGEST' tag above # each test case.\n")
	fmt.Printf("# each test case.\n")
	fmt.Printf("\n")

	// For CBC-mode ciphers, emit tests for padding flexibility.
	fmt.Printf("# Test with non-minimal padding.\n")
	addTestCase(5, options{extraPadding: true})

	fmt.Printf("# Test with bad padding values.\n")
	addTestCase(5, options{wrongPadding: true})

	hash, ok := getHash(*mac)
	if !ok {
		panic("unknown hash")
	}

	fmt.Printf("# Test with no padding.\n")
	addTestCase(64-hash.Size(), options{noPadding: true})

	// Test with maximal padding at all rotations modulo the hash's block
	// size. Our smallest hash (SHA-1 at 64-byte blocks) exceeds our largest
	// block cipher (AES at 16-byte blocks), so this is also covers all
	// block cipher rotations. This is to ensure full coverage of the
	// kVarianceBlocks value in the constant-time logic.
	hashBlockSize := hash.New().BlockSize()
	for i := 0; i < hashBlockSize; i++ {
		fmt.Printf("# Test with maximal padding (%d mod %d).\n", i, hashBlockSize)
		addTestCase(hashBlockSize+i, options{maximalPadding: true})
	}

	fmt.Printf("# Test if the unpadded input is too short for a MAC, but not publicly so.\n")
	addTestCase(0, options{omitMAC: true, maximalPadding: true})

	fmt.Printf("# Test that each byte of incorrect padding is noticed.\n")
	for i := 0; i < 256; i++ {
		addTestCase(64-hash.Size(), options{
			maximalPadding:     true,
			wrongPadding:       true,
			wrongPaddingOffset: i,
		})
	}

	// Generate long enough of input to cover a non-zero num_starting_blocks
	// value in the constant-time CBC logic.
	for l := 0; l < 500; l += 5 {
		addTestCase(l, options{})
	}
}
