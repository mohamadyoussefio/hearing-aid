// ============================================================================
// app.js — Top-level application controller
//
// Wires together:
//   SerialDriver        — Web Serial API connection to the Teensy
//   Audiogram           — D3.js clinical audiogram
//   CalibrationController — calibration state machine
//   EQPanel             — live EQ band sliders
//   DiagnosticsPanel    — live diagnostics + serial log
//
// Boot sequence:
//   1. Build the static DOM (tabs, sidebar, connect screen)
//   2. Wait for the user to click "Connect"
//   3. On connect: attach all serial event handlers, start diagnostics polling
//   4. On "Start Calibration": run the calibration state machine
//   5. On calibration complete: show results, update EQ panel, switch to
//      audiogram tab
// ============================================================================

import { SerialDriver } from "./serial.js";
import {
  Audiogram,
  buildAudiogramLegend,
  amplitudeToDbHL,
  severityLabel,
  severityClass,
  AUDIOGRAM_FREQS,
} from "./audiogram.js";
import { CalibrationController, CalState } from "./calibration.js";
import { EQPanel } from "./eqPanel.js";
import { DiagnosticsPanel } from "./diagnostics.js";

// ============================================================================
// Constants
// ============================================================================

const BANDS = [
  { index: 0, freqHz: 250, label: "250 Hz" },
  { index: 1, freqHz: 500, label: "500 Hz" },
  { index: 2, freqHz: 1000, label: "1 kHz" },
  { index: 3, freqHz: 2000, label: "2 kHz" },
  { index: 4, freqHz: 4000, label: "4 kHz" },
  { index: 5, freqHz: 8000, label: "8 kHz" },
];

const DEBUG_MODES = ["NORMAL", "PASSTHROUGH", "TONE", "ADC_PRINT"];

// ============================================================================
// App
// ============================================================================

class App {
  constructor() {
    // Core modules
    this.serial = new SerialDriver();
    this.audiogram = null;
    this.calibration = null;
    this.eqPanel = null;
    this.diag = null;

    // UI state
    this._activeTab = "audiogram";
    this._calState = CalState.IDLE;
    this._currentMode = "NORMAL";
    this._calResults = [];

    // Bind event handlers
    this._onSerialConnect = this._onSerialConnect.bind(this);
    this._onSerialDisconnect = this._onSerialDisconnect.bind(this);
    this._onSerialLine = this._onSerialLine.bind(this);
    this._onSerialError = this._onSerialError.bind(this);
  }

  // -----------------------------------------------------------------------
  // Boot
  // -----------------------------------------------------------------------

  init() {
    this._buildUI();
    this._bindStaticEvents();
    this._checkWebSerial();

    // Body needs to act as a flex column container for the layout
    document.body.style.display = "flex";
    document.body.style.flexDirection = "column";
    document.body.style.height = "100vh";
    document.body.style.overflow = "hidden";
  }

  // -----------------------------------------------------------------------
  // UI construction
  // -----------------------------------------------------------------------

  _buildUI() {
    // Build audiogram legend
    buildAudiogramLegend("#audiogram-legend");

    // Build calibration step progress
    this._buildCalSteps();

    // Hide the main app layout until connected
    this._showConnectScreen(true);
  }

  // -----------------------------------------------------------------------
  // Removed tab-switching (no tabs in new layout — everything is visible)
  // -----------------------------------------------------------------------

  _buildCalSteps() {
    const container = document.getElementById("cal-steps");
    if (!container) return;

    container.innerHTML = BANDS.map(
      (band, i) => `
            <div class="cal-step" id="cal-step-${i}" data-index="${i}">
                <div class="cal-step__dot">${i + 1}</div>
                <div class="cal-step__label">${band.label}</div>
            </div>
        `,
    ).join("");
  }

  // -----------------------------------------------------------------------
  // Static event bindings (survive connect/disconnect cycles)
  // -----------------------------------------------------------------------

