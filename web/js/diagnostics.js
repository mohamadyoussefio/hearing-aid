// ============================================================================
// diagnostics.js — Live Diagnostics Panel
//
// Parses the structured DIAG output from the Teensy and renders:
//   • Key metric cards: CPU usage, memory, input peak, output peak, limiter hits
//   • Animated peak-level bars (input / output)
//   • A rolling 60-second sparkline chart for CPU usage (D3.js)
//   • A rolling 60-second sparkline chart for input/output peaks
//   • Status indicators: [OK] / [WARN] / [FAIL] parsed from the serial text
//   • Auto-refresh every DIAG_INTERVAL_MS (2000 ms) via a periodic DIAG command
//
// Usage:
//   const diag = new DiagnosticsPanel('#diag-container', serialDriver);
//   diag.start();    // begin auto-polling
//   diag.stop();     // stop auto-polling
//   diag.refresh();  // request one immediate update
// ============================================================================

// How often to request a DIAG snapshot (ms) — matches DIAG_INTERVAL_MS in config.h
const POLL_INTERVAL_MS = 2500;

// How many history points to keep in the sparkline (one per poll)
const HISTORY_LEN = 60;

// Threshold for [WARN] status on CPU
const CPU_WARN_PCT = 60;
const CPU_FAIL_PCT = 85;
const PEAK_WARN = 0.85;
const PEAK_FAIL = 0.95;

// ============================================================================
// DiagnosticsParser
// Stateless helper — converts an array of raw DIAG lines into a structured
// snapshot object.
// ============================================================================
class DiagnosticsParser {
  /**
   * Parse a block of DIAG lines into a snapshot object.
   *
   * Example Teensy output block:
   *   ========== DIAGNOSTICS ==========
   *   Mode        : NORMAL
   *   CPU usage   : 12.4 %  (max 18.7 %)
   *   Audio mem   : 4 blocks used  (max 5, allocated 12)
   *   Input peak  : 0.2341  [####----------------]
   *   Output peak : 0.3120  [######--------------]
   *   Limiter hits: 0
   *   [OK]  All checks passed.
   *   =================================
   *
   * @param  {string[]} lines
   * @returns {DiagSnapshot|null}
   */
  static parse(lines) {
    const snap = {
      mode: "UNKNOWN",
      cpuPct: null,
      cpuMaxPct: null,
      memUsed: null,
      memMax: null,
      memAllocated: null,
      peakInput: null,
      peakOutput: null,
      limiterHits: null,
      statuses: [], // { level: 'ok'|'warn'|'fail'|'info', text: string }
      raw: lines.join("\n"),
      timestamp: Date.now(),
    };

    for (const line of lines) {
      // Mode
      const modeM = line.match(/Mode\s*:\s*(\w+)/i);
      if (modeM) {
        snap.mode = modeM[1].toUpperCase();
        continue;
      }

      // CPU usage   : 12.4 %  (max 18.7 %)
      const cpuM = line.match(/CPU usage\s*:\s*([\d.]+)\s*%.*max\s*([\d.]+)/i);
      if (cpuM) {
        snap.cpuPct = parseFloat(cpuM[1]);
        snap.cpuMaxPct = parseFloat(cpuM[2]);
        continue;
      }

      // Audio mem   : 4 blocks used  (max 5, allocated 12)
      const memM = line.match(
        /Audio mem\s*:\s*(\d+)\s*blocks.*max\s+(\d+).*allocated\s+(\d+)/i,
      );
      if (memM) {
        snap.memUsed = parseInt(memM[1], 10);
        snap.memMax = parseInt(memM[2], 10);
        snap.memAllocated = parseInt(memM[3], 10);
        continue;
      }

      // Input peak  : 0.2341  [####----------------]
      const inM = line.match(/Input peak\s*:\s*([\d.]+)/i);
      if (inM) {
        snap.peakInput = parseFloat(inM[1]);
        continue;
      }

      // Output peak : 0.3120  [######--------------]
      const outM = line.match(/Output peak\s*:\s*([\d.]+)/i);
      if (outM) {
        snap.peakOutput = parseFloat(outM[1]);
        continue;
      }

      // Limiter hits: 12
      const limM = line.match(/Limiter hits\s*:\s*(\d+)/i);
      if (limM) {
        snap.limiterHits = parseInt(limM[1], 10);
        continue;
      }

      // Status lines: [OK] / [WARN] / [FAIL] / [INFO]
      const statusM = line.match(/\[(OK|WARN|FAIL|INFO)\]\s*(.*)/i);
      if (statusM) {
        snap.statuses.push({
          level: statusM[1].toLowerCase(),
          text: statusM[2].trim(),
        });
        continue;
      }
    }

    // Only return a valid snapshot if we got at least a CPU reading
    if (snap.cpuPct === null && snap.peakInput === null) return null;
    return snap;
  }
}

