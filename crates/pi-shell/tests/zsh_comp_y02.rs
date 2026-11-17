//! zsh 5.9 `Test/Y02compmatch.ztst` (matching control) through the port of its
//! `comptest` harness (`comp_support::comptest`): obash runs as `zsh -f +Z` on
//! a pty, with zsh 5.9's installed completion functions, and every `comptest`
//! report must equal zsh's.
//!
//! The steps and reports below were recorded by running the `.ztst` file
//! under `/bin/zsh` 5.9 with `comptest` wrapped to log each `comptesteval`,
//! each `comptest` input and its report, and the file operations of the
//! test script; the reports equal the file's expected output (all of its
//! tests pass under `/bin/zsh`) except where zsh itself is expected to fail
//! (`f` flag), which are pinned to zsh's actual report. `PI_COMP_ORACLE=1`
//! runs them against `/bin/zsh` through this harness.

#![cfg(unix)]

mod comp_support;
mod pty_support;

use comp_support::comptest::{
	Case,
	Step::{self, Eval, Test},
	Suite, run_case,
};

/// The `%prep` steps (after `comptestinit`).
const PREP: &[Step] = &[];

/// The `%test` chunks in file order.
const CASES: &[Case] = &[
	Case {
		name:  "Match Error for \"z:\"",
		steps: &[
			Eval(
				"compdef _tst tst ; _tst () { echo -n '<COMPADD>';compadd -M 'z:'  - IndianRed \
				 IndianRed2 IndianRed3 IndianRed4 ; echo  -n '</COMPADD>'; ; echo -n \
				 '<INSERT_POSITIONS>'; echo $compstate[insert_positions]; echo -n \
				 '</INSERT_POSITIONS>'}",
			),
			Test(
				"tst \t",
				"line: {tst }{}\nCOMPADD:{_tst:compadd: unknown match specification character \
				 `z'}\nINSERT_POSITIONS:{}",
			),
		],
	},
	Case {
		name:  "Match Error for \"m:\"",
		steps: &[
			Eval(
				"compdef _tst tst ; _tst () { echo -n '<COMPADD>';compadd -M 'm:'  - IndianRed \
				 IndianRed2 IndianRed3 IndianRed4 ; echo  -n '</COMPADD>'; ; echo -n \
				 '<INSERT_POSITIONS>'; echo $compstate[insert_positions]; echo -n \
				 '</INSERT_POSITIONS>'}",
			),
			Test(
				"tst \t",
				"line: {tst }{}\nCOMPADD:{_tst:compadd: missing patterns}\nINSERT_POSITIONS:{}",
			),
		],
	},
	Case {
		name:  "Match Error for \"M:\"",
		steps: &[
			Eval(
				"compdef _tst tst ; _tst () { echo -n '<COMPADD>';compadd -M 'M:'  - IndianRed \
				 IndianRed2 IndianRed3 IndianRed4 ; echo  -n '</COMPADD>'; ; echo -n \
				 '<INSERT_POSITIONS>'; echo $compstate[insert_positions]; echo -n \
				 '</INSERT_POSITIONS>'}",
			),
			Test(
				"tst \t",
				"line: {tst }{}\nCOMPADD:{_tst:compadd: missing patterns}\nINSERT_POSITIONS:{}",
			),
		],
	},
	Case {
		name:  "Match Error \"r:\"",
		steps: &[
			Eval(
				"compdef _tst tst ; _tst () { echo -n '<COMPADD>';compadd -M 'r:'  - IndianRed \
				 IndianRed2 IndianRed3 IndianRed4 ; echo  -n '</COMPADD>'; ; echo -n \
				 '<INSERT_POSITIONS>'; echo $compstate[insert_positions]; echo -n \
				 '</INSERT_POSITIONS>'}",
			),
			Test(
				"tst \t",
				"line: {tst }{}\nCOMPADD:{_tst:compadd: missing patterns}\nINSERT_POSITIONS:{}",
			),
		],
	},
	Case {
		name:  "Match Error \"R:\"",
		steps: &[
			Eval(
				"compdef _tst tst ; _tst () { echo -n '<COMPADD>';compadd -M 'R:'  - IndianRed \
				 IndianRed2 IndianRed3 IndianRed4 ; echo  -n '</COMPADD>'; ; echo -n \
				 '<INSERT_POSITIONS>'; echo $compstate[insert_positions]; echo -n \
				 '</INSERT_POSITIONS>'}",
			),
			Test(
				"tst \t",
				"line: {tst }{}\nCOMPADD:{_tst:compadd: missing patterns}\nINSERT_POSITIONS:{}",
			),
		],
	},
	Case {
		name:  "Match Error for \"l:\"",
		steps: &[
			Eval(
				"compdef _tst tst ; _tst () { echo -n '<COMPADD>';compadd -M 'l:'  - IndianRed \
				 IndianRed2 IndianRed3 IndianRed4 ; echo  -n '</COMPADD>'; ; echo -n \
				 '<INSERT_POSITIONS>'; echo $compstate[insert_positions]; echo -n \
				 '</INSERT_POSITIONS>'}",
			),
			Test(
				"tst \t",
				"line: {tst }{}\nCOMPADD:{_tst:compadd: missing patterns}\nINSERT_POSITIONS:{}",
			),
		],
	},
	Case {
		name:  "Match Error for \"L:\"",
		steps: &[
			Eval(
				"compdef _tst tst ; _tst () { echo -n '<COMPADD>';compadd -M 'L:'  - IndianRed \
				 IndianRed2 IndianRed3 IndianRed4 ; echo  -n '</COMPADD>'; ; echo -n \
				 '<INSERT_POSITIONS>'; echo $compstate[insert_positions]; echo -n \
				 '</INSERT_POSITIONS>'}",
			),
			Test(
				"tst \t",
				"line: {tst }{}\nCOMPADD:{_tst:compadd: missing patterns}\nINSERT_POSITIONS:{}",
			),
		],
	},
	Case {
		name:  "Match Error for \"m:{0-9\"",
		steps: &[
			Eval(
				"compdef _tst tst ; _tst () { echo -n '<COMPADD>';compadd -M 'm:{0-9'  - IndianRed \
				 IndianRed2 IndianRed3 IndianRed4 ; echo  -n '</COMPADD>'; ; echo -n \
				 '<INSERT_POSITIONS>'; echo $compstate[insert_positions]; echo -n \
				 '</INSERT_POSITIONS>'}",
			),
			Test(
				"tst \t",
				"line: {tst }{}\nCOMPADD:{_tst:compadd: unterminated character \
				 class}\nINSERT_POSITIONS:{}",
			),
		],
	},
	Case {
		name:  "Match Error for \"m:{0-9}\"",
		steps: &[
			Eval(
				"compdef _tst tst ; _tst () { echo -n '<COMPADD>';compadd -M 'm:{0-9}'  - IndianRed \
				 IndianRed2 IndianRed3 IndianRed4 ; echo  -n '</COMPADD>'; ; echo -n \
				 '<INSERT_POSITIONS>'; echo $compstate[insert_positions]; echo -n \
				 '</INSERT_POSITIONS>'}",
			),
			Test(
				"tst \t",
				"line: {tst }{}\nCOMPADD:{_tst:compadd: missing word pattern}\nINSERT_POSITIONS:{}",
			),
		],
	},
	Case {
		name:  "Match Error for \"m:{0-9}={\"",
		steps: &[
			Eval(
				"compdef _tst tst ; _tst () { echo -n '<COMPADD>';compadd -M 'm:{0-9}={'  - IndianRed \
				 IndianRed2 IndianRed3 IndianRed4 ; echo  -n '</COMPADD>'; ; echo -n \
				 '<INSERT_POSITIONS>'; echo $compstate[insert_positions]; echo -n \
				 '</INSERT_POSITIONS>'}",
			),
			Test(
				"tst \t",
				"line: {tst }{}\nCOMPADD:{_tst:compadd: unterminated character \
				 class}\nINSERT_POSITIONS:{}",
			),
		],
	},
	Case {
		name:  "Match Error for \"m:{0-9}={0-\"",
		steps: &[
			Eval(
				"compdef _tst tst ; _tst () { echo -n '<COMPADD>';compadd -M 'm:{0-9}={0-'  - \
				 IndianRed IndianRed2 IndianRed3 IndianRed4 ; echo  -n '</COMPADD>'; ; echo -n \
				 '<INSERT_POSITIONS>'; echo $compstate[insert_positions]; echo -n \
				 '</INSERT_POSITIONS>'}",
			),
			Test(
				"tst \t",
				"line: {tst }{}\nCOMPADD:{_tst:compadd: unterminated character \
				 class}\nINSERT_POSITIONS:{}",
			),
		],
	},
	Case {
		name:  "Match Error for \"m:{0-9}={-\"",
		steps: &[
			Eval(
				"compdef _tst tst ; _tst () { echo -n '<COMPADD>';compadd -M 'm:{0-9}={-'  - \
				 IndianRed IndianRed2 IndianRed3 IndianRed4 ; echo  -n '</COMPADD>'; ; echo -n \
				 '<INSERT_POSITIONS>'; echo $compstate[insert_positions]; echo -n \
				 '</INSERT_POSITIONS>'}",
			),
			Test(
				"tst \t",
				"line: {tst }{}\nCOMPADD:{_tst:compadd: unterminated character \
				 class}\nINSERT_POSITIONS:{}",
			),
		],
	},
	Case {
		name:  "Match Error \"r:\"",
		steps: &[
			Eval(
				"compdef _tst tst ; _tst () { echo -n '<COMPADD>';compadd -M 'r:'  - IndianRed \
				 IndianRed2 IndianRed3 IndianRed4 ; echo  -n '</COMPADD>'; ; echo -n \
				 '<INSERT_POSITIONS>'; echo $compstate[insert_positions]; echo -n \
				 '</INSERT_POSITIONS>'}",
			),
			Test(
				"tst \t",
				"line: {tst }{}\nCOMPADD:{_tst:compadd: missing patterns}\nINSERT_POSITIONS:{}",
			),
		],
	},
	Case {
		name:  "Documentation example for options, input \"nolistbee\"",
		steps: &[
			Eval(
				"compdef _tst tst ; _tst () { echo -n '<COMPADD>';compadd -M 'L:|[nN][oO]= M:_= \
				 M:{A-Z}={a-z}'  - kshoptionprint shglob listambiguous shinstdin listbeep shnullcmd \
				 listpacked shoptionletters listrowsfirst shortloops listtypes shwordsplit ; echo  -n \
				 '</COMPADD>'; ; echo -n '<INSERT_POSITIONS>'; echo $compstate[insert_positions]; \
				 echo -n '</INSERT_POSITIONS>'}",
			),
			Test("tst nolistbee\t", "line: {tst nolistbeep }{}\nCOMPADD:{}\nINSERT_POSITIONS:{14}"),
		],
	},
	Case {
		name:  "Documentation example for options, input \"list_bee\"",
		steps: &[
			Eval(
				"compdef _tst tst ; _tst () { echo -n '<COMPADD>';compadd -M 'L:|[nN][oO]= M:_= \
				 M:{A-Z}={a-z}'  - kshoptionprint shglob listambiguous shinstdin listbeep shnullcmd \
				 listpacked shoptionletters listrowsfirst shortloops listtypes shwordsplit ; echo  -n \
				 '</COMPADD>'; ; echo -n '<INSERT_POSITIONS>'; echo $compstate[insert_positions]; \
				 echo -n '</INSERT_POSITIONS>'}",
			),
			Test("tst list_bee\t", "line: {tst list_beep }{}\nCOMPADD:{}\nINSERT_POSITIONS:{13}"),
		],
	},
	Case {
		name:  "Documentation example for options, input \"ListBee\"",
		steps: &[
			Eval(
				"compdef _tst tst ; _tst () { echo -n '<COMPADD>';compadd -M 'L:|[nN][oO]= M:_= \
				 M:{A-Z}={a-z}'  - kshoptionprint shglob listambiguous shinstdin listbeep shnullcmd \
				 listpacked shoptionletters listrowsfirst shortloops listtypes shwordsplit ; echo  -n \
				 '</COMPADD>'; ; echo -n '<INSERT_POSITIONS>'; echo $compstate[insert_positions]; \
				 echo -n '</INSERT_POSITIONS>'}",
			),
			Test("tst ListBee\t", "line: {tst ListBeep }{}\nCOMPADD:{}\nINSERT_POSITIONS:{12}"),
		],
	},
	Case {
		name:  "Documentation example for options, input \"NOList\"",
		steps: &[
			Eval(
				"compdef _tst tst ; _tst () { echo -n '<COMPADD>';compadd -M 'L:|[nN][oO]= M:_= \
				 M:{A-Z}={a-z}'  - kshoptionprint shglob listambiguous shinstdin listbeep shnullcmd \
				 listpacked shoptionletters listrowsfirst shortloops listtypes shwordsplit ; echo  -n \
				 '</COMPADD>'; ; echo -n '<INSERT_POSITIONS>'; echo $compstate[insert_positions]; \
				 echo -n '</INSERT_POSITIONS>'}",
			),
			Test(
				"tst NOList\tB\t",
				concat!(
					"line: {tst NOList}{}\n",
					"COMPADD:{}\n",
					"INSERT_POSITIONS:{10}\n",
					"NO:{NOListambiguous}\n",
					"NO:{NOListbeep}\n",
					"NO:{NOListpacked}\n",
					"NO:{NOListrowsfirst}\n",
					"NO:{NOListtypes}\n",
					"line: {tst NOListBeep }{}\n",
					"COMPADD:{}\n",
					"INSERT_POSITIONS:{14}",
				),
			),
		],
	},
	Case {
		name:  "Documentation example for options, input \"NO_List\\t__\\tB\\t\"",
		steps: &[
			Eval(
				"compdef _tst tst ; _tst () { echo -n '<COMPADD>';compadd -M 'L:|[nN][oO]= M:_= \
				 M:{A-Z}={a-z}'  - kshoptionprint shglob listambiguous shinstdin listbeep shnullcmd \
				 listpacked shoptionletters listrowsfirst shortloops listtypes shwordsplit ; echo  -n \
				 '</COMPADD>'; ; echo -n '<INSERT_POSITIONS>'; echo $compstate[insert_positions]; \
				 echo -n '</INSERT_POSITIONS>'}",
			),
			Test(
				"tst NO_List\t__\tB\t",
				concat!(
					"line: {tst NO_List}{}\n",
					"COMPADD:{}\n",
					"INSERT_POSITIONS:{11}\n",
					"NO:{NO_Listambiguous}\n",
					"NO:{NO_Listbeep}\n",
					"NO:{NO_Listpacked}\n",
					"NO:{NO_Listrowsfirst}\n",
					"NO:{NO_Listtypes}\n",
					"line: {tst NO_List__}{}\n",
					"COMPADD:{}\n",
					"INSERT_POSITIONS:{13}\n",
					"NO:{NO_List__ambiguous}\n",
					"NO:{NO_List__beep}\n",
					"NO:{NO_List__packed}\n",
					"NO:{NO_List__rowsfirst}\n",
					"NO:{NO_List__types}\n",
					"line: {tst NO_List__Beep }{}\n",
					"COMPADD:{}\n",
					"INSERT_POSITIONS:{17}",
				),
			),
		],
	},
	Case {
		name:  "Documentation example for options, input \"__\\tN\\t__o\\t___\\tlist_\\tbeep__\\t\" ",
		steps: &[
			Eval(
				"compdef _tst tst ; _tst () { echo -n '<COMPADD>';compadd -M 'L:|[nN][oO]= M:_= \
				 M:{A-Z}={a-z}'  - kshoptionprint shglob listambiguous shinstdin listbeep shnullcmd \
				 listpacked shoptionletters listrowsfirst shortloops listtypes shwordsplit ; echo  -n \
				 '</COMPADD>'; ; echo -n '<INSERT_POSITIONS>'; echo $compstate[insert_positions]; \
				 echo -n '</INSERT_POSITIONS>'}",
			),
			Test(
				"tst __\tN\t__o\t___\tlist_\tbeep__\t",
				concat!(
					"line: {tst __}{}\n",
					"COMPADD:{}\n",
					"INSERT_POSITIONS:{6}\n",
					"NO:{__kshoptionprint}\n",
					"NO:{__listambiguous}\n",
					"NO:{__listbeep}\n",
					"NO:{__listpacked}\n",
					"NO:{__listrowsfirst}\n",
					"NO:{__listtypes}\n",
					"NO:{__shglob}\n",
					"NO:{__shinstdin}\n",
					"NO:{__shnullcmd}\n",
					"NO:{__shoptionletters}\n",
					"NO:{__shortloops}\n",
					"NO:{__shwordsplit}\n",
					"line: {tst __N}{}\n",
					"COMPADD:{}\n",
					"INSERT_POSITIONS:{}\n",
					"line: {tst __N__o}{}\n",
					"COMPADD:{}\n",
					"INSERT_POSITIONS:{}\n",
					"line: {tst __N__o___}{}\n",
					"COMPADD:{}\n",
					"INSERT_POSITIONS:{}\n",
					"line: {tst __N__o___list_}{}\n",
					"COMPADD:{}\n",
					"INSERT_POSITIONS:{}\n",
					"line: {tst __N__o___list_beep__}{}\n",
					"COMPADD:{}\n",
					"INSERT_POSITIONS:{}",
				),
			),
		],
	},
	Case {
		name:  "Documentation example for options, input \"__\\tNo\\t___\\tlist_\\tbeep__\\t\" ",
		steps: &[
			Eval(
				"compdef _tst tst ; _tst () { echo -n '<COMPADD>';compadd -M 'L:|[nN][oO]= M:_= \
				 M:{A-Z}={a-z}'  - kshoptionprint shglob listambiguous shinstdin listbeep shnullcmd \
				 listpacked shoptionletters listrowsfirst shortloops listtypes shwordsplit ; echo  -n \
				 '</COMPADD>'; ; echo -n '<INSERT_POSITIONS>'; echo $compstate[insert_positions]; \
				 echo -n '</INSERT_POSITIONS>'}",
			),
			Test(
				"tst __\tNo\t___\tlist_\tbeep__\t",
				concat!(
					"line: {tst __}{}\n",
					"COMPADD:{}\n",
					"INSERT_POSITIONS:{6}\n",
					"NO:{__kshoptionprint}\n",
					"NO:{__listambiguous}\n",
					"NO:{__listbeep}\n",
					"NO:{__listpacked}\n",
					"NO:{__listrowsfirst}\n",
					"NO:{__listtypes}\n",
					"NO:{__shglob}\n",
					"NO:{__shinstdin}\n",
					"NO:{__shnullcmd}\n",
					"NO:{__shoptionletters}\n",
					"NO:{__shortloops}\n",
					"NO:{__shwordsplit}\n",
					"line: {tst __No}{}\n",
					"COMPADD:{}\n",
					"INSERT_POSITIONS:{}\n",
					"line: {tst __No___}{}\n",
					"COMPADD:{}\n",
					"INSERT_POSITIONS:{}\n",
					"line: {tst __No___list_}{}\n",
					"COMPADD:{}\n",
					"INSERT_POSITIONS:{}\n",
					"line: {tst __No___list_beep__}{}\n",
					"COMPADD:{}\n",
					"INSERT_POSITIONS:{}",
				),
			),
		],
	},
	Case {
		name:  "Documentation example for options, input \"___\\tlist_\\tbeep__\\t\" ",
		steps: &[
			Eval(
				"compdef _tst tst ; _tst () { echo -n '<COMPADD>';compadd -M 'L:|[nN][oO]= M:_= \
				 M:{A-Z}={a-z}'  - kshoptionprint shglob listambiguous shinstdin listbeep shnullcmd \
				 listpacked shoptionletters listrowsfirst shortloops listtypes shwordsplit ; echo  -n \
				 '</COMPADD>'; ; echo -n '<INSERT_POSITIONS>'; echo $compstate[insert_positions]; \
				 echo -n '</INSERT_POSITIONS>'}",
			),
			Test(
				"tst ___\tlist_\tbeep__\t",
				concat!(
					"line: {tst ___}{}\n",
					"COMPADD:{}\n",
					"INSERT_POSITIONS:{7}\n",
					"NO:{___kshoptionprint}\n",
					"NO:{___listambiguous}\n",
					"NO:{___listbeep}\n",
					"NO:{___listpacked}\n",
					"NO:{___listrowsfirst}\n",
					"NO:{___listtypes}\n",
					"NO:{___shglob}\n",
					"NO:{___shinstdin}\n",
					"NO:{___shnullcmd}\n",
					"NO:{___shoptionletters}\n",
					"NO:{___shortloops}\n",
					"NO:{___shwordsplit}\n",
					"line: {tst ___list_}{}\n",
					"COMPADD:{}\n",
					"INSERT_POSITIONS:{12}\n",
					"NO:{___list_ambiguous}\n",
					"NO:{___list_beep}\n",
					"NO:{___list_packed}\n",
					"NO:{___list_rowsfirst}\n",
					"NO:{___list_types}\n",
					"line: {tst ___list_beep__ }{}\n",
					"COMPADD:{}\n",
					"INSERT_POSITIONS:{18}",
				),
			),
		],
	},
	Case {
		name:  "Documentation example for options, input \"__no_listbe\"",
		steps: &[
			Eval(
				"compdef _tst tst ; _tst () { echo -n '<COMPADD>';compadd -M 'B:[nN][oO]= M:_= \
				 M:{A-Z}={a-z}'  - kshoptionprint shglob listambiguous shinstdin listbeep shnullcmd \
				 listpacked shoptionletters listrowsfirst shortloops listtypes shwordsplit ; echo  -n \
				 '</COMPADD>'; ; echo -n '<INSERT_POSITIONS>'; echo $compstate[insert_positions]; \
				 echo -n '</INSERT_POSITIONS>'}",
			),
			Test(
				"tst __no_listbe\t",
				"line: {tst __no_listbeep }{}\nCOMPADD:{}\nINSERT_POSITIONS:{17}",
			),
		],
	},
	Case {
		name:  "Documentation example for options, input \"nonono_listbe\"",
		steps: &[
			Eval(
				"compdef _tst tst ; _tst () { echo -n '<COMPADD>';compadd -M 'B:[nN][oO]= M:_= \
				 M:{A-Z}={a-z}'  - kshoptionprint shglob listambiguous shinstdin listbeep shnullcmd \
				 listpacked shoptionletters listrowsfirst shortloops listtypes shwordsplit ; echo  -n \
				 '</COMPADD>'; ; echo -n '<INSERT_POSITIONS>'; echo $compstate[insert_positions]; \
				 echo -n '</INSERT_POSITIONS>'}",
			),
			Test(
				"tst nonono_listbe\t",
				"line: {tst nonono_listbeep }{}\nCOMPADD:{}\nINSERT_POSITIONS:{19}",
			),
		],
	},
	Case {
		name:  "Documentation example for lowercase insenitive M, input \"ab\\tC\\t\"",
		steps: &[
			Eval(
				"compdef _tst tst ; _tst () { echo -n '<COMPADD>';compadd -M 'M:{a-z}={A-Z}'  - ABC \
				 Abc abc ; echo  -n '</COMPADD>'; ; echo -n '<INSERT_POSITIONS>'; echo \
				 $compstate[insert_positions]; echo -n '</INSERT_POSITIONS>'}",
			),
			Test(
				"tst ab\tC\t",
				"line: {tst ab}{}\nCOMPADD:{}\nINSERT_POSITIONS:{6}\nNO:{abC}\nNO:{abc}\nline: {tst \
				 abC }{}\nCOMPADD:{}\nINSERT_POSITIONS:{7}",
			),
		],
	},
	Case {
		name:  "Documentation example for lowercase insenitive m, input \"A\\t\\t\" ",
		steps: &[
			Eval(
				"compdef _tst tst ; _tst () { echo -n '<COMPADD>';compadd -M 'm:{a-z}={A-Z}'  - ABC \
				 Abc abc ; echo  -n '</COMPADD>'; ; echo -n '<INSERT_POSITIONS>'; echo \
				 $compstate[insert_positions]; echo -n '</INSERT_POSITIONS>'}",
			),
			Test(
				"tst A\t\t",
				"line: {tst A}{}\nCOMPADD:{}\nINSERT_POSITIONS:{5}\nNO:{ABC}\nNO:{Abc}\nline: {tst \
				 ABC}{}\nCOMPADD:{}\nINSERT_POSITIONS:{5}",
			),
		],
	},
	Case {
		name:  "Documentation example for case insenitive M, input \"aB\\t\\t\"",
		steps: &[
			Eval(
				"compdef _tst tst ; _tst () { echo -n '<COMPADD>';compadd -M 'M:{a-zA-Z}={A-Za-z}'  - \
				 ABC Abc abc ; echo  -n '</COMPADD>'; ; echo -n '<INSERT_POSITIONS>'; echo \
				 $compstate[insert_positions]; echo -n '</INSERT_POSITIONS>'}",
			),
			Test(
				"tst aB\t\t",
				"line: {tst aB}{}\nCOMPADD:{}\nINSERT_POSITIONS:{6}\nNO:{aBC}\nNO:{aBc}\nline: {tst \
				 aBC}{}\nCOMPADD:{}\nINSERT_POSITIONS:{6}",
			),
		],
	},
	Case {
		name:  "Documentation example for case insenitive m, input \"aB\\t\\t\"",
		steps: &[
			Eval(
				"compdef _tst tst ; _tst () { echo -n '<COMPADD>';compadd -M 'm:{a-zA-Z}={A-Za-z}'  - \
				 ABC Abc abc ; echo  -n '</COMPADD>'; ; echo -n '<INSERT_POSITIONS>'; echo \
				 $compstate[insert_positions]; echo -n '</INSERT_POSITIONS>'}",
			),
			Test(
				"tst aB\t\t",
				"line: {tst a}{BC}\nCOMPADD:{}\nINSERT_POSITIONS:{5:7}\nline: {tst \
				 a}{BC}\nCOMPADD:{}\nINSERT_POSITIONS:{5:7}\nNO:{ABC}\nNO:{Abc}\nNO:{abc}",
			),
		],
	},
	Case {
		name:  "r:|.=* should complete .s.u",
		steps: &[
			Eval(
				"compdef _tst tst ; _tst () { echo -n '<COMPADD>';compadd -M 'r:|.=* r:|=*'  - \
				 comp.sources.unix comp.sources.misc comp.graphics.algorithms comp.graphics.animation \
				 comp.graphics.api comp.graphics.apps comp.graphics.misc comp.graphics.packages \
				 comp.graphics.rendering comp.graphics.visualization comp.graphics.apps.alias \
				 comp.graphics.apps.gimp comp.graphics.apps.gnuplot comp.graphics.apps.lightwave \
				 comp.graphics.apps.pagemaker comp.graphics.apps.paint-shop-pro \
				 comp.graphics.apps.photoshop comp.graphics.apps.softimage comp.graphics.apps.ulead \
				 comp.graphics.rendering.misc comp.graphics.rendering.raytracing \
				 comp.graphics.rendering.renderman ; echo  -n '</COMPADD>'; ; echo -n \
				 '<INSERT_POSITIONS>'; echo $compstate[insert_positions]; echo -n \
				 '</INSERT_POSITIONS>'}",
			),
			Test("tst .s.u\t", "line: {tst comp.sources.unix }{}\nCOMPADD:{}\nINSERT_POSITIONS:{21}"),
		],
	},
	Case {
		name:  "r:[^.]||.=* should not complete .s.u, but should complete c.s.u",
		steps: &[
			Eval(
				"compdef _tst tst ; _tst () { echo -n '<COMPADD>';compadd -M 'r:[^.]||.=* r:|=*'  - \
				 comp.sources.unix comp.sources.misc comp.graphics.algorithms comp.graphics.animation \
				 comp.graphics.api comp.graphics.apps comp.graphics.misc comp.graphics.packages \
				 comp.graphics.rendering comp.graphics.visualization comp.graphics.apps.alias \
				 comp.graphics.apps.gimp comp.graphics.apps.gnuplot comp.graphics.apps.lightwave \
				 comp.graphics.apps.pagemaker comp.graphics.apps.paint-shop-pro \
				 comp.graphics.apps.photoshop comp.graphics.apps.softimage comp.graphics.apps.ulead \
				 comp.graphics.rendering.misc comp.graphics.rendering.raytracing \
				 comp.graphics.rendering.renderman ; echo  -n '</COMPADD>'; ; echo -n \
				 '<INSERT_POSITIONS>'; echo $compstate[insert_positions]; echo -n \
				 '</INSERT_POSITIONS>'}",
			),
			Test(
				"tst .s.u\t^[bc\t",
				"line: {tst comp.sources.unix }{}\nCOMPADD:{}\nINSERT_POSITIONS:{21}\nline: {tst \
				 comp.sources.unix ^[bc}{}",
			),
		],
	},
	Case {
		name:  "r:|.=* should complete .g.",
		steps: &[
			Eval(
				"compdef _tst tst ; _tst () { echo -n '<COMPADD>';compadd -M 'r:|.=* r:|=*'  - \
				 comp.sources.unix comp.sources.misc comp.graphics.algorithms comp.graphics.animation \
				 comp.graphics.api comp.graphics.apps comp.graphics.misc comp.graphics.packages \
				 comp.graphics.rendering comp.graphics.visualization comp.graphics.apps.alias \
				 comp.graphics.apps.gimp comp.graphics.apps.gnuplot comp.graphics.apps.lightwave \
				 comp.graphics.apps.pagemaker comp.graphics.apps.paint-shop-pro \
				 comp.graphics.apps.photoshop comp.graphics.apps.softimage comp.graphics.apps.ulead \
				 comp.graphics.rendering.misc comp.graphics.rendering.raytracing \
				 comp.graphics.rendering.renderman ; echo  -n '</COMPADD>'; ; echo -n \
				 '<INSERT_POSITIONS>'; echo $compstate[insert_positions]; echo -n \
				 '</INSERT_POSITIONS>'}",
			),
			Test(
				"tst .g.\ta\t.\tp\ta\tg\t",
				concat!(
					"line: {tst comp.graphics.}{}\n",
					"COMPADD:{}\n",
					"INSERT_POSITIONS:{18}\n",
					"line: {tst comp.graphics.a}{}\n",
					"COMPADD:{}\n",
					"INSERT_POSITIONS:{19}\n",
					"NO:{comp.graphics.algorithms}\n",
					"NO:{comp.graphics.animation}\n",
					"NO:{comp.graphics.api}\n",
					"NO:{comp.graphics.apps}\n",
					"NO:{comp.graphics.apps.alias}\n",
					"NO:{comp.graphics.apps.gimp}\n",
					"NO:{comp.graphics.apps.gnuplot}\n",
					"NO:{comp.graphics.apps.lightwave}\n",
					"NO:{comp.graphics.apps.pagemaker}\n",
					"NO:{comp.graphics.apps.paint-shop-pro}\n",
					"NO:{comp.graphics.apps.photoshop}\n",
					"NO:{comp.graphics.apps.softimage}\n",
					"NO:{comp.graphics.apps.ulead}\n",
					"line: {tst comp.graphics.apps.}{}\n",
					"COMPADD:{}\n",
					"INSERT_POSITIONS:{23}\n",
					"line: {tst comp.graphics.apps.p}{}\n",
					"COMPADD:{}\n",
					"INSERT_POSITIONS:{24}\n",
					"NO:{comp.graphics.apps.pagemaker}\n",
					"NO:{comp.graphics.apps.paint-shop-pro}\n",
					"NO:{comp.graphics.apps.photoshop}\n",
					"line: {tst comp.graphics.apps.pa}{}\n",
					"COMPADD:{}\n",
					"INSERT_POSITIONS:{25}\n",
					"NO:{comp.graphics.apps.pagemaker}\n",
					"NO:{comp.graphics.apps.paint-shop-pro}\n",
					"line: {tst comp.graphics.apps.pagemaker }{}\n",
					"COMPADD:{}\n",
					"INSERT_POSITIONS:{32}",
				),
			),
		],
	},
	Case {
		name:  "r:[^.]||.=* should not complete .g., but should complete c.g.",
		steps: &[
			Eval(
				"compdef _tst tst ; _tst () { echo -n '<COMPADD>';compadd -M 'r:[^.]||.=* r:|=*'  - \
				 comp.sources.unix comp.sources.misc comp.graphics.algorithms comp.graphics.animation \
				 comp.graphics.api comp.graphics.apps comp.graphics.misc comp.graphics.packages \
				 comp.graphics.rendering comp.graphics.visualization comp.graphics.apps.alias \
				 comp.graphics.apps.gimp comp.graphics.apps.gnuplot comp.graphics.apps.lightwave \
				 comp.graphics.apps.pagemaker comp.graphics.apps.paint-shop-pro \
				 comp.graphics.apps.photoshop comp.graphics.apps.softimage comp.graphics.apps.ulead \
				 comp.graphics.rendering.misc comp.graphics.rendering.raytracing \
				 comp.graphics.rendering.renderman ; echo  -n '</COMPADD>'; ; echo -n \
				 '<INSERT_POSITIONS>'; echo $compstate[insert_positions]; echo -n \
				 '</INSERT_POSITIONS>'}",
			),
			Test(
				"tst .g.\t^[bc\t",
				"line: {tst comp.graphics.}{}\nCOMPADD:{}\nINSERT_POSITIONS:{18}\nline: {tst \
				 comp.graphics.^[bc}{}",
			),
		],
	},
	Case {
		name:  "r:|.=* should complete ...pag",
		steps: &[
			Eval(
				"compdef _tst tst ; _tst () { echo -n '<COMPADD>';compadd -M 'r:|.=* r:|=*'  - \
				 comp.sources.unix comp.sources.misc comp.graphics.algorithms comp.graphics.animation \
				 comp.graphics.api comp.graphics.apps comp.graphics.misc comp.graphics.packages \
				 comp.graphics.rendering comp.graphics.visualization comp.graphics.apps.alias \
				 comp.graphics.apps.gimp comp.graphics.apps.gnuplot comp.graphics.apps.lightwave \
				 comp.graphics.apps.pagemaker comp.graphics.apps.paint-shop-pro \
				 comp.graphics.apps.photoshop comp.graphics.apps.softimage comp.graphics.apps.ulead \
				 comp.graphics.rendering.misc comp.graphics.rendering.raytracing \
				 comp.graphics.rendering.renderman ; echo  -n '</COMPADD>'; ; echo -n \
				 '<INSERT_POSITIONS>'; echo $compstate[insert_positions]; echo -n \
				 '</INSERT_POSITIONS>'}",
			),
			Test(
				"tst ...pag\t",
				"line: {tst comp.graphics.apps.pagemaker }{}\nCOMPADD:{}\nINSERT_POSITIONS:{32}",
			),
		],
	},
	Case {
		name:  "r:[^.]||.=* should not complete ...pag or c...pag, but should complete c.g.a.p",
		steps: &[
			Eval(
				"compdef _tst tst ; _tst () { echo -n '<COMPADD>';compadd -M 'r:[^.]||.=* r:|=*'  - \
				 comp.sources.unix comp.sources.misc comp.graphics.algorithms comp.graphics.animation \
				 comp.graphics.api comp.graphics.apps comp.graphics.misc comp.graphics.packages \
				 comp.graphics.rendering comp.graphics.visualization comp.graphics.apps.alias \
				 comp.graphics.apps.gimp comp.graphics.apps.gnuplot comp.graphics.apps.lightwave \
				 comp.graphics.apps.pagemaker comp.graphics.apps.paint-shop-pro \
				 comp.graphics.apps.photoshop comp.graphics.apps.softimage comp.graphics.apps.ulead \
				 comp.graphics.rendering.misc comp.graphics.rendering.raytracing \
				 comp.graphics.rendering.renderman ; echo  -n '</COMPADD>'; ; echo -n \
				 '<INSERT_POSITIONS>'; echo $compstate[insert_positions]; echo -n \
				 '</INSERT_POSITIONS>'}",
			),
			Test(
				"tst ...pag\t^[bc\t^Fg^F^Fa\t",
				"line: {tst comp.graphics.apps.pagemaker \
				 }{}\nCOMPADD:{}\nINSERT_POSITIONS:{32}\nline: {tst comp.graphics.apps.pagemaker \
				 ^[bc}{}\nline: {tst comp.graphics.apps.pagemaker ^[bc^Fg^F^Fa}{}",
			),
		],
	},
	Case {
		name:  "Documentation example using input c...pa\\tg\\t",
		steps: &[
			Eval(
				"compdef _tst tst ; _tst () { echo -n '<COMPADD>';compadd -M 'r:|.=* r:|=*'  - \
				 comp.sources.unix comp.sources.misc comp.graphics.algorithms comp.graphics.animation \
				 comp.graphics.api comp.graphics.apps comp.graphics.misc comp.graphics.packages \
				 comp.graphics.rendering comp.graphics.visualization comp.graphics.apps.alias \
				 comp.graphics.apps.gimp comp.graphics.apps.gnuplot comp.graphics.apps.lightwave \
				 comp.graphics.apps.pagemaker comp.graphics.apps.paint-shop-pro \
				 comp.graphics.apps.photoshop comp.graphics.apps.softimage comp.graphics.apps.ulead \
				 comp.graphics.rendering.misc comp.graphics.rendering.raytracing \
				 comp.graphics.rendering.renderman ; echo  -n '</COMPADD>'; ; echo -n \
				 '<INSERT_POSITIONS>'; echo $compstate[insert_positions]; echo -n \
				 '</INSERT_POSITIONS>'}",
			),
			Test(
				"tst c...pa\tg\t",
				"line: {tst comp.graphics.apps.pa}{}\nCOMPADD:{}\nINSERT_POSITIONS:{25}\nline: {tst \
				 comp.graphics.apps.pagemaker }{}\nCOMPADD:{}\nINSERT_POSITIONS:{32}",
			),
		],
	},
	Case {
		name:  "r:|[.,_-]=* should complete .c and .h",
		steps: &[
			Eval(
				"compdef _tst tst ; _tst () { echo -n '<COMPADD>';compadd -M 'r:|[.,_-]=* r:|=*'  - \
				 veryverylongfile.c veryverylongheader.h ; echo  -n '</COMPADD>'; ; echo -n \
				 '<INSERT_POSITIONS>'; echo $compstate[insert_positions]; echo -n \
				 '</INSERT_POSITIONS>'}",
			),
			Test(
				"tst  .c\t.h\t",
				"line: {tst  veryverylongfile.c }{}\nCOMPADD:{}\nINSERT_POSITIONS:{23}\nline: {tst  \
				 veryverylongfile.c veryverylongheader.h }{}\nCOMPADD:{}\nINSERT_POSITIONS:{44}",
			),
		],
	},
	Case {
		name:  "r:[^.,_-]||[.,_-]=* should not complete .c or .h, but should complete v.c and v.h",
		steps: &[
			Eval(
				"compdef _tst tst ; _tst () { echo -n '<COMPADD>';compadd -M 'r:[^.,_-]||[.,_-]=* \
				 r:|=*'  - veryverylongfile.c veryverylongheader.h ; echo  -n '</COMPADD>'; ; echo -n \
				 '<INSERT_POSITIONS>'; echo $compstate[insert_positions]; echo -n \
				 '</INSERT_POSITIONS>'}",
			),
			Test(
				"tst  .c\t^[bv\t.h\t^[bv\t",
				"line: {tst  veryverylongfile.c }{}\nCOMPADD:{}\nINSERT_POSITIONS:{23}\nline: {tst  \
				 veryverylongfile.c ^[bv}{}\nline: {tst  veryverylongfile.c ^[bv.hist}{}\nline: {tst  \
				 veryverylongfile.c ^[bv.hist^[bv}{}",
			),
		],
	},
	Case {
		name:  "Documentation example using \"r:|[A-Z0-9]=* r:|=*\", input H",
		steps: &[
			Eval(
				"compdef _tst tst ; _tst () { echo -n '<COMPADD>';compadd -M 'r:|[A-Z0-9]=* r:|=*'  - \
				 LikeTHIS FooHoo 5foo123 5bar234 ; echo  -n '</COMPADD>'; ; echo -n \
				 '<INSERT_POSITIONS>'; echo $compstate[insert_positions]; echo -n \
				 '</INSERT_POSITIONS>'}",
			),
			Test("tst H\t", "line: {tst H}{}\nCOMPADD:{}\nINSERT_POSITIONS:{}"),
		],
	},
	Case {
		name:  "Documentation example using \"r:|[A-Z0-9]=* r:|=*\", input 2",
		steps: &[
			Eval(
				"compdef _tst tst ; _tst () { echo -n '<COMPADD>';compadd -M 'r:|[A-Z0-9]=* r:|=*'  - \
				 LikeTHIS FooHoo 5foo123 5bar234 ; echo  -n '</COMPADD>'; ; echo -n \
				 '<INSERT_POSITIONS>'; echo $compstate[insert_positions]; echo -n \
				 '</INSERT_POSITIONS>'}",
			),
			Test("tst 2\t", "line: {tst 2}{}\nCOMPADD:{}\nINSERT_POSITIONS:{}"),
		],
	},
	Case {
		name:  "Documentation example using \"r:|[A-Z0-9]=** r:|=*\", input H",
		steps: &[
			Eval(
				"compdef _tst tst ; _tst () { echo -n '<COMPADD>';compadd -M 'r:|[A-Z0-9]=** r:|=*'  \
				 - LikeTHIS FooHoo 5foo123 5bar234 ; echo  -n '</COMPADD>'; ; echo -n \
				 '<INSERT_POSITIONS>'; echo $compstate[insert_positions]; echo -n \
				 '</INSERT_POSITIONS>'}",
			),
			Test(
				"tst H\t",
				"line: {tst H}{}\nCOMPADD:{}\nINSERT_POSITIONS:{4}\nNO:{FooHoo}\nNO:{LikeTHIS}",
			),
		],
	},
	Case {
		name:  "Documentation example using \"r:|[A-Z0-9]=** r:|=*\", input 2",
		steps: &[
			Eval(
				"compdef _tst tst ; _tst () { echo -n '<COMPADD>';compadd -M 'r:|[A-Z0-9]=** r:|=*'  \
				 - LikeTHIS FooHoo 5foo123 5bar234 ; echo  -n '</COMPADD>'; ; echo -n \
				 '<INSERT_POSITIONS>'; echo $compstate[insert_positions]; echo -n \
				 '</INSERT_POSITIONS>'}",
			),
			Test(
				"tst 2\t\t",
				"line: {tst 5}{23}\nCOMPADD:{}\nINSERT_POSITIONS:{5:7}\nline: {tst \
				 5}{23}\nCOMPADD:{}\nINSERT_POSITIONS:{5:7}\nNO:{5bar234}\nNO:{5foo123}",
			),
		],
	},
	Case {
		name:  "r:[^A-Z0-9]||[A-Z0-9]=** should not complete H, FH, 2 or 52, but should complete \
		        FoH and 5b2.",
		steps: &[
			Eval(
				"compdef _tst tst ; _tst () { echo -n '<COMPADD>';compadd -M \
				 'r:[^A-Z0-9]||[A-Z0-9]=** r:|=*'  - LikeTHIS FooHoo 5foo123 5bar234 ; echo  -n \
				 '</COMPADD>'; ; echo -n '<INSERT_POSITIONS>'; echo $compstate[insert_positions]; \
				 echo -n '</INSERT_POSITIONS>'}",
			),
			Test(
				"tst H\t^BF\to\t2\t^B5\tb\t",
				"line: {tst FooHoo }{}\nCOMPADD:{}\nINSERT_POSITIONS:{10}\nline: {tst FooHoo \
				 ^BF}{}\nCOMPADD:{}\nINSERT_POSITIONS:{}\nline: {tst FooHoo \
				 ^BFo}{}\nCOMPADD:{}\nINSERT_POSITIONS:{}\nline: {tst FooHoo \
				 ^BFo2}{}\nCOMPADD:{}\nINSERT_POSITIONS:{}\nline: {tst FooHoo \
				 ^BFo2^B5}{}\nCOMPADD:{}\nINSERT_POSITIONS:{}\nline: {tst FooHoo \
				 ^BFo2^B5b}{}\nCOMPADD:{}\nINSERT_POSITIONS:{}",
			),
		],
	},
	Case {
		name:  "r:?||[A-Z0-9]=* r:|=* should not complete H or 2, but should complete FH and 52.",
		steps: &[
			Eval(
				"compdef _tst tst ; _tst () { echo -n '<COMPADD>';compadd -M 'r:?||[A-Z0-9]=* r:|=*'  \
				 - LikeTHIS FooHoo 5foo123 5bar234 ; echo  -n '</COMPADD>'; ; echo -n \
				 '<INSERT_POSITIONS>'; echo $compstate[insert_positions]; echo -n \
				 '</INSERT_POSITIONS>'}",
			),
			Test(
				"tst H\t^BF2\t^B5\t",
				"line: {tst FooHoo }{}\nCOMPADD:{}\nINSERT_POSITIONS:{10}\nline: {tst FooHoo \
				 ^BF2}{}\nCOMPADD:{}\nINSERT_POSITIONS:{}\nline: {tst FooHoo \
				 ^BF2^B5}{}\nCOMPADD:{}\nINSERT_POSITIONS:{}",
			),
		],
	},
	Case {
		name:  "r:[^.]||.=* and l:.||[^.]=* should work symmetrically.",
		steps: &[
			Eval(
				"compdef _tst tst ; _tst () { echo -n '<COMPADD>';compadd -M 'r:[^.]||.=* \
				 l:.||[^.]=*'  -  ; echo  -n '</COMPADD>'; ; echo -n '<INSERT_POSITIONS>'; echo \
				 $compstate[insert_positions]; echo -n '</INSERT_POSITIONS>'}",
			),
			Test(
				"tst .^B\tpass^Fname\t",
				"line: {tst .^B}{}\nCOMPADD:{}\nINSERT_POSITIONS:{}\nline: {tst \
				 .^Bpass^Fname}{}\nCOMPADD:{}\nINSERT_POSITIONS:{}",
			),
		],
	},
	Case {
		name:  "Bug from workers 7311",
		steps: &[
			Eval(
				"compdef _tst tst ; _tst () { echo -n '<COMPADD>';compadd -M 'm:{a-z}={A-Z} \
				 r:|[.,_-]=* r:|=*'  - Abc-Def-Ghij.txt Abc-def.ghi.jkl_mno.pqr.txt \
				 Abc_def_ghi_jkl_mno_pqr.txt ; echo  -n '</COMPADD>'; ; echo -n '<INSERT_POSITIONS>'; \
				 echo $compstate[insert_positions]; echo -n '</INSERT_POSITIONS>'}",
			),
			Test("tst a-a\t", "line: {tst a-a}{}\nCOMPADD:{}\nINSERT_POSITIONS:{}"),
		],
	},
	Case {
		name:  "Bug from workers_7311 ",
		steps: &[
			Eval(
				"compdef _tst tst ; _tst () { echo -n '<COMPADD>';compadd -M 'm:{a-z}={A-Z} \
				 r:|[.,_-]=* r:|=*'  - Abc-Def-Ghij.txt Abc-def.ghi.jkl_mno.pqr.txt \
				 Abc_def_ghi_jkl_mno_pqr.txt ; echo  -n '</COMPADD>'; ; echo -n '<INSERT_POSITIONS>'; \
				 echo $compstate[insert_positions]; echo -n '</INSERT_POSITIONS>'}",
			),
			Test(
				"tst a\t\t-d.\t",
				"line: {tst Abc}{}\nCOMPADD:{}\nINSERT_POSITIONS:{7}\nline: {tst \
				 Abc}{}\nCOMPADD:{}\nINSERT_POSITIONS:{7}\nNO:{Abc-Def-Ghij.txt}\nNO:{Abc-def.ghi.\
				 jkl_mno.pqr.txt}\nNO:{Abc_def_ghi_jkl_mno_pqr.txt}\nline: {tst \
				 Abc-def.ghi.jkl_mno.pqr.txt }{}\nCOMPADD:{}\nINSERT_POSITIONS:{31}",
			),
		],
	},
	Case {
		name:  "Bug from workers 10886",
		steps: &[
			Eval(
				"compdef _tst tst ; _tst () { echo -n '<COMPADD>';compadd -M 'r:|[A-Z0-9]=* r:|=*'  - \
				 BW UWB W ; echo  -n '</COMPADD>'; ; echo -n '<INSERT_POSITIONS>'; echo \
				 $compstate[insert_positions]; echo -n '</INSERT_POSITIONS>'}",
			),
			Test("tst W\t", "line: {tst W }{}\nCOMPADD:{}\nINSERT_POSITIONS:{5}"),
		],
	},
	Case {
		name:  "Erratic completion bug from workers 11081: bui > build.out[] > build[.]out > \
		        build.out[] > build.out1[] > build.out2[]",
		steps: &[
			Eval(
				"compdef _tst tst ; _tst () { echo -n '<COMPADD>';compadd -M 'm:{a-zA-Z}={A-Za-z} \
				 r:|[.,_-]=* r:|=*'  - build.out build.out1 build.out2 ; echo  -n '</COMPADD>'; ; \
				 echo -n '<INSERT_POSITIONS>'; echo $compstate[insert_positions]; echo -n \
				 '</INSERT_POSITIONS>'}",
			),
			Test(
				"tst bui\t\t\t",
				"line: {tst build.out}{}\nCOMPADD:{}\nINSERT_POSITIONS:{13}\nline: {tst \
				 build.out}{}\nCOMPADD:{}\nINSERT_POSITIONS:{13}\nNO:{build.out}\nNO:{build.out1}\nNO:\
				 {build.out2}\nline: {tst build.out}{}\nCOMPADD:{}\nINSERT_POSITIONS:{13}",
			),
		],
	},
	Case {
		name:  "Non-bug from workers 11388",
		steps: &[
			Eval(
				"compdef _tst tst ; _tst () { echo -n '<COMPADD>';compadd -M 'r:|[:.]=* r:|=*'  - \
				 a.b:0 c.d:1 ; echo  -n '</COMPADD>'; ; echo -n '<INSERT_POSITIONS>'; echo \
				 $compstate[insert_positions]; echo -n '</INSERT_POSITIONS>'}",
			),
			Test("tst :\t", "line: {tst :}{}\nCOMPADD:{}\nINSERT_POSITIONS:{}"),
		],
	},
	Case {
		name:  "Non-bug from workers 11388",
		steps: &[
			Eval(
				"compdef _tst tst ; _tst () { echo -n '<COMPADD>';compadd -M 'r:|[:.]=** r:|=*'  - \
				 a.b:0 c.d:1 ; echo  -n '</COMPADD>'; ; echo -n '<INSERT_POSITIONS>'; echo \
				 $compstate[insert_positions]; echo -n '</INSERT_POSITIONS>'}",
			),
			Test("tst :\t", "line: {tst .:}{}\nCOMPADD:{}\nINSERT_POSITIONS:{4:5:6}"),
		],
	},
	Case {
		name:  "Disappearing characters bug from workers 11586: c00\\t -> c0[], c00\\t -> c0.abc[], \
		        c00.\\t -> c0.abc[]",
		steps: &[
			Eval(
				"compdef _tst tst ; _tst () { echo -n '<COMPADD>';compadd -M 'r:|.=** \
				 r:[^0-9]||[0-9]=**'  - c00.abc c01.abc.def.00.0 ; echo  -n '</COMPADD>'; ; echo -n \
				 '<INSERT_POSITIONS>'; echo $compstate[insert_positions]; echo -n \
				 '</INSERT_POSITIONS>'}",
			),
			Test(
				"tst c00\t.\ta\t",
				"line: {tst \
				 c00}{}\nCOMPADD:{}\nINSERT_POSITIONS:{6}\nNO:{c00.abc}\nNO:{c01.abc.def.00.0}\nline: \
				 {tst c00.}{}\nCOMPADD:{}\nINSERT_POSITIONS:{7:8}\nNO:{c00.abc}\nNO:{c01.abc.def.00.\
				 0}\nline: {tst c00.abc }{}\nCOMPADD:{}\nINSERT_POSITIONS:{11}",
			),
		],
	},
	Case {
		name:  "First test from workers 12995",
		steps: &[
			Eval(
				"compdef _tst tst ; _tst () { echo -n '<COMPADD>';compadd -M 'r:|/=* r:|=*'  - u1 \
				 u1/q1 u1/q1/e1 u2 u2/q1 u2/q1/e2 u2/q1/e2/a1 u2/q1/e2/a2 u3 u3/q1 u4 u4/q u4/q/a1 \
				 u4/q/a2 ; echo  -n '</COMPADD>'; ; echo -n '<INSERT_POSITIONS>'; echo \
				 $compstate[insert_positions]; echo -n '</INSERT_POSITIONS>'}",
			),
			Test("tst u/q/a\t", "line: {tst u4/q/a}{}\nCOMPADD:{}\nINSERT_POSITIONS:{10}"),
		],
	},
	Case {
		name:  "Second test from workers 12995",
		steps: &[
			Eval(
				"compdef _tst tst ; _tst () { echo -n '<COMPADD>';compadd -M 'm:{a-z}={A-Z} r:|/=* \
				 r:|=*'  - ../Completion/Core ../Completion/Commands ; echo  -n '</COMPADD>'; ; echo \
				 -n '<INSERT_POSITIONS>'; echo $compstate[insert_positions]; echo -n \
				 '</INSERT_POSITIONS>'}",
			),
			Test(
				"tst ../com/cor\x02\x02\x02\x02\x02\x02\x02\t",
				"line: {tst ../Completion/Core }{}\nCOMPADD:{}\nINSERT_POSITIONS:{22}",
			),
		],
	},
	Case {
		name:  "Incorrect cursor position bug from workers 13320: glibc-2.1\\t -> \
		        glibc-2[.]1.94-3.i386.rpm",
		steps: &[
			Eval(
				"compdef _tst tst ; _tst () { echo -n '<COMPADD>';compadd -M 'r:|[.,_-]=**'  - \
				 glibc-2.1.94-3.i386.rpm glibc-devel-2.1.94-3.i386.rpm \
				 glibc-profile-2.1.94-3.i386.rpm ; echo  -n '</COMPADD>'; ; echo -n \
				 '<INSERT_POSITIONS>'; echo $compstate[insert_positions]; echo -n \
				 '</INSERT_POSITIONS>'}",
			),
			Test(
				"tst glibc-2.1\t",
				"line: {tst glibc}{-2.1.94-3.i386.rpm}\nCOMPADD:{}\nINSERT_POSITIONS:{9:27}",
			),
		],
	},
	Case {
		name:  "Test from workers 13320",
		steps: &[
			Eval(
				"compdef _tst tst ; _tst () { echo -n '<COMPADD>';compadd -M 'r:|[.,_-]=**'  - \
				 glibc-2.1.94-3.i386.rpm glibc-devel-2.1.94-3.i386.rpm \
				 glibc-profile-2.1.94-3.i386.rpm ; echo  -n '</COMPADD>'; ; echo -n \
				 '<INSERT_POSITIONS>'; echo $compstate[insert_positions]; echo -n \
				 '</INSERT_POSITIONS>'}",
			),
			Test(
				"tst g-2\t",
				"line: {tst glibc}{-2.1.94-3.i386.rpm}\nCOMPADD:{}\nINSERT_POSITIONS:{9:27}",
			),
		],
	},
	Case {
		name:  "First test from workers 13345",
		steps: &[
			Eval(
				"compdef _tst tst ; _tst () { echo -n '<COMPADD>';compadd -M 'r:|[.,_-]=**'  - A.B.C \
				 A.B.C.D A.C ; echo  -n '</COMPADD>'; ; echo -n '<INSERT_POSITIONS>'; echo \
				 $compstate[insert_positions]; echo -n '</INSERT_POSITIONS>'}",
			),
			Test(
				"tst A.C\t",
				"line: {tst \
				 A.C}{}\nCOMPADD:{}\nINSERT_POSITIONS:{5:7}\nNO:{A.B.C}\nNO:{A.B.C.D}\nNO:{A.C}",
			),
		],
	},
	Case {
		name:  "Disappearing character bug from workers 13345: a-b_2\\t -> a-b__",
		steps: &[
			Eval(
				"compdef _tst tst ; _tst () { echo -n '<COMPADD>';compadd -M 'r:|[.,_-]=** \
				 r:|[0-9]=**'  - a-b_1_2_2 a-b_2_0.gz a-b_2_0.zip ; echo  -n '</COMPADD>'; ; echo -n \
				 '<INSERT_POSITIONS>'; echo $compstate[insert_positions]; echo -n \
				 '</INSERT_POSITIONS>'}",
			),
			Test("tst a-b_2\t", "line: {tst a-b_2_}{}\nCOMPADD:{}\nINSERT_POSITIONS:{8:10}"),
		],
	},
	Case {
		name:  "Test for insert positions",
		steps: &[
			Eval(
				"compdef _tst tst ; _tst () { echo -n '<COMPADD>';compadd -M 'r:|.=**'  - a.b.c \
				 a.b.c.d aA.bB.cB.dA aA.bB.cC.dD aD.bC.cB.dA aA.bC.cB.dA ; echo  -n '</COMPADD>'; ; \
				 echo -n '<INSERT_POSITIONS>'; echo $compstate[insert_positions]; echo -n \
				 '</INSERT_POSITIONS>'}",
			),
			Test(
				"tst a...\tA\tC\t",
				"line: {tst a.b.c.d}{}\nCOMPADD:{}\nINSERT_POSITIONS:{5:7:9:11}\nline: {tst \
				 a.b}{.cB.dA}\nCOMPADD:{}\nINSERT_POSITIONS:{5:7:13}\nline: {tst \
				 a}{.bC.cB.dA}\nCOMPADD:{}\nINSERT_POSITIONS:{5:14}\nNO:{aA.bC.cB.dA}\nNO:{aD.bC.cB.\
				 dA}",
			),
		],
	},
	Case {
		name:  "Test for wildcard left anchor with partial word right anchors",
		steps: &[
			Eval(
				"compdef _tst tst ; _tst () { echo -n '<COMPADD>';compadd -M 'r:|[-./_]=* r:|=* \
				 l:|=*'  - foo-bar-abc foo-bar-def foo-bar-ghi ; echo  -n '</COMPADD>'; ; echo -n \
				 '<INSERT_POSITIONS>'; echo $compstate[insert_positions]; echo -n \
				 '</INSERT_POSITIONS>'}",
			),
			Test("tst bar\t", "line: {tst foo-bar-}{}\nCOMPADD:{}\nINSERT_POSITIONS:{12}"),
		],
	},
];