  _bindStaticEvents() {
    // ---- Connect button ----
    document.getElementById("btn-connect")?.addEventListener("click", () => {
      this._connect();
    });

    // ---- Disconnect button ----
    document.getElementById("btn-disconnect")?.addEventListener("click", () => {
      this._disconnect();
    });

    // ---- Start Calibration button ----
    document.getElementById("btn-start-cal")?.addEventListener("click", () => {
      this._startCalibration();
    });

    // ---- Abort Calibration button ----
    document.getElementById("btn-abort-cal")?.addEventListener("click", () => {
      this._abortCalibration();
    });

    // ---- "Heard It" button  +  Space bar shortcut ----
    document.getElementById("btn-heard")?.addEventListener("click", () => {
      this._sendHeard();
    });

    document.addEventListener("keydown", (e) => {
      if (e.code === "Space" && this._calState === CalState.RUNNING) {
        e.preventDefault();
        this._sendHeard();
        this._flashHeardButton();
      }
    });

    // ---- Device mode buttons ----
    document.querySelectorAll(".mode-item").forEach((item) => {
      item.addEventListener("click", () => {
        const mode = item.dataset.mode;
        if (mode) this._setDebugMode(mode);
      });
    });

    // ---- Export audiogram button ----
    document
      .getElementById("btn-export-audiogram")
      ?.addEventListener("click", () => {
        this._exportAudiogram();
      });

    // ---- Reset EQ button ----
    document.getElementById("btn-reset-eq")?.addEventListener("click", () => {
      this._resetEQ();
    });

    // ---- Refresh diagnostics button ----
    document
      .getElementById("btn-refresh-diag")
      ?.addEventListener("click", () => {
        this.diag?.refresh();
      });
  }

  // -----------------------------------------------------------------------
  // Serial connection
  // -----------------------------------------------------------------------

  _checkWebSerial() {
    if (!("serial" in navigator)) {
      this._showAlert(
        "Web Serial API not supported",
        "Please use Chrome 89+ or Edge 89+. Firefox and Safari do not support Web Serial.",
        "danger",
      );
      document.getElementById("btn-connect")?.setAttribute("disabled", "true");
    }
  }

  async _connect() {
    this._setConnStatus("connecting", "Connecting…");
    try {
      this.serial.on("connect", this._onSerialConnect);
      this.serial.on("disconnect", this._onSerialDisconnect);
      this.serial.on("line", this._onSerialLine);
      this.serial.on("error", this._onSerialError);
      this.serial.on("raw", this._onSerialRaw.bind(this));
      await this.serial.connect();
    } catch (err) {
      this._setConnStatus("disconnected", "Disconnected");
      this.serial.off("connect", this._onSerialConnect);
      this.serial.off("disconnect", this._onSerialDisconnect);
      this.serial.off("line", this._onSerialLine);
      this.serial.off("error", this._onSerialError);
    }
  }

  async _disconnect() {
    this.calibration?.abort().catch(() => {});
    this.diag?.stop();
    await this.serial.disconnect();
  }

  // -----------------------------------------------------------------------
  // Serial event handlers
  // -----------------------------------------------------------------------

  _onSerialConnect() {
    this._setConnStatus("connected", "Connected");
    this._showConnectScreen(false);

    // Instantiate modules that need a live serial connection
    this._initModules();

    // Request the current profile to populate the EQ sliders
    setTimeout(() => {
      if (this.serial.connected) {
        this.serial.send("PROFILE").catch(() => {});
      }
    }, 800);

    this._showToast("Device connected.", "success");
  }

  _onSerialDisconnect() {
    this._setConnStatus("disconnected", "Disconnected");
    this._showConnectScreen(true);
    this._setCalState(CalState.IDLE);
    this.diag?.stop();
  }

  _onSerialLine(line) {
    // Route to EQ panel for ACK messages
    this.eqPanel?.handleSerialLine(line);

    // Route PROFILE table lines to EQ panel
    if (line.startsWith("|")) {
      this.eqPanel?.applyProfileLines([line]);
    }

    // Route to diagnostics (it has its own line handler, but also
    // allow the diagnostics panel to see all lines for its serial log)
    this.diag?.feedLine(line);
  }

  _onSerialError(err) {
    console.error("[App] Serial error:", err);
    this._showToast("Serial error: " + err.message, "danger");
  }

  _onSerialRaw({ direction, text }) {
    // Log outgoing commands to the diagnostics serial log
    if (direction === "out") {
      this.diag?.appendLog("> " + text, "sent");
    }
  }

  // -----------------------------------------------------------------------
  // Module initialisation (called after connect)
  // -----------------------------------------------------------------------

