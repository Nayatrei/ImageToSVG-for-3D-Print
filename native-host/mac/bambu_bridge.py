#!/usr/bin/env python3
import json
import os
import struct
import subprocess
import sys
from pathlib import Path


HOST_APP_NAMES = ["Bambu Studio.app", "BambuStudio.app"]
COMMON_APP_PATHS = [
    *(Path("/Applications") / name for name in HOST_APP_NAMES),
    *(Path.home() / "Applications" / name for name in HOST_APP_NAMES),
]


def read_message():
    raw_length = sys.stdin.buffer.read(4)
    if not raw_length:
        return None
    if len(raw_length) != 4:
        raise RuntimeError("Invalid native messaging frame header.")
    message_length = struct.unpack("<I", raw_length)[0]
    payload = sys.stdin.buffer.read(message_length)
    if len(payload) != message_length:
        raise RuntimeError("Incomplete native messaging payload.")
    return json.loads(payload.decode("utf-8"))


def write_message(message):
    payload = json.dumps(message).encode("utf-8")
    sys.stdout.buffer.write(struct.pack("<I", len(payload)))
    sys.stdout.buffer.write(payload)
    sys.stdout.buffer.flush()


def find_bambu_studio():
    for candidate in COMMON_APP_PATHS:
        if candidate.exists():
            return str(candidate)

    try:
        for app_name in HOST_APP_NAMES:
            result = subprocess.run(
                ["mdfind", f"kMDItemFSName == '{app_name}'"],
                capture_output=True,
                text=True,
                check=False
            )
            path = next((line.strip() for line in result.stdout.splitlines() if line.strip().endswith(app_name)), "")
            if path:
                return path
        return ""
    except Exception:
        return ""


def handle_probe():
    app_path = find_bambu_studio()
    return {
        "ok": True,
        "available": bool(app_path),
        "appPath": app_path
    }


def handle_open(path_value):
    path = Path(path_value or "").expanduser()
    if not path.exists():
        return {
            "ok": False,
            "opened": False,
            "code": "missing_path",
            "message": "The Bambu Studio project file does not exist."
        }

    app_path = find_bambu_studio()
    try:
        if app_path:
            subprocess.run(["open", "-a", app_path, str(path)], check=True)
            return {
                "ok": True,
                "opened": True,
                "path": str(path),
                "appPath": app_path
            }

        subprocess.run(["open", str(path)], check=True)
        return {
            "ok": True,
            "opened": True,
            "path": str(path),
            "message": "Bambu Studio was not found, so macOS used the default .3mf app."
        }
    except subprocess.CalledProcessError as error:
        return {
            "ok": False,
            "opened": False,
            "code": "open_failed",
            "message": str(error)
        }


def main():
    try:
        message = read_message()
        if message is None:
            return

        msg_type = message.get("type")
        if msg_type == "probe-bambu-studio":
            write_message(handle_probe())
            return
        if msg_type == "open-bambu-project":
            write_message(handle_open(message.get("path", "")))
            return

        write_message({
            "ok": False,
            "code": "unsupported_type",
            "message": f"Unsupported message type: {msg_type}"
        })
    except Exception as error:
        write_message({
            "ok": False,
            "code": "bridge_error",
            "message": str(error)
        })


if __name__ == "__main__":
    main()