// ============================================================================
// DiagnosticsPanel
// ============================================================================
export class DiagnosticsPanel {
  /**
   * @param {string|HTMLElement} container  — CSS selector or DOM element
   * @param {SerialDriver}       serial     — connected SerialDriver instance
   */
  constructor(container, serial) {
    this._root =
      typeof container === "string"
        ? document.querySelector(container)
        : container;
    this._serial = serial;

    // Rolling history arrays for sparklines
    this._cpuHistory = []; // { t: timestamp, v: cpuPct }
    this._peakInHistory = [];
    this._peakOutHistory = [];

    // Last parsed snapshot
    this._lastSnap = null;

    // Polling state
    this._pollTimer = null;
    this._collecting = false;
    this._collectBuf = [];

    // D3 chart references
    this._cpuChart = null;
    this._peakChart = null;

    // Bind line handler
    this._lineHandler = this._onLine.bind(this);

    this._build();
  }

  // -----------------------------------------------------------------------
  // Public API
  // -----------------------------------------------------------------------

  /** Start auto-polling for diagnostics. */
  start() {
    if (this._pollTimer !== null) return;
    this._serial.on("line", this._lineHandler);
    this._poll(); // immediate first poll
    this._pollTimer = setInterval(() => this._poll(), POLL_INTERVAL_MS);
  }

  /** Stop auto-polling. */
  stop() {
    if (this._pollTimer !== null) {
      clearInterval(this._pollTimer);
      this._pollTimer = null;
    }
    this._serial.off("line", this._lineHandler);
  }

  /** Request one immediate diagnostics snapshot. */
  async refresh() {
    if (!this._serial?.connected) return;
    try {
      await this._serial.send("DIAG");
    } catch (_) {
      /* ignore if disconnected */
    }
  }

  /**
   * Feed an already-received line to the panel (call from app.js if you
   * already have a shared line handler).
   */
  feedLine(line) {
    this._onLine(line);
  }

  /** Tear down the panel (stops polling, removes listeners). */
  destroy() {
    this.stop();
    if (this._cpuChart) this._cpuChart.destroy();
    if (this._peakChart) this._peakChart.destroy();
  }

  // -----------------------------------------------------------------------
  // DOM construction
  // -----------------------------------------------------------------------

