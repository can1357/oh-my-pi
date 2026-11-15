// Copyright 2015 The BoringSSL Authors
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
	"bytes"
	"errors"
	"flag"
	"fmt"
	"os"
	"os/exec"
	"path"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"syscall"

	"boringssl.googlesource.com/boringssl.git/util/testconfig"
	"boringssl.googlesource.com/boringssl.git/util/testresult"
)

// TODO(davidben): Link tests with the malloc shim and port -malloc-test to this runner.

var (
	useValgrind     = flag.Bool("valgrind", false, "If true, run code under valgrind")
	useCallgrind    = flag.Bool("callgrind", false, "If true, run code under valgrind to generate callgrind traces.")
	useGDB          = flag.Bool("gdb", false, "If true, run BoringSSL code under gdb")
	useSDE          = flag.Bool("sde", false, "If true, run BoringSSL code under Intel's SDE for each supported chip")
	sdePath         = flag.String("sde-path", "sde", "The path to find the sde binary.")
	buildDir        = flag.String("build-dir", "build", "The build directory to run the tests from.")
	numWorkers      = flag.Int("num-workers", runtime.NumCPU(), "Runs the given number of workers when testing.")
	jsonOutput      = flag.String("json-output", "", "The file to output JSON results to.")
	mallocTest      = flag.Int64("malloc-test", -1, "If non-negative, run each test with each malloc in turn failing from the given number onwards.")
	mallocTestDebug = flag.Bool("malloc-test-debug", false, "If true, ask each test to abort rather than fail a malloc. This can be used with a specific value for --malloc-test to identity the malloc failing that is causing problems.")
	simulateARMCPUs = flag.Bool("simulate-arm-cpus", simulateARMCPUsDefault(), "If true, runs tests simulating different ARM CPUs.")
	qemuBinary      = flag.String("qemu", "", "Optional, absolute path to a binary location for QEMU runtime.")
)

func simulateARMCPUsDefault() bool {
	return (runtime.GOOS == "linux" || runtime.GOOS == "android") && (runtime.GOARCH == "arm" || runtime.GOARCH == "arm64")
}

type test struct {
	testconfig.Test

	shard, numShards int
	// cpu, if not empty, contains a code to simulate. For SDE, run `sde64
	// -help` to get a list of these codes. For ARM, see gtest_main.cc for
	// the supported values.
	cpu string
}

type result struct {
	Test   test
	Passed bool
	Error  error
}

// sdeCPUs contains a list of CPU code that we run all tests under when *useSDE
// is true.
var sdeCPUs = []string{
	"p4p", // Pentium4 Prescott
	"mrm", // Merom
	"pnr", // Penryn
	"nhm", // Nehalem
	"wsm", // Westmere
	"snb", // Sandy Bridge
	"ivb", // Ivy Bridge
	"hsw", // Haswell
	"bdw", // Broadwell
	"slt", // Saltwell
	"slm", // Silvermont
	"glm", // Goldmont
	"glp", // Goldmont Plus
	"tnt", // Tremont
	"skl", // Skylake
	"cnl", // Cannon Lake
	"icl", // Ice Lake
	"skx", // Skylake server
	"clx", // Cascade Lake
	"cpx", // Cooper Lake
	"icx", // Ice Lake server
	"tgl", // Tiger Lake
	"adl", // Alder Lake
	"spr", // Sapphire Rapids
}

var armCPUs = []string{
	"none",   // No support for any ARM extensions.
	"neon",   // Support for NEON.
	"crypto", // Support for NEON and crypto extensions.
}

func valgrindOf(dbAttach bool, path string, args ...string) *exec.Cmd {
	valgrindArgs := []string{"--error-exitcode=99", "--track-origins=yes", "--leak-check=full", "--quiet"}
	if dbAttach {
		valgrindArgs = append(valgrindArgs, "--db-attach=yes", "--db-command=xterm -e gdb -nw %f %p")
	}
	valgrindArgs = append(valgrindArgs, path)
	valgrindArgs = append(valgrindArgs, args...)

	return exec.Command("valgrind", valgrindArgs...)
}

func callgrindOf(path string, args ...string) *exec.Cmd {
	valgrindArgs := []string{"-q", "--tool=callgrind", "--dump-instr=yes", "--collect-jumps=yes", "--callgrind-out-file=" + *buildDir + "/callgrind/callgrind.out.%p"}
	valgrindArgs = append(valgrindArgs, path)
	valgrindArgs = append(valgrindArgs, args...)

	return exec.Command("valgrind", valgrindArgs...)
}

func gdbOf(path string, args ...string) *exec.Cmd {
	xtermArgs := []string{"-e", "gdb", "--args"}
	xtermArgs = append(xtermArgs, path)
	xtermArgs = append(xtermArgs, args...)

	return exec.Command("xterm", xtermArgs...)
}

