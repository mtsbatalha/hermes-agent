"""Deterministic repro: does the gateway die after the client's socket drops mid-turn?

This drives the *real* `hermes serve` backend over the *real* Desktop wire protocol
(newline JSON-RPC on /api/ws), because that is the only path that exercises the WS
transport, the session lifetime, and the orphan reaper exactly as the product does.

The client here is the same one the terminal-lane E2E suites use:
``tests/e2e/core/terminal/_gateway_client.py`` (``Backend`` + ``WSClient``), whose
``drop()`` shuts the TCP stream down *without* a close frame -- a browser being
killed, not a polite ``websocket.close()``.

A wedged turn is guaranteed rather than hoped for: the loopback scripted provider
sends eight characters of an SSE answer and then goes silent forever
(``StallMidStream``), so the turn is provably in flight when the socket dies.

Run:
    python apps/desktop/spike/_gw_death_repro.py --mode stall --watch 200
    python apps/desktop/spike/_gw_death_repro.py --mode backpressure --watch 200
    python apps/desktop/spike/_gw_death_repro.py --mode clean --watch 60

Verdicts (exit code is always 0: survival is a result, not a failure):
    GATEWAY_DIED            the process exited (rc recorded, logs dumped)
    GATEWAY_STOPPED_ANSWERING  alive but HTTP stopped answering
    GATEWAY_SURVIVED        alive and answering for the whole watch window
"""

from __future__ import annotations

import argparse
import contextlib
import json
import os
import subprocess
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(REPO_ROOT))

from tests.e2e.core.terminal._gateway_client import Backend, WSClient, etype  # noqa: E402
from tests.fakes.fake_llm_provider import StallMidStream  # noqa: E402

ARTIFACTS = Path(__file__).resolve().parent / "artifacts"
REPORT = ARTIFACTS / "_gw-death-repro.json"


def identity_ok(port: int, token: str = "") -> tuple[bool, str]:
    """Liveness the way an operator would check it: HTTP on the serving port."""
    req = urllib.request.Request(f"http://127.0.0.1:{port}/api/host/identity")
    if token:
        req.add_header("X-Hermes-Session-Token", token)
    try:
        with urllib.request.urlopen(req, timeout=5) as resp:
            body = resp.read().decode("utf-8", "replace")
        return True, body[:400]
    except urllib.error.HTTPError as exc:
        return True, f"HTTPError {exc.code}"  # answered -> the listener is alive
    except Exception as exc:  # noqa: BLE001 - refused/reset/timeout all mean "not answering"
        return False, f"{type(exc).__name__}: {exc}"


def await_in_flight(client: WSClient, sid: str, timeout: float) -> dict:
    """Block until the turn is provably running server-side (a streamed delta)."""
    start = len(client.snapshot())
    return client.wait_for(
        lambda f: etype(f) == "message.delta" and (f.get("params") or {}).get("session_id") == sid,
        timeout=timeout, start=start, what=f"a message.delta for {sid} (turn in flight)")


