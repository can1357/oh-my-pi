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

//go:build ignore

package main

import (
	"bufio"
	"bytes"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"

	"boringssl.googlesource.com/boringssl.git/util/build"
	"boringssl.googlesource.com/boringssl.git/util/testconfig"
)

var (
	buildDir     = flag.String("build-dir", "build", "Specifies the build directory to push.")
	adbPath      = flag.String("adb", "adb", "Specifies the adb binary to use. Defaults to looking in PATH.")
	ndkPath      = flag.String("ndk", "", "Specifies the path to the NDK installation. Defaults to detecting from the build directory.")
	device       = flag.String("device", "", "Specifies the device or emulator. See adb's -s argument.")
	abi          = flag.String("abi", "", "Specifies the Android ABI to use when building Go tools. Defaults to detecting from the build directory.")
	apiLevel     = flag.Int("api-level", 0, "Specifies the Android API level to use when building Go tools. Defaults to detecting from the build directory.")
	suite        = flag.String("suite", "all", "Specifies the test suites to run (all, unit, or ssl).")
	allTestsArgs = flag.String("all-tests-args", "", "Specifies space-separated arguments to pass to all_tests.go")
	runnerArgs   = flag.String("runner-args", "", "Specifies space-separated arguments to pass to ssl/test/runner")
	jsonOutput   = flag.String("json-output", "", "The file to output JSON results to.")
)

func enableUnitTests() bool {
	return *suite == "all" || *suite == "unit"
}

func enableSSLTests() bool {
	return *suite == "all" || *suite == "ssl"
}

func adb(args ...string) error {
	if len(*device) > 0 {
		args = append([]string{"-s", *device}, args...)
	}
	cmd := exec.Command(*adbPath, args...)
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr
	return cmd.Run()
}

func adbShell(shellCmd string) (int, error) {
	var args []string
	if len(*device) > 0 {
		args = append([]string{"-s", *device}, args...)
	}
	args = append(args, "shell")

	const delimiter = "___EXIT_CODE___"

	// Older versions of adb and Android do not preserve the exit
	// code, so work around this.
	// https://code.google.com/p/android/issues/detail?id=3254
	shellCmd += "; echo " + delimiter + " $?"
	args = append(args, shellCmd)

	cmd := exec.Command(*adbPath, args...)
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return 0, err
	}
	cmd.Stderr = os.Stderr
	if err := cmd.Start(); err != nil {
		return 0, err
	}

	var stdoutBytes bytes.Buffer
	for {
		var buf [1024]byte
		n, err := stdout.Read(buf[:])
		stdoutBytes.Write(buf[:n])
		os.Stdout.Write(buf[:n])
		if err != nil {
			break
		}
	}

	if err := cmd.Wait(); err != nil {
		return 0, err
	}

	stdoutStr := stdoutBytes.String()
	idx := strings.LastIndex(stdoutStr, delimiter)
	if idx < 0 {
		return 0, fmt.Errorf("Could not find delimiter in output.")
	}

	return strconv.Atoi(strings.TrimSpace(stdoutStr[idx+len(delimiter):]))
}

func goTool(args ...string) error {
	cmd := exec.Command("go", args...)
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr

	cmd.Env = os.Environ()

	// The NDK includes the host platform in the toolchain path.
	var ndkOS, ndkArch string
	switch runtime.GOOS {
	case "linux":
		ndkOS = "linux"
	default:
		return fmt.Errorf("unknown host OS: %q", runtime.GOOS)
	}
	switch runtime.GOARCH {
	case "amd64":
		ndkArch = "x86_64"
	default:
		return fmt.Errorf("unknown host architecture: %q", runtime.GOARCH)
	}
	ndkHost := ndkOS + "-" + ndkArch

	// Use the NDK's target-prefixed clang wrappers, so cgo gets the right
	// flags. See https://developer.android.com/ndk/guides/cmake#android_abi for
	// Android ABIs.
	var targetPrefix string
	switch *abi {
	case "armeabi-v7a", "armeabi-v7a with NEON":
		targetPrefix = fmt.Sprintf("armv7a-linux-androideabi%d-", *apiLevel)
		cmd.Env = append(cmd.Env, "GOARCH=arm")
		cmd.Env = append(cmd.Env, "GOARM=7")
	case "arm64-v8a":
		targetPrefix = fmt.Sprintf("aarch64-linux-android%d-", *apiLevel)
		cmd.Env = append(cmd.Env, "GOARCH=arm64")
	default:
		return fmt.Errorf("unknown Android ABI: %q", *abi)
	}

	// Go's Android support requires cgo and compilers from the NDK. See
	// https://golang.org/misc/android/README, though note CC_FOR_TARGET only
	// works when building Go itself. go build only looks at CC.
	cmd.Env = append(cmd.Env, "CGO_ENABLED=1")
	cmd.Env = append(cmd.Env, "GOOS=android")
	toolchainDir := filepath.Join(*ndkPath, "toolchains", "llvm", "prebuilt", ndkHost, "bin")
	cmd.Env = append(cmd.Env, fmt.Sprintf("CC=%s", filepath.Join(toolchainDir, targetPrefix+"clang")))
	cmd.Env = append(cmd.Env, fmt.Sprintf("CXX=%s", filepath.Join(toolchainDir, targetPrefix+"clang++")))
	return cmd.Run()
}