  _initModules() {
    // ---- Audiogram ----
    const agContainer = document.getElementById("audiogram-svg-container");
    if (agContainer) {
      this.audiogram = new Audiogram(agContainer);
    }

    // ---- Calibration controller ----
    this.calibration = new CalibrationController(this.serial, this.audiogram);

    this.calibration
      .on("stateChange", (state) => {
        this._setCalState(state);
      })
      .on("bandStart", (info) => {
        this._onCalBandStart(info);
      })
      .on("ampStep", (info) => {
        this._onCalAmpStep(info);
      })
      .on("heard", (info) => {
        this._onCalHeard(info);
      })
      .on("bandDone", (info) => {
        this._onCalBandDone(info);
      })
      .on("complete", (results) => {
        this._onCalComplete(results);
      })
      .on("error", (err) => {
        this._showToast("Calibration error: " + err.message, "danger");
        this._setCalState(CalState.IDLE);
      });

    // ---- EQ Panel ----
    const eqContainer = document.getElementById("eq-panel-container");
    if (eqContainer) {
      this.eqPanel = new EQPanel(eqContainer, this.serial, "horizontal");
      this.eqPanel.onGainChange((band, gainDB) => {
        this._onEQGainChanged(band, gainDB);
      });
    }

    // ---- Diagnostics Panel ----
    const diagContainer = document.getElementById("diag-panel-container");
    if (diagContainer) {
      this.diag = new DiagnosticsPanel(diagContainer, this.serial);
      this.diag.start();
    }
  }

  // -----------------------------------------------------------------------
  // Calibration flow
  // -----------------------------------------------------------------------

  async _startCalibration() {
    if (!this.serial.connected) {
      this._showToast("Connect to the device first.", "warning");
      return;
    }

    // Reset audiogram and step indicators
    this.audiogram?.clearPoints();
    this._resetCalSteps();
    this._calResults = [];

    // Show calibration UI panel
    this._setCalUIVisible(true);

    try {
      await this.calibration.start();
    } catch (err) {
      // Error is also emitted via .on('error'), so no double-toast needed
    }
  }

  async _abortCalibration() {
    await this.calibration?.abort();
    this._setCalUIVisible(false);
    this._showToast("Calibration aborted.", "warning");
  }

  /**
   * Send a HEARD command to the firmware over serial.
   * The firmware's waitForButton() checks Serial for "HEARD" so the physical
   * button is no longer required — the web interface drives calibration fully.
   */
  async _sendHeard() {
    if (!this.serial.connected || this._calState !== CalState.RUNNING) return;

    this._flashHeardButton();

    try {
      await this.serial.send("HEARD");
    } catch (err) {
      this._showToast("Failed to send HEARD: " + err.message, "danger");
    }
  }

  _flashHeardButton() {
    const btn = document.getElementById("btn-heard");
    if (!btn) return;
    btn.style.transform = "scale(0.96)";
    btn.style.boxShadow = "0 0 28px rgba(56,139,253,.7)";
    setTimeout(() => {
      btn.style.transform = "";
      btn.style.boxShadow = "";
    }, 180);
  }

  // -----------------------------------------------------------------------
  // Calibration event handlers
  // -----------------------------------------------------------------------

  _onCalBandStart(info) {
    // Activate current step
    this._activateCalStep(info.bandIndex);

    // Update frequency display
    const freqVal = document.getElementById("cal-freq-value");
    const freqUnit = document.getElementById("cal-freq-unit");
    if (freqVal && freqUnit) {
      if (info.freqHz >= 1000) {
        freqVal.textContent = (info.freqHz / 1000).toString();
        freqUnit.textContent = "kHz";
      } else {
        freqVal.textContent = info.freqHz.toString();
        freqUnit.textContent = "Hz";
      }
    }

    // Reset amplitude bar
    this._setAmpBar(0);

    // Show tone playing indicator
    this._setToneState("playing");

    // Update audiogram active frequency marker
    this.audiogram?.setActiveFrequency(info.freqHz);

    // Update sidebar stat
    this._setStat(
      "stat-current-band",
      `${info.bandIndex + 1} / ${info.totalBands}`,
    );
    this._setStat("stat-current-freq", info.label);
  }

