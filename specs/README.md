# TLA+ models

`SerialBridge.tla` models the port lifecycle of `SerialBridge`
(`web/js/serial-bridge.ts`): one TLA+ action per stretch of JavaScript between
two awaits, with the read loops, the teardown continuations and the transport
interleaving at those awaits under the JavaScript event loop's rule (a
macrotask runs only once no continuation is runnable). The module's header
lists what it leaves out.

A change to `serial-bridge.ts` that adds, removes or moves an `await`, or
changes what a stretch between two of them does, updates the matching action
and reruns the models.

## Running

TLC needs Java 11 or later and `tla2tools.jar` from
<https://github.com/tlaplus/tlaplus/releases> (checked with v1.8.0). Keep the
jar outside the repository.

```sh
cd specs
java -cp /path/to/tla2tools.jar tlc2.TLC -workers auto -config SerialBridge.cfg SerialBridge.tla
```

Each configuration takes seconds. TLC stops at the first property that fails;
to see every failing property of a configuration, copy its `CONSTANTS` block
into a configuration that lists one invariant or property at a time.

## Configurations

| Configuration | What it adds to the baseline |
| --- | --- |
| `SerialBridge.cfg` | The baseline: `reconfigure: "reopen"` (native Web Serial, WebUSB), every transport promise settles, a device that goes stays gone. |
| `SerialBridgeUpdate.cfg` | `reconfigure: "update"` (WebBluetooth, node-serialport). |
| `SerialBridgeReplug.cfg` | A device that went away can come back. |
| `SerialBridgeIoHangs.cfg` | A close or a reader cancel may never settle (`SpecIoCanHang`). |

What each configuration currently finds is recorded in `FINDINGS.md` under
"Serial bridge".
