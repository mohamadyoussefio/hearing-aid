// ============================================================================
// serial.js — Web Serial API driver
//
// Wraps the browser's navigator.serial API into a simple event-driven class.
//
// Usage:
//   const port = new SerialDriver();
//   port.on('line', (line) => console.log('received:', line));
//   port.on('connect', () => console.log('connected'));
//   port.on('disconnect', () => console.log('disconnected'));
//   port.on('error', (err) => console.error(err));
//   await port.connect();   // opens the browser port-picker
//   await port.send('DIAG');
//   await port.disconnect();
// ============================================================================

export class SerialDriver {
  // Baud rate must match HearingAid.ino (115200)
  static BAUD_RATE = 115200;

  constructor() {
    this._port = null;
    this._reader = null;
    this._writer = null;
    this._readLoop = null;
    this._listeners = {}; // event → [callback, ...]
    this._lineBuffer = "";
    this._connected = false;
  }

  // -----------------------------------------------------------------------
  // Event emitter helpers
  // -----------------------------------------------------------------------

  /**
   * Register a listener for an event.
   * Events: 'line' | 'connect' | 'disconnect' | 'error' | 'raw'
   */
  on(event, cb) {
    if (!this._listeners[event]) this._listeners[event] = [];
    this._listeners[event].push(cb);
    return this; // allow chaining
  }

  /** Remove a previously registered listener. */
  off(event, cb) {
    if (!this._listeners[event]) return this;
    this._listeners[event] = this._listeners[event].filter((fn) => fn !== cb);
    return this;
  }

  /** Emit an event to all registered listeners. */
  _emit(event, ...args) {
    (this._listeners[event] || []).forEach((fn) => {
      try {
        fn(...args);
      } catch (e) {
        console.error("[SerialDriver] listener threw:", e);
      }
    });
  }

  // -----------------------------------------------------------------------
  // Public API
  // -----------------------------------------------------------------------

  /** True if the serial port is currently open. */
  get connected() {
    return this._connected;
  }

  /**
   * Open the browser serial-port picker and connect.
   * Resolves when the port is open and the read loop has started.
   * Rejects if the user cancels the picker or the port fails to open.
   */
  async connect() {
    if (this._connected) return;

    // Check Web Serial API availability
    if (!("serial" in navigator)) {
      const msg = "Web Serial API not available. Use Chrome or Edge 89+.";
      this._emit("error", new Error(msg));
      throw new Error(msg);
    }

    try {
      // Show the browser port picker; the user selects the Teensy's COM port
      this._port = await navigator.serial.requestPort({
        filters: [
          // Teensy USB Vendor ID  (PJRC) — if defined, only shows Teensys
          { usbVendorId: 0x16c0 },
        ],
      });
    } catch (err) {
      // User cancelled the picker — not really an error
      if (err.name === "NotFoundError" || err.message.includes("cancelled")) {
        return;
      }
      this._emit("error", err);
      throw err;
    }

    try {
      await this._port.open({
        baudRate: SerialDriver.BAUD_RATE,
        dataBits: 8,
        stopBits: 1,
        parity: "none",
        flowControl: "none",
      });
    } catch (err) {
      this._emit("error", err);
      throw err;
    }

    this._connected = true;
    this._lineBuffer = "";

    // Set up writer
    const textEncoder = new TextEncoderStream();
    textEncoder.readable.pipeTo(this._port.writable).catch(() => {});
    this._writer = textEncoder.writable.getWriter();

    // Start the async read loop
    this._readLoop = this._startReadLoop();

    // Listen for the port being physically unplugged
    navigator.serial.addEventListener("disconnect", this._onPortDisconnect);

    this._emit("connect");
  }

  /**
   * Gracefully close the serial port.
   */
  async disconnect() {
    if (!this._connected) return;
    this._connected = false;

    navigator.serial.removeEventListener("disconnect", this._onPortDisconnect);

    try {
      if (this._reader) {
        await this._reader.cancel();
        this._reader = null;
      }
    } catch (_) {
      /* ignore */
    }

    try {
      if (this._writer) {
        await this._writer.close();
        this._writer = null;
      }
    } catch (_) {
      /* ignore */
    }

    try {
      if (this._port && this._port.readable === null) {
        /* already closed */
      } else if (this._port) {
        await this._port.close();
      }
    } catch (_) {
      /* ignore */
    }

    this._port = null;
    this._emit("disconnect");
  }