const SUITE: Suite = Suite { file: "Y02compmatch.ztst", lang: "C", prep: PREP, cases: CASES };

/// Match Error for "z:"
#[test]
fn c001_match_error_for_z() {
	run_case(&SUITE, 0);
}

/// Match Error for "m:"
#[test]
fn c002_match_error_for_m() {
	run_case(&SUITE, 1);
}

/// Match Error for "M:"
#[test]
fn c003_match_error_for_m() {
	run_case(&SUITE, 2);
}

/// Match Error "r:"
#[test]
fn c004_match_error_r() {
	run_case(&SUITE, 3);
}

/// Match Error "R:"
#[test]
fn c005_match_error_r() {
	run_case(&SUITE, 4);
}

/// Match Error for "l:"
#[test]
fn c006_match_error_for_l() {
	run_case(&SUITE, 5);
}

/// Match Error for "L:"
#[test]
fn c007_match_error_for_l() {
	run_case(&SUITE, 6);
}

/// Match Error for "m:{0-9"
#[test]
fn c008_match_error_for_m_0_9() {
	run_case(&SUITE, 7);
}

/// Match Error for "m:{0-9}"
#[test]
fn c009_match_error_for_m_0_9() {
	run_case(&SUITE, 8);
}

/// Match Error for "m:{0-9}={"
#[test]
fn c010_match_error_for_m_0_9() {
	run_case(&SUITE, 9);
}

