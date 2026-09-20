#!/usr/bin/env python3
"""Orchestrate the real-Obsidian smoke rig for proactive intelligence.

Controls Xvfb, Obsidian runtime, and smoke runner.
Usage: python3 scripts/run-smoke-proactive.py <worktree> <root> <cdp-port> [display]
"""
import ctypes, json, os, signal, socket, subprocess, sys, time
from pathlib import Path

worktree = Path(sys.argv[1]).resolve()
root = Path(sys.argv[2]).resolve()
port = int(sys.argv[3])
display = sys.argv[4] if len(sys.argv) > 4 else ":114"

runtime = root / "runtime" / "obsidian-1.13.7-arm64" / "obsidian"
if not runtime.exists():
    # Fallback to shared runtime
    runtime = Path("/home/ubuntu/piem-todo-smoke-20260914/runtime/obsidian-1.13.7-arm64/obsidian")

vault = root / "vault"
profile = root / "profile"
children = []
stopping = False

# Make this process a subreaper so children won't escape
try:
    ctypes.CDLL(None).prctl(36, 1, 0, 0, 0)
except Exception:
    pass

signal.signal(signal.SIGTERM, lambda *_: globals().update(stopping=True))
signal.signal(signal.SIGINT, lambda *_: globals().update(stopping=True))


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


def cdp_port_open():
    try:
        with socket.create_connection(("127.0.0.1", port), timeout=0.5):
            return True
    except OSError:
        return False


