"""Open the authenticated cloud DSH Web in the local browser over a host-key-checked SSH tunnel."""
import argparse
import ctypes
import json
import os
import re
import socket
import subprocess
import sys
import time
import urllib.error
import urllib.request
import webbrowser

REMOTE = "i=$(systemctl show -p InvocationID --value dsh-cloud) && test -n \"$i\" && sudo -n journalctl \"_SYSTEMD_INVOCATION_ID=$i\" -o cat --no-pager | grep -m1 '^dsh web: http://127.0.0.1:18361/' && exec sleep infinity"

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('ssh_alias', type=str)
    parser.add_argument('--verify', action='store_true', help='check owner authentication, without opening a browser')
    args = parser.parse_args()
    if not re.fullmatch(r'[a-zA-Z0-9][\w.-]*', args.ssh_alias):
        raise ValueError('Invalid SSH host alias')
    with socket.socket() as listener:
        listener.bind(('127.0.0.1', 0))
        port = listener.getsockname()[1]
    cmd = ['ssh', '-T', '-o', 'StrictHostKeyChecking=yes', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=8',
           '-o', 'ExitOnForwardFailure=yes', '-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=2',
           '-L', f'127.0.0.1:{port}:127.0.0.1:18361', args.ssh_alias, REMOTE]
    flags = subprocess.CREATE_NO_WINDOW if os.name == 'nt' else 0
    with subprocess.Popen(cmd, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, creationflags=flags) as proc:
        try:
            line = proc.stdout.readline(1024).decode().strip()
            match = re.fullmatch(r'dsh web: http://127\.0\.0\.1:18361/(\?token=[\w.%-]+)', line)
            if not match:
                raise RuntimeError('无法建立经过验证的 DSH Web 通道。')
            url = f'http://127.0.0.1:{port}/' + match.group(1)
            if args.verify:
                import http.cookiejar
                jar = http.cookiejar.CookieJar()
                opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), urllib.request.HTTPCookieProcessor(jar))
                with opener.open(url, timeout=10) as response:
                    if response.status != 200 or not any(c.name.startswith('dsh-auth-') for c in jar):
                        raise RuntimeError('Cloud web authentication failed')
                print('Verified authenticated DSH Web through the loopback tunnel.')
            else:
                if not webbrowser.open(url):
                    raise RuntimeError('无法打开默认浏览器。')
                proc.wait()
        finally:
            if proc.poll() is None:
                proc.terminate()

if __name__ == '__main__':
    try:
        main()
    except Exception as exc:
        # Do not put the authenticated URL in a console, crash log or message box.
        message = '云端 DSH Web 未能打开。请检查 SSH 主机和云端服务。'
        if sys.stderr is not None: print(message, file=sys.stderr)
        elif os.name == 'nt': ctypes.windll.user32.MessageBoxW(None, message, 'DSH', 0x10)
        sys.exit(1)
