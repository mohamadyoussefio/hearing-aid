// ============================================================================
// eqPanel.js — Live EQ Band Panel
//
// Renders six vertical band sliders (250 Hz – 8 kHz) that:
//   • Display the current gain for each band (loaded from PROFILE command)
//   • Let the user drag a slider to send SET_GAIN commands in real time
//   • Reflect gains applied by calibration (two-way sync)
//   • Show a colour-coded gain value below each slider
//   • Animate smoothly when gains are updated programmatically
//
// Usage:
//   const eq = new EQPanel('#eq-container', serialDriver);
//   eq.setGains([6, 4, 0, -2, 7, 10]);   // programmatic update (no serial send)
//   eq.onGainChange((band, gainDB) => {}); // fires after slider release + send
// ============================================================================

// Band definitions — must match DEFAULT_PROFILE in profile.cpp
const BANDS = [
  { index: 0, freqHz: 250, label: "250", unit: "Hz" },
  { index: 1, freqHz: 500, label: "500", unit: "Hz" },
  { index: 2, freqHz: 1000, label: "1", unit: "kHz" },
  { index: 3, freqHz: 2000, label: "2", unit: "kHz" },
  { index: 4, freqHz: 4000, label: "4", unit: "kHz" },
  { index: 5, freqHz: 8000, label: "8", unit: "kHz" },
];

// Slider range in dB
const GAIN_MIN = -12;
const GAIN_MAX = 30;

// Debounce delay for SET_GAIN serial sends (ms)
// Prevents flooding while the user is still dragging
const SEND_DEBOUNCE_MS = 80;

// ============================================================================
// EQPanel
// ============================================================================
export class EQPanel {
  /**
   * @param {string|HTMLElement} container  — CSS selector or DOM element
   * @param {SerialDriver}       serial     — connected SerialDriver instance
   * @param {'vertical'|'horizontal'} layout — slider orientation (default: 'vertical')
   */
  constructor(container, serial, layout = "vertical") {
    this._root =
      typeof container === "string"
        ? document.querySelector(container)
        : container;
    this._serial = serial;
    this._layout = layout; // 'vertical' | 'horizontal'
    this._gains = new Array(BANDS.length).fill(0);
    this._sliders = []; // HTMLInputElement[]
    this._labels = []; // HTMLElement[]  (gain value display)
    this._sendTimers = []; // debounce timer per band
    this._changeCb = null; // optional callback
    this._sending = false; // guard against feedback loops

    this._build();
  }

  // -----------------------------------------------------------------------
  // Public API
  // -----------------------------------------------------------------------

  /**
   * Programmatically set all six gains (e.g. after calibration completes).
   * Does NOT send SET_GAIN commands — caller has already applied them.
   * @param {number[]} gains  — array of 6 gain values in dB
   */
  setGains(gains) {
    gains.forEach((g, i) => this._setGainUI(i, g));
  }

  /**
   * Programmatically set one band's gain and update the UI.
   * Does NOT send a SET_GAIN command.
   * @param {number} band
   * @param {number} gainDB
   */
  setBandGain(band, gainDB) {
    this._setGainUI(band, gainDB);
  }

  /**
   * Return a copy of the current gain array.
   * @returns {number[]}
   */
  getGains() {
    return this._gains.slice();
  }

  /**
   * Register a callback that fires whenever the user releases a slider
   * AND the SET_GAIN command has been sent successfully.
   * @param {function} cb  — (bandIndex: number, gainDB: number) => void
   */
  onGainChange(cb) {
    this._changeCb = cb;
    return this;
  }

  /**
   * Parse a PROFILE table printed by the Teensy and update all sliders.
   * Expected format per row:  "|   N     |   FREQ   | Q.Q |  +G.G   |"
   * @param {string[]} lines  — the raw lines from the serial PROFILE response
   */
  applyProfileLines(lines) {
    lines.forEach((line) => {
      // Match table rows: |   0     |    250   | 1.2 |  +6.0   |
      const m = line.match(
        /\|\s*(\d)\s*\|[^|]+\|\s*[\d.]+\s*\|\s*([+\-]?[\d.]+)\s*\|/,
      );
      if (m) {
        const band = parseInt(m[1], 10);
        const gainDB = parseFloat(m[2]);
        if (band >= 0 && band < BANDS.length) {
          this._setGainUI(band, gainDB);
        }
      }
    });
  }

