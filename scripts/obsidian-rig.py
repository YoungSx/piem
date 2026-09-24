#!/usr/bin/env python3
"""Generalized real-Obsidian smoke rig manager.

Every scripts/smoke-*-obsidian.mjs expects the same setup that used to be
re-derived from scratch in every session: a real Obsidian with CDP open, a
disposable vault at <root>/vault with the built plugin deployed inside, the
community-plugins master switch on, and the plugin unlocked. This tool does
that ritual in one command so nobody rediscovers it — or its pitfalls — again.

Usage:
  python3 scripts/obsidian-rig.py <worktree> <root> <cdp-port> [options]

  --smoke scripts/smoke-rpiv-todo-obsidian.mjs
      Run that smoke against the rig: desktop pass first, then the official
      mobile-emulation pass when the smoke supports --expect-mobile (detected
      from its source). Without --smoke the rig comes up and holds for manual
      CDP driving; Ctrl-C tears it down.
  --display :114     Xvfb display to launch on.
  --obsidian PATH    Obsidian binary override (skip the known-location search).
  --download         Fetch the pinned aarch64 build into <root>/runtime when no
      runtime is found. This host is aarch64; the amd64 .deb cannot run here.
  --skip-build       Deploy the worktree's existing main.js instead of running
      esbuild. A fresh worktree has no main.js — build first or use this only
      when one is already there.
  --data PATH        Seed the vault plugin's data.json from this file. Smokes
      that talk to a model need a provider row with activeModelId; without it
      normalizeSettings silently drops the custom provider.

Layout created under <root>: vault/ (disposable), profile/ (obsidian.json
registering the vault so the app skips the picker), logs/.

Teardown kills the process groups and reaps strays via /proc. Never use
`pkill -f` on this rig: the pattern matches your own shell's command line and
the kill lands on you (exit 144, output lost).
"""
import argparse, ctypes, glob, json, os, signal, socket, subprocess, sys, tarfile, time, urllib.request
from pathlib import Path

OBSIDIAN_VERSION = "1.13.7"
OBSIDIAN_URL = (
    "https://github.com/obsidianmd/obsidian-releases/releases/download/"
    f"v{OBSIDIAN_VERSION}/obsidian-{OBSIDIAN_VERSION}-arm64.tar.gz"
)

children = []
stopping = False


def request_stop(*_):
    global stopping
    stopping = True


def make_subreaper():
    # Children must not outlive this process and become stray Xvfbs/Obsidians.
    try:
        ctypes.CDLL(None).prctl(36, 1, 0, 0, 0)
    except Exception:
        pass


