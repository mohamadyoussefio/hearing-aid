// ============================================================================
// calibration.js — Calibration state machine (FIXED)
// ============================================================================

// Bands that match HearingAid/profile.cpp DEFAULT_PROFILE
const BANDS = [
  { index: 0, freqHz: 250, label: "250 Hz" },
  { index: 1, freqHz: 500, label: "500 Hz" },
  { index: 2, freqHz: 1000, label: "1 kHz" },
  { index: 3, freqHz: 2000, label: "2 kHz" },
  { index: 4, freqHz: 4000, label: "4 kHz" },
  { index: 5, freqHz: 8000, label: "8 kHz" },
];

export const CalState = Object.freeze({
  IDLE: "idle",
  STARTING: "starting",
  RUNNING: "running",
  COMPLETE: "complete",
  ABORTED: "aborted",
});

export class CalibrationController {
  constructor(serial, audiogram) {
    this._serial = serial;
    this._audiogram = audiogram;
    this._listeners = {};

    this._state = CalState.IDLE;
    this._currentBand = null;
    this._currentAmp = 0;
    this._results = [];
    this._bandResults = {};

    this._lineHandler = this._onLine.bind(this);
    this._watchdog = null;
    this._WATCHDOG_MS = 60_000;
  }

  on(event, cb) {
    if (!this._listeners[event]) this._listeners[event] = [];
    this._listeners[event].push(cb);
    return this;
  }

  off(event, cb) {
    if (!this._listeners[event]) return this;
    this._listeners[event] = this._listeners[event].filter((fn) => fn !== cb);
    return this;
  }

  _emit(event, ...args) {
    (this._listeners[event] || []).forEach((fn) => {
      try {
        fn(...args);
      } catch (e) {
        console.error(`Event ${event} error:`, e);
      }
    });
  }

  get state() {
    return this._state;
  }
  get isRunning() {
    return (
      this._state === CalState.STARTING || this._state === CalState.RUNNING
    );
  }

  async start() {
    if (this.isRunning) throw new Error("Calibration already running");
    if (!this._serial.connected) throw new Error("Serial port not connected");

    this._results = [];
    this._bandResults = {};
    this._currentBand = null;
    this._currentAmp = 0;
    this._audiogram.clearPoints();

    this._setState(CalState.STARTING);
    this._serial.on("line", this._lineHandler);
    this._resetWatchdog();

    try {
      await this._serial.send("CALIBRATE");
    } catch (err) {
      this._cleanup();
      this._setState(CalState.ABORTED);
      this._emit("error", err);
      throw err;
    }

    return new Promise((resolve, reject) => {
      this.on("complete", (results) => resolve(results));
      this.on("error", (err) => reject(err));
    });
  }

  async abort() {
    if (!this.isRunning) return;
    this._cleanup();
    this._setState(CalState.ABORTED);
    if (this._serial.connected) {
      try {
        await this._serial.send("DEBUG_MODE NORMAL");
      } catch (_) {}
    }
    this._emit("error", new Error("Calibration aborted by user"));
  }