  _build() {
    this._root.innerHTML = `
        <div class="diag-grid" id="diag-metric-grid">
            <!-- CPU Usage -->
            <div class="diag-card" id="diag-cpu">
                <div class="diag-card-label">CPU Usage</div>
                <div class="diag-card-value">
                    <span id="diag-cpu-val">—</span><span class="diag-card-unit">%</span>
                </div>
                <div class="diag-bar"><div class="diag-bar-fill" id="diag-cpu-bar" style="width:0%"></div></div>
                <div class="diag-card-status" id="diag-cpu-status"></div>
            </div>

            <!-- Audio Memory -->
            <div class="diag-card" id="diag-mem">
                <div class="diag-card-label">Audio Mem</div>
                <div class="diag-card-value">
                    <span id="diag-mem-val">—</span><span class="diag-card-unit"> blk</span>
                </div>
                <div class="diag-bar"><div class="diag-bar-fill" id="diag-mem-bar" style="width:0%"></div></div>
                <div class="diag-card-status" id="diag-mem-status"></div>
            </div>

            <!-- Input Peak -->
            <div class="diag-card" id="diag-peak-in">
                <div class="diag-card-label">Peak In</div>
                <div class="diag-card-value"><span id="diag-peak-in-val">—</span></div>
                <div class="diag-bar"><div class="diag-bar-fill" id="diag-peak-in-bar" style="width:0%"></div></div>
                <div class="diag-card-status" id="diag-peak-in-status"></div>
            </div>

            <!-- Output Peak -->
            <div class="diag-card" id="diag-peak-out">
                <div class="diag-card-label">Peak Out</div>
                <div class="diag-card-value"><span id="diag-peak-out-val">—</span></div>
                <div class="diag-bar"><div class="diag-bar-fill" id="diag-peak-out-bar" style="width:0%"></div></div>
                <div class="diag-card-status" id="diag-peak-out-status"></div>
            </div>

            <!-- Limiter Hits -->
            <div class="diag-card" id="diag-limiter">
                <div class="diag-card-label">Limiter Hits</div>
                <div class="diag-card-value">
                    <span id="diag-limiter-val">—</span><span class="diag-card-unit">/win</span>
                </div>
                <div class="diag-card-status" id="diag-limiter-status"></div>
            </div>

            <!-- Mode -->
            <div class="diag-card" id="diag-mode">
                <div class="diag-card-label">Mode</div>
                <div class="diag-card-value" style="font-size:12px;">
                    <span id="diag-mode-val">—</span>
                </div>
                <div class="diag-card-status" id="diag-mode-status"></div>
            </div>

        </div>

        <!-- Sparklines -->
        <div class="spark-grid" style="margin-top:8px;">
            <div>
                <div class="spark-label">CPU History</div>
                <div class="spark-box" id="diag-cpu-chart"></div>
            </div>
            <div>
                <div class="spark-label">Peak History</div>
                <div class="spark-box" id="diag-peak-chart"></div>
            </div>
        </div>

        <!-- Status messages -->
        <div id="diag-status-list" style="margin-top:8px;"></div>

        <!-- Serial log -->
        <div style="margin-top:8px;">
            <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:5px;">
                <span class="spark-label" style="margin-bottom:0;">Serial Log</span>
                <button class="btn btn-ghost btn-xs" id="diag-log-clear">Clear</button>
            </div>
            <div class="serial-log" id="diag-serial-log"></div>
        </div>
        `;

    // Wire the clear button
    const clearBtn = this._root.querySelector("#diag-log-clear");
    if (clearBtn) {
      clearBtn.addEventListener("click", () => {
        const log = this._root.querySelector("#diag-serial-log");
        if (log) log.innerHTML = "";
      });
    }

    // Build D3 sparklines once the container has dimensions
    requestAnimationFrame(() => {
      this._cpuChart = this._buildSparkline("#diag-cpu-chart", "#388bfd");
      this._peakChart = this._buildSparkline(
        "#diag-peak-chart",
        "#3fb950",
        "#f85149",
      );
    });
  }

  // -----------------------------------------------------------------------
  // Polling
  // -----------------------------------------------------------------------

  async _poll() {
    if (!this._serial?.connected) return;
    try {
      await this._serial.send("DIAG");
    } catch (_) {
      /* silently ignore */
    }
  }

  // -----------------------------------------------------------------------
  // Serial line ingestion
  // -----------------------------------------------------------------------

  _onLine(line) {
    // Log every line to the serial log
    this._appendLog(line, "recv");

    // Detect start of a DIAG block
    if (line.includes("========== DIAGNOSTICS")) {
      this._collecting = true;
      this._collectBuf = [line];
      return;
    }

    if (this._collecting) {
      this._collectBuf.push(line);

      // Detect end of DIAG block
      if (line.includes("=================================")) {
        this._collecting = false;
        const snap = DiagnosticsParser.parse(this._collectBuf);
        if (snap) {
          this._lastSnap = snap;
          this._updateUI(snap);
          this._updateHistory(snap);
          this._updateCharts();
        }
        this._collectBuf = [];
      }
    }
  }

  // -----------------------------------------------------------------------
  // UI update
  // -----------------------------------------------------------------------