func sdeOf(cpu, path string, args ...string) *exec.Cmd {
	sdeArgs := []string{"-" + cpu}
	// The kernel's vdso code for gettimeofday sometimes uses the RDTSCP
	// instruction. Although SDE has a -chip_check_vsyscall flag that
	// excludes such code by default, it does not seem to work. Instead,
	// pass the -chip_check_exe_only flag which retains test coverage when
	// statically linked and excludes the vdso.
	if cpu == "p4p" || cpu == "pnr" || cpu == "mrm" || cpu == "slt" {
		sdeArgs = append(sdeArgs, "-chip_check_exe_only")
	}
	sdeArgs = append(sdeArgs, "--", path)
	sdeArgs = append(sdeArgs, args...)
	return exec.Command(*sdePath, sdeArgs...)
}

func qemuOf(path string, args ...string) *exec.Cmd {
	// The QEMU binary becomes the program to run, and the previous test program
	// to run instead becomes an additional argument to the QEMU binary.
	args = append([]string{path}, args...)
	return exec.Command(*qemuBinary, args...)
}

var (
	errMoreMallocs = errors.New("child process did not exhaust all allocation calls")
	errTestSkipped = errors.New("test was skipped")
)

func runTestOnce(test test, mallocNumToFail int64) (passed bool, err error) {
	prog := path.Join(*buildDir, test.Cmd[0])
	args := append([]string{}, test.Cmd[1:]...)
	if *simulateARMCPUs && test.cpu != "" {
		args = append(args, "--cpu="+test.cpu)
	}
	if *useSDE {
		// SDE is neither compatible with the unwind tester nor automatically
		// detected.
		args = append(args, "--no_unwind_tests")
	}

	var cmd *exec.Cmd
	if *useValgrind {
		cmd = valgrindOf(false, prog, args...)
	} else if *useCallgrind {
		cmd = callgrindOf(prog, args...)
	} else if *useGDB {
		cmd = gdbOf(prog, args...)
	} else if *useSDE {
		cmd = sdeOf(test.cpu, prog, args...)
	} else if *qemuBinary != "" {
		cmd = qemuOf(prog, args...)
	} else {
		cmd = exec.Command(prog, args...)
	}
	if test.Env != nil || test.numShards != 0 {
		cmd.Env = make([]string, len(os.Environ()))
		copy(cmd.Env, os.Environ())
	}
	if test.Env != nil {
		cmd.Env = append(cmd.Env, test.Env...)
	}
	if test.numShards != 0 {
		cmd.Env = append(cmd.Env, fmt.Sprintf("GTEST_SHARD_INDEX=%d", test.shard))
		cmd.Env = append(cmd.Env, fmt.Sprintf("GTEST_TOTAL_SHARDS=%d", test.numShards))
	}
	var outBuf bytes.Buffer
	cmd.Stdout = &outBuf
	cmd.Stderr = &outBuf
	if mallocNumToFail >= 0 {
		cmd.Env = os.Environ()
		cmd.Env = append(cmd.Env, "MALLOC_NUMBER_TO_FAIL="+strconv.FormatInt(mallocNumToFail, 10))
		if *mallocTestDebug {
			cmd.Env = append(cmd.Env, "MALLOC_ABORT_ON_FAIL=1")
		}
		cmd.Env = append(cmd.Env, "_MALLOC_CHECK=1")
	}

	if err := cmd.Start(); err != nil {
		return false, err
	}
	if err := cmd.Wait(); err != nil {
		if exitError, ok := err.(*exec.ExitError); ok {
			switch exitError.Sys().(syscall.WaitStatus).ExitStatus() {
			case 88:
				return false, errMoreMallocs
			case 89:
				fmt.Print(string(outBuf.Bytes()))
				return false, errTestSkipped
			}
		}
		fmt.Print(string(outBuf.Bytes()))
		return false, err
	}

	// Account for Windows line-endings.
	stdout := bytes.Replace(outBuf.Bytes(), []byte("\r\n"), []byte("\n"), -1)

	if bytes.HasSuffix(stdout, []byte("PASS\n")) &&
		(len(stdout) == 5 || stdout[len(stdout)-6] == '\n') {
		return true, nil
	}

	// Also accept a googletest-style pass line. This is left here in
	// transition until the tests are all converted and this script made
	// unnecessary.
	if bytes.Contains(stdout, []byte("\n[  PASSED  ]")) {
		return true, nil
	}

	fmt.Print(string(outBuf.Bytes()))
	return false, nil
}

