// ============================================================================
// audiogram.js — Clinical audiogram renderer
//
// Renders a standard clinical audiogram per ISO 8253-1:
//   • X-axis: frequency in Hz (125–8000 Hz, log scale)
//   • Y-axis: Hearing Level in dB HL (–10 to 120 dB, inverted — worse = down)
//   • Severity bands: Normal / Mild / Moderate / Severe / Profound
//   • Right ear: Red circles (O), Left ear: Blue crosses (X)
//   • Live point plotting as calibration progresses
//   • Hover tooltips with frequency and threshold detail
//
// The dB HL conversion maps the device's internal amplitude threshold to
// an approximate dB SPL, then offsets by the standard RETSPL audiometric
// reference to give dB HL values.
//
// Usage:
//   const ag = new Audiogram('#audiogram-container');
//   ag.addPoint({ freqHz: 1000, dbHL: 35, ear: 'right' });
//   ag.clearPoints();
//   ag.exportSVG();
// ============================================================================

// -----------------------------------------------------------------------
// ISO 8253 audiogram constants
// -----------------------------------------------------------------------

// Standard audiometric test frequencies (Hz)
const AUDIOGRAM_FREQS = [125, 250, 500, 1000, 2000, 4000, 8000];

// dB HL axis range (inverted: 0 at top, 120 at bottom)
const DB_MIN = -10; // top of y-axis (best hearing)
const DB_MAX = 120; // bottom of y-axis (worst hearing)

// Severity band boundaries (dB HL) — per WHO / ASHA classification
const SEVERITY_BANDS = [
  { label: "Normal", min: -10, max: 25, color: "rgba(34,197,94,0.07)" },
  { label: "Mild", min: 25, max: 40, color: "rgba(234,179,8,0.10)" },
  { label: "Moderate", min: 40, max: 55, color: "rgba(249,115,22,0.12)" },
  { label: "Severe", min: 55, max: 70, color: "rgba(239,68,68,0.13)" },
  { label: "Profound", min: 70, max: 120, color: "rgba(124,58,237,0.10)" },
];

// Ear styling
const EAR_STYLE = {
  right: { color: "#dc2626", symbol: "O", dashArray: null },
  left: { color: "#2563eb", symbol: "X", dashArray: "6,4" },
};

// Convert device amplitude threshold (0–1) to approximate dB HL.
// The device ramps from CAL_START_AMP (0.02) to CAL_MAX_AMP (0.80).
// We model the speaker + headphone chain as roughly linear in dB SPL,
// with full amplitude (1.0) ≈ 100 dB SPL, and apply a flat 0 dB HL offset
// (conservative — a proper calibration would use RETSPL correction per freq).
//
//   dB SPL  = 20 * log10(amplitude / 1.0) + 100
//   dB HL   ≈ dB SPL − 0   (simplified; add freq-specific RETSPL for accuracy)
//
// Clamp to [0, 120] for the audiogram display.
function amplitudeToDbHL(amplitude) {
  if (amplitude <= 0) return 0;
  const dbSPL = 20 * Math.log10(amplitude) + 100;
  return Math.max(0, Math.min(120, Math.round(dbSPL)));
}

// Map a dB HL value to a WHO severity label
function severityLabel(dbHL) {
  if (dbHL <= 25) return "Normal";
  if (dbHL <= 40) return "Mild";
  if (dbHL <= 55) return "Moderate";
  if (dbHL <= 70) return "Severe";
  return "Profound";
}

// Severity chip CSS class
function severityClass(dbHL) {
  const label = severityLabel(dbHL).toLowerCase();
  return `severity-chip severity-chip--${label}`;
}

// ============================================================================
// Audiogram class
// ============================================================================
export class Audiogram {
  /**
   * @param {string|HTMLElement} container  — CSS selector or DOM element
   */
  constructor(container) {
    this._root =
      typeof container === "string"
        ? document.querySelector(container)
        : container;
    this._points = []; // { freqHz, dbHL, amplitude, ear, bandIndex }
    this._svg = null;
    this._scales = null;
    this._tooltip = null;
    this._onPointCb = null; // optional callback when a point is added

    this._buildSVG();
    this._buildTooltip();

    // Re-draw on resize
    this._ro = new ResizeObserver(() => this._rebuild());
    this._ro.observe(this._root);
  }

  // -----------------------------------------------------------------------
  // Public API
  // -----------------------------------------------------------------------