  _onCalAmpStep(info) {
    this._setAmpBar(info.pct);
    this._setToneState(info.isPlaying ? "playing" : "silence");
    this._setStat("stat-current-amp", (info.amplitude * 100).toFixed(1) + "%");
  }

  _onCalHeard(info) {
    this._setToneState("heard");
    const dbHL = amplitudeToDbHL(info.amplitude);
    this._showToast(
      `${info.freqHz >= 1000 ? info.freqHz / 1000 + " kHz" : info.freqHz + " Hz"} — threshold: ${dbHL} dB HL`,
      "success",
    );
  }

  _onCalBandDone(info) {
    this._completeCalStep(info.bandIndex);
    this._calResults.push(info);
  }

  _onCalComplete(results) {
    this._calResults = results;

    // Update EQ sliders with calibrated gains
    const gains = new Array(BANDS.length).fill(0);
    results.forEach((r) => {
      if (r.bandIndex >= 0 && r.bandIndex < BANDS.length) {
        gains[r.bandIndex] = r.gainDB;
      }
    });
    this.eqPanel?.setGains(gains);

    // Hide calibration UI panel
    this._setCalUIVisible(false);

    // Remove active frequency line from audiogram
    this.audiogram?.setActiveFrequency(null);

    // Build and show the results table
    this._showResults(results);

    this._showToast(
      "Calibration complete. Profile applied to device.",
      "success",
    );
    this._setStat("stat-current-band", "—");
    this._setStat("stat-current-freq", "—");
    this._setStat("stat-current-amp", "—");
  }

  // -----------------------------------------------------------------------
  // EQ
  // -----------------------------------------------------------------------

  _onEQGainChanged(band, gainDB) {
    // No additional UI update needed — EQPanel handles itself
  }

  async _resetEQ() {
    if (!this.serial.connected) return;

    // Send SET_GAIN band=N gain=0.0 for all bands
    const promises = BANDS.map((b) =>
      this.serial.send(`SET_GAIN band=${b.index} gain=0.0`).catch(() => {}),
    );
    await Promise.all(promises);
    this.eqPanel?.reset();
    this._showToast("All EQ bands reset to 0 dB.", "info");
  }

  // -----------------------------------------------------------------------
  // Debug mode
  // -----------------------------------------------------------------------

  async _setDebugMode(mode) {
    if (!this.serial.connected) {
      this._showToast("Connect to the device first.", "warning");
      return;
    }

    try {
      await this.serial.send(`DEBUG_MODE ${mode}`);
      this._currentMode = mode;
      this._updateModeButtons(mode);
      this._setStat("stat-mode", mode);
      this._showToast(`Mode set to ${mode}.`, "info");
    } catch (err) {
      this._showToast("Failed to set mode: " + err.message, "danger");
    }
  }

  _updateModeButtons(activeMode) {
    document.querySelectorAll(".mode-item").forEach((item) => {
      item.classList.toggle("active", item.dataset.mode === activeMode);
    });
  }

  // -----------------------------------------------------------------------
  // Export
  // -----------------------------------------------------------------------

  _exportAudiogram() {
    if (!this.audiogram) {
      this._showToast("No audiogram data to export.", "warning");
      return;
    }

    const uri = this.audiogram.exportSVG();
    if (!uri) {
      this._showToast("Export failed.", "danger");
      return;
    }

    const a = document.createElement("a");
    a.href = uri;
    a.download = `audiogram-${new Date().toISOString().slice(0, 10)}.svg`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    this._showToast("Audiogram exported as SVG.", "success");
  }

  // -----------------------------------------------------------------------
  // Results table
  // -----------------------------------------------------------------------

