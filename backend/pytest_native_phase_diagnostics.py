"""Print native CI pytest phase timings as reports reach the controller."""

import json
import os

import pytest

_config = None


def pytest_configure(config):
    global _config
    _config = config


@pytest.hookimpl(trylast=True)
def pytest_runtest_logreport(report):
    if os.environ.get("PYTEST_XDIST_WORKER"):
        return

    terminal_reporter = _config.pluginmanager.getplugin("terminalreporter")
    worker = getattr(report, "worker_id", None)
    if worker is None:
        worker = getattr(getattr(report, "node", None), "workerid", None)
    if worker is None:
        raise RuntimeError("xdist phase report has no worker ID")
    record = {
        "nodeid": report.nodeid,
        "phase": report.when,
        "duration": report.duration,
        "worker": worker,
    }
    terminal_reporter.write_line(f"NATIVE_PHASE {json.dumps(record, separators=(',', ':'))}")
