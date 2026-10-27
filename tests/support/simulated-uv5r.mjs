// A Baofeng UV-5R on the far end of the serial bridge: it answers the clone
// protocol chirp/chirp/drivers/uv5r.py speaks (_do_ident, _read_block,
// _send_block) from a radio memory seeded with a CHIRP image, so a test can
// run the real driver's sync_out end to end without hardware. Hand it to
// createTestRadioHarness({serialBridge}) in place of the stub bridge.
//
// The radio's address space and the image's offsets differ by the 8-byte
// ident the image starts with: radio 0x0000-0x1800 is image 0x0008-0x1808,
// and the aux block at radio 0x1EC0-0x2000 is image 0x1808-0x1948.

const ACK = 0x06;
const NAK = 0x15;
const READ_COMMAND = 0x53; // "S"
const WRITE_COMMAND = 0x58; // "X"
const MAGIC_LENGTH = 7;
const MAIN_START = 0x0008;
const MAIN_END = 0x1808;
const AUX_RADIO_START = 0x1ec0;
const AUX_IMAGE_END = 0x1948;

export class SimulatedUv5rBridge {
  /**
   * @param {Uint8Array} image  A UV-5R image, e.g. chirp/tests/images/Baofeng_UV-5R.img.
   * @param {{refuseWriteAt?: number}} [faults]  refuseWriteAt: the radio address
   *   whose block write the radio answers with a NAK instead of storing it.
   */
  constructor(image, { refuseWriteAt } = {}) {
    this.refuseWriteAt = refuseWriteAt ?? null;
    this.memory = new Uint8Array(0x2000).fill(0xff);
    this.memory.set(image.subarray(MAIN_START, MAIN_END), 0x0000);
    this.memory.set(image.subarray(MAIN_END, AUX_IMAGE_END), AUX_RADIO_START);
    this.ident = Array.from(image.subarray(0, 8));
    // The radio addresses every block write landed at, in order, so a test can
    // tell a finished upload from one the driver abandoned part way.
    /** @type {number[]} */
    this.writtenAddresses = [];
    this.transport = "webserial";
    this.resetSession();
  }

  // Back to waiting for the program-mode magic, as a radio is after a clone
  // session ends; prepareClone() calls it so each clone starts from there.
  resetSession() {
    /** @type {number[]} */
    this.incoming = [];
    /** @type {number[]} */
    this.outgoing = [];
    this.phase = "magic";
    this.readsServed = 0;
  }

  // Consume whatever complete requests the host has written and queue the
  // radio's answers. Returns once the next request is still incomplete.
  processIncoming() {
    for (;;) {
      if (this.phase === "magic") {
        if (this.incoming.length < MAGIC_LENGTH) return;
        this.incoming.splice(0, MAGIC_LENGTH);
        this.outgoing.push(ACK);
        this.phase = "ident";
      } else if (this.phase === "ident") {
        if (this.incoming.length < 1) return;
        this.expectByte(0x02);
        this.outgoing.push(...this.ident);
        this.phase = "secondack";
      } else if (this.phase === "secondack") {
        if (this.incoming.length < 1) return;
        this.expectByte(ACK);
        this.outgoing.push(ACK);
        this.phase = "command";
      } else if (!this.processCommand()) {
        return;
      }
    }
  }

  // One read, block write or host acknowledgement; false while the request at
  // the head of the queue is still incomplete.
  processCommand() {
    const [command, addrHigh, addrLow, size] = this.incoming;
    if (command === undefined) return false;
    if (command === ACK) {
      // The host's acknowledgement of a block the radio just sent.
      this.incoming.shift();
      return true;
    }
    if (this.incoming.length < 4) return false;
    const addr = (addrHigh << 8) | addrLow;
    if (command === READ_COMMAND) {
      this.incoming.splice(0, 4);
      // _read_block expects an ack before every block but the session's first.
      if (this.readsServed > 0) this.outgoing.push(ACK);
      this.outgoing.push(WRITE_COMMAND, addrHigh, addrLow, size);
      this.outgoing.push(...this.memory.subarray(addr, addr + size));
      this.readsServed += 1;
      return true;
    }
    if (command === WRITE_COMMAND) {
      if (this.incoming.length < 4 + size) return false;
      const data = this.incoming.splice(0, 4 + size).slice(4);
      if (addr === this.refuseWriteAt) {
        this.outgoing.push(NAK);
        return true;
      }
      this.memory.set(data, addr);
      this.writtenAddresses.push(addr);
      this.outgoing.push(ACK);
      return true;
    }
    throw new Error(`Simulated UV-5R got an unexpected byte 0x${command.toString(16)}`);
  }

  /** @param {number} expected */
  expectByte(expected) {
    const got = this.incoming.shift();
    if (got !== expected) {
      throw new Error(
        `Simulated UV-5R expected 0x${expected.toString(16)} in ${this.phase}, got 0x${Number(got).toString(16)}`,
      );
    }
  }

  async open() {
    return { connected: true, message: "simulated UV-5R open" };
  }

  async close() {
    return { connected: false, message: "simulated UV-5R close" };
  }

  async writeHex() {
    return { written: 0, hex: "" };
  }

  async readHex() {
    return { read: 0, hex: "", timedOut: true };
  }

  /** @param {number[]} bytes */
  async writeBytes(bytes) {
    this.incoming.push(...bytes);
    this.processIncoming();
    return { written: bytes.length };
  }

  // Answers are queued by the write that asks for them, so a read never has to
  // wait: an empty queue is the same as the radio staying silent to timeout.
  /** @param {number} count */
  async readBytes(count) {
    return this.outgoing.splice(0, Number(count) || 0);
  }

  async inWaiting() {
    return { available: this.outgoing.length };
  }

  async resetBuffers() {
    this.outgoing.length = 0;
    return { reset: true };
  }

  /**
   * @param {boolean} _wantsDtr
   * @param {boolean} _wantsRts
   * @param {number} _settleMs
   * @param {number} baudRate
   */
  async prepareClone(_wantsDtr, _wantsRts, _settleMs, baudRate) {
    this.resetSession();
    return { prepared: true, settleMs: 0, baudRate: Number(baudRate || 0), transport: this.transport };
  }

  async setSignals() {
    return { applied: true };
  }

  /** @param {Record<string, unknown>} [options] */
  async reconfigure(options = {}) {
    return { reconfigured: false, options, changed: [] };
  }
}