// setWorkingDirectory walks up directories as needed until the current working
// directory is the top of a BoringSSL checkout.
func setWorkingDirectory() {
	for i := 0; i < 64; i++ {
		if _, err := os.Stat("BUILDING.md"); err == nil {
			return
		}
		os.Chdir("..")
	}

	panic("Couldn't find BUILDING.md in a parent directory!")
}

func detectOptionsFromCMake() error {
	if len(*ndkPath) != 0 && len(*abi) != 0 && *apiLevel != 0 {
		// No need to parse options from CMake.
		return nil
	}

	cmakeCache, err := os.Open(filepath.Join(*buildDir, "CMakeCache.txt"))
	if err != nil {
		return err
	}
	defer cmakeCache.Close()

	cmakeVars := make(map[string]string)
	scanner := bufio.NewScanner(cmakeCache)
	for scanner.Scan() {
		line := scanner.Text()
		if idx := strings.IndexByte(line, '#'); idx >= 0 {
			line = line[:idx]
		}
		if idx := strings.Index(line, "//"); idx >= 0 {
			line = line[:idx]
		}
		// The syntax for each line is KEY:TYPE=VALUE.
		equals := strings.IndexByte(line, '=')
		if equals < 0 {
			continue
		}
		name := line[:equals]
		value := line[equals+1:]
		if idx := strings.IndexByte(name, ':'); idx >= 0 {
			name = name[:idx]
		}
		cmakeVars[name] = value
	}
	if err := scanner.Err(); err != nil {
		return err
	}

	if len(*ndkPath) == 0 {
		if ndk, ok := cmakeVars["ANDROID_NDK"]; ok {
			*ndkPath = ndk
		} else if toolchainFile, ok := cmakeVars["CMAKE_TOOLCHAIN_FILE"]; ok {
			// The toolchain is at build/cmake/android.toolchain.cmake under the NDK.
			*ndkPath = filepath.Dir(filepath.Dir(filepath.Dir(toolchainFile)))
		} else {
			return errors.New("Neither CMAKE_TOOLCHAIN_FILE nor ANDROID_NDK found in CMakeCache.txt")
		}
		fmt.Printf("Detected NDK path %q from CMakeCache.txt.\n", *ndkPath)
	}
	if len(*abi) == 0 {
		var ok bool
		if *abi, ok = cmakeVars["ANDROID_ABI"]; !ok {
			return errors.New("ANDROID_ABI not found in CMakeCache.txt")
		}
		fmt.Printf("Detected ABI %q from CMakeCache.txt.\n", *abi)
	}
	if *apiLevel == 0 {
		apiLevelStr, ok := cmakeVars["ANDROID_PLATFORM"]
		if !ok {
			return errors.New("ANDROID_PLATFORM not found in CMakeCache.txt")
		}
		apiLevelStr = strings.TrimPrefix(apiLevelStr, "android-")
		var err error
		if *apiLevel, err = strconv.Atoi(apiLevelStr); err != nil {
			return fmt.Errorf("error parsing ANDROID_PLATFORM: %s", err)
		}
		fmt.Printf("Detected API level %d from CMakeCache.txt.\n", *apiLevel)
	}
	return nil
}

func copyFile(dst, src string) error {
	srcFile, err := os.Open(src)
	if err != nil {
		return err
	}
	defer srcFile.Close()

	srcInfo, err := srcFile.Stat()
	if err != nil {
		return err
	}

	dir := filepath.Dir(dst)
	if err := os.MkdirAll(dir, 0777); err != nil {
		return err
	}

	dstFile, err := os.OpenFile(dst, os.O_CREATE|os.O_WRONLY, srcInfo.Mode())
	if err != nil {
		return err
	}
	defer dstFile.Close()

	_, err = io.Copy(dstFile, srcFile)
	return err
}

