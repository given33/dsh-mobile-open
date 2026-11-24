"""Incremental exchange on the same authenticated SSH session as native DSH history."""

from contextlib import closing
import json
import sqlite3
import subprocess

from source_sync import HASH, Journal, authorize, digest, grants, keys, valid_scopes


def support(root, role, offers):
    if not isinstance(offers, dict) or len(offers) > 64:
        raise ValueError("Invalid source offers")
    for key, scopes in offers.items():
        if not HASH.fullmatch(key) or not valid_scopes(scopes):
            raise ValueError("Invalid source scope")
        if (grants(root) / (key + ".json")).exists():
            continue
        # A network packet can only opt in the replica previously allocated by native DSH.
        # It can never nominate the path of a local project or grant access to an original.
        routefile = root / "routes" / (key + ".json")
        folder = root / "workspaces" / key
        if (
            not routefile.is_file()
            or not folder.is_dir()
            or folder.resolve() != folder.absolute()
        ):
            continue
        route = json.loads(routefile.read_bytes())
        peer = "cloud" if role == "desktop" else "desktop"
        if (
            route["owner"] == peer
            and digest((peer + ":" + route["key"]).encode()) == key
        ):
            authorize(root, key, folder, scopes)


def inventory(root):
    return {
        k: json.loads((grants(root) / (k + ".json")).read_bytes())["scopes"]
        for k in keys(root)
    }


def exchange(root, reader, writer, send, receive):
    local = inventory(root)
    send(writer, ["source-list", local])
    remote = receive(reader)
    support(root, "desktop", remote)
    local = inventory(root)
    for key in local.keys() & remote.keys():
        if local[key] != remote[key]:
            continue
        try:
            with closing(Journal(root, key)) as j:
                j.scan()
                here = j.fence()
                send(writer, ["source-get", key, here["epoch"], here["received"]])
                reply = receive(reader)
                if reply is None:
                    continue
                epoch, cursor, rows = reply
                if type(cursor) != int or not 0 <= cursor <= here["seq"]:
                    raise ValueError("Invalid source acknowledgement")
                got = j.accept(epoch, rows)
                send(writer, ["source-put", key, here["epoch"], got, j.page(cursor)])
                ack = receive(reader)
                if type(ack) != int or not cursor <= ack <= j.fence()["seq"]:
                    continue
                with j.locked():
                    j.setmeta("ack", ack)
                j.scan()
        except (OSError, ValueError, sqlite3.Error, subprocess.SubprocessError) as exc:
            # One blocked project must not starve history, task receipts or other projects.
            import sys

            print("Source exchange pending:", key, type(exc).__name__, file=sys.stderr)


def respond(root, cmd, permitted):
    if len(cmd) < 2 or cmd[1] not in permitted:
        return None
    with closing(Journal(root, cmd[1])) as j:
        if cmd[0] == "source-get" and len(cmd) == 4:
            _, key, epoch, cursor = cmd
            j.scan()
            state = j.fence()
            if (
                state["peerEpoch"] not in (None, epoch)
                or type(cursor) != int
                or not 0 <= cursor <= state["seq"]
            ):
                return None
            return [state["epoch"], state["received"], j.page(cursor)]
        if cmd[0] == "source-put" and len(cmd) == 5:
            _, key, epoch, ack, rows = cmd
            if type(ack) != int or not 0 <= ack <= j.fence()["seq"]:
                return None
            received = j.accept(epoch, rows)
            with j.locked():
                j.setmeta("ack", ack)
            j.scan()
            return received
    return None