  /**
   * Reset all bands to 0 dB (visually; does NOT send serial commands).
   */
  reset() {
    this._gains.fill(0);
    this._sliders.forEach((slider, i) => {
      slider.value = String(0);
      this._updateLabel(i, 0);
      this._updateTrack(i, 0);
    });
  }

  // -----------------------------------------------------------------------
  // Build DOM
  // -----------------------------------------------------------------------

  _build() {
    this._root.innerHTML = "";

    if (this._layout === "horizontal") {
      this._buildHorizontal();
    } else {
      this._buildVertical();
    }
  }

  _buildVertical() {
    // Outer wrapper
    const wrap = document.createElement("div");
    wrap.className = "eq-grid";
    this._root.appendChild(wrap);

    BANDS.forEach((band) => {
      const col = this._buildBand(band);
      wrap.appendChild(col);
      this._sendTimers.push(null);
    });

    // Hint
    const hint = document.createElement("p");
    hint.className = "text-xs text-subtle mt-4";
    hint.style.textAlign = "center";
    hint.textContent =
      "Drag sliders to adjust gain per band. Changes are sent to the device in real time.";
    this._root.appendChild(hint);
  }

  _buildHorizontal() {
    // Each band is a horizontal row: [freq label] [slider] [gain value]
    BANDS.forEach((band) => {
      const row = document.createElement("div");
      row.className = "eq-band";
      row.dataset.bandIndex = band.index;

      // Frequency label
      const freqLabel = document.createElement("div");
      freqLabel.className = "eq-band__freq";
      freqLabel.innerHTML = `<span>${band.label}</span><span style="color:var(--text-muted);margin-left:1px;">${band.unit}</span>`;
      row.appendChild(freqLabel);

      // Slider wrapper
      const sliderWrap = document.createElement("div");
      sliderWrap.className = "eq-band__slider-wrap";
      row.appendChild(sliderWrap);

      // Horizontal slider
      const slider = document.createElement("input");
      slider.type = "range";
      slider.className = "eq-band__slider";
      slider.min = String(GAIN_MIN);
      slider.max = String(GAIN_MAX);
      slider.step = "0.5";
      slider.value = "0";
      slider.setAttribute("aria-label", `${band.label} ${band.unit} gain`);
      sliderWrap.appendChild(slider);
      this._sliders.push(slider);

      // Gain value label
      const gainLabel = document.createElement("div");
      gainLabel.className = "eq-band__gain eq-band__gain--zero";
      gainLabel.textContent = "0.0 dB";
      gainLabel.id = `eq-gain-${band.index}`;
      row.appendChild(gainLabel);
      this._labels.push(gainLabel);

      // Wire events
      slider.addEventListener("input", () => {
        const val = parseFloat(slider.value);
        this._gains[band.index] = val;
        this._updateLabel(band.index, val);
        this._updateTrack(band.index, val);
        this._scheduleSend(band.index, val);
      });
      slider.addEventListener("change", () => {
        this._flushSend(band.index, parseFloat(slider.value));
      });
      slider.addEventListener("keyup", (e) => {
        if (
          [
            "ArrowUp",
            "ArrowDown",
            "ArrowLeft",
            "ArrowRight",
            "PageUp",
            "PageDown",
            "Home",
            "End",
          ].includes(e.key)
        ) {
          this._flushSend(band.index, parseFloat(slider.value));
        }
      });

      // Apply initial track gradient
      this._updateTrack(band.index, 0);

      this._sendTimers.push(null);
      this._root.appendChild(row);
    });
  }