  /**
   * Add a measured threshold point to the audiogram.
   * @param {Object} opts
   *   opts.freqHz    {number}  — centre frequency in Hz
   *   opts.amplitude {number}  — raw device amplitude (0–1), converted to dB HL
   *   opts.ear       {string}  — 'right' | 'left'
   *   opts.bandIndex {number}  — 0-based band index
   */
  addPoint({ freqHz, amplitude, ear = "right", bandIndex = 0 }) {
    const dbHL = amplitudeToDbHL(amplitude);
    const point = { freqHz, amplitude, dbHL, ear, bandIndex };
    this._points.push(point);
    this._drawPoint(point, true /* animate */);
    this._drawLine(ear);
    if (this._onPointCb) this._onPointCb(point);
    return point;
  }

  /**
   * Register a callback invoked whenever a new point is added.
   * @param {function} cb — receives the point object
   */
  onPoint(cb) {
    this._onPointCb = cb;
    return this;
  }

  /** Remove all plotted points and lines, keeping the grid. */
  clearPoints() {
    this._points = [];
    if (this._svg) {
      this._svg.selectAll(".ag-point").remove();
      this._svg.selectAll(".ag-line").remove();
    }
  }

  /** Return the current points array (read-only copy). */
  getPoints() {
    return this._points.map((p) => ({ ...p }));
  }

  /**
   * Return the audiogram SVG as a data URI (for download / print).
   */
  exportSVG() {
    const svgEl = this._root.querySelector("svg");
    if (!svgEl) return null;
    const serial = new XMLSerializer().serializeToString(svgEl);
    return (
      "data:image/svg+xml;base64," + btoa(unescape(encodeURIComponent(serial)))
    );
  }

  /** Highlight the currently-being-tested frequency with a vertical marker. */
  setActiveFrequency(freqHz) {
    if (!this._svg || !this._scales) return;
    this._svg.select(".ag-active-line").remove();

    if (freqHz == null) return;

    const x = this._scales.x(freqHz);
    if (isNaN(x)) return;

    this._svg
      .insert("line", ":first-child")
      .attr("class", "ag-active-line")
      .attr("x1", x)
      .attr("x2", x)
      .attr("y1", 0)
      .attr("y2", this._scales.height)
      .attr("stroke", "#1a6fb5")
      .attr("stroke-width", 1.5)
      .attr("stroke-dasharray", "4,3")
      .attr("opacity", 0.5);
  }

  /** Tear down the ResizeObserver (call when removing from DOM). */
  destroy() {
    this._ro.disconnect();
  }

  // -----------------------------------------------------------------------
  // Build / rebuild SVG
  // -----------------------------------------------------------------------

  _getMargins() {
    return { top: 20, right: 32, bottom: 56, left: 64 };
  }

  _getDimensions() {
    const m = this._getMargins();
    const totalW = this._root.clientWidth || 680;
    const totalH = this._root.clientHeight || 480;
    const width = totalW - m.left - m.right;
    const height = totalH - m.top - m.bottom;
    return { totalW, totalH, width, height, m };
  }

  _buildSVG() {
    // Clear existing
    this._root.innerHTML = "";

    const { totalW, totalH, width, height, m } = this._getDimensions();

    // Create SVG via D3
    const svgRoot = d3
      .select(this._root)
      .append("svg")
      .attr("width", totalW)
      .attr("height", totalH)
      .attr("viewBox", `0 0 ${totalW} ${totalH}`)
      .attr("preserveAspectRatio", "xMidYMid meet")
      .style("overflow", "visible");

    // Main drawing group offset by margins
    const g = svgRoot
      .append("g")
      .attr("class", "ag-main")
      .attr("transform", `translate(${m.left},${m.top})`);

    this._svg = g;

    // Scales
    const xScale = d3.scaleLog().domain([125, 8000]).range([0, width]);

    const yScale = d3.scaleLinear().domain([DB_MIN, DB_MAX]).range([0, height]);

    this._scales = { x: xScale, y: yScale, width, height };

    // Build chart layers in order
    this._drawSeverityBands(g, xScale, yScale, width, height);
    this._drawGrid(g, xScale, yScale, width, height);
    this._drawAxes(g, xScale, yScale, width, height);
    this._drawAxisLabels(g, width, height, m);

    // Container for lines and points (drawn on top)
    g.append("g").attr("class", "ag-lines-layer");
    g.append("g").attr("class", "ag-points-layer");

    // Re-draw any existing points (after rebuild on resize)
    this._points.forEach((p) => {
      this._drawPoint(p, false);
    });
    ["right", "left"].forEach((ear) => this._drawLine(ear));
  }

