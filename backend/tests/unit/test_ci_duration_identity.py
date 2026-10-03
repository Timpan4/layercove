"""Exercise the native CI collector against a timing map with real node IDs."""

import json
import os
import re
import shlex
import subprocess
import sys
from pathlib import Path


def test_native_ci_shards_use_recorded_duration_nodeids(tmp_path):
    repository = Path(os.environ.get("TEST_REPOSITORY_ROOT", Path(__file__).resolve().parents[3]))
    workflow = (repository / ".github/workflows/ci.yml").read_text()
    job_match = re.search(r"^  backend-tests:\n(.*?)(?=^  [\w-]+:|\Z)", workflow, re.M | re.S)
    assert job_match is not None
    job = job_match.group(1)
    matrix_match = re.search(r"shard: (\[[^\n]+\])", job)
    command_match = re.search(r"^        run: \|\n((?:          [^\n]*\n)+)", job, re.M)
    assert matrix_match is not None and command_match is not None
    shards = json.loads(matrix_match.group(1))
    command = "\n".join(line[10:] for line in command_match.group(1).splitlines()).replace("\\\n", "")
    command = next(line for line in command.splitlines() if line.startswith("python -m pytest "))

    # Match the repository/backend/tests layout that establishes pytest's root.
    (tmp_path / "pytest.ini").write_text("[pytest]\n")
    backend = tmp_path / "backend"
    tests = backend / "tests"
    tests.mkdir(parents=True)
    names = [f"test_duration_identity_{shard}" for shard in shards]
    (tests / "test_duration_identity_fixture.py").write_text("\n".join(f"def {name}():\n    pass\n" for name in names))
    recorded = json.loads((repository / "backend/.test_durations").read_text())
    timings = {
        f"test_duration_identity_fixture.py::{name}": duration
        for name, duration in zip(names, recorded.values(), strict=False)
    }
    (backend / ".test_durations").write_text(json.dumps(timings))
    selected_across_shards = []
    for shard in shards:
        arguments = shlex.split(command.replace("${{ matrix.shard }}", str(shard)))[3:]
        # Collection does not need execution workers or per-test timeout plugins.
        worker_option = arguments.index("-n")
        del arguments[worker_option : worker_option + 2]
        arguments = [argument for argument in arguments if not argument.startswith("--timeout")]
        result = subprocess.run(
            [
                sys.executable,
                "-m",
                "pytest",
                "-p",
                "pytest_split.plugin",
                *arguments,
                "--collect-only",
                "--verbosity=-1",
            ],
            cwd=backend,
            env={
                **os.environ,
                "PYTHONPATH": os.pathsep.join(filter(None, [str(repository / "backend"), os.environ.get("PYTHONPATH")])),
                "PYTEST_DISABLE_PLUGIN_AUTOLOAD": "1",
                "PYTEST_ADDOPTS": "",
            },
            capture_output=True,
            text=True,
            check=False,
        )
        assert result.returncode == 0, result.stdout + result.stderr
        selected = [line for line in result.stdout.splitlines() if ".py::test_duration_identity_" in line]
        assert selected and all(nodeid in timings for nodeid in selected), result.stdout
        expected_duration = sum(timings[nodeid] for nodeid in selected)
        assert f"estimated duration: {expected_duration:.2f}s" in result.stdout, result.stdout
        selected_across_shards.extend(selected)
    assert sorted(selected_across_shards) == sorted(timings)