  _buildBand(band) {
    const col = document.createElement("div");
    col.className = "eq-band";
    col.dataset.bandIndex = band.index;

    // ---- Frequency label (top) ----
    const freqLabel = document.createElement("div");
    freqLabel.className = "eq-band__freq";
    freqLabel.innerHTML =
      `<span style="font-size:var(--text-md);font-weight:var(--weight-semibold);">` +
      `${band.label}</span>` +
      `<span style="font-size:var(--text-xs);color:var(--clr-text-subtle);margin-left:1px;">` +
      `${band.unit}</span>`;
    col.appendChild(freqLabel);

    // ---- Gain value display ----
    const gainLabel = document.createElement("div");
    gainLabel.className = "eq-band__gain eq-band__gain--zero";
    gainLabel.textContent = "0.0 dB";
    gainLabel.id = `eq-gain-${band.index}`;
    col.appendChild(gainLabel);
    this._labels.push(gainLabel);

    // ---- Slider wrapper ----
    const sliderWrap = document.createElement("div");
    sliderWrap.className = "eq-band__slider-wrap";
    col.appendChild(sliderWrap);

    // ---- Vertical slider ----
    const slider = document.createElement("input");
    slider.type = "range";
    slider.className = "eq-band__slider";
    slider.min = String(GAIN_MIN);
    slider.max = String(GAIN_MAX);
    slider.step = "0.5";
    slider.value = "0";
    slider.setAttribute("aria-label", `${band.label} ${band.unit} gain`);
    sliderWrap.appendChild(slider);
    this._sliders.push(slider);

    // ---- Track fill update on input ----
    slider.addEventListener("input", () => {
      const val = parseFloat(slider.value);
      this._gains[band.index] = val;
      this._updateLabel(band.index, val);
      this._updateTrack(band.index, val);
      this._scheduleSend(band.index, val);
    });

    // ---- On mouse/touch release, send immediately (flush debounce) ----
    slider.addEventListener("change", () => {
      const val = parseFloat(slider.value);
      this._flushSend(band.index, val);
    });

    // ---- Keyboard support: arrow keys send on keyup ----
    slider.addEventListener("keyup", (e) => {
      if (
        [
          "ArrowUp",
          "ArrowDown",
          "ArrowLeft",
          "ArrowRight",
          "PageUp",
          "PageDown",
          "Home",
          "End",
        ].includes(e.key)
      ) {
        const val = parseFloat(slider.value);
        this._flushSend(band.index, val);
      }
    });

    // ---- dB scale markers on the right of the slider ----
    const markers = this._buildMarkers();
    sliderWrap.appendChild(markers);

    // Apply initial track gradient
    this._updateTrack(band.index, 0);

    return col;
  }

  /** Build small tick marks: +30, +20, +10, 0, -10 dB */
  _buildMarkers() {
    const markerWrap = document.createElement("div");
    markerWrap.style.cssText = `
            position: absolute;
            right: -28px;
            top: 0; bottom: 0;
            display: flex;
            flex-direction: column;
            justify-content: space-between;
            pointer-events: none;
        `;

    const ticks = [GAIN_MAX, 20, 10, 0, GAIN_MIN];
    ticks.forEach((db) => {
      const pct = (GAIN_MAX - db) / (GAIN_MAX - GAIN_MIN);
      const tick = document.createElement("div");
      tick.style.cssText = `
                position: absolute;
                top: ${pct * 100}%;
                transform: translateY(-50%);
                font-size: 9px;
                color: var(--clr-text-subtle);
                white-space: nowrap;
                font-family: var(--font-mono);
                line-height: 1;
            `;
      tick.textContent = (db > 0 ? "+" : "") + db;
      markerWrap.appendChild(tick);
    });

    return markerWrap;
  }

  // -----------------------------------------------------------------------
  // UI update helpers
  // -----------------------------------------------------------------------

  /**
   * Update slider position and label without sending a serial command.
   */
  _setGainUI(bandIndex, gainDB) {
    const clamped = Math.max(GAIN_MIN, Math.min(GAIN_MAX, gainDB));
    this._gains[bandIndex] = clamped;

    const slider = this._sliders[bandIndex];
    if (slider) slider.value = String(clamped);

    this._updateLabel(bandIndex, clamped);
    this._updateTrack(bandIndex, clamped);
  }