def evaluate(expression):
    script = (
        "const targets=await (await fetch('http://127.0.0.1:%d/json/list')).json();"
        "const target=targets.find(t=>t.type==='page'&&t.url.startsWith('app://'));"
        "if(!target)throw new Error('no page');"
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


def run_smoke(mobile):
    command = ["node", str(worktree / "scripts" / "smoke-proactive-obsidian.mjs"), str(port), str(root)]
    if mobile:
        command.append("--expect-mobile")
    out = subprocess.run(command, capture_output=True, text=True, timeout=300)
    line = (out.stdout.strip().splitlines() or ["{}"])[-1]
    try:
        report = json.loads(line)
    except json.JSONDecodeError:
        report = {"passed": False, "failure": out.stdout[-500:] + out.stderr[-500:]}
    if out.returncode != 0:
        print(f"Smoke error (code {out.returncode}):\nSTDOUT: {out.stdout}\nSTDERR: {out.stderr}")
    return report, out.returncode


def main():
    (root / "logs").mkdir(parents=True, exist_ok=True)

    # Launch Xvfb
    print(f"Starting Xvfb on display {display}...")
    with open(root / "logs" / "xvfb.log", "ab") as log:
        xvfb = subprocess.Popen(
            ["Xvfb", display, "-screen", "0", "1280x900x24", "-nolisten", "tcp"],
            stdout=log, stderr=subprocess.STDOUT, start_new_session=True
        )
    children.append(xvfb)

    for _ in range(50):
        if Path(f"/tmp/.X11-unix/X{display[1:]}").exists():
            break
        time.sleep(0.1)

    env = dict(os.environ, DISPLAY=display)

    # Launch Obsidian
    print(f"Starting Obsidian on port {port}...")
    with open(root / "logs" / "obsidian.log", "ab") as log:
        app = subprocess.Popen([
            str(runtime), f"--user-data-dir={profile}", "--no-sandbox", "--disable-gpu",
            "--disable-dev-shm-usage", "--remote-debugging-address=127.0.0.1",
            f"--remote-debugging-port={port}", "--no-first-run",
        ], env=env, stdout=log, stderr=subprocess.STDOUT, start_new_session=True)
    children.append(app)

    for _ in range(300):
        if cdp_port_open():
            break
        if app.poll() is not None:
            raise RuntimeError(f"Obsidian exited early with code {app.returncode}")
        if stopping:
            raise RuntimeError("Interrupted before CDP port opened")
        time.sleep(0.5)

    print("Obsidian CDP listening. Waiting for plugin load...")
    time.sleep(3)

    rescue = []
    for _ in range(60):
        try:
            loaded = evaluate("!!window.app?.plugins?.plugins?.piem")
            if loaded:
                break
            evaluate("app.plugins.setEnable('piem', true); await app.plugins.enablePluginAndSave('piem')")
        except Exception as cause:
            rescue.append(str(cause)[:200])
        time.sleep(1)
    else:
        raise RuntimeError(f"piem never loaded; rescue attempts: {rescue}")

    # Ensure desktop mode is active before desktop pass
    if evaluate("app.isMobile === true"):
        print("Currently in mobile mode, switching back to Desktop mode...")
        evaluate("app.emulateMobile(false)")
        for _ in range(60):
            if evaluate("app.isMobile === false"):
                break
            time.sleep(0.5)
        # Clear device metrics override
        subprocess.run(["node", "-e", (
            "const targets=await(await fetch('http://127.0.0.1:%d/json/list')).json();"
            "const t=targets.find(t=>t.type==='page'&&t.url.startsWith('app://'));"
            "const ws=new WebSocket(t.webSocketDebuggerUrl);"
            "await new Promise(r=>ws.addEventListener('open',r,{once:true}));"
            "ws.send(JSON.stringify({id:1,method:'Emulation.clearDeviceMetricsOverride'}));"
            "await new Promise(r=>setTimeout(r,500));ws.close();"
        ) % port], timeout=30)
        # Wait for plugin to reload after emulateMobile reload
        time.sleep(2)
        for _ in range(60):
            if evaluate("!!window.app?.plugins?.plugins?.piem?.agentService"):
                break
            time.sleep(0.5)

    print("Piem plugin loaded! Running Desktop Smoke Pass...")
    desktop, desktopCode = run_smoke(False)
    print(f"Desktop result: {desktop.get('passed', False)}")

    mobile, mobileCode = {"passed": False, "failure": "skipped"}, 1
    if desktop.get("passed"):
        print("Switching to Mobile Emulation mode...")
        try:
            evaluate("app.emulateMobile(true)")
        except Exception as cause:
            print(f"emulateMobile failed: {cause}")
        for _ in range(60):
            if evaluate("app.isMobile === true"):
                break
            time.sleep(0.5)

        # Set 390x844 viewport via CDP Emulation
        subprocess.run(["node", "-e", (
            "const targets=await(await fetch('http://127.0.0.1:%d/json/list')).json();"
            "const t=targets.find(t=>t.type==='page'&&t.url.startsWith('app://'));"
            "const ws=new WebSocket(t.webSocketDebuggerUrl);"
            "await new Promise(r=>ws.addEventListener('open',r,{once:true}));"
            "ws.send(JSON.stringify({id:1,method:'Emulation.setDeviceMetricsOverride',"
            "params:{width:390,height:844,deviceScaleFactor:2,mobile:true}}));"
            "await new Promise(r=>setTimeout(r,1000));ws.close();"
        ) % port], timeout=30)

        time.sleep(2)
        for _ in range(60):
            if evaluate("!!window.app?.plugins?.plugins?.piem?.agentService"):
                break
            time.sleep(0.5)

        print("Running Mobile Smoke Pass...")
        mobile, mobileCode = run_smoke(True)
        print(f"Mobile result: {mobile.get('passed', False)}")

    adopted = reap_adopted()
    for child in reversed(children):
        terminate(child)
    adopted.extend(reap_adopted())

    summary = {
        "desktop": desktop,
        "mobile": mobile,
        "exitCodes": {"desktop": desktopCode, "mobile": mobileCode},
        "vault": str(vault),
        "port": port,
        "display": display,
    }
    (root / "cleanup.json").write_text(json.dumps(summary, indent=2))
    print("\n--- Final Smoke Summary ---")
    print(json.dumps({"desktop": desktop.get("passed"), "mobile": mobile.get("passed")}, indent=2, ensure_ascii=False))

    return 0 if desktop.get("passed") and mobile.get("passed") else 1


if __name__ == "__main__":
    sys.exit(main())