  _onLine(line) {
    this._resetWatchdog();

    if (this._state === CalState.STARTING) {
      if (
        line.includes("AUDIOMETRY CALIBRATION") ||
        line.includes("Band 0") ||
        line.includes("get ready")
      ) {
        this._setState(CalState.RUNNING);
      }
    }

    if (this._state !== CalState.RUNNING) return;

    // ---- FIXED: Band start regex (handles all dash types and whitespace) ----
    const bandMatch = line.match(/Band\s+(\d+)\s*[—\-\|]+\s*([\d.]+)\s*Hz/i);
    if (bandMatch) {
      const index = parseInt(bandMatch[1], 10);
      const freqHz = parseFloat(bandMatch[2]);
      const band = BANDS.find((b) => b.index === index) || {
        index,
        freqHz,
        label: `${freqHz} Hz`,
      };

      this._currentBand = band;
      this._currentAmp = 0;
      this._audiogram.setActiveFrequency(freqHz);

      this._emit("bandStart", {
        bandIndex: index,
        freqHz,
        label: band.label,
        totalBands: BANDS.length,
      });
      return;
    }

    // ---- FIXED: Amplitude step and percentage calculation ----
    const ampMatch = line.match(/amp=([\d.]+)\s+playing/i);
    if (ampMatch) {
      const amp = parseFloat(ampMatch[1]);
      this._currentAmp = amp;

      // Ensure these match your config.h constants
      const MIN_AMP = 0.02;
      const MAX_AMP = 0.8;

      // Linear mapping: (current - start) / (total range)
      const progressPct = Math.max(
        0,
        Math.min(
          100,
          Math.round(((amp - MIN_AMP) / (MAX_AMP - MIN_AMP)) * 100),
        ),
      );

      this._emit("ampStep", {
        amplitude: amp,
        bandIndex: this._currentBand?.index ?? 0,
        freqHz: this._currentBand?.freqHz ?? 0,
        isPlaying: true,
        pct: progressPct,
      });
      return;
    }

    if (line.includes("(silence)")) {
      const MIN_AMP = 0.02;
      const MAX_AMP = 0.8;
      const progressPct = Math.max(
        0,
        Math.min(
          100,
          Math.round(
            ((this._currentAmp - MIN_AMP) / (MAX_AMP - MIN_AMP)) * 100,
          ),
        ),
      );

      this._emit("ampStep", {
        amplitude: this._currentAmp,
        bandIndex: this._currentBand?.index ?? 0,
        freqHz: this._currentBand?.freqHz ?? 0,
        isPlaying: false,
        pct: progressPct,
      });
      return;
    }

    if (line.includes("HEARD")) {
      this._emit("heard", {
        bandIndex: this._currentBand?.index ?? 0,
        freqHz: this._currentBand?.freqHz ?? 0,
        amplitude: this._currentAmp,
      });
      return;
    }

    const threshMatch = line.match(/Threshold:\s*([\d.]+)/i);
    if (threshMatch) {
      const amp = parseFloat(threshMatch[1]);
      if (this._currentBand) {
        this._bandResults[this._currentBand.index] = { amplitude: amp };
      }
      return;
    }

    if (line.includes("not reached")) {
      if (this._currentBand)
        this._bandResults[this._currentBand.index] = { amplitude: 0 };
      return;
    }

    // ---- FIXED: Gain regex to capture data properly ----
    const gainMatch = line.match(
      /Band\s+(\d+)\s*\(.*\)\s+threshold=([\d.]+)\s+gain=\+?([-\d.]+)\s*dB/i,
    );
    if (gainMatch) {
      const index = parseInt(gainMatch[1], 10);
      const amp = parseFloat(gainMatch[2]);
      const gainDB = parseFloat(gainMatch[3]);
      const band = BANDS.find((b) => b.index === index) || {
        index,
        freqHz: 0,
        label: `Band ${index}`,
      };

      const point = this._audiogram.addPoint({
        freqHz: band.freqHz,
        amplitude: amp,
        ear: "right",
        bandIndex: index,
      });

      this._results.push({
        bandIndex: index,
        freqHz: band.freqHz,
        label: band.label,
        amplitude: amp,
        dbHL: point.dbHL,
        gainDB,
      });

      this._emit("bandDone", {
        bandIndex: index,
        freqHz: band.freqHz,
        label: band.label,
        amplitude: amp,
        dbHL: point.dbHL,
        gainDB,
      });
      return;
    }

    if (
      line.includes("Calibration complete") ||
      line.includes("Hearing aid is running")
    ) {
      this._audiogram.setActiveFrequency(null);
      this._cleanup();
      this._setState(CalState.COMPLETE);
      this._emit("complete", this._results.slice());
      return;
    }
  }

  _setState(newState) {
    const prev = this._state;
    this._state = newState;
    if (prev !== newState) this._emit("stateChange", newState, prev);
  }

  _cleanup() {
    this._serial.off("line", this._lineHandler);
    this._clearWatchdog();
  }

  _resetWatchdog() {
    this._clearWatchdog();
    this._watchdog = setTimeout(() => {
      if (this.isRunning) {
        this._cleanup();
        this._setState(CalState.ABORTED);
        this._emit("error", new Error("Calibration timed out."));
      }
    }, this._WATCHDOG_MS);
  }

  _clearWatchdog() {
    if (this._watchdog !== null) {
      clearTimeout(this._watchdog);
      this._watchdog = null;
    }
  }
}