  _showResults(results) {
    const container = document.getElementById("results-container");
    if (!container) return;

    if (!results || results.length === 0) {
      container.innerHTML =
        '<p class="text-muted text-sm">No calibration data.</p>';
      return;
    }

    const rows = results
      .map((r) => {
        const chipClass =
          "chip chip-" + severityClass(r.dbHL).replace("severity-chip--", "");
        const gainPct = Math.min(100, (Math.abs(r.gainDB) / 30) * 100);

        return `
            <tr>
                <td><strong>${r.label}</strong></td>
                <td>${r.freqHz >= 1000 ? r.freqHz / 1000 + " kHz" : r.freqHz + " Hz"}</td>
                <td>
                    <span class="${chipClass}">
                        ${r.dbHL} dB HL — ${severityLabel(r.dbHL)}
                    </span>
                </td>
                <td>
                    <div class="results-gain-bar">
                        <div class="results-gain-bar__track">
                            <div class="results-gain-bar__fill" style="width:${gainPct}%"></div>
                        </div>
                        <div class="results-gain-bar__value">
                            ${r.gainDB > 0 ? "+" : ""}${r.gainDB.toFixed(1)} dB
                        </div>
                    </div>
                </td>
            </tr>
            `;
      })
      .join("");

    container.innerHTML = `
            <table class="results-table">
                <thead>
                    <tr>
                        <th>Band</th>
                        <th>Frequency</th>
                        <th>Threshold</th>
                        <th>Applied Gain</th>
                    </tr>
                </thead>
                <tbody>${rows}</tbody>
            </table>
        `;

    // Make results visible
    const resultsCard = document.getElementById("results-card");
    if (resultsCard) resultsCard.classList.remove("hidden");
  }

  // -----------------------------------------------------------------------
  // Calibration UI helpers
  // -----------------------------------------------------------------------

  _setCalState(state) {
    this._calState = state;

    const btnStart = document.getElementById("btn-start-cal");
    const btnAbort = document.getElementById("btn-abort-cal");
    const btnHeard = document.getElementById("btn-heard");

    const isRunning = state === CalState.RUNNING || state === CalState.STARTING;

    if (btnStart) btnStart.disabled = isRunning;
    if (btnAbort) btnAbort.disabled = !isRunning;
    if (btnHeard) btnHeard.disabled = !isRunning;
  }

  _setCalUIVisible(visible) {
    const panel = document.getElementById("cal-panel");
    if (panel) panel.classList.toggle("hidden", !visible);
  }

  _setToneState(state) {
    const playing = document.getElementById("tone-playing-indicator");
    const silence = document.getElementById("tone-silence-indicator");
    const heard = document.getElementById("tone-heard-indicator");

    playing?.classList.add("hidden");
    silence?.classList.add("hidden");
    heard?.classList.add("hidden");

    if (state === "playing") playing?.classList.remove("hidden");
    else if (state === "silence") silence?.classList.remove("hidden");
    else if (state === "heard") heard?.classList.remove("hidden");
  }

  _setAmpBar(pct) {
    const fill = document.getElementById("cal-amp-bar-fill");
    const label = document.getElementById("cal-amp-bar-label-value");
    if (fill) fill.style.width = Math.max(2, Math.min(100, pct)) + "%";
    if (label) label.textContent = pct + "%";
  }

  _resetCalSteps() {
    BANDS.forEach((_, i) => {
      const step = document.getElementById(`cal-step-${i}`);
      if (step) {
        step.classList.remove("active", "done");
        const dot = step.querySelector(".cal-step__dot");
        if (dot) dot.textContent = String(i + 1);
      }
    });
  }

  _activateCalStep(index) {
    BANDS.forEach((_, i) => {
      const step = document.getElementById(`cal-step-${i}`);
      if (!step) return;
      if (i < index) step.className = "cal-step done";
      else if (i === index) step.className = "cal-step active";
      else step.className = "cal-step";

      const dot = step.querySelector(".cal-step__dot");
      if (dot) dot.textContent = i < index ? "✓" : String(i + 1);
    });
  }

  _completeCalStep(index) {
    const step = document.getElementById(`cal-step-${index}`);
    if (step) {
      step.className = "cal-step done";
      const dot = step.querySelector(".cal-step__dot");
      if (dot) dot.textContent = "✓";
    }
  }

  // -----------------------------------------------------------------------
  // Tab switching
  // -----------------------------------------------------------------------

  // Tab switching removed — new layout shows everything simultaneously.
  // Keeping as a no-op stub so any remaining call sites don't error.
  _switchTab(_tabName) {}

  // -----------------------------------------------------------------------
  // Connection status badge
  // -----------------------------------------------------------------------