def probe_new_client(backend: "Backend", step) -> dict:
    """Ask the gateway for NEW work over a brand-new socket, the way a reloaded Desktop does.

    HTTP liveness cannot see a gateway that still answers ``/api/host/identity`` but no longer
    accepts sessions; this can. Both halves -- a fresh ``session.create`` and a ``prompt.submit``
    that actually streams -- are timed and recorded, and any failure is captured rather than
    raised so the watch window can continue.
    """
    out: dict = {"attempted": True, "ok": False, "connectSeconds": None, "createSeconds": None,
                 "submitSeconds": None, "error": None}
    client = None
    try:
        t = time.monotonic()
        client = backend.connect("probe")
        out["connectSeconds"] = round(time.monotonic() - t, 2)
        t = time.monotonic()
        created = client.call("session.create", timeout=30, cols=100, source="desktop")
        out["createSeconds"] = round(time.monotonic() - t, 2)
        psid = created["session_id"]
        out["sessionId"] = psid
        t = time.monotonic()
        submitted = client.call("prompt.submit", timeout=30, session_id=psid, text="probe")
        out["submitSeconds"] = round(time.monotonic() - t, 2)
        out["submitStatus"] = submitted.get("status")
        # The scripted provider streams a few chars then wedges, so a delta is expected almost
        # immediately; its absence within a few seconds means the new socket is not being served.
        started = len(client.frames)
        delta = client.wait_for(lambda f: etype(f) == "message.delta", timeout=8)
        out["firstDeltaAfterStart"] = len(client.snapshot()) > started
        out["deltaSeen"] = etype(delta)
        out["ok"] = True
    except Exception as exc:  # noqa: BLE001 - a dead gateway is the finding, not an error
        out["error"] = f"{type(exc).__name__}: {exc}"
    finally:
        if client is not None:
            try:
                client.close()
            except Exception:  # noqa: BLE001
                pass
    step("probe_result", ok=out["ok"], error=out["error"],
         connect=out["connectSeconds"], submit=out["submitSeconds"])
    return out


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--mode", choices=("stall", "backpressure", "clean", "orphan"), default="stall",
                    help="stall: wedged turn then drop | backpressure: stop reading then drop | "
                         "orphan: drop then kill the watch-parent (Desktop/browser) so the "
                         "parent-death watchdog fires | clean: drop with no turn (control)")
    ap.add_argument("--parent-kill-at", type=float, default=1.0,
                    help="orphan mode: seconds after the drop to kill the watch-parent")
    ap.add_argument("--watch", type=float, default=200.0, help="seconds to watch for death after the drop")
    ap.add_argument("--probe-at", type=float, default=10.0,
                    help="seconds after the drop to ask the gateway for new work on a new socket")
    ap.add_argument("--grace", type=float, default=None,
                    help="HERMES_TUI_WS_ORPHAN_REAP_GRACE_S override (default: prod 20s)")
    ap.add_argument("--tag", default=None, help="artifact suffix")
    args = ap.parse_args()

    tag = args.tag or args.mode
    root = Path(os.environ.get("TEMP", "/tmp")) / f"gw-death-{tag}"
    root.mkdir(parents=True, exist_ok=True)

    # The shared fixture's minimal env is POSIX-shaped: it sets HOME and drops USERPROFILE, and
    # Windows resolves ~ from USERPROFILE (plus TMP/TEMP for tempfile), so the child would refuse
    # to start with "Could not determine home directory". Pin the Windows equivalents at the same
    # sandbox home the fixture uses.
    sandbox_home = root / "home"
    extra_env = {
        "USERPROFILE": str(sandbox_home), "HOMEDRIVE": sandbox_home.drive or "C:",
        "HOMEPATH": str(sandbox_home)[2:] if len(str(sandbox_home)) > 2 else "\\",
        "TEMP": str(root / "tmp"), "TMP": str(root / "tmp"),
    }
    (root / "tmp").mkdir(parents=True, exist_ok=True)
    if args.grace is not None:
        extra_env["HERMES_TUI_WS_ORPHAN_REAP_GRACE_S"] = str(args.grace)
        extra_env["HERMES_TUI_WS_ORPHAN_ACTIVITY_STALE_S"] = "0"

    # orphan mode: give the backend a watch-parent (the Desktop's Electron PID in production) via
    # HERMES_PARENT_PID, so killing it arms the real parent-death watchdog. PID-only probing (no
    # marker/nonce) is the older-Desktop contract and needs just the PID.
    watch_parent = None
    if args.mode == "orphan":
        watch_parent = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(3600)"],
                                        stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                                        stderr=subprocess.DEVNULL)
        extra_env["HERMES_PARENT_PID"] = str(watch_parent.pid)

    backend = Backend(root, [StallMidStream(text="partial answer that never finishes", after_chars=8,
                                            seconds=3600.0)], env=extra_env)
    record: dict = {
        "mode": args.mode, "watchSeconds": args.watch, "startedAt": time.strftime("%Y-%m-%dT%H:%M:%S"),
        "root": str(root), "graceOverride": args.grace, "steps": [], "timeline": [],
    }
    verdict = "INCONCLUSIVE"

    def step(name: str, **detail) -> None:
        record["steps"].append({"at": round(time.monotonic() - t0, 2), "step": name, **detail})
        print(f"[{round(time.monotonic() - t0, 2):7.2f}s] {name} {detail or ''}", flush=True)

    t0 = time.monotonic()
    backend.start(timeout=120)
    port, proc = backend.port, backend.proc
    record.update({"port": port, "gatewayPid": proc.pid, "wsUrl": backend.ws_url})
    step("backend_ready", port=port, pid=proc.pid)

    ok, body = identity_ok(port, backend.token)
    step("identity_before", ok=ok, body=body)

    client = backend.connect("A")
    created = client.call("session.create", cols=100, source="desktop")
    sid, key = created["session_id"], created.get("stored_session_id")
    step("session_created", sid=sid, stored=key)

    if args.mode != "clean":
        submitted = client.call("prompt.submit", session_id=sid, text="write a long essay please")
        step("prompt_submitted", status=submitted.get("status"))
        delta = await_in_flight(client, sid, timeout=90)
        step("turn_in_flight", event=etype(delta), chars=len(str((delta.get("params") or {}).get("text") or "")))

    if args.mode == "backpressure":
        # Stop consuming: the backend's send queue fills, TCP backpressures, and the transport's
        # write timeout / send deadline is what should (or should not) close the socket.
        client.pause()
        step("client_paused", seconds=35)
        time.sleep(35)

    dropped_at = time.monotonic()
    client.drop()
    step("socket_dropped", abrupt=True)

    if args.mode == "orphan":
        # The browser/Desktop that owns the backend closes. Its PID disappears; the armed
        # parent-death watchdog notices on its next poll and asks this backend to shut down.
        time.sleep(args.parent_kill_at)
        watch_parent.kill()
        watch_parent.wait(timeout=10)
        step("watch_parent_killed", pid=watch_parent.pid, after=round(time.monotonic() - dropped_at, 2))

    deadline = time.monotonic() + args.watch
    alive, answered, first_failure = proc.poll() is None, True, None
    rc = None
    probed = False
    while time.monotonic() < deadline:
        rc = proc.poll()
        ok, detail = identity_ok(port, backend.token) if rc is None else (False, "process exited")
        elapsed = round(time.monotonic() - dropped_at, 2)
        record["timeline"].append({"t": elapsed, "alive": rc is None, "identity": ok})
        if rc is not None:
            alive = False
            step("gateway_exited", rc=rc, secondsAfterDrop=elapsed)
            break
        if answered and not ok:
            answered, first_failure = False, {"t": elapsed, "detail": detail}
            step("gateway_stopped_answering", secondsAfterDrop=elapsed, detail=detail)
        # Once the reap cycle has had its chance, ask the gateway for NEW work over a NEW socket.
        # A process that still answers HTTP but no longer serves sessions is the "dead gateway" a
        # user reports; HTTP liveness alone cannot see that.
        if not probed and elapsed >= args.probe_at:
            probed = True
            step("probe_begin", after=elapsed)
            record["probe"] = probe_new_client(backend, step)
        time.sleep(1.0)
    else:
        step("watch_window_elapsed", seconds=args.watch, alive=alive)

    rc = proc.poll()
    if rc is not None:
        verdict = "GATEWAY_DIED"
    elif first_failure is not None:
        verdict = "GATEWAY_STOPPED_ANSWERING"
    else:
        verdict = "GATEWAY_SURVIVED"

    ok_after, body_after = identity_ok(port, backend.token) if rc is None else (False, "process exited")
    record.update({
        "verdict": verdict, "exitCode": rc, "polls": len(record["timeline"]),
        "firstFailure": first_failure, "identityAfter": {"ok": ok_after, "body": body_after},
        "watchWindow": {"polls": len(record["timeline"]), "seconds": args.watch},
    })
    record["logs"] = backend.logs(tail=80)

    # The forensic trail the operator has: every log the child wrote under its sandbox home,
    # filtered to the lines that name a WS transport, a session teardown, or the orphan reaper.
    needles = ("ws closed", "client_gone", "force-reap", "teardown", "reclaimed", "ws_disconnect",
               "detached", "reap", "Interrupted during API call", "Traceback", "Error", "heartbeat")
    forensic: list[str] = []
    for path in sorted((backend.hermes_home / "logs").glob("*.log")) if (backend.hermes_home / "logs").exists() else []:
        try:
            for line in path.read_text(errors="replace").splitlines():
                if any(n.lower() in line.lower() for n in needles):
                    forensic.append(f"{path.name}: {line}")
        except OSError as exc:
            forensic.append(f"{path.name}: <unreadable: {exc}>")
    record["forensic"] = forensic[-200:]

    # The reaper's own decision trail, if it is written anywhere but stdout.
    err_log = backend.hermes_home / "logs" / "errors.log"
    record["errorsLog"] = err_log.read_text(errors="replace")[-4000:] if err_log.exists() else ""

    try:
        backend.stop()
        record["cleanStop"] = True
    except Exception as exc:  # noqa: BLE001
        record["cleanStop"] = f"{type(exc).__name__}: {exc}"
    if watch_parent is not None and watch_parent.poll() is None:
        with contextlib.suppress(Exception):
            watch_parent.kill()

    ARTIFACTS.mkdir(parents=True, exist_ok=True)
    out = ARTIFACTS / f"_gw-death-repro-{tag}.json" if tag != "stall" else REPORT
    out.write_text(json.dumps(record, indent=2), encoding="utf-8")
    print(f"\nVERDICT {verdict}  rc={rc}  polls={record['polls']}  artifact={out}", flush=True)
    print(record.get("logs", "")[-3000:], flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
