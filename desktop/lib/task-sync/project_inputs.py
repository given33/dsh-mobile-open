"""Bounded project inputs for relay-inputs.mjs. Never scans a directory or executes a project file."""

import base64
import ctypes
from contextlib import contextmanager, ExitStack
import hashlib
import json
import os
import re
import secrets
import stat
import sys

LIMIT = 8 * 1024 * 1024
MAX_WIRE = 12 * 1024 * 1024


if os.name == "nt":
    from ctypes import wintypes
    import msvcrt

    kernel = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel.CreateFileW.argtypes = [
        wintypes.LPCWSTR,
        wintypes.DWORD,
        wintypes.DWORD,
        ctypes.c_void_p,
        wintypes.DWORD,
        wintypes.DWORD,
        wintypes.HANDLE,
    ]
    kernel.CreateFileW.restype = wintypes.HANDLE
    kernel.GetFileInformationByHandleEx.argtypes = [
        wintypes.HANDLE,
        ctypes.c_int,
        ctypes.c_void_p,
        wintypes.DWORD,
    ]
    kernel.CloseHandle.argtypes = [wintypes.HANDLE]

    def win_open(path, directory):
        # OPEN_REPARSE_POINT opens the link itself. Hold every ancestor without share-delete
        # or share-write, so a junction cannot replace it between validation and leaf I/O.
        handle = kernel.CreateFileW(
            path, 0x80 if directory else 0x80000000, 1, None, 3, 0x02200000, None
        )
        if handle == wintypes.HANDLE(-1).value:
            raise ctypes.WinError(ctypes.get_last_error())
        try:
            attr_tag = (wintypes.DWORD * 2)()
            if not kernel.GetFileInformationByHandleEx(
                handle, 9, attr_tag, ctypes.sizeof(attr_tag)
            ):
                raise ctypes.WinError(ctypes.get_last_error())
            if attr_tag[0] & 0x400 or bool(attr_tag[0] & 0x10) != directory:
                raise ValueError("Unexpected directory, file or reparse point")
            if directory:
                return handle
            return msvcrt.open_osfhandle(handle, os.O_RDONLY | os.O_BINARY)
        except BaseException:
            kernel.CloseHandle(handle)
            raise


class Folder:
    def __init__(self, path, fd):
        self.path = path
        self.fd = fd

    def child(self, name):
        return os.path.join(self.path, name) if self.fd is None else name


@contextmanager
def directory(path, parent=None):
    absolute = path if parent is None else os.path.join(parent.path, path)
    if os.name == "nt":
        handle = win_open(absolute, True)
        try:
            yield Folder(absolute, None)
        finally:
            kernel.CloseHandle(handle)
    else:
        fd = os.open(
            path,
            os.O_RDONLY | os.O_NOFOLLOW | os.O_DIRECTORY,
            dir_fd=parent.fd if parent else None,
        )
        try:
            yield Folder(absolute, fd)
        finally:
            os.close(fd)


@contextmanager
def leaf(root, name, create=False):
    parts = name.split("/")
    with ExitStack() as held:
        parent = root
        for part in parts[:-1]:
            try:
                child = held.enter_context(directory(part, parent))
            except FileNotFoundError:
                if not create:
                    raise
                try:
                    os.mkdir(parent.child(part), 0o700, dir_fd=parent.fd)
                except FileExistsError:
                    pass  # Another snapshot made it. Still require a real directory.
                if parent.fd is not None:
                    os.fsync(parent.fd)
                child = held.enter_context(directory(part, parent))
            parent = child
        yield parent, parts[-1]


def regular_bytes(root, name, budget):
    with leaf(root, name) as (parent, filename):
        path = parent.child(filename)
        fd = (
            win_open(path, False)
            if os.name == "nt"
            else os.open(
                path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=parent.fd
            )
        )
        with os.fdopen(fd, "rb") as handle:
            before = os.fstat(fd)
            if (
                not stat.S_ISREG(before.st_mode)
                or before.st_nlink != 1
                or before.st_size > budget
            ):
                raise ValueError("Not a bounded, independent regular file: " + name)
            data = handle.read(before.st_size + 1)
            after = os.fstat(fd)
            if (
                len(data) != before.st_size
                or before.st_size != after.st_size
                or before.st_ctime_ns != after.st_ctime_ns
                or before.st_mtime_ns != after.st_mtime_ns
                or after.st_nlink != 1
            ):
                raise ValueError("File changed while being read: " + name)
            return data