/// Match Error for "m:{0-9}={0-"
#[test]
fn c011_match_error_for_m_0_9_0() {
	run_case(&SUITE, 10);
}

/// Match Error for "m:{0-9}={-"
#[test]
fn c012_match_error_for_m_0_9() {
	run_case(&SUITE, 11);
}

/// Match Error "r:"
#[test]
fn c013_match_error_r() {
	run_case(&SUITE, 12);
}

/// Documentation example for options, input "nolistbee"
#[test]
fn c014_documentation_example_for_options_input_nolistbee() {
	run_case(&SUITE, 13);
}

/// Documentation example for options, input "list_bee"
#[test]
fn c015_documentation_example_for_options_input_list_bee() {
	run_case(&SUITE, 14);
}

/// Documentation example for options, input "ListBee"
#[test]
fn c016_documentation_example_for_options_input_listbee() {
	run_case(&SUITE, 15);
}

/// Documentation example for options, input "NOList"
#[test]
fn c017_documentation_example_for_options_input_nolist() {
	run_case(&SUITE, 16);
}

/// Documentation example for options, input "NO_List\t__\tB\t"
#[test]
fn c018_documentation_example_for_options_input_no_list_t_tb_t() {
	run_case(&SUITE, 17);
}

/// Documentation example for options, input "__\tN\t__o\t___\tlist_\tbeep__\t"
#[test]
fn c019_documentation_example_for_options_input_tn_t_o_t_tlist_tbeep() {
	run_case(&SUITE, 18);
}

