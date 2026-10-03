"""Exercise native CI pytest and require its live per-phase diagnostics."""

import json
import os
import re
import shlex
import subprocess
import sys
from pathlib import Path


def test_native_ci_pytest_emits_phase_records(tmp_path):
    repository = Path(os.environ.get("TEST_REPOSITORY_ROOT", Path(__file__).resolve().parents[3]))
    workflow = (repository / ".github/workflows/ci.yml").read_text()
    job_match = re.search(r"^  backend-tests:\n(.*?)(?=^  [\w-]+:|\Z)", workflow, re.M | re.S)
    assert job_match is not None
    command_match = re.search(r"^        run: \|\n((?:          [^\n]*\n)+)", job_match.group(1), re.M)
    assert command_match is not None
    command = " ".join(line[10:].rstrip("\\").strip() for line in command_match.group(1).splitlines())
    pytest_command = "python -m pytest " + command.split("python -m pytest ", 1)[1]
    pytest_command = pytest_command.replace("${{ matrix.shard }}", "4")
    arguments = shlex.split(pytest_command)[3:]
    arguments[arguments.index("-n") + 1] = "2"  # Match the two workers assigned in the saved native run.
    group_index = arguments.index("--group")

    tests = tmp_path / "tests"
    tests.mkdir()
    test_names = [f"test_phase_record_{index}" for index in range(4)]
    (tests / "test_phase_records.py").write_text("\n".join(f"def {name}():\n    pass\n" for name in test_names))
    duration_map = {f"test_phase_records.py::{name}": 1.0 for name in test_names}
    (tmp_path / ".test_durations").write_text(json.dumps(duration_map))

    phase_records = []
    for shard in range(1, 5):
        shard_arguments = arguments.copy()
        shard_arguments[group_index + 1] = str(shard)
        environment = {
            **os.environ,
            "PYTHONPATH": os.pathsep.join(filter(None, [str(repository / "backend"), os.environ.get("PYTHONPATH")])),
            "PYTEST_ADDOPTS": "",
        }
        for name in ("PYTEST_XDIST_TESTRUNUID", "PYTEST_XDIST_WORKER", "PYTEST_XDIST_WORKER_COUNT"):
            environment.pop(name, None)
        result = subprocess.run(
            [sys.executable, "-m", "pytest", *shard_arguments],
            cwd=tmp_path,
            capture_output=True,
            text=True,
            check=False,
            env=environment,
        )
        assert result.returncode == 0, f"{shard_arguments!r}\n{result.stdout}{result.stderr}"
        phase_records.extend(
            json.loads(line.removeprefix("NATIVE_PHASE "))
            for line in result.stdout.splitlines()
            if line.startswith("NATIVE_PHASE ")
        )

    expected = {
        (f"test_phase_records.py::{name}", phase) for name in test_names for phase in ("setup", "call", "teardown")
    }
    actual = {(record["nodeid"], record["phase"]) for record in phase_records}
    assert actual == expected, f"missing={sorted(expected - actual)!r}; extra={sorted(actual - expected)!r}"
    assert len(phase_records) == len(expected)
    assert all(isinstance(record["duration"], (int, float)) for record in phase_records)
    assert all(record["worker"].startswith("gw") for record in phase_records), phase_records