func main() {
	flag.Parse()

	if *suite == "all" && *jsonOutput != "" {
		fmt.Printf("To use -json-output flag, select only one test suite with -suite.\n")
		os.Exit(1)
	}

	setWorkingDirectory()
	if err := detectOptionsFromCMake(); err != nil {
		fmt.Printf("Error reading options from CMake: %s.\n", err)
		os.Exit(1)
	}

	targetsJSON, err := os.ReadFile("gen/sources.json")
	if err != nil {
		fmt.Printf("Error reading sources.json: %s.\n", err)
		os.Exit(1)
	}
	var targets map[string]build.Target
	if err := json.Unmarshal(targetsJSON, &targets); err != nil {
		fmt.Printf("Error reading sources.json: %s.\n", err)
		os.Exit(1)
	}

	// Clear the target directory.
	if err := adb("shell", "rm -Rf /data/local/tmp/boringssl-tmp"); err != nil {
		fmt.Printf("Failed to clear target directory: %s\n", err)
		os.Exit(1)
	}

	// Stage everything in a temporary directory.
	tmpDir, err := os.MkdirTemp("", "boringssl-android")
	if err != nil {
		fmt.Printf("Error making temporary directory: %s\n", err)
		os.Exit(1)
	}
	defer os.RemoveAll(tmpDir)

	var binaries, files []string

	if enableUnitTests() {
		files = append(files,
			"util/all_tests.json",
			"BUILDING.md",
		)
		for _, target := range targets {
			files = append(files, target.Data...)
		}

		tests, err := testconfig.ParseTestConfig("util/all_tests.json")
		if err != nil {
			fmt.Printf("Failed to parse input: %s\n", err)
			os.Exit(1)
		}

		seenBinary := make(map[string]struct{})
		for _, test := range tests {
			if _, ok := seenBinary[test.Cmd[0]]; !ok {
				binaries = append(binaries, test.Cmd[0])
				seenBinary[test.Cmd[0]] = struct{}{}
			}
			for _, arg := range test.Cmd[1:] {
				if strings.Contains(arg, "/") {
					files = append(files, arg)
				}
			}
		}

		fmt.Printf("Building all_tests...\n")
		if err := goTool("build", "-o", filepath.Join(tmpDir, "util/all_tests"), "util/all_tests.go"); err != nil {
			fmt.Printf("Error building all_tests.go: %s\n", err)
			os.Exit(1)
		}
	}

	if enableSSLTests() {
		binaries = append(binaries, "ssl/test/bssl_shim")
		fmt.Printf("Building runner...\n")
		if err := goTool("test", "-c", "-o", filepath.Join(tmpDir, "ssl/test/runner/runner"), "./ssl/test/runner/"); err != nil {
			fmt.Printf("Error building runner: %s\n", err)
			os.Exit(1)
		}
	}

	var libraries []string
	if _, err := os.Stat(filepath.Join(*buildDir, "libcrypto.so")); err == nil {
		libraries = []string{
			"libboringssl_gtest.so",
			"libcrypto.so",
			"libdecrepit.so",
			"libpki.so",
			"libssl.so",
		}
	} else if !os.IsNotExist(err) {
		fmt.Printf("Failed to stat libcrypto.so: %s\n", err)
		os.Exit(1)
	}

	fmt.Printf("Copying test binaries...\n")
	for _, binary := range binaries {
		if err := copyFile(filepath.Join(tmpDir, "build", binary), filepath.Join(*buildDir, binary)); err != nil {
			fmt.Printf("Failed to copy %s: %s\n", binary, err)
			os.Exit(1)
		}
	}

	var envPrefix string
	if len(libraries) > 0 {
		fmt.Printf("Copying libraries...\n")
		for _, library := range libraries {
			// Place all the libraries in a common directory so they
			// can be passed to LD_LIBRARY_PATH once.
			if err := copyFile(filepath.Join(tmpDir, "build", "lib", filepath.Base(library)), filepath.Join(*buildDir, library)); err != nil {
				fmt.Printf("Failed to copy %s: %s\n", library, err)
				os.Exit(1)
			}
		}
		envPrefix = "env LD_LIBRARY_PATH=/data/local/tmp/boringssl-tmp/build/lib "
	}

	fmt.Printf("Copying data files...\n")
	for _, file := range files {
		if err := copyFile(filepath.Join(tmpDir, file), file); err != nil {
			fmt.Printf("Failed to copy %s: %s\n", file, err)
			os.Exit(1)
		}
	}

	fmt.Printf("Uploading files...\n")
	if err := adb("push", "-p", tmpDir, "/data/local/tmp/boringssl-tmp"); err != nil {
		fmt.Printf("Failed to push runner: %s\n", err)
		os.Exit(1)
	}

	var unitTestExit int
	if enableUnitTests() {
		fmt.Printf("Running unit tests...\n")
		unitTestExit, err = adbShell(fmt.Sprintf("cd /data/local/tmp/boringssl-tmp && %s./util/all_tests -json-output results.json %s", envPrefix, *allTestsArgs))
		if err != nil {
			fmt.Printf("Failed to run unit tests: %s\n", err)
			os.Exit(1)
		}
	}

	var sslTestExit int
	if enableSSLTests() {
		fmt.Printf("Running SSL tests...\n")
		sslTestExit, err = adbShell(fmt.Sprintf("cd /data/local/tmp/boringssl-tmp/ssl/test/runner && %s./runner -json-output ../../../results.json %s", envPrefix, *runnerArgs))
		if err != nil {
			fmt.Printf("Failed to run SSL tests: %s\n", err)
			os.Exit(1)
		}
	}

	if *jsonOutput != "" {
		if err := adb("pull", "-p", "/data/local/tmp/boringssl-tmp/results.json", *jsonOutput); err != nil {
			fmt.Printf("Failed to extract results.json: %s\n", err)
			os.Exit(1)
		}
	}

	if unitTestExit != 0 {
		os.Exit(unitTestExit)
	}

	if sslTestExit != 0 {
		os.Exit(sslTestExit)
	}
}