def publish_name(parent, temporary, filename):
    # Move the complete inode in a single no-replace operation. link()+unlink()
    # would leave a two-link file that the integrity checks must reject after a crash.
    if os.name == "nt":
        os.rename(temporary, parent.child(filename))
        return
    libc = ctypes.CDLL(None, use_errno=True)
    if sys.platform == "darwin":
        rename, flags = libc.renameatx_np, 4  # RENAME_EXCL
    elif sys.platform.startswith("linux") and hasattr(libc, "renameat2"):
        rename, flags = libc.renameat2, 1  # RENAME_NOREPLACE
    else:
        raise ValueError("No atomic no-replace rename on this host")
    rename.argtypes = [
        ctypes.c_int,
        ctypes.c_char_p,
        ctypes.c_int,
        ctypes.c_char_p,
        ctypes.c_uint,
    ]
    if rename(
        parent.fd, os.fsencode(temporary), parent.fd, os.fsencode(filename), flags
    ):
        code = ctypes.get_errno()
        raise OSError(code, os.strerror(code))


def publish(root, name, data):
    with leaf(root, name, create=True) as (parent, filename):
        temporary = parent.child(".dsh-relay-" + secrets.token_hex(16))
        fd = os.open(
            temporary,
            os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_BINARY", 0),
            0o600,
            dir_fd=parent.fd,
        )
        try:
            with os.fdopen(fd, "wb") as out:
                out.write(data)
                out.flush()
                os.fsync(out.fileno())
            publish_name(parent, temporary, filename)
        finally:
            try:
                os.unlink(temporary, dir_fd=parent.fd)
            except FileNotFoundError:
                pass
        if parent.fd is not None:
            os.fsync(parent.fd)


def run(action, folder, records):
    if (
        action not in ("collect", "check", "prepare")
        or not isinstance(records, list)
        or len(records) > 256
    ):
        raise ValueError("Invalid relay input operation")
    output, missing = [], []
    remaining = LIMIT
    for record in records:
        name = record["name"]
        # The JS policy also validates portable names, sensitive components, case collisions
        # and file/dir conflicts before calling this private helper; never accept host paths.
        if len(name) > 240 or any(
            not part
            or not part[0].isalnum()
            or part.endswith((".", " "))
            or not all(c.isalnum() or c in " ._-" for c in part)
            for part in name.split("/")
        ):
            raise ValueError("Invalid relative input name")
        if action == "collect":
            data = regular_bytes(folder, name, remaining)
            output.append(
                dict(
                    name=name,
                    digest=hashlib.sha256(data).hexdigest(),
                    bytes=base64.b64encode(data).decode("ascii"),
                )
            )
        else:
            data = base64.b64decode(record["bytes"], validate=True)
            if (
                len(data) > remaining
                or base64.b64encode(data).decode("ascii") != record["bytes"]
                or hashlib.sha256(data).hexdigest() != record["digest"]
            ):
                raise ValueError("Project input failed integrity check: " + name)
            try:
                matched = regular_bytes(folder, name, len(data)) == data
            except FileNotFoundError:
                if action != "prepare":
                    raise
                missing.append((name, data))
            else:
                if not matched:
                    raise ValueError("Existing project input differs: " + name)
        remaining -= len(data)
    for name, data in missing:
        try:
            publish(folder, name, data)
        except FileExistsError:
            if regular_bytes(folder, name, len(data)) != data:
                raise ValueError("A different file appeared during handoff: " + name)
    return output


if __name__ == "__main__":
    try:
        action, base, *key = sys.argv[1:]
        if key and (len(key) != 1 or not re.fullmatch("[a-f0-9]{64}", key[0])):
            raise ValueError("Invalid managed workspace identity")
        raw = sys.stdin.buffer.read(MAX_WIRE + 1)
        if len(raw) > MAX_WIRE:
            raise ValueError("Oversized project input request")
        with ExitStack() as held:
            root = held.enter_context(directory(base))
            if key:
                workspaces = held.enter_context(directory("workspaces", root))
                root = held.enter_context(directory(key[0], workspaces))
            print(
                json.dumps(
                    run(action, root, json.loads(raw.decode("utf-8"))),
                    ensure_ascii=True,
                )
            )
    except (ValueError, KeyError, TypeError, OSError) as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