func runTest(test test) (bool, error) {
	if *mallocTest < 0 {
		return runTestOnce(test, -1)
	}

	for mallocNumToFail := int64(*mallocTest); ; mallocNumToFail++ {
		if passed, err := runTestOnce(test, mallocNumToFail); err != errMoreMallocs {
			if err != nil {
				err = fmt.Errorf("at malloc %d: %s", mallocNumToFail, err)
			}
			return passed, err
		}
	}
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

func worker(tests <-chan test, results chan<- result, done *sync.WaitGroup) {
	defer done.Done()
	for test := range tests {
		passed, err := runTest(test)
		results <- result{test, passed, err}
	}
}

func (t test) shortName() string {
	return strings.Join(t.Cmd, " ") + t.shardMsg() + t.cpuMsg() + t.envMsg()
}

func SpaceIf(returnSpace bool) string {
	if !returnSpace {
		return ""
	}
	return " "
}

func (t test) longName() string {
	return strings.Join(t.Env, " ") + SpaceIf(len(t.Env) != 0) + strings.Join(t.Cmd, " ") + t.shardMsg() + t.cpuMsg()
}

func (t test) shardMsg() string {
	if t.numShards == 0 {
		return ""
	}

	return fmt.Sprintf(" [shard %d/%d]", t.shard+1, t.numShards)
}

func (t test) cpuMsg() string {
	if len(t.cpu) == 0 {
		return ""
	}

	return fmt.Sprintf(" (for CPU %q)", t.cpu)
}

func (t test) envMsg() string {
	if len(t.Env) == 0 {
		return ""
	}

	return " (custom environment)"
}

func (t test) getGTestShards() ([]test, error) {
	if *numWorkers == 1 || !t.Shard {
		return []test{t}, nil
	}

	shards := make([]test, *numWorkers)
	for i := range shards {
		shards[i] = t
		shards[i].shard = i
		shards[i].numShards = *numWorkers
	}

	return shards, nil
}

func main() {
	flag.Parse()
	setWorkingDirectory()

	testCases, err := testconfig.ParseTestConfig("util/all_tests.json")
	if err != nil {
		fmt.Printf("Failed to parse input: %s\n", err)
		os.Exit(1)
	}

	var wg sync.WaitGroup
	tests := make(chan test, *numWorkers)
	results := make(chan result, *numWorkers)

	for i := 0; i < *numWorkers; i++ {
		wg.Add(1)
		go worker(tests, results, &wg)
	}

	go func() {
		for _, baseTest := range testCases {
			test := test{Test: baseTest}
			if *useSDE {
				if test.SkipSDE {
					continue
				}
				// SDE generates plenty of tasks and gets slower
				// with additional sharding.
				for _, cpu := range sdeCPUs {
					testForCPU := test
					testForCPU.cpu = cpu
					tests <- testForCPU
				}
			} else if *simulateARMCPUs {
				// This mode is run instead of the default path,
				// so also include the native flow.
				tests <- test
				for _, cpu := range armCPUs {
					testForCPU := test
					testForCPU.cpu = cpu
					tests <- testForCPU
				}
			} else {
				shards, err := test.getGTestShards()
				if err != nil {
					fmt.Printf("Error listing tests: %s\n", err)
					os.Exit(1)
				}
				for _, shard := range shards {
					tests <- shard
				}
			}
		}
		close(tests)

		wg.Wait()
		close(results)
	}()

	testOutput := testresult.NewResults()
	var failed, skipped []test
	var total int
	for testResult := range results {
		test := testResult.Test
		args := test.Cmd

		total++
		if testResult.Error == errTestSkipped {
			fmt.Printf("%s\n", test.longName())
			fmt.Printf("%s was skipped\n", args[0])
			skipped = append(skipped, test)
			testOutput.AddSkip(test.longName())
		} else if testResult.Error != nil {
			fmt.Printf("%s\n", test.longName())
			fmt.Printf("%s failed to complete: %s\n", args[0], testResult.Error)
			failed = append(failed, test)
			testOutput.AddResult(test.longName(), "CRASH", testResult.Error)
		} else if !testResult.Passed {
			fmt.Printf("%s\n", test.longName())
			fmt.Printf("%s failed to print PASS on the last line.\n", args[0])
			failed = append(failed, test)
			testOutput.AddResult(test.longName(), "FAIL", nil)
		} else {
			fmt.Printf("%s\n", test.shortName())
			testOutput.AddResult(test.longName(), "PASS", nil)
		}
	}

	if *jsonOutput != "" {
		if err := testOutput.WriteToFile(*jsonOutput); err != nil {
			fmt.Fprintf(os.Stderr, "Error: %s\n", err)
		}
	}

	if len(skipped) > 0 {
		fmt.Printf("\n%d of %d tests were skipped:\n", len(skipped), total)
		for _, test := range skipped {
			fmt.Printf("\t%s\n", test.shortName())
		}
	}

	if len(failed) > 0 {
		fmt.Printf("\n%d of %d tests failed:\n", len(failed), total)
		for _, test := range failed {
			fmt.Printf("\t%s\n", test.shortName())
		}
		os.Exit(1)
	}

	fmt.Printf("All unit tests passed!\n")
}