  _rebuild() {
    this._buildSVG();
    if (this._tooltip) {
      // Tooltip stays in body, no rebuild needed
    }
  }

  // -----------------------------------------------------------------------
  // Severity bands (coloured horizontal strips)
  // -----------------------------------------------------------------------

  _drawSeverityBands(g, xScale, yScale, width) {
    const bandsG = g.append("g").attr("class", "ag-severity-bands");

    SEVERITY_BANDS.forEach((band) => {
      const y1 = yScale(band.min);
      const y2 = yScale(band.max);
      bandsG
        .append("rect")
        .attr("x", 0)
        .attr("y", Math.min(y1, y2))
        .attr("width", width)
        .attr("height", Math.abs(y2 - y1))
        .attr("fill", band.color)
        .attr("rx", 0);
    });
  }

  // -----------------------------------------------------------------------
  // Grid lines
  // -----------------------------------------------------------------------

  _drawGrid(g, xScale, yScale, width, height) {
    const gridG = g.append("g").attr("class", "ag-grid");

    // Vertical grid lines at each audiometric frequency
    AUDIOGRAM_FREQS.forEach((freq) => {
      const x = xScale(freq);
      gridG
        .append("line")
        .attr("x1", x)
        .attr("x2", x)
        .attr("y1", 0)
        .attr("y2", height)
        .attr("stroke", "#dde6f0")
        .attr("stroke-width", 1);
    });

    // Horizontal grid lines every 10 dB
    d3.range(DB_MIN, DB_MAX + 1, 10).forEach((db) => {
      const y = yScale(db);
      const isMajor = db % 20 === 0;
      gridG
        .append("line")
        .attr("x1", 0)
        .attr("x2", width)
        .attr("y1", y)
        .attr("y2", y)
        .attr("stroke", isMajor ? "#c8d6e5" : "#dde6f0")
        .attr("stroke-width", isMajor ? 1 : 0.5);
    });

    // Prominent 0 dB HL reference line
    const y0 = yScale(0);
    gridG
      .append("line")
      .attr("x1", 0)
      .attr("x2", width)
      .attr("y1", y0)
      .attr("y2", y0)
      .attr("stroke", "#94a3b8")
      .attr("stroke-width", 1.5)
      .attr("stroke-dasharray", "5,3");
  }

  // -----------------------------------------------------------------------
  // Axes
  // -----------------------------------------------------------------------

  _drawAxes(g, xScale, yScale, width, height) {
    // X-axis (bottom)
    const xAxis = d3
      .axisBottom(xScale)
      .tickValues(AUDIOGRAM_FREQS)
      .tickFormat((d) => (d >= 1000 ? `${d / 1000}k` : d));

    g.append("g")
      .attr("class", "ag-axis ag-axis-x")
      .attr("transform", `translate(0,${height})`)
      .call(xAxis)
      .call((ax) => {
        ax.select(".domain").attr("stroke", "#94a3b8");
        ax.selectAll(".tick line").attr("stroke", "#94a3b8");
        ax.selectAll(".tick text")
          .attr("font-size", "12px")
          .attr("font-family", "Inter, system-ui, sans-serif")
          .attr("fill", "#64748b")
          .attr("dy", "1.2em");
      });

    // Y-axis (left) — 0 at top, 120 at bottom (inverted perception)
    const yAxis = d3
      .axisLeft(yScale)
      .tickValues(d3.range(DB_MIN, DB_MAX + 1, 10))
      .tickFormat((d) => d);

    g.append("g")
      .attr("class", "ag-axis ag-axis-y")
      .call(yAxis)
      .call((ax) => {
        ax.select(".domain").attr("stroke", "#94a3b8");
        ax.selectAll(".tick line").attr("stroke", "#94a3b8");
        ax.selectAll(".tick text")
          .attr("font-size", "11px")
          .attr("font-family", "Inter, system-ui, sans-serif")
          .attr("fill", "#64748b");
      });
  }