  _setConnStatus(state, label) {
    const badge = document.getElementById("conn-badge");
    if (!badge) return;

    badge.className = "badge";
    badge.classList.add(
      state === "connected"
        ? "badge--on"
        : state === "connecting"
          ? "badge--wait"
          : "badge--off",
    );

    const dot = badge.querySelector(".badge-dot");

    // Show/hide connect / disconnect buttons
    const btnConnect = document.getElementById("btn-connect");
    const btnDisconnect = document.getElementById("btn-disconnect");

    if (state === "connected") {
      btnConnect?.classList.add("hidden");
      btnDisconnect?.classList.remove("hidden");
    } else {
      btnConnect?.classList.remove("hidden");
      btnDisconnect?.classList.add("hidden");
    }

    // Also update text
    const text = badge.querySelector(".conn-badge__text");
    if (text) text.textContent = label;
  }

  // -----------------------------------------------------------------------
  // Connect screen visibility
  // -----------------------------------------------------------------------

  _showConnectScreen(show) {
    const screen = document.getElementById("connect-screen");
    const layout = document.getElementById("app-layout");
    if (screen) screen.classList.toggle("hidden", !show);
    if (layout) layout.classList.toggle("hidden", show);

    // When the layout becomes visible, trigger a resize so D3 charts
    // measure their containers correctly after the layout is rendered.
    if (!show) {
      requestAnimationFrame(() => {
        window.dispatchEvent(new Event("resize"));
      });
    }
  }

  // -----------------------------------------------------------------------
  // Sidebar stats
  // -----------------------------------------------------------------------

  _setStat(id, value) {
    const el = document.getElementById(id);
    if (el) el.textContent = value;
  }

  // -----------------------------------------------------------------------
  // Toast notifications
  // -----------------------------------------------------------------------

  _showToast(message, type = "info") {
    const container = document.getElementById("toast-container");
    if (!container) return;

    const typeClass =
      type === "success"
        ? "alert--success"
        : type === "warning"
          ? "alert--warning"
          : type === "danger"
            ? "alert--danger"
            : "alert--info";

    const icon =
      type === "success"
        ? "✓"
        : type === "warning"
          ? "⚠"
          : type === "danger"
            ? "✗"
            : "ℹ";

    const toast = document.createElement("div");
    toast.className = `alert ${typeClass}`;
    toast.style.cssText = `
            box-shadow: var(--shadow-lg);
            min-width: 280px;
            max-width: 420px;
            animation: toast-in 0.22s ease forwards;
        `;
    toast.innerHTML = `
            <div class="alert__body" style="flex:1;">${this._escHtml(message)}</div>
            <button style="background:none;border:none;cursor:pointer;color:inherit;padding:0 0 0 8px;font-size:16px;line-height:1;opacity:0.6;"
                    onclick="this.parentElement.remove()">×</button>
        `;

    container.appendChild(toast);

    // Auto-remove after 4 seconds
    setTimeout(() => {
      toast.style.animation = "toast-out 0.2s ease forwards";
      setTimeout(() => toast.remove(), 200);
    }, 4000);
  }

  _showAlert(title, body, type = "info") {
    const typeClass =
      type === "success"
        ? "alert--success"
        : type === "warning"
          ? "alert--warning"
          : type === "danger"
            ? "alert--danger"
            : "alert--info";
    const icon = type === "danger" ? "✗" : type === "warning" ? "⚠" : "ℹ";

    const container = document.getElementById("connect-screen");
    if (!container) return;

    const el = document.createElement("div");
    el.className = `alert ${typeClass}`;
    el.style.maxWidth = "420px";
    el.innerHTML = `
            <span class="alert__icon">${icon}</span>
            <div class="alert__body">
                <div class="alert__title">${this._escHtml(title)}</div>
                <div>${this._escHtml(body)}</div>
            </div>
        `;
    container.appendChild(el);
  }

  _escHtml(str) {
    return String(str)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }
}

// ============================================================================
// Boot
// ============================================================================

const app = new App();
document.addEventListener("DOMContentLoaded", () => app.init());

// Inject toast animation keyframes once
const toastStyle = document.createElement("style");
toastStyle.textContent = `
@keyframes toast-in {
    from { opacity: 0; transform: translateX(20px); }
    to   { opacity: 1; transform: translateX(0);    }
}
@keyframes toast-out {
    from { opacity: 1; transform: translateX(0);    }
    to   { opacity: 0; transform: translateX(20px); }
}
`;
document.head.appendChild(toastStyle);
