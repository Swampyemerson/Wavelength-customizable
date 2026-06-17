/* Wavelength dial — an SVG 180° semicircle mapped to a 0..100 scale.
 *
 * value 0   -> far left  (angle 180°)
 * value 100 -> far right  (angle 0°)
 *
 * Draggable via Pointer Events (touch + mouse). Scales to its container width.
 */
(function (global) {
  "use strict";

  const NS = "http://www.w3.org/2000/svg";
  const VW = 320;          // viewBox width
  const VH = 188;          // viewBox height (semicircle + a little room for the knob)
  const CX = 160;          // center x
  const CY = 168;          // center y (baseline)
  const R = 148;           // dial radius

  // Scoring bands (half-widths, points) — mirror the server.
  const BANDS = [
    { w: 12, cls: "band-2" },
    { w: 8, cls: "band-3" },
    { w: 4, cls: "band-4" },
  ];

  function el(name, attrs) {
    const node = document.createElementNS(NS, name);
    for (const k in attrs) node.setAttribute(k, attrs[k]);
    return node;
  }

  function clamp(v, lo, hi) {
    return Math.max(lo, Math.min(hi, v));
  }

  // value (0..100) -> point on the rim
  function pointAt(value, radius) {
    const r = radius == null ? R : radius;
    const deg = 180 - value * 1.8;
    const rad = (deg * Math.PI) / 180;
    return { x: CX + r * Math.cos(rad), y: CY - r * Math.sin(rad) };
  }

  // Arc path from vStart (lower) to vEnd (higher) along the rim at `radius`.
  function arcPath(vStart, vEnd, radius) {
    const a = pointAt(vStart, radius);
    const b = pointAt(vEnd, radius);
    const large = Math.abs(vEnd - vStart) > 50 ? 1 : 0;
    return `M ${a.x} ${a.y} A ${radius} ${radius} 0 ${large} 1 ${b.x} ${b.y}`;
  }

  // Filled wedge (center -> arc -> center) between two values.
  function wedgePath(vStart, vEnd) {
    const a = pointAt(vStart);
    const b = pointAt(vEnd);
    const large = Math.abs(vEnd - vStart) > 50 ? 1 : 0;
    return `M ${CX} ${CY} L ${a.x} ${a.y} A ${R} ${R} 0 ${large} 1 ${b.x} ${b.y} Z`;
  }

  class Dial {
    constructor(container, opts) {
      opts = opts || {};
      this.container = container;
      this.interactive = !!opts.interactive;
      this.value = opts.value == null ? 50 : opts.value;
      this.target = opts.target == null ? null : opts.target;
      this.onChange = opts.onChange || null;
      this._dragging = false;
      this._build();
      this.render();
    }

    _build() {
      this.container.innerHTML = "";
      const svg = el("svg", {
        viewBox: `0 0 ${VW} ${VH}`,
        class: "dial",
        role: "img",
      });
      this.svg = svg;

      // Background face.
      svg.appendChild(el("path", { d: wedgePath(0, 100), class: "dial-face" }));

      // Target band wedges (added/removed in render()).
      this.bandLayer = el("g", { class: "dial-bands" });
      svg.appendChild(this.bandLayer);

      // Rim outline.
      svg.appendChild(el("path", { d: arcPath(0, 100, R), class: "dial-rim" }));

      // Tick marks every 10.
      const ticks = el("g", { class: "dial-ticks" });
      for (let v = 0; v <= 100; v += 10) {
        const outer = pointAt(v, R);
        const inner = pointAt(v, R - 9);
        ticks.appendChild(
          el("line", { x1: inner.x, y1: inner.y, x2: outer.x, y2: outer.y })
        );
      }
      svg.appendChild(ticks);

      // Pointer (needle + knob).
      this.needle = el("line", { class: "dial-needle" });
      this.knob = el("circle", { r: 11, class: "dial-knob" });
      svg.appendChild(this.needle);
      svg.appendChild(this.knob);

      this.container.appendChild(svg);

      if (this.interactive) {
        svg.classList.add("interactive");
        svg.style.touchAction = "none";
        svg.addEventListener("pointerdown", (e) => this._onDown(e));
        svg.addEventListener("pointermove", (e) => this._onMove(e));
        svg.addEventListener("pointerup", (e) => this._onUp(e));
        svg.addEventListener("pointercancel", (e) => this._onUp(e));
      }
    }

    _valueFromEvent(e) {
      const rect = this.svg.getBoundingClientRect();
      // Map client coords into viewBox coords.
      const x = ((e.clientX - rect.left) / rect.width) * VW;
      const y = ((e.clientY - rect.top) / rect.height) * VH;
      let deg = (Math.atan2(CY - y, x - CX) * 180) / Math.PI; // 0..180 on top half
      deg = clamp(deg, 0, 180);
      return clamp((180 - deg) / 1.8, 0, 100);
    }

    _onDown(e) {
      if (!this.interactive) return;
      this._dragging = true;
      this.svg.setPointerCapture(e.pointerId);
      this._set(this._valueFromEvent(e), true);
    }
    _onMove(e) {
      if (!this._dragging) return;
      this._set(this._valueFromEvent(e), true);
    }
    _onUp(e) {
      if (!this._dragging) return;
      this._dragging = false;
      try { this.svg.releasePointerCapture(e.pointerId); } catch (_) {}
    }

    _set(value, fromUser) {
      this.value = value;
      this._renderPointer();
      if (fromUser && this.onChange) this.onChange(value);
    }

    setValue(v) {
      this.value = clamp(v, 0, 100);
      this._renderPointer();
    }
    getValue() {
      return this.value;
    }
    setTarget(t) {
      this.target = t;
      this._renderBands();
    }
    setInteractive(on) {
      this.interactive = !!on;
      this.svg.classList.toggle("interactive", this.interactive);
      this.svg.style.touchAction = on ? "none" : "auto";
    }

    _renderBands() {
      this.bandLayer.innerHTML = "";
      if (this.target == null) return;
      for (const b of BANDS) {
        const lo = clamp(this.target - b.w, 0, 100);
        const hi = clamp(this.target + b.w, 0, 100);
        this.bandLayer.appendChild(el("path", { d: wedgePath(lo, hi), class: b.cls }));
      }
      // Bullseye line at the exact target.
      const tip = pointAt(this.target);
      this.bandLayer.appendChild(
        el("line", {
          x1: CX, y1: CY, x2: tip.x, y2: tip.y, class: "dial-target-line",
        })
      );
    }

    _renderPointer() {
      const p = pointAt(this.value, R - 4);
      this.needle.setAttribute("x1", CX);
      this.needle.setAttribute("y1", CY);
      this.needle.setAttribute("x2", p.x);
      this.needle.setAttribute("y2", p.y);
      this.knob.setAttribute("cx", p.x);
      this.knob.setAttribute("cy", p.y);
    }

    // Add a labeled marker for another player's guess (used on reveal).
    addMarker(value, label, cls) {
      const p = pointAt(value, R - 4);
      const g = el("g", { class: "guess-marker " + (cls || "") });
      g.appendChild(el("line", { x1: CX, y1: CY, x2: p.x, y2: p.y }));
      g.appendChild(el("circle", { cx: p.x, cy: p.y, r: 7 }));
      if (label) {
        const lp = pointAt(value, R + 12);
        const t = el("text", {
          x: lp.x, y: lp.y, class: "marker-label",
          "text-anchor": lp.x < CX - 5 ? "end" : lp.x > CX + 5 ? "start" : "middle",
        });
        t.textContent = label;
        g.appendChild(t);
      }
      this.svg.appendChild(g);
    }

    clearMarkers() {
      this.svg.querySelectorAll(".guess-marker").forEach((n) => n.remove());
    }

    render() {
      this._renderBands();
      this._renderPointer();
    }
  }

  global.Dial = Dial;
})(window);
