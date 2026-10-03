"""Exercise native CI pytest and require its live per-phase diagnostics."""

import io
import json
import os
import re
import selectors
import shlex
import signal
import socket
import subprocess
import sys
from pathlib import Path

import pytest


def _run_controlled_pytest(tmp_path, arguments, repository, test_source, controller_hook=None, synchronize=True):
    listener = socket.socket()
    listener.bind(("127.0.0.1", 0))
    listener.listen()
    host, port = listener.getsockname()
    (tmp_path / "test_controlled_phase.py").write_text(test_source)
    hook = ""
    if controller_hook:
        hook = f"\n{controller_hook}\n"
    (tmp_path / "conftest.py").write_text(
        "import os, socket\n"
        "def _notify(event, wait=False):\n"
        "    connection = socket.create_connection((os.environ['PHASE_SYNC_HOST'], int(os.environ['PHASE_SYNC_PORT'])))\n"
        "    connection.sendall((event + '\\n').encode())\n"
        "    if wait:\n"
        "        connection.recv(1)\n"
        "    connection.close()\n" + hook
    )
    environment = {
        **os.environ,
        "PYTHONPATH": os.pathsep.join(filter(None, [str(repository / "backend"), os.environ.get("PYTHONPATH")])),
        "PYTEST_ADDOPTS": "",
        "PYTEST_PLUGINS": "pytest_native_phase_diagnostics",
        "PHASE_SYNC_HOST": host,
        "PHASE_SYNC_PORT": str(port),
    }
    for name in ("PYTEST_XDIST_TESTRUNUID", "PYTEST_XDIST_WORKER", "PYTEST_XDIST_WORKER_COUNT"):
        environment.pop(name, None)
    process = subprocess.Popen(
        [sys.executable, "-m", "pytest", *arguments, "-n", "1", "--dist=load", "-vv"],
        cwd=tmp_path,
        env=environment,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        start_new_session=True,
    )
    accepted = []
    try:
        if not synchronize:
            output, _ = process.communicate()
            return process.returncode, output
        events = {}
        output = bytearray()
        with selectors.DefaultSelector() as selector:
            selector.register(listener, selectors.EVENT_READ, "sync")
            selector.register(process.stdout, selectors.EVENT_READ, "stdout")
            while len(events) < 2:
                for ready, _ in selector.select():
                    if ready.data == "stdout":
                        chunk = os.read(process.stdout.fileno(), io.DEFAULT_BUFFER_SIZE)
                        if not chunk:
                            raise AssertionError("pytest subprocess ended before synchronization completed")
                        output.extend(chunk)
                        continue
                    connection, _ = listener.accept()
                    accepted.append(connection)
                    line = bytearray()
                    while not line.endswith(b"\n"):
                        chunk = connection.recv(1)
                        if not chunk:
                            raise AssertionError("synchronization peer closed before sending its event")
                        line.extend(chunk)
                    events[line.decode().strip()] = connection
        assert set(events) == {"setup-report-processed", "call-blocked"}, set(events)
        with selectors.DefaultSelector() as selector:
            selector.register(process.stdout, selectors.EVENT_READ)
            while selector.select(0):
                chunk = os.read(process.stdout.fileno(), io.DEFAULT_BUFFER_SIZE)
                if not chunk:
                    break
                output.extend(chunk)
        records = [
            json.loads(line.removeprefix("NATIVE_PHASE "))
            for line in output.decode().splitlines()
            if line.startswith("NATIVE_PHASE ")
        ]
        assert any(
            record["nodeid"] == "test_controlled_phase.py::test_waits_for_release" and record["phase"] == "setup"
            for record in records
        ), output.decode(errors="replace")
        events["call-blocked"].sendall(b"x")
        remainder, _ = process.communicate()
        return process.returncode, output + remainder
    finally:
        for connection in accepted:
            try:
                connection.sendall(b"x")
            except OSError:
                pass
            connection.close()
        listener.close()
        if process.poll() is None:
            os.killpg(process.pid, signal.SIGKILL)
            process.wait()


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


def test_phase_record_is_visible_before_blocked_call_is_released(tmp_path):
    repository = Path(os.environ.get("TEST_REPOSITORY_ROOT", Path(__file__).resolve().parents[3]))
    controller_hook = (
        "import pytest\n"
        "@pytest.hookimpl(hookwrapper=True, tryfirst=True)\n"
        "def pytest_runtest_logreport(report):\n"
        "    yield\n"
        "    if report.when == 'setup' and not os.environ.get('PYTEST_XDIST_WORKER'):\n"
        "        _notify('setup-report-processed')\n"
    )
    source = "from conftest import _notify\ndef test_waits_for_release():\n    _notify('call-blocked', wait=True)\n"
    result = _run_controlled_pytest(tmp_path, [], repository, source, controller_hook)
    assert result[0] == 0, result[1].decode(errors="replace")


def test_worker_crash_preserves_pytest_tests_failed_exit(tmp_path):
    repository = Path(os.environ.get("TEST_REPOSITORY_ROOT", Path(__file__).resolve().parents[3]))
    source = "import os, pytest\ndef test_worker_crash():\n    os._exit(pytest.ExitCode.TESTS_FAILED)\n"
    code, output = _run_controlled_pytest(tmp_path, [], repository, source, synchronize=False)
    rendered = output.decode(errors="replace")
    assert code == pytest.ExitCode.TESTS_FAILED, rendered
    assert "crashed while running 'test_controlled_phase.py::test_worker_crash'" in rendered, rendered
    assert "INTERNALERROR" not in rendered, rendered
    assert "no worker ID" not in rendered, rendered
