/*
 * Small statistics toolkit for the PMT Explorer.
 * Everything runs in the browser: OLS fitting, poverty classification,
 * error metrics and Fisher's exact test.
 */
(function () {
  "use strict";

  // ---------- OLS ----------------------------------------------------------
  // rows: Int32Array of row indices. cols: array of Float64Array (one per feature).
  // y: Float64Array. Returns {beta, names, r2, sigma2, se(j)}.
  function fitOLS(rows, cols, names, y) {
    // Keep only columns that vary within these rows
    const keep = [];
    for (let j = 0; j < cols.length; j++) {
      const c = cols[j];
      const first = c[rows[0]];
      for (let k = 1; k < rows.length; k++) {
        if (c[rows[k]] !== first) { keep.push(j); break; }
      }
    }
    const X = keep.map((j) => cols[j]);
    const p = X.length + 1;
    const XtX = new Float64Array(p * p);
    const Xty = new Float64Array(p);
    const x = new Float64Array(p);
    const nz = new Int32Array(p);
    let yMean = 0;
    for (let k = 0; k < rows.length; k++) yMean += y[rows[k]];
    yMean /= rows.length;

    for (let k = 0; k < rows.length; k++) {
      const i = rows[k];
      x[0] = 1;
      let m = 1;
      nz[0] = 0;
      for (let j = 0; j < X.length; j++) {
        const v = X[j][i];
        x[j + 1] = v;
        if (v !== 0) nz[m++] = j + 1;
      }
      const yi = y[i];
      for (let a = 0; a < m; a++) {
        const ia = nz[a];
        const xa = x[ia];
        Xty[ia] += xa * yi;
        const rowOff = ia * p;
        for (let b = a; b < m; b++) {
          const ib = nz[b];
          XtX[rowOff + ib] += xa * x[ib];
        }
      }
    }
    // Mirror upper triangle (nz indices are increasing so ia <= ib)
    for (let a = 0; a < p; a++) for (let b = a + 1; b < p; b++) XtX[b * p + a] = XtX[a * p + b];

    // Cholesky with a tiny ridge fallback for (near-)collinear columns
    let L = null;
    let ridge = 0;
    let trace = 0;
    for (let a = 0; a < p; a++) trace += XtX[a * p + a];
    for (let attempt = 0; attempt < 8 && !L; attempt++) {
      L = cholesky(XtX, p, ridge);
      ridge = ridge === 0 ? (1e-10 * trace) / p : ridge * 100;
    }
    if (!L) throw new Error("Could not fit the model (matrix not invertible)");
    const beta = cholSolve(L, p, Xty);

    // R-squared and residual variance
    let sse = 0, sst = 0;
    for (let k = 0; k < rows.length; k++) {
      const i = rows[k];
      let pred = beta[0];
      for (let j = 0; j < X.length; j++) pred += beta[j + 1] * X[j][i];
      const r = y[i] - pred;
      sse += r * r;
      const d = y[i] - yMean;
      sst += d * d;
    }
    const dof = Math.max(1, rows.length - p);
    const sigma2 = sse / dof;

    const keptNames = keep.map((j) => names[j]);
    const fullBeta = new Float64Array(cols.length + 1);
    fullBeta[0] = beta[0];
    keep.forEach((j, idx) => { fullBeta[j + 1] = beta[idx + 1]; });

    return {
      beta: fullBeta, // aligned with [const, ...names]; dropped columns get 0
      names: names,
      kept: keptNames,
      r2: 1 - sse / sst,
      n: rows.length,
      sigma2: sigma2,
      // Standard error and p-value for a named column (null if dropped)
      test: function (name) {
        const idx = keptNames.indexOf(name);
        if (idx < 0) return null;
        const e = new Float64Array(p);
        e[idx + 1] = 1;
        const col = cholSolve(L, p, e);
        const se = Math.sqrt(sigma2 * col[idx + 1]);
        const b = beta[idx + 1];
        const t = b / se;
        return { coef: b, se: se, t: t, p: 2 * (1 - normCdf(Math.abs(t))) };
      },
    };
  }

  function cholesky(A, p, ridge) {
    const L = new Float64Array(p * p);
    for (let i = 0; i < p; i++) {
      for (let j = 0; j <= i; j++) {
        let s = A[i * p + j];
        if (i === j) s += ridge;
        for (let k = 0; k < j; k++) s -= L[i * p + k] * L[j * p + k];
        if (i === j) {
          if (!(s > 1e-12)) return null;
          L[i * p + i] = Math.sqrt(s);
        } else {
          L[i * p + j] = s / L[j * p + j];
        }
      }
    }
    return L;
  }

  function cholSolve(L, p, b) {
    const z = new Float64Array(p);
    for (let i = 0; i < p; i++) {
      let s = b[i];
      for (let k = 0; k < i; k++) s -= L[i * p + k] * z[k];
      z[i] = s / L[i * p + i];
    }
    const x = new Float64Array(p);
    for (let i = p - 1; i >= 0; i--) {
      let s = z[i];
      for (let k = i + 1; k < p; k++) s -= L[k * p + i] * x[k];
      x[i] = s / L[i * p + i];
    }
    return x;
  }

  function normCdf(z) {
    // Abramowitz-Stegun approximation
    const t = 1 / (1 + 0.2316419 * Math.abs(z));
    const d = 0.3989423 * Math.exp((-z * z) / 2);
    let prob = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
    return z > 0 ? 1 - prob : prob;
  }

  // ---------- Quantiles ----------------------------------------------------
  // Linear interpolation, same as pandas' default
  function quantile(values, q) {
    const s = Float64Array.from(values).sort();
    if (!s.length) return NaN;
    const pos = (s.length - 1) * q;
    const lo = Math.floor(pos);
    const hi = Math.ceil(pos);
    return s[lo] + (s[hi] - s[lo]) * (pos - lo);
  }

  function median(values) { return quantile(values, 0.5); }

  // ---------- Fisher's exact test (two-sided) ------------------------------
  const logFact = [0];
  function lf(n) {
    for (let i = logFact.length; i <= n; i++) logFact[i] = logFact[i - 1] + Math.log(i);
    return logFact[n];
  }
  function fisherExact(a, b, c, d) {
    const r1 = a + b, r2 = c + d, c1 = a + c, n = a + b + c + d;
    const base = lf(r1) + lf(r2) + lf(c1) + lf(n - c1) - lf(n);
    const prob = (x) => Math.exp(base - lf(x) - lf(r1 - x) - lf(c1 - x) - lf(r2 - c1 + x));
    const pObs = prob(a);
    let p = 0;
    const lo = Math.max(0, c1 - r2), hi = Math.min(r1, c1);
    for (let x = lo; x <= hi; x++) {
      const px = prob(x);
      if (px <= pObs * (1 + 1e-7)) p += px;
    }
    return Math.min(1, p);
  }

  window.Stats = { fitOLS, quantile, median, fisherExact, normCdf };
})();
