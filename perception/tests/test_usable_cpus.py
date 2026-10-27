"""
How many cores this process may actually use.

The bug this guards against is invisible from inside: `os.cpu_count()`
reports the machine, so a container given sixteen cores on a host with a
hundred and ninety-two starts a hundred and ninety-two threads and gets
slower. Measured on a Nebius endpoint it came out at 208 ms a frame,
against 195 on a four-thread laptop - more hardware, less throughput, and
nothing in the logs to say why.
"""

from __future__ import annotations

import os
from pathlib import Path

from pact_perception import embed


def test_a_cgroup_v2_quota_wins_over_the_machine(tmp_path, monkeypatch) -> None:
    # 1.6 seconds of CPU per 0.1 second period is sixteen cores, however
    # many the host happens to have.
    quota = tmp_path / "cpu.max"
    quota.write_text("1600000 100000")
    real = Path

    def fake(p: str) -> Path:
        return quota if p == "/sys/fs/cgroup/cpu.max" else real(p)

    monkeypatch.setattr(embed, "Path", fake)
    assert embed.usable_cpus() == 16


def test_an_unlimited_cgroup_falls_through(tmp_path, monkeypatch) -> None:
    # "max" means no quota, so the answer has to come from somewhere else
    # rather than being read as a core count.
    quota = tmp_path / "cpu.max"
    quota.write_text("max 100000")
    real = Path
    monkeypatch.setattr(
        embed, "Path", lambda p: quota if p == "/sys/fs/cgroup/cpu.max" else real(p)
    )
    assert embed.usable_cpus() >= 1
    assert embed.usable_cpus() <= (os.cpu_count() or 1)


def test_a_fractional_quota_is_still_at_least_one(tmp_path, monkeypatch) -> None:
    # Half a core is a real allocation. Rounding it to zero would hand torch
    # set_num_threads(0), which is not a thread count.
    quota = tmp_path / "cpu.max"
    quota.write_text("50000 100000")
    real = Path
    monkeypatch.setattr(
        embed, "Path", lambda p: quota if p == "/sys/fs/cgroup/cpu.max" else real(p)
    )
    assert embed.usable_cpus() == 1


def test_without_a_cgroup_it_is_the_machine() -> None:
    # A laptop or a bare-metal box: nothing is limiting the process, and
    # every source agrees.
    n = embed.usable_cpus()
    assert 1 <= n <= (os.cpu_count() or 1)