  _drawAxisLabels(g, width, height, m) {
    // X-axis label
    g.append("text")
      .attr("class", "ag-axis-label")
      .attr("x", width / 2)
      .attr("y", height + m.bottom - 4)
      .attr("text-anchor", "middle")
      .attr("font-size", "12px")
      .attr("font-family", "Inter, system-ui, sans-serif")
      .attr("font-weight", "600")
      .attr("fill", "#64748b")
      .attr("letter-spacing", "0.04em")
      .attr("text-transform", "uppercase")
      .text("FREQUENCY (Hz)");

    // Y-axis label (rotated)
    g.append("text")
      .attr("class", "ag-axis-label")
      .attr("transform", `translate(${-m.left + 14},${height / 2}) rotate(-90)`)
      .attr("text-anchor", "middle")
      .attr("font-size", "12px")
      .attr("font-family", "Inter, system-ui, sans-serif")
      .attr("font-weight", "600")
      .attr("fill", "#64748b")
      .attr("letter-spacing", "0.04em")
      .text("HEARING LEVEL (dB HL)");

    // Severity band labels on the right edge
    const rightX = width + 6;
    SEVERITY_BANDS.forEach((band) => {
      const midDb = (band.min + band.max) / 2;
      const yMid = this._scales.y(midDb);
      if (midDb > DB_MIN && midDb < DB_MAX) {
        g.append("text")
          .attr("x", rightX)
          .attr("y", yMid)
          .attr("dominant-baseline", "middle")
          .attr("font-size", "9px")
          .attr("font-family", "Inter, system-ui, sans-serif")
          .attr("font-weight", "600")
          .attr("fill", "#94a3b8")
          .attr("letter-spacing", "0.06em")
          .text(band.label.toUpperCase());
      }
    });
  }

  // -----------------------------------------------------------------------
  // Points
  // -----------------------------------------------------------------------

  _drawPoint(point, animate = false) {
    const { x: xScale, y: yScale } = this._scales;
    const style = EAR_STYLE[point.ear] || EAR_STYLE.right;
    const cx = xScale(point.freqHz);
    const cy = yScale(point.dbHL);
    const layer = this._svg.select(".ag-points-layer");

    if (point.ear === "right") {
      // Right ear: hollow circle (O)
      const circle = layer
        .append("circle")
        .attr("class", "ag-point ag-point--right")
        .attr("cx", cx)
        .attr("cy", cy)
        .attr("r", animate ? 0 : 8)
        .attr("fill", "white")
        .attr("stroke", style.color)
        .attr("stroke-width", 2.5)
        .attr("cursor", "pointer")
        .datum(point);

      if (animate) {
        circle.transition().duration(350).ease(d3.easeBounceOut).attr("r", 8);
      }

      this._attachTooltip(circle);
    } else {
      // Left ear: X cross
      const size = 8;
      const group = layer
        .append("g")
        .attr("class", "ag-point ag-point--left")
        .attr(
          "transform",
          animate
            ? `translate(${cx},${cy}) scale(0)`
            : `translate(${cx},${cy})`,
        )
        .attr("cursor", "pointer")
        .datum(point);

      group
        .append("line")
        .attr("x1", -size)
        .attr("y1", -size)
        .attr("x2", size)
        .attr("y2", size)
        .attr("stroke", style.color)
        .attr("stroke-width", 2.5)
        .attr("stroke-linecap", "round");

      group
        .append("line")
        .attr("x1", size)
        .attr("y1", -size)
        .attr("x2", -size)
        .attr("y2", size)
        .attr("stroke", style.color)
        .attr("stroke-width", 2.5)
        .attr("stroke-linecap", "round");

      // Invisible hit area
      group.append("circle").attr("r", 14).attr("fill", "transparent");

      if (animate) {
        group
          .transition()
          .duration(300)
          .ease(d3.easeBackOut)
          .attr("transform", `translate(${cx},${cy}) scale(1)`);
      }

      this._attachTooltip(group);
    }
  }

  // -----------------------------------------------------------------------
  // Lines connecting same-ear points
  // -----------------------------------------------------------------------