/// Documentation example for options, input "__\tNo\t___\tlist_\tbeep__\t"
#[test]
fn c020_documentation_example_for_options_input_tno_t_tlist_tbeep_t() {
	run_case(&SUITE, 19);
}

/// Documentation example for options, input "___\tlist_\tbeep__\t"
#[test]
fn c021_documentation_example_for_options_input_tlist_tbeep_t() {
	run_case(&SUITE, 20);
}

/// Documentation example for options, input "__no_listbe"
#[test]
fn c022_documentation_example_for_options_input_no_listbe() {
	run_case(&SUITE, 21);
}

/// Documentation example for options, input "nonono_listbe"
#[test]
fn c023_documentation_example_for_options_input_nonono_listbe() {
	run_case(&SUITE, 22);
}

/// Documentation example for lowercase insenitive M, input "ab\tC\t"
#[test]
fn c024_documentation_example_for_lowercase_insenitive_m_input_ab_tc() {
	run_case(&SUITE, 23);
}

/// Documentation example for lowercase insenitive m, input "A\t\t"
#[test]
fn c025_documentation_example_for_lowercase_insenitive_m_input_a_t_t() {
	run_case(&SUITE, 24);
}

/// Documentation example for case insenitive M, input "aB\t\t"
#[test]
fn c026_documentation_example_for_case_insenitive_m_input_ab_t_t() {
	run_case(&SUITE, 25);
}

