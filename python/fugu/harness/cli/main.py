from pathlib import Path

import typer

from harness.cli.calibrate_verifier import calibrate_verifier
from harness.cli.compare import compare_candidates
from harness.cli.evaluate_synthesizer import evaluate_synthesizer
from harness.cli.evaluate_verifier import evaluate_verifier
from harness.cli.fugu_app import app as fugu_app
from harness.cli.improve_verifier import improve_verifier
from harness.cli.inspect import grep as grep_runs
from harness.cli.inspect import inspect_run
from harness.cli.optimize import optimize
from harness.cli.promote import promote
from harness.cli.rqgm import app as rqgm_app
from harness.cli.run_eval import run_eval
from harness.cli.run_task import run_task
from harness.cli.verifier_fusion import fusion as verifier_fusion
from harness.core.task_contract import load_task_contract
from harness.experience.sqlite_store import SQLiteIndex
app = typer.Typer(no_args_is_help=True)


@app.command("validate-task")
def validate_task(task: Path = typer.Argument(..., exists=True, readable=True)) -> None:
    contract = load_task_contract(task, Path.cwd())
    typer.echo(contract.model_dump_json(indent=2))

app.command("run-task")(run_task)
app.command("run-eval")(run_eval)
app.command("optimize")(optimize)
app.command("improve-verifier")(improve_verifier)
app.command("evaluate-verifier")(evaluate_verifier)
app.command("evaluate-synthesizer")(evaluate_synthesizer)
app.command("promote")(promote)
inspect_app = typer.Typer()
inspect_app.command("run")(inspect_run)
app.add_typer(inspect_app, name="inspect")

compare_app = typer.Typer()
compare_app.command("candidate")(compare_candidates)
app.add_typer(compare_app, name="compare")

verifier_app = typer.Typer(no_args_is_help=True)
verifier_app.command("fusion")(verifier_fusion)
verifier_app.command("calibrate")(calibrate_verifier)
app.add_typer(verifier_app, name="verifier")
app.add_typer(fugu_app, name="fugu")
app.add_typer(rqgm_app, name="rqgm")


@app.command("failures")
def failures(type: str = typer.Option(..., "--type"), limit: int = typer.Option(20, "--limit")) -> None:
    for row in SQLiteIndex().failures(type, limit):
        typer.echo(row)


@app.command("frontier")
def frontier(metric: str = typer.Option("final_score", "--metric")) -> None:
    for row in SQLiteIndex().frontier():
        typer.echo(row)


@app.command("grep")
def grep_cmd(pattern: str, root: Path = Path("runs")) -> None:
    grep_runs(pattern, root)


if __name__ == "__main__":
    app()