  _updateUI(snap) {
    // -- CPU --
    this._setText(
      "diag-cpu-val",
      snap.cpuPct !== null ? snap.cpuPct.toFixed(1) : "—",
    );
    this._setBar(
      "diag-cpu-bar",
      snap.cpuPct !== null ? snap.cpuPct : 0,
      0,
      100,
      snap.cpuPct >= CPU_FAIL_PCT
        ? "fail"
        : snap.cpuPct >= CPU_WARN_PCT
          ? "warn"
          : null,
    );
    this._setStatus(
      "diag-cpu-status",
      snap.cpuPct >= CPU_FAIL_PCT
        ? { level: "fail", text: "CPU overloaded" }
        : snap.cpuPct >= CPU_WARN_PCT
          ? { level: "warn", text: "CPU high" }
          : snap.cpuPct !== null
            ? { level: "ok", text: "OK" }
            : null,
    );

    // -- Memory --
    if (snap.memUsed !== null && snap.memAllocated) {
      this._setText("diag-mem-val", `${snap.memUsed} / ${snap.memAllocated}`);
      const pct = (snap.memUsed / snap.memAllocated) * 100;
      const atLimit = snap.memMax >= snap.memAllocated;
      this._setBar(
        "diag-mem-bar",
        pct,
        0,
        100,
        atLimit ? "fail" : pct > 75 ? "warn" : null,
      );
      this._setStatus(
        "diag-mem-status",
        atLimit
          ? {
              level: "fail",
              text: "Pool exhausted — increase AUDIO_MEMORY_BLOCKS",
            }
          : pct > 75
            ? { level: "warn", text: "Memory usage high" }
            : { level: "ok", text: "OK" },
      );
    }

    // -- Input peak --
    if (snap.peakInput !== null) {
      this._setText("diag-peak-in-val", snap.peakInput.toFixed(4));
      const warn =
        snap.peakInput >= PEAK_FAIL
          ? "fail"
          : snap.peakInput >= PEAK_WARN
            ? "warn"
            : null;
      this._setBar("diag-peak-in-bar", snap.peakInput * 100, 0, 100, warn);
      this._setStatus(
        "diag-peak-in-status",
        snap.peakInput < 0.005
          ? { level: "warn", text: "Near zero — check mic wiring" }
          : snap.peakInput >= PEAK_FAIL
            ? { level: "fail", text: "Clipping! Reduce mic gain" }
            : snap.peakInput >= PEAK_WARN
              ? { level: "warn", text: "High — approaching clip" }
              : { level: "ok", text: "OK" },
      );
    }

    // -- Output peak --
    if (snap.peakOutput !== null) {
      this._setText("diag-peak-out-val", snap.peakOutput.toFixed(4));
      const warn =
        snap.peakOutput >= PEAK_FAIL
          ? "fail"
          : snap.peakOutput >= PEAK_WARN
            ? "warn"
            : null;
      this._setBar("diag-peak-out-bar", snap.peakOutput * 100, 0, 100, warn);
      this._setStatus(
        "diag-peak-out-status",
        snap.peakOutput < 0.001 && snap.peakInput > 0.01
          ? { level: "fail", text: "Signal in but output silent" }
          : snap.peakOutput >= PEAK_FAIL
            ? { level: "fail", text: "Output clipping" }
            : snap.peakOutput >= PEAK_WARN
              ? { level: "warn", text: "Output high" }
              : { level: "ok", text: "OK" },
      );
    }

    // -- Limiter hits --
    if (snap.limiterHits !== null) {
      this._setText("diag-limiter-val", snap.limiterHits.toLocaleString());
      this._setStatus(
        "diag-limiter-status",
        snap.limiterHits > 4410
          ? { level: "fail", text: "Excessive clipping (>10%)" }
          : snap.limiterHits > 441
            ? { level: "warn", text: "Some clipping" }
            : snap.limiterHits > 0
              ? { level: "warn", text: "Minor clipping" }
              : { level: "ok", text: "No clipping" },
      );
    }

    // -- Mode --
    this._setText("diag-mode-val", snap.mode);
    this._setStatus("diag-mode-status", null); // mode is informational

    // -- Status list --
    this._renderStatusList(snap.statuses);
  }

  _updateHistory(snap) {
    const t = snap.timestamp;

    const push = (arr, v) => {
      arr.push({ t, v });
      while (arr.length > HISTORY_LEN) arr.shift();
    };

    if (snap.cpuPct !== null) push(this._cpuHistory, snap.cpuPct);
    if (snap.peakInput !== null)
      push(this._peakInHistory, snap.peakInput * 100);
    if (snap.peakOutput !== null)
      push(this._peakOutHistory, snap.peakOutput * 100);
  }

  _renderStatusList(statuses) {
    const container = this._root.querySelector("#diag-status-list");
    if (!container) return;

    if (!statuses || statuses.length === 0) {
      container.innerHTML = "";
      return;
    }

    container.innerHTML = statuses
      .map((s) => {
        const alertClass =
          s.level === "ok"
            ? "alert--success"
            : s.level === "warn"
              ? "alert--warning"
              : s.level === "fail"
                ? "alert--danger"
                : "alert--info";

        return `
                <div class="alert ${alertClass}">
                    <span class="alert__icon">${icon}</span>
                    <div class="alert__body">${this._escHtml(s.text)}</div>
                </div>
            `;
      })
      .join("");
  }