/// Documentation example for case insenitive m, input "aB\t\t"
#[test]
fn c027_documentation_example_for_case_insenitive_m_input_ab_t_t() {
	run_case(&SUITE, 26);
}

/// r:|.=* should complete .s.u
#[test]
fn c028_r_should_complete_s_u() {
	run_case(&SUITE, 27);
}

/// r:[^.]||.=* should not complete .s.u, but should complete c.s.u (zsh 5.9
/// itself fails upstream's expectation: `f` flag; pinned to its actual report)
#[test]
fn c029_r_should_not_complete_s_u_but_should_complete_c_s_u() {
	run_case(&SUITE, 28);
}

/// r:|.=* should complete .g.
#[test]
fn c030_r_should_complete_g() {
	run_case(&SUITE, 29);
}

/// r:[^.]||.=* should not complete .g., but should complete c.g. (zsh 5.9
/// itself fails upstream's expectation: `f` flag; pinned to its actual report)
#[test]
fn c031_r_should_not_complete_g_but_should_complete_c_g() {
	run_case(&SUITE, 30);
}

/// r:|.=* should complete ...pag
#[test]
fn c032_r_should_complete_pag() {
	run_case(&SUITE, 31);
}

/// r:[^.]||.=* should not complete ...pag or c...pag, but should complete
/// c.g.a.p (zsh 5.9 itself fails upstream's expectation: `f` flag; pinned to
/// its actual report)
#[test]
fn c033_r_should_not_complete_pag_or_c_pag_but_should_complete_c_g_a() {
	run_case(&SUITE, 32);
}

