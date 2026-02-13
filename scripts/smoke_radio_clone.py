#!/usr/bin/env python
"""Hardware-in-the-loop clone smoke test using CHIRP clone-mode drivers."""

import argparse
import json
import os
import sys
import time


REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CHIRP_ROOT = os.path.join(REPO_ROOT, "chirp")
if CHIRP_ROOT not in sys.path:
    sys.path.insert(0, CHIRP_ROOT)

SERIAL_MODULE = None

from chirp import chirp_common, memmap


def parse_args():
    parser = argparse.ArgumentParser()
    parser.add_argument("--module", required=True, help="Driver module, e.g. h777")
    parser.add_argument("--class", dest="class_name", required=True, help="Driver class")
    parser.add_argument("--port", required=True, help="Serial port path, e.g. /dev/tty.usbserial-xxx")
    parser.add_argument("--baud", type=int, default=9600, help="Serial baud rate")
    parser.add_argument("--settle-ms", type=int, default=350, help="Signal settle delay before clone")
    parser.add_argument(
        "--max-diff-bytes",
        type=int,
        default=0,
        help="Maximum byte differences allowed between before/after downloads",
    )
    return parser.parse_args()


def import_radio_class(module_name, class_name):
    module = __import__(f"chirp.drivers.{module_name}", fromlist=[class_name])
    return getattr(module, class_name)


def status_logger(status):
    msg = getattr(status, "msg", "")
    cur = getattr(status, "cur", None)
    maxv = getattr(status, "max", None)
    if cur is None or maxv is None:
        print(f"STATUS {msg}")
    else:
        print(f"STATUS {msg}: {cur}/{maxv}")


def open_pipe(port, baud, wants_dtr, wants_rts, settle_ms):
    global SERIAL_MODULE
    if SERIAL_MODULE is None:
        try:
            import serial as serial_module  # type: ignore
        except Exception as exc:  # pragma: no cover
            print(
                "pyserial is required. Install with: python -m pip install pyserial",
                file=sys.stderr,
            )
            raise SystemExit(2) from exc
        SERIAL_MODULE = serial_module
    else:
        serial_module = SERIAL_MODULE

    pipe = serial_module.Serial(
        port=port,
        baudrate=int(baud),
        timeout=0.5,
        bytesize=serial_module.EIGHTBITS,
        parity=serial_module.PARITY_NONE,
        stopbits=serial_module.STOPBITS_ONE,
    )
    pipe.reset_input_buffer()
    pipe.reset_output_buffer()
    pipe.dtr = bool(wants_dtr)
    pipe.rts = bool(wants_rts)
    time.sleep(max(0, settle_ms) / 1000.0)
    return pipe


def run_clone_smoke(args):
    radio_cls = import_radio_class(args.module, args.class_name)
    if not issubclass(radio_cls, chirp_common.CloneModeRadio):
        raise RuntimeError("Selected driver is not clone-mode")

    wants_dtr = bool(getattr(radio_cls, "WANTS_DTR", True))
    wants_rts = bool(getattr(radio_cls, "WANTS_RTS", True))
    baud = int(getattr(radio_cls, "BAUD_RATE", args.baud) or args.baud)

    print(f"INFO Driver {args.module}.{args.class_name}")
    print(f"INFO Port {args.port} @ {baud}")
    print(f"INFO Control lines DTR={wants_dtr} RTS={wants_rts}")

    with open_pipe(args.port, baud, wants_dtr, wants_rts, args.settle_ms) as pipe_in:
        radio_in = radio_cls(pipe_in)
        radio_in.status_fn = status_logger
        radio_in.sync_in()
        before = radio_in.get_mmap().get_byte_compatible().get_packed()

    radio_out = radio_cls(memmap.MemoryMapBytes(before))
    radio_out.status_fn = status_logger
    with open_pipe(args.port, baud, wants_dtr, wants_rts, args.settle_ms) as pipe_out:
        radio_out.set_pipe(pipe_out)
        radio_out.sync_out()

    with open_pipe(args.port, baud, wants_dtr, wants_rts, args.settle_ms) as pipe_verify:
        radio_verify = radio_cls(pipe_verify)
        radio_verify.status_fn = status_logger
        radio_verify.sync_in()
        after = radio_verify.get_mmap().get_byte_compatible().get_packed()

    if len(before) != len(after):
        raise RuntimeError(
            f"Image size mismatch before={len(before)} after={len(after)}"
        )

    diff_count = sum(1 for a, b in zip(before, after) if a != b)
    ok = diff_count <= int(args.max_diff_bytes)
    result = {
        "ok": ok,
        "module": args.module,
        "className": args.class_name,
        "port": args.port,
        "baud": baud,
        "size": len(before),
        "diffBytes": diff_count,
        "maxDiffBytes": int(args.max_diff_bytes),
    }
    print(json.dumps(result))
    if not ok:
        raise RuntimeError(
            f"Verification failed: diffBytes={diff_count} exceeds maxDiffBytes={args.max_diff_bytes}"
        )


if __name__ == "__main__":
    try:
        run_clone_smoke(parse_args())
    except Exception as error:
        print(f"ERROR {error}", file=sys.stderr)
        raise