  // -----------------------------------------------------------------------
  // D3 Sparklines
  // -----------------------------------------------------------------------

  /**
   * Build a compact sparkline SVG inside the given container.
   * @param {string} selector
   * @param {string} color1   — primary series color
   * @param {string} [color2] — optional secondary series color
   * @returns {{ update, destroy }}
   */
  _buildSparkline(selector, color1, color2 = null) {
    const el = this._root.querySelector(selector);
    if (!el || typeof d3 === "undefined")
      return { update: () => {}, destroy: () => {} };

    const margin = { top: 4, right: 8, bottom: 18, left: 28 };
    const totalW = el.clientWidth || 300;
    const totalH = el.clientHeight || 80;
    const w = totalW - margin.left - margin.right;
    const h = totalH - margin.top - margin.bottom;

    const svg = d3
      .select(el)
      .append("svg")
      .attr("width", totalW)
      .attr("height", totalH)
      .attr("viewBox", `0 0 ${totalW} ${totalH}`);

    const g = svg
      .append("g")
      .attr("transform", `translate(${margin.left},${margin.top})`);

    // Axes
    const xScale = d3.scaleLinear().range([0, w]);
    const yScale = d3.scaleLinear().range([h, 0]);

    // Grid
    const gridG = g.append("g").attr("class", "spark-grid");

    // Area fill
    const areaG1 = g
      .append("path")
      .attr("class", "spark-area-1")
      .attr("fill", color1)
      .attr("opacity", 0.12);

    const lineG1 = g
      .append("path")
      .attr("class", "spark-line-1")
      .attr("fill", "none")
      .attr("stroke", color1)
      .attr("stroke-width", 1.5);

    let areaG2, lineG2;
    if (color2) {
      areaG2 = g
        .append("path")
        .attr("class", "spark-area-2")
        .attr("fill", color2)
        .attr("opacity", 0.1);
      lineG2 = g
        .append("path")
        .attr("class", "spark-line-2")
        .attr("fill", "none")
        .attr("stroke", color2)
        .attr("stroke-width", 1.5)
        .attr("stroke-dasharray", "3,2");
    }

    // Y-axis
    const yAxisG = g.append("g").attr("class", "spark-y-axis");

    // X-axis label
    g.append("text")
      .attr("x", w / 2)
      .attr("y", h + margin.bottom - 2)
      .attr("text-anchor", "middle")
      .attr("font-size", "9px")
      .attr("fill", "#94a3b8")
      .attr("font-family", "Inter, system-ui, sans-serif")
      .text("← older                                   newer →");

    const areaGen = (yScale) =>
      d3
        .area()
        .x((_, i) => xScale(i))
        .y0(h)
        .y1((d) => yScale(d.v))
        .curve(d3.curveMonotoneX);

    const lineGen = (yScale) =>
      d3
        .line()
        .x((_, i) => xScale(i))
        .y((d) => yScale(d.v))
        .curve(d3.curveMonotoneX);

    const update = (data1, data2 = null) => {
      if (!data1 || data1.length === 0) return;

      xScale.domain([0, Math.max(data1.length - 1, 1)]);

      // Compute unified y domain across both series
      const allVals = [...data1.map((d) => d.v)];
      if (data2) allVals.push(...data2.map((d) => d.v));
      const yMax = Math.max(10, d3.max(allVals) * 1.15);
      yScale.domain([0, yMax]);

      // Grid lines
      gridG.selectAll("line").remove();
      yScale.ticks(3).forEach((tick) => {
        gridG
          .append("line")
          .attr("x1", 0)
          .attr("x2", w)
          .attr("y1", yScale(tick))
          .attr("y2", yScale(tick))
          .attr("stroke", "#e2e8f0")
          .attr("stroke-width", 0.5);
      });

      // Y-axis ticks
      const yAxis = d3
        .axisLeft(yScale)
        .ticks(3)
        .tickFormat((d) => d.toFixed(0));
      yAxisG.call(yAxis).call((ax) => {
        ax.select(".domain").remove();
        ax.selectAll(".tick line").remove();
        ax.selectAll(".tick text")
          .attr("font-size", "8px")
          .attr("fill", "#94a3b8")
          .attr("font-family", "Inter, system-ui, sans-serif");
      });

      // Series 1
      areaG1.datum(data1).attr("d", areaGen(yScale));
      lineG1.datum(data1).attr("d", lineGen(yScale));

      // Series 2
      if (data2 && areaG2 && lineG2) {
        areaG2.datum(data2).attr("d", areaGen(yScale));
        lineG2.datum(data2).attr("d", lineGen(yScale));
      }
    };

    const destroy = () => {
      svg.remove();
    };

    return { update, destroy };
  }