/// Documentation example using input c...pa\tg\t
#[test]
fn c034_documentation_example_using_input_c_pa_tg_t() {
	run_case(&SUITE, 33);
}

/// r:|[.,_-]=* should complete .c and .h
#[test]
fn c035_r_should_complete_c_and_h() {
	run_case(&SUITE, 34);
}

/// r:[^.,_-]||[.,_-]=* should not complete .c or .h, but should complete v.c
/// and v.h (zsh 5.9 itself fails upstream's expectation: `f` flag; pinned to
/// its actual report)
#[test]
fn c036_r_should_not_complete_c_or_h_but_should_complete_v_c_and_v_h() {
	run_case(&SUITE, 35);
}

/// Documentation example using "r:|[A-Z0-9]=* r:|=*", input H
#[test]
fn c037_documentation_example_using_r_a_z0_9_r_input_h() {
	run_case(&SUITE, 36);
}

/// Documentation example using "r:|[A-Z0-9]=* r:|=*", input 2
#[test]
fn c038_documentation_example_using_r_a_z0_9_r_input_2() {
	run_case(&SUITE, 37);
}

/// Documentation example using "r:|[A-Z0-9]=** r:|=*", input H
#[test]
fn c039_documentation_example_using_r_a_z0_9_r_input_h() {
	run_case(&SUITE, 38);
}