  /**
   * Update the gain value label below the slider.
   */
  _updateLabel(bandIndex, gainDB) {
    const el = this._labels[bandIndex];
    if (!el) return;

    const text = (gainDB >= 0 ? "+" : "") + gainDB.toFixed(1) + " dB";
    el.textContent = text;

    // Remove all modifier classes then add the correct one
    el.className =
      "eq-band__gain " +
      (gainDB > 0.1
        ? "eq-band__gain--positive"
        : gainDB < -0.1
          ? "eq-band__gain--negative"
          : "eq-band__gain--zero");
  }

  /**
   * Update the CSS linear-gradient track fill behind the slider thumb.
   * Positive gain → blue fill above zero; negative → red fill below zero.
   */
  _updateTrack(bandIndex, gainDB) {
    const slider = this._sliders[bandIndex];
    if (!slider) return;

    const range = GAIN_MAX - GAIN_MIN;
    const zeroPct = ((GAIN_MAX - 0) / range) * 100; // position of 0 dB
    const valPct = ((GAIN_MAX - gainDB) / range) * 100; // position of current value

    // The slider is rotated -90deg so "top" of visual = high dB
    // In CSS terms, the fill goes from valPct% to zeroPct% (or reverse)
    const low = Math.min(zeroPct, valPct);
    const high = Math.max(zeroPct, valPct);

    const color = gainDB >= 0 ? "var(--accent)" : "var(--clr-danger)";

    slider.style.background = [
      `linear-gradient(to right,`,
      `  var(--bg-overlay) 0%,`,
      `  var(--bg-overlay) ${low}%,`,
      `  ${color} ${low}%,`,
      `  ${color} ${high}%,`,
      `  var(--bg-overlay) ${high}%,`,
      `  var(--bg-overlay) 100%`,
      `)`,
    ].join(" ");
  }

  // -----------------------------------------------------------------------
  // Serial send helpers
  // -----------------------------------------------------------------------

  /**
   * Schedule a debounced SET_GAIN send.
   * Resets the timer every time the slider moves, so we only send
   * once the user pauses dragging.
   */
  _scheduleSend(bandIndex, gainDB) {
    if (this._sendTimers[bandIndex] !== null) {
      clearTimeout(this._sendTimers[bandIndex]);
    }
    this._sendTimers[bandIndex] = setTimeout(() => {
      this._sendTimers[bandIndex] = null;
      this._sendGain(bandIndex, gainDB);
    }, SEND_DEBOUNCE_MS);
  }

  /**
   * Flush the debounce timer and send immediately.
   * Called on mouseup / touchend / keyup so the final value is sent promptly.
   */
  _flushSend(bandIndex, gainDB) {
    if (this._sendTimers[bandIndex] !== null) {
      clearTimeout(this._sendTimers[bandIndex]);
      this._sendTimers[bandIndex] = null;
    }
    this._sendGain(bandIndex, gainDB);
  }

  /**
   * Send SET_GAIN band=N gain=G.G over serial.
   */
  async _sendGain(bandIndex, gainDB) {
    if (!this._serial?.connected) return;

    const cmd = `SET_GAIN band=${bandIndex} gain=${gainDB.toFixed(1)}`;

    try {
      await this._serial.send(cmd);
      if (this._changeCb) this._changeCb(bandIndex, gainDB);
    } catch (err) {
      console.error("[EQPanel] Failed to send gain:", err);
    }
  }

  // -----------------------------------------------------------------------
  // Parse incoming SET_GAIN ACK from the Teensy
  // "ACK  band=4  gain=10.5 dB"
  // -----------------------------------------------------------------------

  /**
   * Call this from the serial 'line' event handler in app.js to keep
   * the panel in sync with ACK messages from the Teensy.
   * @param {string} line
   * @returns {boolean}  true if the line was consumed
   */
  handleSerialLine(line) {
    const m = line.match(/ACK\s+band=(\d+)\s+gain=([-\d.]+)\s*dB/i);
    if (m) {
      const band = parseInt(m[1], 10);
      const gainDB = parseFloat(m[2]);
      // Update UI without re-sending (prevents feedback loop)
      this._setGainUI(band, gainDB);
      return true;
    }
    return false;
  }
}