  _updateCharts() {
    if (this._cpuChart) {
      this._cpuChart.update(this._cpuHistory);
    }
    if (this._peakChart) {
      this._peakChart.update(this._peakInHistory, this._peakOutHistory);
    }
  }

  // -----------------------------------------------------------------------
  // Serial log
  // -----------------------------------------------------------------------

  /**
   * Append a line to the serial log panel.
   * @param {string} text
   * @param {'sent'|'recv'|'warn'|'error'|'ok'} type
   */
  appendLog(text, type = "recv") {
    this._appendLog(text, type);
  }

  _appendLog(text, type = "recv") {
    const log = this._root.querySelector("#diag-serial-log");
    if (!log) return;

    const now = new Date();
    const ts =
      `${String(now.getHours()).padStart(2, "0")}:` +
      `${String(now.getMinutes()).padStart(2, "0")}:` +
      `${String(now.getSeconds()).padStart(2, "0")}`;

    // Classify line type from content
    let lineType = type;
    if (type === "recv") {
      if (text.includes("[OK]")) lineType = "ok";
      else if (text.includes("[WARN]") || text.includes("[WARN]"))
        lineType = "warn";
      else if (text.includes("[FAIL]")) lineType = "error";
    }

    const line = document.createElement("span");
    line.className = `serial-log__line log-${lineType}`;
    line.innerHTML = `<span class="log-ts">${ts}</span>` + this._escHtml(text);

    log.appendChild(line);
    log.appendChild(document.createTextNode("\n"));

    // Auto-scroll to bottom, but only if user is already near the bottom
    const atBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 60;
    if (atBottom) log.scrollTop = log.scrollHeight;

    // Trim old lines to keep DOM lean (max 400 lines)
    const lines = log.querySelectorAll(".serial-log__line, [class^='log-']");
    if (lines.length > 400) {
      for (let i = 0; i < lines.length - 400; i++) {
        lines[i].nextSibling?.remove(); // trailing \n text node
        lines[i].remove();
      }
    }
  }

  // -----------------------------------------------------------------------
  // DOM helpers
  // -----------------------------------------------------------------------

  _setText(id, value) {
    const el = this._root.querySelector(`#${id}`);
    if (el) el.textContent = value;
  }

  /**
   * Set a bar fill width and optional danger class.
   * @param {string}      id
   * @param {number}      value   — current value
   * @param {number}      min
   * @param {number}      max
   * @param {'warn'|'fail'|null} level
   */
  _setBar(id, value, min, max, level) {
    const el = this._root.querySelector(`#${id}`);
    if (!el) return;

    const pct = Math.max(0, Math.min(100, ((value - min) / (max - min)) * 100));
    el.style.width = pct + "%";

    el.classList.remove("warn", "fail");
    if (level === "fail") el.classList.add("fail");
    else if (level === "warn") el.classList.add("warn");
  }

  /**
   * Set the status indicator below a metric card.
   * @param {string} id
   * @param {{ level: string, text: string }|null} status
   */
  _setStatus(id, status) {
    const el = this._root.querySelector(`#${id}`);
    if (!el) return;

    el.className = "diag-card-status";
    if (!status) {
      el.textContent = "";
      return;
    }

    const cls =
      status.level === "ok"
        ? "diag-status-ok"
        : status.level === "warn"
          ? "diag-status-warn"
          : status.level === "fail"
            ? "diag-status-fail"
            : "";

    if (cls) el.classList.add(cls);
    el.textContent = status.text;
  }

  /**
   * Escape HTML special characters to prevent XSS in the serial log.
   * @param {string} str
   * @returns {string}
   */
  _escHtml(str) {
    return String(str)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }
}