/// Documentation example using "r:|[A-Z0-9]=** r:|=*", input 2
#[test]
fn c040_documentation_example_using_r_a_z0_9_r_input_2() {
	run_case(&SUITE, 39);
}

/// r:[^A-Z0-9]||[A-Z0-9]=** should not complete H, FH, 2 or 52, but should
/// complete FoH and 5b2. (zsh 5.9 itself fails upstream's expectation: `f`
/// flag; pinned to its actual report)
#[test]
fn c041_r_a_z0_9_a_z0_9_should_not_complete_h_fh_2_or_52_but_should() {
	run_case(&SUITE, 40);
}

/// r:?||[A-Z0-9]=* r:|=* should not complete H or 2, but should complete FH and
/// 52. (zsh 5.9 itself fails upstream's expectation: `f` flag; pinned to its
/// actual report)
#[test]
fn c042_r_a_z0_9_r_should_not_complete_h_or_2_but_should_complete_fh() {
	run_case(&SUITE, 41);
}

/// r:[^.]||.=* and l:.||[^.]=* should work symmetrically. (zsh 5.9 itself fails
/// upstream's expectation: `f` flag; pinned to its actual report)
#[test]
fn c043_r_and_l_should_work_symmetrically() {
	run_case(&SUITE, 42);
}