  _drawLine(ear) {
    if (!this._svg) return;

    const { x: xScale, y: yScale } = this._scales;
    const style = EAR_STYLE[ear] || EAR_STYLE.right;
    const points = this._points
      .filter((p) => p.ear === ear)
      .sort((a, b) => a.freqHz - b.freqHz);

    const layer = this._svg.select(".ag-lines-layer");

    // Remove previous line for this ear
    layer.selectAll(`.ag-line--${ear}`).remove();

    if (points.length < 2) return;

    const lineGen = d3
      .line()
      .x((p) => xScale(p.freqHz))
      .y((p) => yScale(p.dbHL))
      .curve(d3.curveMonotoneX);

    const path = layer
      .append("path")
      .attr("class", `ag-line ag-line--${ear}`)
      .datum(points)
      .attr("d", lineGen)
      .attr("fill", "none")
      .attr("stroke", style.color)
      .attr("stroke-width", 1.5)
      .attr("opacity", 0.6);

    if (style.dashArray) {
      path.attr("stroke-dasharray", style.dashArray);
    }

    // Animate path drawing
    const totalLength = path.node().getTotalLength();
    path
      .attr("stroke-dasharray", `${totalLength} ${totalLength}`)
      .attr("stroke-dashoffset", totalLength)
      .transition()
      .duration(600)
      .ease(d3.easeQuadOut)
      .attr("stroke-dashoffset", 0)
      .on("end", () => {
        if (!style.dashArray) {
          path.attr("stroke-dasharray", null);
        } else {
          path.attr("stroke-dasharray", style.dashArray);
        }
      });
  }

  // -----------------------------------------------------------------------
  // Tooltip
  // -----------------------------------------------------------------------

  _buildTooltip() {
    // Reuse existing tooltip element if already in DOM
    let tip = document.getElementById("ag-tooltip");
    if (!tip) {
      tip = document.createElement("div");
      tip.id = "ag-tooltip";
      tip.className = "audiogram-tooltip";
      document.body.appendChild(tip);
    }
    this._tooltip = tip;
  }

  _attachTooltip(selection) {
    const tip = this._tooltip;

    selection
      .on("mouseenter", function (event, d) {
        const severity = severityLabel(d.dbHL);
        tip.innerHTML = `
                    <div style="margin-bottom:4px;font-weight:600;">
                        ${d.freqHz >= 1000 ? d.freqHz / 1000 + " kHz" : d.freqHz + " Hz"}
                    </div>
                    <div style="opacity:0.85;">
                        Threshold: <strong>${d.dbHL} dB HL</strong>
                    </div>
                    <div style="opacity:0.75;font-size:11px;margin-top:3px;">
                        Classification: ${severity}
                    </div>
                    <div style="opacity:0.65;font-size:10px;margin-top:2px;">
                        Amplitude: ${(d.amplitude * 100).toFixed(1)}%
                    </div>
                `;
        tip.style.opacity = "1";
        tip.style.pointerEvents = "none";
      })
      .on("mousemove", function (event) {
        const scrollY = window.scrollY || 0;
        const scrollX = window.scrollX || 0;
        tip.style.left = event.clientX + scrollX + 14 + "px";
        tip.style.top = event.clientY + scrollY - 10 + "px";
      })
      .on("mouseleave", function () {
        tip.style.opacity = "0";
      });
  }
}

// ============================================================================
// Audiogram Legend builder (call once on page load)
// ============================================================================

/**
 * Populate a severity-legend container with the standard severity swatches.
 * @param {string|HTMLElement} container
 */
export function buildAudiogramLegend(container) {
  const el =
    typeof container === "string"
      ? document.querySelector(container)
      : container;
  if (!el) return;

  const items = [
    { label: "Normal (≤25 dB HL)", color: "#22c55e" },
    { label: "Mild (26–40 dB HL)", color: "#eab308" },
    { label: "Moderate (41–55 dB HL)", color: "#f97316" },
    { label: "Severe (56–70 dB HL)", color: "#ef4444" },
    { label: "Profound (>70 dB HL)", color: "#7c3aed" },
    { label: "Right ear (O)", color: "#dc2626", shape: "circle" },
    { label: "Left ear (X)", color: "#2563eb", shape: "x" },
  ];

  el.innerHTML = items
    .map(
      (item) => `
        <div class="severity-legend__item">
            <div class="severity-legend__swatch"
                 style="background:${item.color};
                        border-radius:${item.shape === "circle" ? "50%" : "2px"};
                        border:${item.shape ? "2px solid " + item.color : "none"};
                        background:${item.shape ? "transparent" : item.color};">
            </div>
            <span>${item.label}</span>
        </div>
    `,
    )
    .join("");
}

// ============================================================================
// Exported helpers
// ============================================================================
export { amplitudeToDbHL, severityLabel, severityClass, AUDIOGRAM_FREQS };
