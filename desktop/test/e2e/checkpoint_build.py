"""Per-host real npm build + a frozen transport session for crash-injection QA.
Start in a disposable empty directory. The control channel accepts only named QA events.
"""

import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import signal
import subprocess
import sys
import time

SCRIPT = r"""import { appendFileSync,writeFileSync,readFileSync,existsSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
const {ScriptProgress,recipeHash,computationSlice} = await import(process.env.DSH_QA_SEED ? './computation-slice.mjs' : process.env.DSH_QA_SDK);
const pages=['North','East','West'];
const recipe=recipeHash([readFileSync(new URL(import.meta.url)),readFileSync(new URL('./computation-slice.mjs',import.meta.url)),JSON.stringify(pages),'html-v1']);
const state=process.env.DSH_QA_SEED ? null : new ScriptProgress({session:process.env.DSH_QA_SESSION,job:'site',root:process.env.DSH_QA_ROOT,recipe});
const slice=process.env.DSH_QA_SEED ? computationSlice(JSON.parse(Buffer.from(process.env.DSH_QA_SEED,'base64')), {job:'site',recipe}) : null;
const primary=process.env.DSH_QA_MODE==='primary';
const closePulse=primary ? await state.startProducer() : null;
writeFileSync('running.json',JSON.stringify({pid:process.pid,primary}));
let checkpoint=slice ?? (primary ? state.load() : await state.waitForQuietReplica({quietMs:4000,timeoutMs:90000}));
let built=checkpoint.state ? JSON.parse(checkpoint.state) : [];
if (!primary && !built.length) throw Error('Standby started without durable state');
for(let i=built.length;i<pages.length;i++) {
  if(primary && i===1) {
    // The process is alive in chunk 2 when the driver kills it. No second checkpoint exists.
    writeFileSync('mid-chunk','1');while(true)await delay(100);
  }
  if(!primary && i===0)throw Error('Standby repeated committed page');
  built.push(`<article id="${i}">${pages[i]}</article>`);appendFileSync('executed',i+'\n');
  if(slice)continue;
  checkpoint=state.save(checkpoint,Buffer.from(JSON.stringify(built)),{done:i===pages.length-1});
  if(primary) state.waitPaired(checkpoint,60);
}
if(slice) console.log('DSH-QA-SAVE:'+Buffer.from(JSON.stringify(slice.result(Buffer.from(JSON.stringify(built)),{done:true}))).toString('base64'));
if(closePulse) await closePulse();
writeFileSync('site.html',built.join('\n'));console.log('BUILD-COMPLETED');
"""


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("workspace", type=Path)
    parser.add_argument("sdk", type=Path)
    parser.add_argument("--dsh-home", type=Path)
    parser.add_argument("mode", choices=["primary", "standby"])
    parser.add_argument("session")
    a = parser.parse_args()
    ws = a.workspace.resolve()
    ws.mkdir(parents=True, exist_ok=False)
    sdk = a.sdk.resolve(strict=True)
    shutil.copyfile(sdk.with_name("computation-slice.mjs"), ws / "computation-slice.mjs")
    os.chdir(ws)
    (ws / "package.json").write_text(
        json.dumps({"scripts": {"build": "node build.mjs"}}), encoding="utf8"
    )
    (ws / "build.mjs").write_bytes(SCRIPT.encode("utf8"))
    env = dict(
        os.environ,
        DSH_QA_MODE=a.mode,
        DSH_QA_SDK=sdk.as_uri(),
        DSH_QA_SESSION=a.session,
        DSH_HOME=str(a.dsh_home or ws / "dsh"),
    )
    with (ws / "build.log").open("wb") as log:
        build = subprocess.Popen(
            [shutil.which("npm.cmd" if os.name == "nt" else "npm"), "run", "build"],
            env=env,
            stdin=subprocess.DEVNULL,
            stdout=log,
            stderr=subprocess.STDOUT,
        )
        try:
            for line in sys.stdin:
                action = json.loads(line)
                if action == "status":
                    response = {
                        "ready": (ws / "running.json").exists(),
                        "mid": (ws / "mid-chunk").exists(),
                        "exit": build.poll(),
                        "steps": (ws / "executed").read_text().splitlines()
                        if (ws / "executed").exists()
                        else [],
                        "result": hashlib.sha256(
                            (ws / "site.html").read_bytes()
                        ).hexdigest()
                        if (ws / "site.html").exists()
                        else None,
                    }
                    if build.returncode not in (None, 0):
                        response["log"] = (ws / "build.log").read_text(
                            errors="replace"
                        )[-500:]
                elif (
                    action == "cut"
                    and a.mode == "primary"
                    and (ws / "mid-chunk").exists()
                    and build.poll() is None
                ):
                    pid = json.loads((ws / "running.json").read_bytes())["pid"]
                    os.kill(pid, signal.SIGTERM if os.name == "nt" else signal.SIGKILL)
                    assert build.wait(timeout=10) != 0
                    response = True
                elif action == "end":
                    break
                else:
                    raise ValueError("Unknown test command")
                print(json.dumps(response), flush=True)
        finally:
            if build.poll() is None:
                if (ws / "running.json").exists():
                    try:
                        os.kill(
                            json.loads((ws / "running.json").read_bytes())["pid"],
                            signal.SIGTERM,
                        )
                    except (ProcessLookupError, PermissionError):
                        pass
                try:
                    build.wait(timeout=3)
                except subprocess.TimeoutExpired:
                    build.kill()
                    build.wait()


if __name__ == "__main__":
    main()