/// Bug from workers 7311
#[test]
fn c044_bug_from_workers_7311() {
	run_case(&SUITE, 43);
}

/// Bug from workers_7311
#[test]
fn c045_bug_from_workers_7311() {
	run_case(&SUITE, 44);
}

/// Bug from workers 10886
#[test]
fn c046_bug_from_workers_10886() {
	run_case(&SUITE, 45);
}

/// Erratic completion bug from workers 11081: bui > build.out[] > build[.]out >
/// build.out[] > build.out1[] > build.out2[]
#[test]
fn c047_erratic_completion_bug_from_workers_11081_bui_build_out_buil() {
	run_case(&SUITE, 46);
}

/// Non-bug from workers 11388
#[test]
fn c048_non_bug_from_workers_11388() {
	run_case(&SUITE, 47);
}

/// Non-bug from workers 11388
#[test]
fn c049_non_bug_from_workers_11388() {
	run_case(&SUITE, 48);
}

/// Disappearing characters bug from workers 11586: c00\t -> c0[], c00\t ->
/// c0.abc[], c00.\t -> c0.abc[]
#[test]
fn c050_disappearing_characters_bug_from_workers_11586_c00_t_c0_c00() {
	run_case(&SUITE, 49);
}

/// First test from workers 12995
#[test]
fn c051_first_test_from_workers_12995() {
	run_case(&SUITE, 50);
}

/// Second test from workers 12995
#[test]
fn c052_second_test_from_workers_12995() {
	run_case(&SUITE, 51);
}

/// Incorrect cursor position bug from workers 13320: glibc-2.1\t ->
/// glibc-2[.]1.94-3.i386.rpm
#[test]
fn c053_incorrect_cursor_position_bug_from_workers_13320_glibc_2_1_t() {
	run_case(&SUITE, 52);
}

/// Test from workers 13320
#[test]
fn c054_test_from_workers_13320() {
	run_case(&SUITE, 53);
}

/// First test from workers 13345
#[test]
fn c055_first_test_from_workers_13345() {
	run_case(&SUITE, 54);
}

/// Disappearing character bug from workers 13345: a-b_2\t -> a-b__
#[test]
fn c056_disappearing_character_bug_from_workers_13345_a_b_2_t_a_b() {
	run_case(&SUITE, 55);
}

/// Test for insert positions
#[test]
fn c057_test_for_insert_positions() {
	run_case(&SUITE, 56);
}

/// Test for wildcard left anchor with partial word right anchors
#[test]
fn c058_test_for_wildcard_left_anchor_with_partial_word_right_anchor() {
	run_case(&SUITE, 57);
}