def terminate(child):
    try:
        os.killpg(child.pid, signal.SIGTERM)
    except ProcessLookupError:
        pass
    try:
        child.wait(timeout=5)
    except subprocess.TimeoutExpired:
        try:
            os.killpg(child.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        child.wait(timeout=3)


def reap_adopted():
    """SIGTERM children reparented to us while we were busy, via /proc."""
    adopted = []
    for path in Path("/proc").glob("[0-9]*/status"):
        try:
            fields = dict(line.split(":", 1) for line in path.read_text().splitlines() if ":" in line)
            pid = int(path.parent.name)
            if int(fields.get("PPid", "0")) == os.getpid():
                adopted.append(pid)
                os.kill(pid, signal.SIGTERM)
        except (FileNotFoundError, ProcessLookupError, PermissionError, ValueError):
            pass
    deadline = time.monotonic() + 2
    waiting = set(adopted)
    while waiting and time.monotonic() < deadline:
        for pid in tuple(waiting):
            try:
                reaped, _ = os.waitpid(pid, os.WNOHANG)
                if reaped:
                    waiting.discard(pid)
            except ChildProcessError:
                waiting.discard(pid)
        if waiting:
            time.sleep(0.05)
    for pid in waiting:
        try:
            os.kill(pid, signal.SIGKILL)
            os.waitpid(pid, 0)
        except (ProcessLookupError, ChildProcessError):
            pass
    return adopted


def cdp_port_open(port):
    try:
        with socket.create_connection(("127.0.0.1", port), timeout=0.5):
            return True
    except OSError:
        return False


def evaluate(port, expression):
    # The page target must be index.html: /json/list can also serve
    # starter.html, whose window.app is a plugin-less shim — every check would
    # read an empty world and time out looking like a product failure.
    script = (
        "const targets=await (await fetch('http://127.0.0.1:%d/json/list')).json();"
        "const target=targets.find(t=>t.type==='page'&&t.url.startsWith('app://')&&t.url.includes('index.html'))"
        "??targets.find(t=>t.type==='page'&&t.url.startsWith('app://'));"
        "if(!target)throw new Error('no page target');"
        "const ws=new WebSocket(target.webSocketDebuggerUrl);"
        "await new Promise((resolve,reject)=>{ws.addEventListener('open',resolve,{once:true});ws.addEventListener('error',reject,{once:true});});"
        "const reply=await new Promise((resolve,reject)=>{const id=1;"
        "ws.addEventListener('message',event=>{const m=JSON.parse(event.data);"
        "if(m.id===id){m.error?reject(new Error(JSON.stringify(m.error))):resolve(m.result);}},{once:false});"
        "ws.send(JSON.stringify({id,method:'Runtime.evaluate',params:{expression:%s,awaitPromise:true,returnByValue:true}}));"
        "setTimeout(()=>reject(new Error('cdp timeout')),25000);});"
        "ws.close();console.log(JSON.stringify(reply.result));"
    ) % (port, json.dumps(expression))
    out = subprocess.run(["node", "-e", script], capture_output=True, text=True, timeout=35)
    if out.returncode != 0:
        raise RuntimeError(out.stderr.strip()[-500:])
    return json.loads(out.stdout.splitlines()[-1])


def cdp_domain_command(port, method, params="{}"):
    expression = (
        "const targets=await (await fetch('http://127.0.0.1:%d/json/list')).json();"
        "const t=targets.find(t=>t.type==='page'&&t.url.startsWith('app://')&&t.url.includes('index.html'))"
        "??targets.find(t=>t.type==='page'&&t.url.startsWith('app://'));"
        "const ws=new WebSocket(t.webSocketDebuggerUrl);"
        "await new Promise(r=>ws.addEventListener('open',r,{once:true}));"
        "ws.send(JSON.stringify({id:1,method:'%s',params:%s}));"
        "await new Promise(r=>setTimeout(r,800));ws.close();" % (port, method, params)
    )
    subprocess.run(["node", "-e", expression], timeout=30, capture_output=True)


def set_focus_emulation(port, enabled):
    """The Xvfb window is never focused from Chromium's point of view, and an
    unfocused renderer throttles timers (and SSE settling) until a turn's
    reply lands tens of seconds late — which reads as a hung run."""
    cdp_domain_command(
        port, "Emulation.setFocusEmulationEnabled", '{"enabled":%s}' % ("true" if enabled else "false")
    )


def wait_until(port, expression, timeout, label, interval=0.5):
    deadline = time.monotonic() + timeout
    last_error = None
    while time.monotonic() < deadline:
        if stopping:
            raise RuntimeError(f"interrupted while waiting for {label}")
        try:
            if evaluate(port, expression):
                return
        except Exception as cause:
            last_error = cause
        time.sleep(interval)
    raise RuntimeError(f"timed out waiting for {label} ({timeout}s); last error: {last_error}")


def find_runtime(root, explicit, download):
    if explicit:
        runtime = Path(explicit)
        if not runtime.exists():
            sys.exit(f"--obsidian path does not exist: {runtime}")
        return runtime
    candidates = [
        root / "runtime" / f"obsidian-{OBSIDIAN_VERSION}-arm64" / "obsidian",
        *sorted(glob.glob(str(Path.home() / "piem-*-smoke-*" / "runtime" / "obsidian-*-arm64" / "obsidian"))),
        Path("/tmp/obs-app/obsidian"),
    ]
    for candidate in candidates:
        if Path(candidate).exists():
            return Path(candidate)
    if not download:
        sys.exit(
            "No Obsidian runtime found. Checked:\n  "
            + "\n  ".join(str(c) for c in candidates)
            + f"\nRe-run with --download to fetch {OBSIDIAN_URL} into <root>/runtime, "
            "or pass --obsidian /path/to/obsidian."
        )
    runtime_dir = root / "runtime"
    runtime_dir.mkdir(parents=True, exist_ok=True)
    tar_path = runtime_dir / f"obsidian-{OBSIDIAN_VERSION}-arm64.tar.gz"
    print(f"Downloading Obsidian {OBSIDIAN_VERSION} (aarch64)...")
    urllib.request.urlretrieve(OBSIDIAN_URL, tar_path)
    with tarfile.open(tar_path) as tar:
        tar.extractall(runtime_dir, filter="data")
    tar_path.unlink()
    runtime = runtime_dir / f"obsidian-{OBSIDIAN_VERSION}-arm64" / "obsidian"
    if not runtime.exists():
        sys.exit(f"Archive extracted but {runtime} is missing; inspect {runtime_dir}.")
    return runtime


def build_plugin(worktree, skip_build):
    main_js = worktree / "main.js"
    if skip_build:
        if not main_js.exists():
            sys.exit("--skip-build given but the worktree has no main.js; build once first.")
        return
    print("Building plugin (esbuild production)...")
    out = subprocess.run(
        ["node", "esbuild.config.mjs", "production"], cwd=worktree, capture_output=True, text=True
    )
    if out.returncode != 0 or not main_js.exists():
        sys.exit(f"esbuild failed (code {out.returncode}):\n{out.stdout[-800:]}\n{out.stderr[-800:]}")


def deploy_plugin(worktree, vault, data_seed):
    plugin_dir = vault / ".obsidian" / "plugins" / "piem"
    plugin_dir.mkdir(parents=True, exist_ok=True)
    for name in ("main.js", "manifest.json", "styles.css"):
        (plugin_dir / name).write_bytes((worktree / name).read_bytes())
    (vault / ".obsidian" / "community-plugins.json").write_text(json.dumps(["piem"]))
    data = json.loads(Path(data_seed).read_text()) if data_seed else {}
    (plugin_dir / "data.json").write_text(json.dumps(data, indent=2))


def prepare_profile(profile, vault):
    profile.mkdir(parents=True, exist_ok=True)
    obsidian_json = profile / "obsidian.json"
    if not obsidian_json.exists():
        # "open": true skips the vault picker — a fresh profile otherwise boots
        # into starter.html and window.app stays a plugin-less shim forever.
        obsidian_json.write_text(json.dumps({
            "vaults": {"0d11061a9f31c6f4": {"path": str(vault), "ts": int(time.time() * 1000), "open": True}}
        }))


def launch_xvfb(display, logs):
    print(f"Starting Xvfb on display {display}...")
    with open(logs / "xvfb.log", "ab") as log:
        xvfb = subprocess.Popen(
            ["Xvfb", display, "-screen", "0", "1280x900x24", "-nolisten", "tcp"],
            stdout=log, stderr=subprocess.STDOUT, start_new_session=True,
        )
    children.append(xvfb)
    for _ in range(50):
        if Path(f"/tmp/.X11-unix/X{display[1:]}").exists():
            return
        time.sleep(0.1)
    sys.exit(f"Xvfb did not create display {display}; see {logs / 'xvfb.log'}")


def launch_obsidian(runtime, profile, port, display, logs):
    print(f"Starting Obsidian on CDP port {port}...")
    env = dict(os.environ, DISPLAY=display)
    with open(logs / "obsidian.log", "ab") as log:
        app = subprocess.Popen([
            str(runtime), f"--user-data-dir={profile}", "--no-sandbox", "--disable-gpu",
            "--disable-dev-shm-usage", "--remote-debugging-address=127.0.0.1",
            f"--remote-debugging-port={port}", "--no-first-run",
        ], env=env, stdout=log, stderr=subprocess.STDOUT, start_new_session=True)
    children.append(app)
    for _ in range(300):
        if cdp_port_open(port):
            return
        if app.poll() is not None:
            sys.exit(f"Obsidian exited early with code {app.returncode}; see {logs / 'obsidian.log'}")
        if stopping:
            sys.exit("Interrupted before CDP port opened.")
        time.sleep(0.5)
    sys.exit(f"CDP port {port} never opened; see {logs / 'obsidian.log'}")


def unlock_plugin(port):
    print("Waiting for the piem plugin...")
    # Two gates, both silent: the community-plugins master switch in
    # localStorage, and loadPlugin no-oping while it is off. The unlock must
    # run as an async IIFE — Runtime.evaluate rejects a bare await as a syntax
    # error. Then verify the agentService body, not the plugin shell: the
    # shell existing while the service does not is the classic false green.
    # Cold start on a pristine vault can exceed 30s; the loop below allows 90.
    deadline = time.monotonic() + 90
    rescue = []
    while time.monotonic() < deadline:
        if stopping:
            raise RuntimeError("interrupted while waiting for the plugin")
        try:
            if evaluate(port, "!!window.app?.plugins?.plugins?.piem?.agentService"):
                return
            evaluate(port, "(async () => { app.plugins.setEnable(true); await app.plugins.enablePluginAndSave('piem'); })()")
        except Exception as cause:
            rescue.append(str(cause)[:200])
        time.sleep(1)
    raise RuntimeError(f"piem never loaded; rescue attempts: {rescue[-5:]}")


def run_smoke_script(smoke, port, root, mobile):
    command = ["node", str(smoke), str(port), str(root)]
    if mobile:
        command.append("--expect-mobile")
    out = subprocess.run(command, capture_output=True, text=True, timeout=600)
    line = (out.stdout.strip().splitlines() or ["{}"])[-1]
    try:
        report = json.loads(line)
    except json.JSONDecodeError:
        report = {"passed": False, "failure": out.stdout[-500:] + out.stderr[-500:]}
    if out.returncode != 0:
        print(f"Smoke error (code {out.returncode}):\nSTDOUT: {out.stdout[-800:]}\nSTDERR: {out.stderr[-800:]}")
    return report


def teardown(port, display, summary, root):
    cdp_domain_command(port, "Emulation.clearDeviceMetricsOverride")
    adopted = reap_adopted()
    for child in reversed(children):
        terminate(child)
    adopted.extend(reap_adopted())
    lock = Path(f"/tmp/.X{display[1:]}-lock")
    try:
        lock.unlink()
    except OSError:
        pass
    (root / "cleanup.json").write_text(json.dumps(summary, indent=2))
    return adopted


def main():
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("worktree", type=Path, help="piem checkout to build/deploy from")
    parser.add_argument("root", type=Path, help="disposable rig directory (vault/, profile/, logs/)")
    parser.add_argument("port", type=int, help="CDP port for Obsidian")
    parser.add_argument("--smoke", type=Path, default=None, help="smoke-*-obsidian.mjs to run (default: hold for manual driving)")
    parser.add_argument("--display", default=":114", help="Xvfb display")
    parser.add_argument("--obsidian", default=None, help="Obsidian binary override")
    parser.add_argument("--download", action="store_true", help="fetch the pinned aarch64 build when no runtime is found")
    parser.add_argument("--skip-build", action="store_true", help="deploy the existing main.js instead of building")
    parser.add_argument("--data", default=None, help="seed the vault plugin data.json from this file")
    args = parser.parse_args()

    # Piped runs (background shells) would otherwise block-buffer every status
    # line and hide progress behind the next flush.
    sys.stdout.reconfigure(line_buffering=True)

    signal.signal(signal.SIGTERM, request_stop)
    signal.signal(signal.SIGINT, request_stop)
    make_subreaper()

    worktree = args.worktree.resolve()
    root = args.root.resolve()
    vault = root / "vault"
    profile = root / "profile"
    logs = root / "logs"
    logs.mkdir(parents=True, exist_ok=True)

    runtime = find_runtime(root, args.obsidian, args.download)
    build_plugin(worktree, args.skip_build)
    deploy_plugin(worktree, vault, args.data)
    prepare_profile(profile, vault)

    launch_xvfb(args.display, logs)
    launch_obsidian(runtime, profile, args.port, args.display, logs)
    time.sleep(3)
    unlock_plugin(args.port)
    set_focus_emulation(args.port, True)

    results = {"desktop": None, "mobile": None}
    if args.smoke is None:
        print(
            f"\nRig is up. CDP port {args.port}, vault at {vault}.\n"
            f"Drive it manually (evaluate via /json/list → index.html target), or run any smoke with:\n"
            f"  node <smoke-script>.mjs {args.port} {root}\n"
            "Ctrl-C to tear down."
        )
        try:
            while not stopping:
                time.sleep(0.5)
        except KeyboardInterrupt:
            pass
    else:
        supports_mobile = "--expect-mobile" in args.smoke.read_text()
        print(f"Running desktop pass: {args.smoke.name}")
        results["desktop"] = run_smoke_script(args.smoke, args.port, root, mobile=False)
        print(f"Desktop result: {results['desktop'].get('passed', False)}")

        if supports_mobile and results["desktop"].get("passed") and not stopping:
            print("Switching to mobile emulation...")
            evaluate(args.port, "app.emulateMobile(true)")
            wait_until(args.port, "app.isMobile === true", 30, "mobile mode")
            cdp_domain_command(
                args.port, "Emulation.setDeviceMetricsOverride",
                '{"width":390,"height":844,"deviceScaleFactor":2,"mobile":true}',
            )
            # emulateMobile triggers a reload; the plugin re-attaches asynchronously.
            wait_until(args.port, "!!window.app?.plugins?.plugins?.piem?.agentService", 60, "plugin after mobile reload")
            print(f"Running mobile pass: {args.smoke.name}")
            results["mobile"] = run_smoke_script(args.smoke, args.port, root, mobile=True)
            print(f"Mobile result: {results['mobile'].get('passed', False)}")

    summary = {
        "desktop": results["desktop"] or "not run",
        "mobile": results["mobile"] or "not run",
        "vault": str(vault),
        "port": args.port,
        "display": args.display,
    }
    adopted = teardown(args.port, args.display, summary, root)
    if adopted:
        print(f"Reaped {len(adopted)} stray process(es).")

    if args.smoke is not None:
        print("\n--- Final Smoke Summary ---")
        print(json.dumps(
            {k: (v.get("passed") if isinstance(v, dict) else v) for k, v in results.items() if v},
            indent=2, ensure_ascii=False,
        ))
        return 0 if results["desktop"] and results["desktop"].get("passed") and (
            results["mobile"] is None or results["mobile"].get("passed")
        ) else 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