  /**
   * Send a command string to the Teensy.
   * A newline is appended automatically (matches Serial.readStringUntil('\n')).
   * @param {string} cmd  — e.g. 'DIAG' or 'SET_GAIN band=4 gain=10.5'
   */
  async send(cmd) {
    if (!this._connected || !this._writer) {
      throw new Error("Not connected");
    }
    const line = cmd.endsWith("\n") ? cmd : cmd + "\n";
    await this._writer.write(line);
    this._emit("raw", { direction: "out", text: cmd.trim() });
  }

  // -----------------------------------------------------------------------
  // Internal — read loop
  // -----------------------------------------------------------------------

  /**
   * Continuously read bytes from the port, decode as UTF-8, and emit
   * a 'line' event for each complete newline-terminated line.
   */
  async _startReadLoop() {
    const decoder = new TextDecoderStream();
    this._port.readable.pipeTo(decoder.writable).catch(() => {});
    const reader = decoder.readable.getReader();
    this._reader = reader;

    try {
      while (this._connected) {
        const { value, done } = await reader.read();
        if (done) break;
        if (!value) continue;

        this._emit("raw", { direction: "in", text: value });

        // Split incoming text on newlines, handling \r\n and \n
        this._lineBuffer += value;
        const parts = this._lineBuffer.split(/\r?\n/);

        // All parts except the last are complete lines
        for (let i = 0; i < parts.length - 1; i++) {
          const line = parts[i].trim();
          if (line.length > 0) {
            this._emit("line", line);
          }
        }
        // The last part is a partial line — keep it buffered
        this._lineBuffer = parts[parts.length - 1];
      }
    } catch (err) {
      if (this._connected) {
        // Unexpected error (e.g. device unplugged mid-read)
        this._emit("error", err);
        await this.disconnect();
      }
    } finally {
      try {
        reader.releaseLock();
      } catch (_) {
        /* ignore */
      }
    }
  }

  /**
   * Called when the OS reports the serial device was physically disconnected.
   */
  _onPortDisconnect = async (event) => {
    if (this._port && event.target === this._port) {
      this._connected = false;
      this._reader = null;
      this._writer = null;
      this._port = null;
      this._emit("disconnect");
    }
  };

  // -----------------------------------------------------------------------
  // Convenience helpers
  // -----------------------------------------------------------------------

  /**
   * Send a command and wait for the Teensy's acknowledgement line.
   * @param {string} cmd        — command to send
   * @param {string} ackPrefix  — expected prefix of the reply line
   * @param {number} timeoutMs  — give up after this many milliseconds
   * @returns {Promise<string>} — the full acknowledgement line
   */
  sendAndWait(cmd, ackPrefix, timeoutMs = 3000) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.off("line", handler);
        reject(new Error(`Timeout waiting for '${ackPrefix}'`));
      }, timeoutMs);

      const handler = (line) => {
        if (line.startsWith(ackPrefix)) {
          clearTimeout(timer);
          this.off("line", handler);
          resolve(line);
        }
      };

      this.on("line", handler);
      this.send(cmd).catch((err) => {
        clearTimeout(timer);
        this.off("line", handler);
        reject(err);
      });
    });
  }

  /**
   * Collect all lines received for durationMs and return them as an array.
   * Useful for capturing a multi-line DIAG report.
   * @param {string} triggerCmd  — command to send first
   * @param {string} endMarker   — line that signals the report is complete
   * @param {number} timeoutMs
   * @returns {Promise<string[]>}
   */
  sendAndCollect(triggerCmd, endMarker, timeoutMs = 4000) {
    return new Promise((resolve, reject) => {
      const lines = [];

      const timer = setTimeout(() => {
        this.off("line", handler);
        // Return whatever was collected even if end marker not seen
        resolve(lines);
      }, timeoutMs);

      const handler = (line) => {
        lines.push(line);
        if (line.includes(endMarker)) {
          clearTimeout(timer);
          this.off("line", handler);
          resolve(lines);
        }
      };

      this.on("line", handler);
      this.send(triggerCmd).catch((err) => {
        clearTimeout(timer);
        this.off("line", handler);
        reject(err);
      });
    });
  }
}
