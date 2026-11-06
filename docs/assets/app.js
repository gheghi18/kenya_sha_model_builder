/*
 * PMT Explorer: interactive tests of the reconstructed SHA Means Testing
 * Instrument (OLS, urban/rural submodels, KCHS 2021).
 */
(function () {
  "use strict";
  const S = window.Stats;
  const DATA_VERSION = "2026-11-05h";

  // ---------------------------------------------------------------- helpers
  const $ = (s, r = document) => r.querySelector(s);
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const kes = (v) => "KES " + Math.round(v).toLocaleString("en-US");
  // KNBS consumption per adult equivalent (deflated, 2021) -> total household KES in 2024 prices.
  // Same conversion as code/02_train/training_log.py: x pdeflator x adult equivalents x inflation.
  const toHouseholdKes = (perAdq, adq, defl) => perAdq * adq * defl * app.meta.inflation_factor;
  const pct = (v, d = 0) => (isFinite(v) ? (v * 100).toFixed(d) + "%" : "–");
  const signedPct = (v, d = 0) => (v >= 0 ? "+" : "") + (v * 100).toFixed(d) + "%";
  const inTen = (v) => Math.round(v * 10);
  function el(tag, attrs = {}, html) {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (k === "class") e.className = v;
      else if (k.startsWith("on")) e.addEventListener(k.slice(2), v);
      else e.setAttribute(k, v);
    }
    if (html !== undefined) e.innerHTML = html;
    return e;
  }

  const C = {
    accent: "#c63d2a", ok: "#2f7d5d", under: "#3a6ea5", grey: "#a9a59b", amber: "#d8902c",
    ink: "#1d1d1b", muted: "#66645e", line: "#e2ded5", light: "#d9d5cc",
  };
  const KES_TICKS = [1000, 2000, 5000, 10000, 20000, 50000, 100000, 200000, 500000, 1000000];
  const kesTickText = (v) => (v >= 1e6 ? v / 1e6 + "m" : v >= 1000 ? v / 1000 + "k" : String(v));

  const GLOSSARY = {
    pmt: ["Proxy means test (PMT)", "A way of guessing a household's income from things that are easier to observe, such as its house, belongings and family members, instead of measuring income directly."],
    ols: ["OLS regression", "Ordinary least squares: a standard statistical method that finds the set of weights for each answer that best predicts income across all survey households."],
    log: ["Log scale", "The model works with the logarithm of income, so its errors are in percentages rather than shillings. On a log-scale chart, equal distances mean equal percentage differences."],
    over: ["Pays too much", "The model guesses the household's income more than 20% too high, so its bill is more than 20% too high."],
    exclusion: ["Exclusion error", "The share of truly poor households that the model wrongly predicts are not poor. These households could be asked to pay more than they can afford."],
    inclusion: ["Inclusion error", "The share of households the model labels as poor that are not actually poor."],
    r2: ["R-squared", "How much of the differences in income between households the model accounts for. 1 would be perfect and 0 would mean no better than guessing the average."],
    prices: ["2024 prices", "The survey was carried out in 2021. Amounts are converted to each household's local prices and then raised by 21.1% to account for inflation from 2021 to 2024, the same adjustment used in our analysis code."],
    hhline: ["Poverty line for the household", "KNBS sets the 2021 poverty line at KES 3,948 a month per adult in rural areas and KES 7,193 in urban areas. Children count for less: 0.24 of an adult under age 5 and 0.65 aged 5 to 14. The line for a whole household adds these up, and here it is converted to 2024 prices in the same way as income."],
    adq: ["Adult equivalent", "A way of counting household members that gives children less weight than adults, so incomes can be compared across households of different sizes."],
    decile: ["Decile", "Split households into ten equal-sized groups, from the poorest 10% to the richest 10%."],
    test: ["Test households", "The 20% of survey households (3,394) that were held back while the model was trained. We test the model on these so it can't simply memorise the answers."],
    pp: ["Percentage points", "The difference between two percentages. Going from 20% to 25% is a rise of 5 percentage points."],
    chance: ["Could it be chance?", "With small groups, differences can appear just by luck. We use a statistical test (p-value below 0.05) to flag differences that are unlikely to be due to chance alone."],
    rtm: ["Regression to the mean", "Models like this one pull predictions towards the average. Households at the extremes, the very poor and the very rich, end up with estimates that are too close to the middle."],
    coef: ["Coefficient (weight)", "The amount the model adds to or subtracts from its estimate for a particular answer. For example, owning a fridge raises the estimate by a fixed percentage."],
  };

  const THR_OPTS = [
    { v: "official", l: "Official poverty line" },
    { v: 0.25, l: "Poorest 25%" },
    { v: 0.4, l: "Poorest 40%" },
  ];
  const SECTOR_OPTS = [{ v: "All", l: "All" }, { v: "Urban", l: "Urban" }, { v: "Rural", l: "Rural" }];
  const SECTORS = ["Urban", "Rural"];
  // Questions worked out from the list of people rather than asked directly
  const PEOPLE_KEYS = new Set(["household_size", "mm_age", "prop_over65", "prop_under5", "prop_m1864", "prop_w1864", "x_num_children"]);

  const app = {
    meta: null, D: null,
    base: null, basePred: null,
    opts: { thr: "official", sector: "All" },
    user: null,
  };

  // ------------------------------------------------------------------ data
  async function load() {
    const [meta, csv] = await Promise.all([
      fetch("data/meta.json?v=" + DATA_VERSION).then((r) => { if (!r.ok) throw new Error("meta.json " + r.status); return r.json(); }),
      fetch("data/households.csv?v=" + DATA_VERSION).then((r) => { if (!r.ok) throw new Error("households.csv " + r.status); return r.text(); }),
    ]);
    const parsed = Papa.parse(csv, { header: true, skipEmptyLines: true });
    const rows = parsed.data;
    const n = rows.length;
    const D = { n, num: {}, str: {} };
    for (const f of parsed.meta.fields) {
      if (f.startsWith("g_") || f === "people") {
        D.str[f] = rows.map((r) => r[f]);
      } else {
        const a = new Float64Array(n);
        for (let i = 0; i < n; i++) a[i] = +rows[i][f];
        D.num[f] = a;
      }
    }
    D.y = D.num.y;
    D.isUrban = D.num.urban;
    D.sector = (i) => (D.isUrban[i] ? "Urban" : "Rural");
    const test = [], train = { Urban: [], Rural: [] };
    for (let i = 0; i < n; i++) {
      if (D.num.test[i]) test.push(i);
      else train[D.sector(i)].push(i);
    }
    D.testRows = Int32Array.from(test);
    D.trainRows = { Urban: Int32Array.from(train.Urban), Rural: Int32Array.from(train.Rural) };
    // Means of each column among training households (for "typical household" comparisons)
    D.means = {};
    for (const s of SECTORS) {
      D.means[s] = {};
      const r = D.trainRows[s];
      for (const f of Object.keys(D.num)) {
        let sum = 0;
        for (let k = 0; k < r.length; k++) sum += D.num[f][r[k]];
        D.means[s][f] = sum / r.length;
      }
    }
    app.meta = meta;
    app.D = D;

    // Column -> plain label
    app.colLabel = {};
    app.colVar = {};
    for (const v of meta.model_vars.concat(meta.extra_vars)) {
      if (v.type === "categorical") {
        for (const c of v.categories) if (c.column) { app.colLabel[c.column] = v.label + ": " + c.label; app.colVar[c.column] = v; }
      } else {
        app.colLabel[v.columns[0]] = v.label;
        app.colVar[v.columns[0]] = v;
      }
    }

    // Every question you can build with: SHA's 39 plus extra survey questions
    app.vars = meta.model_vars.map((v) => ({ ...v, sha: true })).concat(meta.extra_vars.map((v) => ({ ...v, sha: false })));
    app.varByKey = Object.fromEntries(app.vars.map((v) => [v.key, v]));
    // Neutral groups that mix SHA's questions with the others, so the list doesn't reveal SHA's model
    const WORK_KEYS = new Set(["working", "d01_wage", "d01_own_account", "d01_own_frm", "occupation"]);
    const OWN_KEYS = new Set(["x_owns_sewing_machine", "x_owns_animal_drawn_vehicles"]);
    for (const v of app.vars) {
      v.group = WORK_KEYS.has(v.key) || ((v.theme === "Work" || v.theme === "Livelihood") && !OWN_KEYS.has(v.key)) ? "Work & livelihood"
        : OWN_KEYS.has(v.key) || ["Things you own", "Everyday household items", "Electrical goods"].includes(v.theme) ? "Things the household owns"
        : v.theme;
    }
    // Same naming style for every owned item ("Blender", not "Owns a blender")
    for (const v of app.vars) if (v.group === "Things the household owns") {
      const l = v.label.replace(/^Owns (an? )?/, "");
      v.label = l.charAt(0).toUpperCase() + l.slice(1);
      if (v.type === "binary") app.colLabel[v.columns[0]] = v.label;
    }
    app.vars.sort((a, b) => a.label.localeCompare(b.label));

    // Baseline model = SHA formula with coefficients estimated in code/02_train
    app.base = {};
    for (const s of SECTORS) {
      const b = meta.baseline[s.toLowerCase()];
      const names = meta.features;
      const beta = new Float64Array(names.length + 1);
      beta[0] = b.coef.const;
      names.forEach((nm, j) => { beta[j + 1] = b.coef[nm] || 0; });
      app.base[s] = { names, beta, r2: b.r2_train };
    }
    app.basePred = predictAll(app.base);
  }

  function predictAll(model) {
    const D = app.D;
    const out = new Float64Array(D.n);
    for (const s of SECTORS) {
      const m = model[s];
      const cols = m.names.map((nm) => D.num[nm]);
      for (let i = 0; i < D.n; i++) {
        if (D.sector(i) !== s) continue;
        let v = m.beta[0];
        for (let j = 0; j < cols.length; j++) {
          const b = m.beta[j + 1];
          if (b !== 0) v += b * cols[j][i];
        }
        out[i] = v;
      }
    }
    return out;
  }

  // Poverty classification of test households
  function classify(pred, opts) {
    const D = app.D;
    const lines = {};
    for (const s of SECTORS) {
      if (opts.thr === "official") lines[s] = app.meta.poverty_line[s];
      else {
        const vals = [];
        for (const i of D.testRows) if (D.sector(i) === s) vals.push(Math.exp(D.y[i]));
        lines[s] = S.quantile(vals, opts.thr);
      }
    }
    const rows = [];
    for (const i of D.testRows) if (opts.sector === "All" || D.sector(i) === opts.sector) rows.push(i);
    const m = rows.length;
    const act = new Float64Array(m), prd = new Float64Array(m), ap = new Uint8Array(m), pp = new Uint8Array(m), line = new Float64Array(m), mult = new Float64Array(m);
    rows.forEach((i, k) => {
      act[k] = Math.exp(D.y[i]);
      mult[k] = toHouseholdKes(1, D.num.adq[i], D.num.defl[i]);
      prd[k] = Math.exp(pred[i]);
      line[k] = lines[D.sector(i)];
      ap[k] = act[k] <= line[k] ? 1 : 0;
      pp[k] = prd[k] <= line[k] ? 1 : 0;
    });
    return { rows, act, prd, ap, pp, line, lines, pred, mult };
  }

  function confusion(c, filter) {
    let TP = 0, FN = 0, FP = 0, TN = 0;
    for (let k = 0; k < c.rows.length; k++) {
      if (filter && !filter(k)) continue;
      if (c.ap[k]) c.pp[k] ? TP++ : FN++;
      else c.pp[k] ? FP++ : TN++;
    }
    return {
      TP, FN, FP, TN, N: TP + FN + FP + TN, poor: TP + FN,
      exclusion: FN / (TP + FN), inclusion: FP / (TP + FP), povRate: (TP + FN) / (TP + FN + FP + TN),
    };
  }

  // Deciles of actual spending, with share under/about right/over (±0.2 log points)
  function deciles(c, tol = 0.2) {
    const edges = [];
    for (let q = 1; q < 10; q++) edges.push(S.quantile(c.act, q / 10));
    const out = Array.from({ length: 10 }, () => ({ under: 0, ok: 0, over: 0, n: 0 }));
    const bucket = new Array(c.rows.length);
    for (let k = 0; k < c.rows.length; k++) {
      let d = 0;
      while (d < 9 && c.act[k] > edges[d]) d++;
      const err = Math.log(c.prd[k]) - Math.log(c.act[k]);
      const b = Math.abs(err) <= tol ? "ok" : err > 0 ? "over" : "under";
      bucket[k] = b;
      out[d][b]++;
      out[d].n++;
    }
    out.forEach((o) => { o.underP = o.under / o.n; o.okP = o.ok / o.n; o.overP = o.over / o.n; });
    return { dec: out, bucket };
  }

  // ------------------------------------------------------------ UI helpers
  document.addEventListener("toggle", (e) => {
    if (e.target.open) e.target.querySelectorAll(".js-plotly-plot").forEach((g) => Plotly.Plots.resize(g));
  }, true);

  function plot(id, data, layout) {
    const base = {
      margin: { l: 60, r: 20, t: 10, b: 50 },
      paper_bgcolor: "rgba(0,0,0,0)", plot_bgcolor: "rgba(0,0,0,0)",
      font: { family: "Inter, system-ui, sans-serif", size: 12, color: C.ink },
      hoverlabel: { font: { family: "Inter, system-ui, sans-serif" } },
      showlegend: false,
    };
    const lay = Object.assign(base, layout);
    for (const ax of ["xaxis", "yaxis"]) lay[ax] = Object.assign({ gridcolor: "#ece9e2", zerolinecolor: C.line, linecolor: C.line, automargin: true }, layout[ax] || {});
    Plotly.react(id, data, lay, { displayModeBar: false, responsive: true });
  }

  function seg(container, label, options, value, onChange) {
    const wrap = el("div", { class: "control" });
    wrap.append(el("span", { class: "clabel" }, esc(label)));
    const s = el("div", { class: "seg", role: "group", "aria-label": label });
    options.forEach((o) => {
      const b = el("button", { type: "button", "aria-pressed": String(o.v === value) }, esc(o.l));
      if (o.v === value) b.classList.add("on");
      b.addEventListener("click", () => onChange(o.v));
      s.append(b);
    });
    wrap.append(s);
    container.append(wrap);
  }

  function selectControl(container, label, options, value, onChange) {
    const wrap = el("div", { class: "control" });
    const id = "sel-" + Math.random().toString(36).slice(2);
    wrap.append(el("label", { for: id }, esc(label)));
    const s = el("select", { id });
    options.forEach((o) => {
      const op = el("option", { value: o.v }, esc(o.l));
      if (o.v === value) op.selected = true;
      s.append(op);
    });
    s.addEventListener("change", () => onChange(s.value));
    wrap.append(s);
    container.append(wrap);
  }

  function standardControls(id, rerender, { thr = true, sector = true } = {}) {
    const box = $(id);
    box.innerHTML = "";
    if (thr) seg(box, "Who counts as poor?", THR_OPTS, app.opts.thr, (v) => { app.opts.thr = v; rerender(); });
    if (sector) seg(box, "Area", SECTOR_OPTS, app.opts.sector, (v) => { app.opts.sector = v; rerender(); });
  }

  const thrText = () => (app.opts.thr === "official" ? "below the official poverty line" : "in the poorest " + Math.round(app.opts.thr * 100) + "%");
  const sectorText = () => (app.opts.sector === "All" ? "" : " " + app.opts.sector.toLowerCase());

  // -------------------------------------------------------------- START
  function renderStart() {}

  // ------------------------------------------------------ 1. HOUSEHOLD
  const hh = { cur: null, start: null };
  const PREMIUM_RATE = 0.0275;

  function varByKey(k) { return app.meta.model_vars.find((v) => v.key === k); }

  // Adult-equivalent weight used by KNBS (Anzagi-Bernard scale)
  function adqWeight(age) {
    if (!Number.isFinite(age)) return 1;
    return age < 5 ? 0.24 : age < 15 ? 0.65 : 1;
  }

  function parsePeople(str) {
    return String(str || "").split("|").filter(Boolean).map((p) => ({ sex: p[0] === "M" ? "M" : "F", age: p.slice(1) === "?" ? NaN : +p.slice(1) }));
  }

  function blankHousehold() {
    const h = {
      sector: "Rural",
      people: [{ sex: "M", age: 38 }, { sex: "F", age: 34 }, { sex: "F", age: 9 }, { sex: "M", age: 3 }],
      nr_rooms: 2, cat: {}, bin: {}, real: null, label: "",
    };
    for (const v of app.vars) {
      if (v.type === "categorical") h.cat[v.key] = v.reference || v.categories[0].label;
      if (v.type === "binary") h.bin[v.key] = 0;
    }
    h.x_age_household_head = 38;
    return h;
  }

  function householdFromRow(i) {
    const D = app.D, h = blankHousehold();
    h.sector = D.sector(i);
    h.people = parsePeople(D.str.people[i]);
    h.nr_rooms = D.num.nr_rooms[i];
    for (const v of app.vars) {
      if (v.type === "categorical") {
        const hit = v.categories.find((c) => c.column && D.num[c.column][i] === 1);
        h.cat[v.key] = hit ? hit.label : v.reference;
      } else if (v.type === "binary") h.bin[v.key] = D.num[v.columns[0]][i];
    }
    h.x_age_household_head = D.num.x_age_household_head[i];
    h.real = { i, actualPerAdq: Math.exp(D.y[i]) };
    return h;
  }

  function setPreset(kind) {
    const h = blankHousehold();
    const set = (key, label) => { h.cat[key] = label; };
    if (kind === "couple") {
      Object.assign(h, { sector: "Rural", people: [{ sex: "M", age: 74 }, { sex: "F", age: 70 }], nr_rooms: 2, label: "Elderly farming couple, Murang'a (illustrative)" });
      set("County", "Murang'a"); set("hhhead_woman", "Man"); set("marital_status", "Married monogamous"); set("education_level", "Primary");
      set("occupation", "Farmer"); set("dwelling", "Bungalow"); set("ownership_dwelling", "Owns"); set("roof_material", "Iron sheets");
      set("wall_material", "Stone with lime/cement"); set("floor_material", "Concrete/cement/terrazzo"); set("drinking_water_source", "Piped to yard/plot");
      set("toilet_facility", "Pit latrine (covered)"); set("cooking_fuel_source", "Firewood and products of wood"); set("lighting_source", "Electricity");
      Object.assign(h.bin, { working: 1, d01_own_frm: 1, access_electricity: 1, own_radio: 1, own_phone: 1, own_tv: 1 });
    } else if (kind === "young") {
      Object.assign(h, { sector: "Urban", people: [{ sex: "F", age: 24 }], nr_rooms: 1, label: "Young woman living alone, Meru (illustrative)" });
      set("County", "Meru"); set("hhhead_woman", "Woman"); set("marital_status", "Never married"); set("education_level", "Secondary");
      set("occupation", "Casual labour"); set("dwelling", "Landie (row of rooms)"); set("ownership_dwelling", "Pays rent/lease"); set("roof_material", "Iron sheets");
      set("wall_material", "Stone with lime/cement"); set("floor_material", "Concrete/cement/terrazzo"); set("drinking_water_source", "Public tap/Standpipe");
      set("toilet_facility", "Pit latrine (covered)"); set("cooking_fuel_source", "Charcoal"); set("lighting_source", "Electricity");
      Object.assign(h.bin, { working: 1, access_electricity: 1, own_phone: 1 });
    } else {
      const c = classify(app.basePred, { thr: "official", sector: "All" });
      const p80 = S.quantile(c.act, 0.8);
      const pool = [];
      for (let k = 0; k < c.rows.length; k++) {
        const err = Math.log(c.prd[k] / c.act[k]);
        if (kind === "random") pool.push(c.rows[k]);
        if (kind === "middle" && Math.abs(err) < 0.1 && app.D.sector(c.rows[k]) === "Rural") pool.push(c.rows[k]);
        if (kind === "missed" && c.ap[k] && !c.pp[k] && err > 0.4) pool.push(c.rows[k]);
        if (kind === "rich" && c.act[k] > p80 && err < -0.4) pool.push(c.rows[k]);
      }
      let pick = pool[Math.floor(Math.random() * pool.length)];
      if (kind === "middle") {
        // A typical household: rural, real income and model guess both near the rural median, 4 people, model roughly right
        const kOf = new Map(c.rows.map((i, k) => [i, k]));
        const rural = c.rows.map((i, k) => k).filter((k) => app.D.sector(c.rows[k]) === "Rural");
        const medA = S.median(rural.map((k) => c.act[k] * c.mult[k]));
        const medP = S.median(rural.map((k) => c.prd[k] * c.mult[k]));
        const ok = pool.filter((i) => (app.D.str.people[i] || "").split("|").length === 4);
        const dist = (i) => { const k = kOf.get(i); return Math.abs(Math.log(c.act[k] * c.mult[k] / medA)) + Math.abs(Math.log(c.prd[k] * c.mult[k] / medP)); };
        pick = (ok.length ? ok : pool).sort((a, b) => dist(a) - dist(b))[0];
      }
      const r = householdFromRow(pick);
      r.label = { middle: "A typical household", random: "A random real household", missed: "A real poor household the model gets wrong", rich: "A real better-off household the model underestimates" }[kind];
      Object.assign(h, r);
    }
    hh.cur = h;
    hh.start = JSON.parse(JSON.stringify(h));
    renderHouseholdForm();
    renderHouseholdResult();
  }

  // Model inputs derived from the member list, exactly as in prep_kchs_data.ipynb
  function householdVector(h) {
    const x = {};
    const ppl = h.people.length ? h.people : [{ sex: "F", age: 30 }];
    const n = ppl.length;
    let sumAge = 0, o65 = 0, u5 = 0, m = 0, w = 0;
    for (const p of ppl) {
      if (!Number.isFinite(p.age)) continue;
      sumAge += p.age;
      if (p.age >= 65) o65++;
      if (p.age <= 5) u5++;
      if (p.age >= 18 && p.age <= 64) p.sex === "M" ? m++ : w++;
    }
    x.household_size = n;
    x.mm_age = Math.log(Math.max(0.5, sumAge));
    x.prop_over65 = o65 / n;
    x.prop_under5 = u5 / n;
    x.prop_m1864 = m / n;
    x.prop_w1864 = w / n;
    x.nr_rooms = h.nr_rooms;
    x.x_num_children = ppl.filter((p) => Number.isFinite(p.age) && p.age < 18).length;
    x.x_age_household_head = h.x_age_household_head;
    if (h.real && hh.start && hh.start.real && JSON.stringify(h.people) === JSON.stringify(hh.start.people)) x.x_num_children = app.D.num.x_num_children[h.real.i];
    for (const v of app.vars) {
      if (v.type === "categorical") {
        const c = v.categories.find((c) => c.label === h.cat[v.key]);
        if (c && c.column) x[c.column] = 1;
      } else if (v.type === "binary") x[v.columns[0]] = h.bin[v.key] ? 1 : 0;
    }
    return x;
  }

  // Adult equivalents and price deflator for a household. Real survey households use their own
  // values; households you build use the typical deflator for urban or rural areas.
  function householdScale(h) {
    const D = app.D;
    const unchangedReal = h.real && hh.start.real && hh.start.real.i === h.real.i && JSON.stringify(h.people) === JSON.stringify(hh.start.people);
    const adq = unchangedReal ? D.num.adq[h.real.i] : h.people.reduce((s, p) => s + adqWeight(p.age), 0) || 1;
    const defl = h.real && h.sector === D.sector(h.real.i) ? D.num.defl[h.real.i] : app.meta.deflator_median[h.sector];
    return { adq, defl };
  }

  function predictHousehold(h, model = app.user.model || app.base) {
    const m = model[h.sector];
    const x = householdVector(h);
    let v = m.beta[0];
    m.names.forEach((nm, j) => { v += m.beta[j + 1] * (x[nm] || 0); });
    const { adq, defl } = householdScale(h);
    return { log: v, perAdq: Math.exp(v), adq, defl, total: toHouseholdKes(Math.exp(v), adq, defl), x };
  }

  function contributions(h, x) {
    const m = app.user.model[h.sector];
    const means = app.D.means[h.sector];
    const out = [];
    for (const v of app.vars.filter((v) => app.user.sel.includes(v.key))) {
      let c = 0;
      for (const col of v.columns) {
        const j = m.names.indexOf(col);
        if (j >= 0) c += m.beta[j + 1] * ((x[col] || 0) - means[col]);
      }
      let label = v.label;
      if (v.type === "categorical") label += ": " + h.cat[v.key];
      if (v.type === "binary") label += h.bin[v.key] ? ": yes" : ": no";
      if (v.key === "x_age_household_head" || v.key === "nr_rooms") label += ": " + h[v.key];
      out.push({ label, c });
    }
    return out;
  }

  function renderPeople(container, onChange) {
    const h = hh.cur;
    container.innerHTML = "";
    const list = el("div", { class: "people" });
    h.people.forEach((p, idx) => {
      const row = el("div", { class: "person" });
      row.append(el("span", { class: "pnum" }, String(idx + 1)));
      const sexId = "ps-" + idx, ageId = "pa-" + idx;
      const sex = el("select", { id: sexId, "aria-label": `Person ${idx + 1} sex` });
      [["F", "Female"], ["M", "Male"]].forEach(([v, l]) => { const o = el("option", { value: v }, l); if (p.sex === v) o.selected = true; sex.append(o); });
      sex.addEventListener("change", () => { p.sex = sex.value; onChange(); });
      const age = el("input", { id: ageId, type: "number", min: 0, max: 110, step: 1, value: Number.isFinite(p.age) ? p.age : "", "aria-label": `Person ${idx + 1} age` });
      age.addEventListener("input", () => { const v = parseFloat(age.value); if (isFinite(v)) { p.age = Math.min(110, Math.max(0, v)); onChange(); } });
      const ageWrap = el("label", { class: "page" });
      ageWrap.append(age, document.createTextNode(" years"));
      const rm = el("button", { type: "button", class: "linkbtn", "aria-label": `Remove person ${idx + 1}` }, "remove");
      rm.disabled = h.people.length <= 1;
      rm.addEventListener("click", () => { h.people.splice(idx, 1); renderPeople(container, onChange); onChange(); });
      row.append(sex, ageWrap, rm);
      list.append(row);
    });
    container.append(list);
    const add = el("button", { type: "button", class: "btn small" }, "+ Add a person");
    add.addEventListener("click", () => { h.people.push({ sex: "F", age: 10 }); renderPeople(container, onChange); onChange(); });
    container.append(add);
  }

  function renderHouseholdForm() {
    const h = hh.cur, start = hh.start;
    const form = $("#hh-form");
    form.innerHTML = "";
    const changed = (a, b) => (JSON.stringify(a) !== JSON.stringify(b) ? " changed" : "");
    const onChange = () => { renderHouseholdResult(); };

    const inModel = (k) => app.user.sel.includes(k);

    // Where
    const fsWhere = el("fieldset");
    fsWhere.append(el("legend", {}, "Where the household lives"));
    const g1 = el("div", { class: "field-grid" });
    g1.append(fieldSelect("Urban or rural area?", [{ v: "Urban", l: "Urban" }, { v: "Rural", l: "Rural" }], h.sector, (v) => { h.sector = v; onChange(); }, changed(h.sector, start.sector)));
    if (inModel("County")) {
      const county = app.varByKey.County;
      g1.append(fieldSelect(county.question, county.categories.map((c) => ({ v: c.label, l: c.label })).sort((a, b) => a.l.localeCompare(b.l)), h.cat.County, (v) => { h.cat.County = v; onChange(); }, changed(h.cat.County, start.cat.County)));
    }
    fsWhere.append(g1);
    form.append(fsWhere);

    // People (always: household size sets the bill)
    const fsPeople = el("fieldset");
    fsPeople.append(el("legend", {}, "Who lives here"));
    const pbox = el("div");
    fsPeople.append(pbox);
    renderPeople(pbox, onChange);
    form.append(fsPeople);

    // Only the questions in your model, grouped by theme
    hh.closed = hh.closed || new Set();
    let asked = 0;
    for (const t of THEME_ORDER.filter((t) => t !== "Where you live")) {
      const vars = app.vars.filter((v) => v.group === t && inModel(v.key) && !PEOPLE_KEYS.has(v.key));
      if (!vars.length) continue;
      asked += vars.length;
      const fs = el("details", { class: "fs" });
      fs.open = !hh.closed.has(t);
      fs.addEventListener("toggle", () => (fs.open ? hh.closed.delete(t) : hh.closed.add(t)));
      fs.append(el("summary", {}, esc(THEME_LABEL[t] || t) + ` <span class="badge sec-badge" data-theme="${esc(t)}" hidden></span>`));
      const grid = el("div", { class: "field-grid" });
      const checks = el("div", { class: "checks" });
      for (const v of vars) {
        if (v.type === "categorical") {
          grid.append(fieldSelect(v.question || v.label, v.categories.map((c) => ({ v: c.label, l: c.label })), h.cat[v.key], (val) => { h.cat[v.key] = val; onChange(); }, changed(h.cat[v.key], start.cat[v.key])));
        } else if (v.type === "numeric") {
          grid.append(fieldNumber(v.question || v.label, h[v.key], 0, v.key === "x_age_household_head" ? 110 : 20, 1, (val) => { h[v.key] = val; onChange(); }, changed(h[v.key], start[v.key])));
        } else {
          const lab = el("label", { class: "check" + changed(h.bin[v.key], start.bin[v.key]) });
          const cb = el("input", { type: "checkbox" });
          cb.checked = !!h.bin[v.key];
          cb.addEventListener("change", () => { h.bin[v.key] = cb.checked ? 1 : 0; lab.classList.toggle("changed", h.bin[v.key] !== start.bin[v.key]); onChange(); });
          lab.append(cb, document.createTextNode(v.label));
          checks.append(lab);
        }
      }
      if (grid.children.length) fs.append(grid);
      if (checks.children.length) {
        if (grid.children.length) checks.style.marginTop = "10px";
        fs.append(checks);
      }
      form.append(fs);
    }
    if (!asked && !inModel("County")) form.append(el("p", { class: "small muted" }, "Your model only uses the list of people. Add more questions in step 1."));
  }

  function fieldSelect(label, options, value, onChange, extraClass = "") {
    const f = el("div", { class: "field" + extraClass });
    const id = "f-" + Math.random().toString(36).slice(2);
    f.append(el("label", { for: id }, esc(label)));
    const s = el("select", { id });
    options.forEach((o) => {
      const op = el("option", { value: o.v }, esc(o.l));
      if (o.v === value) op.selected = true;
      s.append(op);
    });
    s.addEventListener("change", () => {
      onChange(s.value);
      f.classList.toggle("changed", true);
    });
    f.append(s);
    return f;
  }

  function fieldNumber(label, value, min, max, step, onChange, extraClass = "") {
    const f = el("div", { class: "field" + extraClass });
    const id = "f-" + Math.random().toString(36).slice(2);
    f.append(el("label", { for: id }, esc(label)));
    const inp = el("input", { id, type: "number", min, max, step, value });
    inp.addEventListener("input", () => {
      const v = parseFloat(inp.value);
      if (!isFinite(v)) return;
      onChange(Math.min(max, Math.max(min, v)));
      f.classList.toggle("changed", true);
    });
    f.append(inp);
    return f;
  }

  const clone = (o) => JSON.parse(JSON.stringify(o));
  const premiumOf = (h) => predictHousehold(h).total * PREMIUM_RATE;

  // Every difference between the current household and where you started,
  // with how much that single change moves the monthly premium.
  function householdChanges(h, s) {
    const out = [];
    const add = (label, revert) => {
      const without = clone(h);
      revert(without);
      out.push({ label, revert, effect: premiumOf(h) - premiumOf(without) });
    };
    if (h.sector !== s.sector) add(`Area: ${s.sector} → ${h.sector}`, (x) => { x.sector = s.sector; });
    if (JSON.stringify(h.people) !== JSON.stringify(s.people)) {
      const a = s.people.length, b = h.people.length;
      add(a === b ? "Household members changed" : `People: ${a} → ${b}`, (x) => { x.people = clone(s.people); });
    }
    for (const v of app.vars) {
      if (v.type === "categorical" && h.cat[v.key] !== s.cat[v.key]) {
        add(`${v.label}: ${s.cat[v.key]} → ${h.cat[v.key]}`, (x) => { x.cat[v.key] = s.cat[v.key]; });
      } else if (v.type === "binary" && !!h.bin[v.key] !== !!s.bin[v.key]) {
        add(`${v.label}: ${s.bin[v.key] ? "yes" : "no"} → ${h.bin[v.key] ? "yes" : "no"}`, (x) => { x.bin[v.key] = s.bin[v.key]; });
      } else if (v.type === "numeric" && v.key in h && h[v.key] !== s[v.key]) {
        add(`${v.label}: ${s[v.key]} → ${h[v.key]}`, (x) => { x[v.key] = s[v.key]; });
      }
    }
    return out;
  }

  // A single shilling scale: poor zone, poverty line and up to three dots
  function numberLine(marks, line) {
    const W = 340, x0 = 12, x1 = W - 12;
    const max = Math.max(line, ...marks.map((m) => m.v)) * 1.15;
    const X = (v) => x0 + (v / max) * (x1 - x0);
    const sorted = marks.slice().sort((a, b) => a.v - b.v);
    let svg = `<svg viewBox="0 0 ${W} 92" width="100%" role="img" aria-label="Monthly premium on a shilling scale">
      <rect x="${x0}" y="46" width="${X(line) - x0}" height="10" rx="2" fill="${C.ok}" opacity=".18"/>
      <line x1="${x0}" y1="51" x2="${x1}" y2="51" stroke="${C.grey}" stroke-width="1"/>
      <line x1="${X(line)}" y1="40" x2="${X(line)}" y2="62" stroke="${C.ink}" stroke-width="1.5"/>
      <text x="${X(line)}" y="78" font-size="11" text-anchor="middle" fill="${C.muted}">Poverty line ${kes(line)}</text>
      <text x="${x0}" y="78" font-size="11" fill="${C.ok}" text-anchor="start" ${X(line) - x0 < 120 ? 'opacity="0"' : ""}>Poor</text>`;
    sorted.forEach((m, k) => {
      const y = k % 2 === 0 ? 30 : 14;
      const x = X(m.v);
      const anchor = x < 60 ? "start" : x > W - 60 ? "end" : "middle";
      svg += `<line x1="${x}" y1="${y + 3}" x2="${x}" y2="51" stroke="${m.color}" stroke-width="1" opacity=".5"/>
        <circle cx="${x}" cy="51" r="${m.big ? 7 : 6}" fill="${m.color}" stroke="#fff" stroke-width="1.5"/>
        <text x="${x}" y="${y}" font-size="11.5" font-weight="${m.big ? 600 : 400}" text-anchor="${anchor}" fill="${C.ink}">${esc(m.label)}</text>`;
    });
    const legend = marks.map((m) => `<span><i class="dot" style="background:${m.color}"></i>${esc(m.label)} <b>${kes(m.v)}</b></span>`).join("");
    return svg + `</svg><div class="legend numlegend">${legend}</div>`;
  }

  function renderHouseholdResult() {
    const h = hh.cur, s = hh.start;
    const r = predictHousehold(h);
    const r0 = predictHousehold(s);
    const prem = r.total * PREMIUM_RATE, prem0 = r0.total * PREMIUM_RATE;
    const lineSpend = toHouseholdKes(app.meta.poverty_line[h.sector], r.adq, r.defl);
    const linePrem = lineSpend * PREMIUM_RATE;
    const predPoor = r.total <= lineSpend;
    const changes = householdChanges(h, s);
    const realOk = h.real && JSON.stringify(h.people) === JSON.stringify(s.people);
    const actual = realOk ? toHouseholdKes(h.real.actualPerAdq, r.adq, r.defl) : null;
    const box = $("#hh-result");

    // Headline: premium before -> after
    const d = prem - prem0;
    let html = `<span class="kicker">${esc(h.label || "Your household")}</span>
      <div class="small muted" style="margin-top:6px">Monthly bill from your model</div>`;
    html += changes.length
      ? `<div class="headline"><span class="was">${kes(prem0)}</span><span class="arrow">→</span><span class="now">${kes(prem)}</span><span class="dlt" style="color:${d > 0 ? C.accent : C.under}">${d > 0 ? "+" : "−"}${kes(Math.abs(d))}</span></div>`
      : `<div class="headline"><span class="now">${kes(prem)}</span></div>`;
    html += `<div class="verdict ${predPoor ? "poor" : "notpoor"}">Your model says: ${predPoor ? "poor" : "not poor"}</div>`;
    html += `<div class="sha-cmp">SHA's model would charge ${kes(predictHousehold(h, app.base).total * PREMIUM_RATE)}</div>`;

    // Number line
    const marks = [];
    if (actual) marks.push({ label: "Real", v: actual * PREMIUM_RATE, color: C.ok });
    if (changes.length) marks.push({ label: "Before", v: prem0, color: C.grey });
    marks.push({ label: changes.length ? "Now" : "Yours", v: prem, color: C.accent, big: true });
    html += `<div class="numline">${numberLine(marks, linePrem)}</div>`;

    // One sentence
    let say = "";
    if (actual && !changes.length) {
      const extra = prem - actual * PREMIUM_RATE;
      const actPoor = actual <= lineSpend;
      if (actPoor && !predPoor) say = `Really poor, but the model says not. Overcharged by ${kes(extra)} a month.`;
      else if (!actPoor && predPoor) say = `Not poor, but the model thinks it is.`;
      else say = `${kes(Math.abs(extra))} a month too ${extra > 0 ? "high" : "low"}.`;
    }
    if (changes.length) {
      const crossed = (r0.total <= toHouseholdKes(app.meta.poverty_line[s.sector], r0.adq, r0.defl)) !== predPoor;
      say = crossed ? `Now: <strong>${predPoor ? "poor" : "not poor"}</strong>.` : "";
    } else if (!actual) say = "Change any answer.";
    if (say.trim()) html += `<p class="say">${say.trim()}</p>`;

    // Change chips
    if (changes.length) {
      html += `<div class="chips-head"><span class="small muted">You changed</span><button type="button" class="linkbtn" id="hh-undo-all">Undo all</button></div><div class="chips">` +
        changes.map((c, k) => `<span class="chip">${esc(c.label)} <b style="color:${c.effect > 0.5 ? C.accent : c.effect < -0.5 ? C.under : C.muted}">${Math.abs(c.effect) < 0.5 ? "±KES 0" : (c.effect > 0 ? "+" : "−") + kes(Math.abs(c.effect))}</b><button type="button" class="chip-x" data-k="${k}" aria-label="Undo ${esc(c.label)}">×</button></span>`).join("") +
        `</div>`;
    }

    // Details drawer
    html += `<details class="drawer" id="hh-details"${hh.detailsOpen ? " open" : ""}><summary>More detail</summary>
      <div class="compare-line"><span>Model's guess of monthly income</span><b>${kes(r.total)}</b></div>
      ${actual ? `<div class="compare-line"><span>Real monthly income</span><b>${kes(actual)}</b></div>` : ""}
      <div class="compare-line"><span>Poverty line for this household (<span class="term" data-term="hhline">?</span>)</span><b>${kes(lineSpend)}</b></div>
      <p class="small muted">2024 prices (<span class="term" data-term="prices">how?</span>). Bill = 2.75% of income. What pushes the guess up or down:</p>
      <div id="hh-contrib" class="chart" style="min-height:300px"></div></details>`;
    box.innerHTML = html;

    // Compact result bar pinned to the bottom of small screens
    const mini = $("#hh-mini");
    mini.innerHTML = `<span>Premium</span>${changes.length ? `<s>${kes(prem0)}</s> → ` : ""}<b>${kes(prem)}</b>${changes.length ? ` <em style="color:${d > 0 ? "#ffb4a6" : "#a9c8ee"}">${d > 0 ? "+" : "−"}${kes(Math.abs(d))}</em>` : ""}<span class="mini-v">${predPoor ? "poor" : "not poor"}</span><span class="mini-go">↓</span>`;
    if (!mini.dataset.bound) {
      mini.dataset.bound = "1";
      mini.addEventListener("click", () => $("#hh-result").scrollIntoView({ behavior: "smooth", block: "start" }));
    }

    // Show how many answers changed in each collapsed section
    document.querySelectorAll(".sec-badge").forEach((b) => {
      const vars = app.vars.filter((v) => v.group === b.dataset.theme);
      const n = vars.filter((v) => (v.type === "categorical" ? h.cat[v.key] !== s.cat[v.key] : v.type === "binary" ? !!h.bin[v.key] !== !!s.bin[v.key] : h[v.key] !== s[v.key])).length;
      b.hidden = !n;
      b.textContent = n + " changed";
    });
    box.querySelectorAll(".chip-x").forEach((b) => b.addEventListener("click", () => {
      changes[+b.dataset.k].revert(hh.cur);
      renderHouseholdForm();
      renderHouseholdResult();
    }));
    const undo = $("#hh-undo-all");
    if (undo) undo.addEventListener("click", () => { hh.cur = clone(hh.start); renderHouseholdForm(); renderHouseholdResult(); });
    const det = $("#hh-details");
    const drawContrib = () => {
      const contrib = contributions(h, r.x).sort((a, b) => Math.abs(b.c) - Math.abs(a.c)).slice(0, 10).reverse();
      plot("hh-contrib", [{
        type: "bar", orientation: "h",
        y: contrib.map((q) => q.label), x: contrib.map((q) => (Math.exp(q.c) - 1) * 100),
        marker: { color: contrib.map((q) => (q.c > 0 ? C.accent : C.under)) },
        hovertemplate: "%{y}<br>%{x:+.0f}% on the estimate<extra></extra>",
      }], {
        margin: { l: 10, r: 10, t: 0, b: 40 }, height: 320,
        xaxis: { ticksuffix: "%", zeroline: true, zerolinecolor: C.ink, title: { text: "Effect on the estimate", font: { size: 11 } } },
        yaxis: { automargin: true, tickfont: { size: 11 } },
      });
    };
    det.addEventListener("toggle", () => { hh.detailsOpen = det.open; if (det.open) drawContrib(); });
    if (det.open) drawContrib();
  }

  function renderHousehold() {
    if (!hh.cur) setPreset("middle");
    else renderHouseholdResult();
  }

  // ------------------------------------------------------- 2. ACCURACY
  function renderAccuracy() {
    standardControls("#acc-controls", renderAccuracy, { thr: false });
    const c = classify(app.user.pred, { thr: "official", sector: app.opts.sector });
    const { dec, bucket } = deciles(c);
    const sha = deciles(classify(app.basePred, { thr: "official", sector: app.opts.sector })).dec;
    const okAll = bucket.filter((b) => b === "ok").length / bucket.length;
    const shaOk = (() => { const b = deciles(classify(app.basePred, { thr: "official", sector: app.opts.sector })).bucket; return b.filter((x) => x === "ok").length / b.length; })();
    $("#acc-stats").innerHTML = `
      <div class="stat green"><div class="v">${pct(okAll)}</div><div class="k">of households guessed <strong>about right</strong><span class="sha-cmp">SHA's model: ${pct(shaOk)}</span></div></div>
      <div class="stat red"><div class="v">${pct(dec[0].overP)}</div><div class="k">of the poorest 10% guessed <strong>too high</strong><span class="sha-cmp">SHA's model: ${pct(sha[0].overP)}</span></div></div>
      <div class="stat blue"><div class="v">${pct(dec[9].underP)}</div><div class="k">of the richest 10% guessed <strong>too low</strong><span class="sha-cmp">SHA's model: ${pct(sha[9].underP)}</span></div></div>`;

    const col = { over: C.accent, ok: C.ok, under: C.under };
    const traces = ["under", "ok", "over"].map((b) => {
      const idx = [];
      for (let k = 0; k < c.rows.length; k++) if (bucket[k] === b) idx.push(k);
      return {
        type: "scatter", mode: "markers", name: b,
        x: idx.map((k) => c.act[k] * c.mult[k]), y: idx.map((k) => c.prd[k] * c.mult[k]),
        marker: { size: 5, color: col[b], opacity: 0.55 },
        hovertemplate: "Real income: KES %{x:,.0f}<br>Your model guesses: KES %{y:,.0f}<extra></extra>",
      };
    });
    const lo = 400, hi = 2000000;
    traces.push({ type: "scatter", mode: "lines", x: [lo, hi], y: [lo, hi], line: { color: C.ink, width: 1.5, dash: "dot" }, hoverinfo: "skip" });
    const axis = (title) => ({ type: "log", tickvals: KES_TICKS, ticktext: KES_TICKS.map(kesTickText), title: { text: title }, range: [Math.log10(1000), Math.log10(1000000)] });
    plot("acc-scatter", traces, { xaxis: axis("Real monthly income (KES)"), yaxis: axis("Your model's guess (KES)"), height: 480 });

    const labels = dec.map((_, i) => (i === 0 ? "Poorest 10%" : i === 9 ? "Richest 10%" : String(i + 1)));
    plot("acc-deciles", [
      { type: "bar", name: "Underestimated", x: labels, y: dec.map((d) => d.underP * 100), marker: { color: C.under }, hovertemplate: "%{x}: %{y:.0f}% underestimated<extra></extra>" },
      { type: "bar", name: "About right", x: labels, y: dec.map((d) => d.okP * 100), marker: { color: C.ok }, hovertemplate: "%{x}: %{y:.0f}% about right<extra></extra>" },
      { type: "bar", name: "Overestimated", x: labels, y: dec.map((d) => d.overP * 100), marker: { color: C.accent }, hovertemplate: "%{x}: %{y:.0f}% overestimated<extra></extra>" },
    ], {
      barmode: "stack", showlegend: true, legend: { orientation: "h", y: 1.12, x: 0 }, margin: { l: 50, r: 10, t: 30, b: 50 },
      yaxis: { ticksuffix: "%", range: [0, 100] }, xaxis: { title: { text: "Households grouped by real income" }, type: "category" },
    });

    $("#acc-explain").innerHTML = dec[0].overP > dec[9].overP + 0.2
      ? `<p>Your model pulls everyone to the middle: <strong>the poor get overcharged, the rich undercharged.</strong></p>`
      : `<p>Look at the poorest and richest bars: who does your model get wrong?</p>`;

    // Density of actual vs predicted (log scale)
    const la = Array.from(c.act, (v, k) => Math.log(v * c.mult[k])), lp = Array.from(c.prd, (v, k) => Math.log(v * c.mult[k]));
    const mn = Math.log(1000), mx = Math.log(1000000), nb = 45, w = (mx - mn) / nb;
    const hist = (arr) => {
      const h = new Array(nb).fill(0);
      arr.forEach((v) => { const b = Math.floor((v - mn) / w); if (b >= 0 && b < nb) h[b]++; });
      return h.map((v) => (v / arr.length) * 100);
    };
    const xs = Array.from({ length: nb }, (_, b) => Math.exp(mn + (b + 0.5) * w));
    plot("acc-density", [
      { type: "scatter", mode: "lines", name: "Real income", x: xs, y: hist(la), line: { color: C.grey, width: 2, shape: "spline" }, fill: "tozeroy", fillcolor: "rgba(169,165,155,.25)", hovertemplate: "KES %{x:,.0f}: %{y:.1f}% of households<extra>Real</extra>" },
      { type: "scatter", mode: "lines", name: "Your model's guess", x: xs, y: hist(lp), line: { color: C.accent, width: 2, shape: "spline" }, hovertemplate: "KES %{x:,.0f}: %{y:.1f}% of households<extra>Model</extra>" },
    ], {
      showlegend: true, legend: { orientation: "h", y: 1.12, x: 0 }, margin: { l: 50, r: 10, t: 30, b: 50 },
      xaxis: { type: "log", tickvals: KES_TICKS, ticktext: KES_TICKS.map(kesTickText), title: { text: "Monthly household income (KES, 2024 prices)" } },
      yaxis: { ticksuffix: "%", title: { text: "Share of households" } },
    });
  }

  // ---------------------------------------------- shared: overcharging
  // "Overcharged" = the model guesses income more than 20% too high (same cut-off as "about right")
  const OVER_TOL = 0.2;
  const AMONG_OPTS = [
    { v: 0.1, l: "Poorest 10%" },
    { v: 0.4, l: "Poorest 40%" },
    { v: 1, l: "Everyone" },
  ];
  const amongText = (v) => (v === 1 ? "" : `the poorest ${Math.round(v * 100)}% of `);

  // Test households in the chosen income band and area, with overcharge flags
  function overSet(pred, opts) {
    const among = opts.among ?? 0.4;
    const c = classify(pred, { thr: among === 1 ? 0.4 : among, sector: opts.sector });
    const ks = [];
    for (let k = 0; k < c.rows.length; k++) if (among === 1 || c.ap[k]) ks.push(k);
    const over = new Uint8Array(c.rows.length);
    for (let k = 0; k < c.rows.length; k++) over[k] = Math.log(c.prd[k] / c.act[k]) > OVER_TOL ? 1 : 0;
    return { c, ks, over };
  }

  function amongControls(id, rerender, { everyone = true } = {}) {
    if (app.opts.among === undefined || (!everyone && app.opts.among === 1)) app.opts.among = 0.4;
    const box = $(id);
    box.innerHTML = "";
    seg(box, "Look at", everyone ? AMONG_OPTS : AMONG_OPTS.filter((o) => o.v !== 1), app.opts.among, (v) => { app.opts.among = v; rerender(); });
    seg(box, "Area", SECTOR_OPTS, app.opts.sector, (v) => { app.opts.sector = v; rerender(); });
  }

  // ------------------------------------------------ 3. WHO PAYS TOO MUCH
  function renderExcluded() {
    amongControls("#exc-controls", renderExcluded);
    const { c, ks, over } = overSet(app.user.pred, app.opts);
    const so = overSet(app.basePred, app.opts);
    const shaShare = so.ks.reduce((t, k) => t + so.over[k], 0) / so.ks.length;
    let n = 0;
    const extra = [];
    for (const k of ks) if (over[k]) { n++; extra.push((c.prd[k] - c.act[k]) * c.mult[k] * PREMIUM_RATE); }
    const share = n / ks.length, per100 = Math.round(share * 100);
    const who = app.opts.among === 1 ? "households" : `of the poorest ${Math.round(app.opts.among * 100)}% of${sectorText()} households`;
    $("#exc-dots-title").innerHTML = app.opts.among === 1
      ? `Out of 100${sectorText()} households, <span style="color:${C.accent}">${per100} pay too much</span>`
      : `Out of 100 ${who}, <span style="color:${C.accent}">${per100} pay too much</span>`;
    $("#exc-dots-title").innerHTML += `<span class="sha-cmp">SHA's model: ${Math.round(shaShare * 100)}</span>`;
    $("#exc-dots").innerHTML = Array.from({ length: 100 }, (_, k) => `<i class="${k < per100 ? "miss" : ""}"></i>`).join("");
    const med = extra.length ? S.median(extra) : NaN;
    $("#exc-explain").innerHTML = extra.length
      ? `<p>A typical one pays <strong>${kes(med)} a month too much</strong>. That's about <strong>${kes(med * 12)} a year</strong>.</p>`
      : "";

    // Drawer: the published poverty-line figure
    const m = confusion(classify(app.user.pred, { thr: "official", sector: app.opts.sector }));
    const ms = confusion(classify(app.basePred, { thr: "official", sector: app.opts.sector }));
    $("#exc-matrix").innerHTML = `<p>Using the official <span class="term" data-term="hhline">poverty line</span> instead, as in the published investigation: your model calls <strong>${pct(m.exclusion)}</strong> of poor${sectorText()} households "not poor" (${m.FN.toLocaleString()} of ${m.poor.toLocaleString()}). SHA's model: ${pct(ms.exclusion)}. This is the <span class="term" data-term="exclusion">exclusion error</span>.</p>
      <p class="small muted">"Pays too much" means the model guesses the household's income more than 20% too high. "Poorest 10%/40%" is by real income, within urban or rural areas.</p>`;
  }

  // ------------------------------------------------------- 4. FAIRNESS
  const GROUP_ORDER = {
    g_women: ["No women", "Mostly men", "Mixed", "Mostly women", "All women"],
    g_head_age: ["Under 30", "30-39", "40-49", "50-59", "60+"],
    g_hh_size: ["1 person", "2 people", "3-4 people", "5-6 people", "7+ people"],
    g_children: ["No children", "1-2 children", "3-4 children", "5+ children"],
    g_education: ["Never attended school", "Pre-primary", "Primary", "Secondary level", "Vocational", "Middle level college (certificate/diploma)", "University(Undergraduate)", "University (Post Graduate)", "Informal education (madrasa/adult basic)"],
  };
  const fair = { group: "g_electricity" };

  // Group label for every household, for a preset group (g_*) or any question
  const groupCache = {};
  function groupValues(key) {
    if (app.D.str[key]) return app.D.str[key];
    if (groupCache[key]) return groupCache[key];
    const v = app.varByKey[key], D = app.D, out = new Array(D.n);
    if (v.type === "binary") {
      const col = D.num[v.columns[0]];
      for (let i = 0; i < D.n; i++) out[i] = col[i] ? "Yes" : "No";
      GROUP_ORDER[key] = ["No", "Yes"];
    } else if (v.type === "categorical") {
      const cats = v.categories.filter((c) => c.column);
      for (let i = 0; i < D.n; i++) { const hit = cats.find((c) => D.num[c.column][i] === 1); out[i] = hit ? hit.label : v.reference; }
    } else {
      // Numbers: split into roughly equal-sized bands
      const col = D.num[v.columns[0]];
      const vals = Array.from(D.testRows, (i) => col[i]);
      const edges = [...new Set([0.25, 0.5, 0.75].map((q) => S.quantile(vals, q)))];
      const isShare = key.startsWith("prop");
      const f = (x) => (isShare ? Math.round(x * 100) + "%" : key === "mm_age" ? String(Math.round(Math.exp(x))) : String(Math.round(x * 10) / 10));
      const whole = vals.every((x) => Number.isInteger(x));
      const labels = whole
        ? edges.map((e, j) => { const lo = j === 0 ? null : edges[j - 1] + 1; return lo === null ? `Up to ${e}` : lo === e ? String(e) : `${lo} to ${e}`; }).concat(`${edges[edges.length - 1] + 1} or more`)
        : edges.map((e, j) => (j === 0 ? `Up to ${f(e)}` : `${f(edges[j - 1])} to ${f(e)}`)).concat(`Over ${f(edges[edges.length - 1])}`);
      for (let i = 0; i < D.n; i++) { let b = 0; while (b < edges.length && col[i] > edges[b]) b++; out[i] = labels[b]; }
      GROUP_ORDER[key] = labels;
    }
    return (groupCache[key] = out);
  }
  const groupLabel = (key) => (app.varByKey[key] ? app.varByKey[key].label : app.meta.fairness_groups.find((g) => g.key === key).label);

  // Poverty-line exclusion by group (used by the Model lab)
  function groupStats(c, key, minN = 50, minPoor = 10) {
    const vals = groupValues(key);
    const overall = confusion(c);
    const cats = {};
    c.rows.forEach((i, k) => { (cats[vals[i]] = cats[vals[i]] || []).push(k); });
    const res = [];
    for (const [cat, ks] of Object.entries(cats)) {
      if (cat === "Unknown") continue;
      const set = new Uint8Array(c.rows.length);
      ks.forEach((k) => (set[k] = 1));
      const g = confusion(c, (k) => set[k]);
      const rest = confusion(c, (k) => !set[k]);
      const enough = g.N >= minN && g.poor >= minPoor;
      const p = enough && rest.poor ? S.fisherExact(g.FN, g.TP, rest.FN, rest.TP) : null;
      res.push({ cat, ...g, rest, p, enough });
    }
    const order = GROUP_ORDER[key];
    if (key === "g_county") res.sort((a, b) => b.povRate - a.povRate);
    else if (order) res.sort((a, b) => order.indexOf(a.cat) - order.indexOf(b.cat));
    else res.sort((a, b) => b.N - a.N);
    return { res, overall };
  }

  // Share overcharged by group, within the chosen income band
  function groupOver(pred, opts, key, minN = 30) {
    const { c, ks, over } = overSet(pred, opts);
    const vals = groupValues(key);
    const cats = {};
    let tot = 0;
    for (const k of ks) { (cats[vals[c.rows[k]]] = cats[vals[c.rows[k]]] || []).push(k); tot += over[k]; }
    const res = [];
    for (const [cat, gk] of Object.entries(cats)) {
      if (cat === "Unknown") continue;
      const o = gk.reduce((a, k) => a + over[k], 0);
      const N = gk.length, rN = ks.length - N, rO = tot - o;
      const enough = N >= minN;
      const p = enough && rN ? S.fisherExact(o, N - o, rO, rN - rO) : null;
      res.push({ cat, N, o, rate: o / N, restRate: rO / rN, p, enough });
    }
    const order = GROUP_ORDER[key];
    if (order) res.sort((a, b) => order.indexOf(a.cat) - order.indexOf(b.cat));
    else res.sort((a, b) => b.rate - a.rate);
    return { res, overall: tot / ks.length };
  }

  function renderFairness() {
    const mBox = $("#fair-missions");
    mBox.innerHTML = "";
    mBox.append(el("span", { class: "clabel" }, "Compare by a question in your model:"));
    app.user.sel.forEach((k) => mBox.append(el("button", { class: "btn small" + (fair.group === k ? " primary" : ""), type: "button", onclick: () => { fair.group = k; renderFairness(); } }, esc(app.varByKey[k].label))));

    amongControls("#fair-controls", renderFairness, { everyone: false });
    // Everything else: other questions and preset household groups
    const wrap = el("div", { class: "control" });
    wrap.append(el("label", { for: "fair-any" }, "Or compare by anything"));
    const sel = el("select", { id: "fair-any" });
    const og = (label, items) => {
      const g = el("optgroup", { label });
      items.forEach(([v, l]) => { const o = el("option", { value: v }, esc(l)); if (v === fair.group) o.selected = true; g.append(o); });
      sel.append(g);
    };
    og("Household groups", app.meta.fairness_groups.map((g) => [g.key, g.label]));
    og("Questions not in your model", app.vars.filter((v) => !app.user.sel.includes(v.key)).map((v) => [v.key, v.label]));
    if (app.user.sel.includes(fair.group)) sel.prepend(el("option", { value: "", selected: "" }, "Pick one…"));
    sel.addEventListener("change", () => { if (sel.value) { fair.group = sel.value; renderFairness(); } });
    wrap.append(sel);
    $("#fair-controls").append(wrap);

    const { res, overall } = groupOver(app.user.pred, app.opts, fair.group);
    const shaBy = Object.fromEntries(groupOver(app.basePred, app.opts, fair.group).res.map((r) => [r.cat, r]));
    const shown = res.filter((r) => r.enough);
    const label = groupLabel(fair.group);
    $("#fair-title").textContent = `${label}: share of ${amongText(app.opts.among)}households that pay too much`;

    const ys = shown.map((r) => r.cat);
    const h = Math.max(260, shown.length * (fair.group === "g_county" ? 36 : 56) + 70);
    plot("fair-chart", [
      { type: "bar", orientation: "h", name: "Your model", y: ys, x: shown.map((r) => r.rate * 100), marker: { color: C.accent }, text: shown.map((r) => pct(r.rate)), textposition: "outside", cliponaxis: false, hovertemplate: "Your model, %{y}: %{x:.0f}% pay too much<extra></extra>" },
      { type: "bar", orientation: "h", name: "SHA's model", y: ys, x: shown.map((r) => (shaBy[r.cat] ? shaBy[r.cat].rate * 100 : null)), marker: { color: C.light }, hovertemplate: "SHA's model, %{y}: %{x:.0f}% pay too much<extra></extra>" },
    ], {
      barmode: "group", showlegend: true, legend: { orientation: "h", y: 1.02, x: 0, yanchor: "bottom" },
      height: h + 30, margin: { l: 10, r: 40, t: 30, b: 40 },
      yaxis: { autorange: "reversed", type: "category" }, xaxis: { ticksuffix: "%", range: [0, 100] },
      shapes: [{ type: "line", xref: "x", yref: "paper", x0: overall * 100, x1: overall * 100, y0: 0, y1: 1, line: { color: C.ink, dash: "dash", width: 1.5 } }],
    });
    $("#fair-chart").style.minHeight = h + "px";

    let text = "";
    if (shown.length >= 2) {
      const hi = shown.reduce((a, b) => (b.rate > a.rate ? b : a));
      const lo = shown.reduce((a, b) => (b.rate < a.rate ? b : a));
      const nm = (cat) => (cat === "Yes" || cat === "No" ? `${label}: ${cat.toLowerCase()}` : cat);
      text = `<p>With your model, most overcharged: <strong>${esc(nm(hi.cat))}</strong> (${pct(hi.rate)}). Least: <strong>${esc(nm(lo.cat))}</strong> (${pct(lo.rate)}).</p>`;
    } else text = "<p>Too few households here. Try another group.</p>";
    $("#fair-explain").innerHTML = text;

    // Drawer: numbers, chance test and the published poverty-line measure
    const cp = classify(app.user.pred, { thr: "official", sector: app.opts.sector });
    const ex = Object.fromEntries(groupStats(cp, fair.group).res.map((r) => [r.cat, r]));
    const rows = res.map((r) => {
      const e = ex[r.cat];
      return `<tr><td>${esc(r.cat)}</td><td class="num">${r.N}</td><td class="num">${r.enough ? pct(r.rate) : "–"}</td><td class="num">${r.enough ? pct(r.restRate) : "–"}</td><td class="num">${r.enough && shaBy[r.cat] ? pct(shaBy[r.cat].rate) : "–"}</td><td>${!r.enough ? '<span class="tag chance">Too few to tell</span>' : r.p < 0.05 ? '<span class="tag sig">Unlikely to be chance</span>' : '<span class="tag chance">Could be chance</span>'}</td><td class="num">${e && e.enough ? pct(e.exclusion) : "–"}</td></tr>`;
    }).join("");
    $("#fair-table").innerHTML = `<table><thead><tr><th>Group</th><th class="num">Households</th><th class="num">Pay too much</th><th class="num">Everyone else</th><th class="num">SHA's model</th><th><span class="term" data-term="chance">Could be chance?</span></th><th class="num">Poor called "not poor" (poverty line)</th></tr></thead><tbody>${rows}</tbody></table>`;
  }

  // -------------------------------------------------------- 5. DRIVERS
  const drv = { control: true, all: false, cache: {} };

  // Linear probability model of a 0/1 outcome on the model's variables, optionally controlling for real income
  function outcomeRegression(rows, outcome, control, features) {
    const names = features.slice();
    if (control) names.push("y");
    const cols = names.map((nm) => app.D.num[nm]);
    const fit = S.fitOLS(Int32Array.from(rows), cols, names, outcome);
    return fit.kept.filter((nm) => nm !== "y").map((nm) => {
      const t = fit.test(nm);
      const col = app.D.num[nm];
      let n = 0;
      for (const i of rows) if (col[i] !== 0) n++;
      return { term: nm, label: app.colLabel[nm] || nm, pp: t.coef * 100, p: t.p, n };
    });
  }

  // Poverty-line exclusion regression, as in the published methodology
  function exclusionRegression(pred, opts, control, features) {
    const c = classify(pred, opts);
    const yEx = new Float64Array(app.D.n);
    c.rows.forEach((i, k) => { yEx[i] = c.ap[k] && !c.pp[k] ? 1 : 0; });
    return outcomeRegression(c.rows, yEx, control, features);
  }

  function overRegression(opts, control) {
    const key = [app.user.version, opts.among, opts.sector, control].join("|");
    if (drv.cache[key]) return drv.cache[key];
    const { c, ks, over } = overSet(app.user.pred, opts);
    const yO = new Float64Array(app.D.n);
    const rows = ks.map((k) => { yO[c.rows[k]] = over[k]; return c.rows[k]; });
    return (drv.cache[key] = outcomeRegression(rows, yO, control, app.vars.flatMap((v) => v.columns)));
  }

  function renderDrivers() {
    amongControls("#drv-controls", renderDrivers);
    const box = $("#drv-controls");
    const opt = el("div", { class: "control" });
    opt.append(el("span", { class: "clabel" }, "Options"));
    const mk = (txt, prop) => {
      const l = el("label", { class: "check", style: "display:inline-flex;margin-right:14px" });
      const cb = el("input", { type: "checkbox" });
      cb.checked = drv[prop];
      cb.addEventListener("change", () => { drv[prop] = cb.checked; renderDrivers(); });
      l.append(cb, document.createTextNode(txt));
      opt.append(l);
    };
    mk("Compare same-income households", "control");
    mk("Show all variables", "all");
    box.append(opt);

    const res = overRegression(app.opts, drv.control);
    let shown = res.filter((r) => drv.all || (r.p < 0.05 && r.n >= 30)).sort((a, b) => a.pp - b.pp);
    if (!drv.all) shown = shown.filter((r) => Math.abs(r.pp) >= 0.5);
    const h = Math.max(360, shown.length * 22 + 80);
    plot("drv-chart", [{
      type: "bar", orientation: "h", y: shown.map((r) => r.label), x: shown.map((r) => r.pp),
      marker: { color: shown.map((r) => (r.pp > 0 ? C.accent : C.under)), opacity: shown.map((r) => (r.p < 0.05 ? 1 : 0.35)) },
      customdata: shown.map((r) => (r.p < 0.05 ? "unlikely to be chance" : "could be chance")),
      hovertemplate: "%{y}<br>%{x:+.0f} percentage points (%{customdata})<extra></extra>",
    }], { height: h, margin: { l: 10, r: 20, t: 10, b: 50 }, yaxis: { type: "category", tickfont: { size: 11 } }, xaxis: { ticksuffix: " pp", zeroline: true, zerolinecolor: C.ink, title: { text: "More (or less) likely to pay too much, % points" } } });
    $("#drv-chart").style.minHeight = h + "px";

    const pos = res.filter((r) => r.p < 0.05 && r.pp > 0 && r.n >= 30).sort((a, b) => b.pp - a.pp).slice(0, 3);
    $("#drv-explain").innerHTML = `<p>Most linked to paying too much: ${pos.length ? pos.map((r) => `<strong>${esc(r.label)}</strong> (+${r.pp.toFixed(0)} <span class="term" data-term="pp">pp</span>)`).join(", ") : "nothing clear here"}, compared with households on the same income.</p>`;
  }

  // ------------------------------------------------------- 1. BUILD
  const MAX_Q = 15;
  const THEME_ORDER = ["Where you live", "Who lives here", "Household head", "Work & livelihood", "The home", "Water, toilet & energy",
    "Things the household owns", "Hunger (self-reported)", "Sensitive characteristics"];
  const THEME_LABEL = {};
  const NOTE_THEMES = ["Hunger (self-reported)", "Sensitive characteristics"];
  const STORE_KEY = "pmt-model-v1";

  function initUser() {
    let saved = [];
    try { saved = JSON.parse(localStorage.getItem(STORE_KEY) || "[]"); } catch (e) { saved = []; }
    app.user = { sel: (Array.isArray(saved) ? saved : []).filter((k) => app.varByKey[k]).slice(0, MAX_Q), model: null, pred: null, fits: null, version: 0, timer: null };
    trainUser();
  }

  function userColumns() {
    const cols = [];
    for (const k of app.user.sel) cols.push(...app.varByKey[k].columns);
    return cols;
  }

  function trainUser() {
    const U = app.user;
    U.version++;
    try { localStorage.setItem(STORE_KEY, JSON.stringify(U.sel)); } catch (e) { /* storage unavailable */ }
    if (!U.sel.length) { U.model = null; U.pred = null; U.fits = null; return; }
    const names = userColumns();
    const model = {}, fits = {};
    for (const s of SECTORS) {
      const fit = S.fitOLS(app.D.trainRows[s], names.map((n) => app.D.num[n]), names, app.D.y);
      fits[s] = fit;
      model[s] = { names, beta: fit.beta, r2: fit.r2 };
    }
    U.model = model;
    U.fits = fits;
    U.pred = predictAll(model);
  }

  function setSelection(sel) {
    app.user.sel = sel.slice(0, MAX_Q);
    trainUser();
    renderBuild();
  }
  const addQ = (k) => { const s = app.user.sel; if (!s.includes(k) && s.length < MAX_Q) setSelection(s.concat(k)); else if (s.length >= MAX_Q) flashFull(); };
  const removeQ = (k) => setSelection(app.user.sel.filter((x) => x !== k));
  function flashFull() {
    const c = $("#model-count");
    c.classList.remove("flash"); void c.offsetWidth; c.classList.add("flash");
  }

  function initBuild() {
    const pal = $("#palette");
    pal.innerHTML = "";
    const themes = THEME_ORDER.filter((t) => app.vars.some((v) => v.group === t));
    for (const t of themes) {
      const g = el("div", { class: "pgroup" });
      g.append(el("h4", {}, esc(THEME_LABEL[t] || t)));
      if (NOTE_THEMES.includes(t) && app.meta.extra_notes[t]) g.append(el("p", { class: "note" }, esc(app.meta.extra_notes[t])));
      const list = el("div", { class: "qlist" });
      for (const v of app.vars.filter((v) => v.group === t)) {
        const b = el("button", { type: "button", class: "q", draggable: "true", "data-key": v.key, title: v.question || v.label },
          `<span>${esc(v.label)}</span>`);
        b.addEventListener("click", () => (app.user.sel.includes(v.key) ? removeQ(v.key) : addQ(v.key)));
        b.addEventListener("dragstart", (e) => { e.dataTransfer.setData("text/plain", v.key); e.dataTransfer.effectAllowed = "move"; });
        list.append(b);
      }
      g.append(list);
      pal.append(g);
    }

    const dz = $("#dropzone");
    const over = (e) => { e.preventDefault(); dz.classList.add("over"); };
    dz.addEventListener("dragover", over);
    dz.addEventListener("dragenter", over);
    dz.addEventListener("dragleave", () => dz.classList.remove("over"));
    dz.addEventListener("drop", (e) => { e.preventDefault(); dz.classList.remove("over"); const k = e.dataTransfer.getData("text/plain"); if (app.varByKey[k]) addQ(k); });
    // Dropping a chip back on the list removes it
    pal.addEventListener("dragover", (e) => e.preventDefault());
    pal.addEventListener("drop", (e) => { e.preventDefault(); const k = e.dataTransfer.getData("text/plain"); if (app.user.sel.includes(k)) removeQ(k); });
    $("#model-clear").addEventListener("click", () => setSelection([]));
    $("#learned").addEventListener("toggle", () => { if ($("#learned").open) renderLearned(); });
    $("#build-mini").addEventListener("click", () => $(".model-box").scrollIntoView({ behavior: "smooth", block: "start" }));
    app.buildReady = true;
  }

  function peopleRow(share, color) {
    const n = Math.round(share * 10);
    let s = "";
    for (let k = 0; k < 10; k++) {
      s += `<svg class="person-ico" viewBox="0 0 20 28" aria-hidden="true"><circle cx="10" cy="6" r="5" fill="${k < n ? color : C.ok}"/><path d="M2 27 v-7 a8 8 0 0 1 16 0 v7 z" fill="${k < n ? color : C.ok}"/></svg>`;
    }
    return s;
  }

  const overShare = (pred) => { const o = overSet(pred, { among: 0.4, sector: "All" }); return o.ks.reduce((t, k) => t + o.over[k], 0) / o.ks.length; };
  function aboutRight(pred) {
    let ok = 0;
    for (const i of app.D.testRows) if (Math.abs(pred[i] - app.D.y[i]) <= OVER_TOL) ok++;
    return ok / app.D.testRows.length;
  }

  function renderBuild() {
    if (!app.buildReady) initBuild();
    const U = app.user, n = U.sel.length;
    document.querySelectorAll("#palette .q").forEach((b) => b.classList.toggle("used", U.sel.includes(b.dataset.key)));
    $("#palette").classList.toggle("full", n >= MAX_Q);
    $("#model-count").textContent = `${n} / ${MAX_Q}`;
    $("#model-clear").hidden = !n;

    const dz = $("#dropzone");
    dz.innerHTML = n
      ? U.sel.map((k) => `<span class="mq" draggable="true" data-key="${esc(k)}">${esc(app.varByKey[k].label)}<button type="button" class="chip-x" aria-label="Remove ${esc(app.varByKey[k].label)}">×</button></span>`).join("")
      : `<p class="empty">Drag questions here<br><span class="small muted">or tap them in the list</span></p>`;
    dz.querySelectorAll(".mq").forEach((m) => {
      m.querySelector(".chip-x").addEventListener("click", () => removeQ(m.dataset.key));
      m.addEventListener("dragstart", (e) => e.dataTransfer.setData("text/plain", m.dataset.key));
    });

    $("#score").innerHTML = "";
    $("#build-next").classList.toggle("disabled", !n);
    $("#build-next").setAttribute("aria-disabled", String(!n));
    $("#build-mini").innerHTML = n
      ? `<span>Your model</span><b>${n} / ${MAX_Q}</b><span class="mini-go">↑</span>`
      : `<span>Your model</span><b>empty</b><span class="mini-go">↑</span>`;
    if ($("#learned").open) renderLearned();
  }

  // What each chosen question does to the guess, in plain percentages
  function renderLearned() {
    const U = app.user, box = $("#learned-body");
    if (!U.model) { box.innerHTML = '<p class="small muted">Add questions first.</p>'; return; }
    const eff = (s, col) => { const t = U.fits[s].test(col); return t ? Math.exp(t.coef) - 1 : null; };
    const cell = (v) => (v === null ? "–" : `<span style="color:${v > 0 ? C.accent : C.under}">${signedPct(v)}</span>`);
    const rows = [];
    for (const k of U.sel) {
      const v = app.varByKey[k];
      if (v.type === "categorical") {
        const cats = v.categories.filter((c) => c.column).map((c) => ({ l: c.label, u: eff("Urban", c.column), r: eff("Rural", c.column) }))
          .filter((c) => c.u !== null || c.r !== null)
          .sort((a, b) => ((b.u ?? b.r) + (b.r ?? b.u)) - ((a.u ?? a.r) + (a.r ?? a.u)));
        const show = cats.length > 4 ? [cats[0], cats[1], cats[cats.length - 2], cats[cats.length - 1]] : cats;
        rows.push(`<tr class="vh"><td colspan="3"><strong>${esc(v.label)}</strong> <span class="small muted">compared with ${esc(v.reference || "the most common answer")}</span></td></tr>`);
        show.forEach((c) => rows.push(`<tr><td class="sub">${esc(c.l)}</td><td class="num">${cell(c.u)}</td><td class="num">${cell(c.r)}</td></tr>`));
      } else {
        const col = v.columns[0];
        const what = v.type === "binary" ? "if yes" : k.startsWith("prop") ? "from 0% to 100%" : k === "mm_age" ? "if the ages add up to twice as much" : k === "household_size" ? "for each extra person" : "for each extra one";
        // mm_age is the log of summed ages, so report the effect of doubling it
        const e2 = (s) => { const t = U.fits[s].test(col); return t ? Math.pow(2, t.coef) - 1 : null; };
        const f = k === "mm_age" ? e2 : (s) => eff(s, col);
        rows.push(`<tr><td><strong>${esc(v.label)}</strong> <span class="small muted">${what}</span></td><td class="num">${cell(f("Urban"))}</td><td class="num">${cell(f("Rural"))}</td></tr>`);
      }
    }
    box.innerHTML = `<p class="small muted">How each answer moves your model's income guess, everything else the same.</p>
      <div class="table-wrap"><table class="learned"><thead><tr><th></th><th class="num">Urban</th><th class="num">Rural</th></tr></thead><tbody>${rows.join("")}</tbody></table></div>`;
  }

  // ----------------------------------------------------------- glossary
  function initGlossary() {
    if ($("#glossary")) $("#glossary").innerHTML = Object.values(GLOSSARY).map(([t, d]) => `<dt>${esc(t)}</dt><dd>${esc(d)}</dd>`).join("");
    const tip = $("#tooltip");
    const show = (e) => {
      const t = e.target.closest(".term");
      if (!t) return;
      const g = GLOSSARY[t.dataset.term];
      if (!g) return;
      tip.innerHTML = `<strong>${esc(g[0])}</strong><br>${esc(g[1])}`;
      tip.hidden = false;
      const r = t.getBoundingClientRect();
      const x = Math.min(window.innerWidth - 316, Math.max(8, r.left));
      tip.style.left = x + "px";
      const below = r.bottom + 8;
      tip.style.top = (below + tip.offsetHeight > window.innerHeight ? r.top - tip.offsetHeight - 8 : below) + "px";
    };
    document.addEventListener("mouseover", show);
    document.addEventListener("focusin", show);
    document.addEventListener("click", (e) => { if (e.target.closest(".term")) show(e); else tip.hidden = true; });
    document.addEventListener("mouseout", (e) => { if (e.target.closest(".term")) tip.hidden = true; });
  }

  // ------------------------------------------------------------- router
  const RENDER = {
    start: renderStart, household: renderHousehold, accuracy: renderAccuracy, excluded: renderExcluded,
    fairness: renderFairness, drivers: renderDrivers, build: renderBuild,
  };
  const NEEDS_MODEL = new Set(["household", "accuracy", "excluded", "fairness", "drivers"]);

  function route() {
    const tab = (location.hash || "#start").slice(1);
    const name = RENDER[tab] ? tab : "start";
    const blocked = NEEDS_MODEL.has(name) && !app.user.model;
    document.querySelectorAll(".tab").forEach((s) => (s.hidden = blocked || s.id !== "tab-" + name));
    $("#need-model").hidden = !blocked;
    const pill = $("#model-pill");
    pill.hidden = !NEEDS_MODEL.has(name) || blocked;
    if (!pill.hidden) pill.innerHTML = `Your model: <strong>${app.user.sel.length} question${app.user.sel.length === 1 ? "" : "s"}</strong> <a href="#build">Change it</a>`;
    document.querySelectorAll(".steps a").forEach((a) => {
      const on = a.dataset.tab === name;
      a.classList.toggle("active", on);
      if (on) a.setAttribute("aria-current", "page"); else a.removeAttribute("aria-current");
      if (on) a.scrollIntoView({ block: "nearest", inline: "center" });
    });
    $("#tooltip").hidden = true;
    window.scrollTo(0, 0);
    if (!blocked) try { RENDER[name](); } catch (e) { console.error(e); }
  }

  // --------------------------------------------------------------- boot
  initGlossary();
  load()
    .then(() => {
      $("#loading").hidden = true;
      initUser();
      window.addEventListener("hashchange", route);
      route();
    })
    .catch((e) => {
      console.error(e);
      $("#loading").hidden = true;
      const box = $("#load-error");
      box.hidden = false;
      box.innerHTML = `<strong>The data could not be loaded.</strong> ${esc(e.message)}. If you opened this file directly, serve the <code>docs/</code> folder with a web server (for example <code>python3 -m http.server</code>) or publish it on GitHub Pages.`;
    });

  // Expose for debugging / verification in the console
  window.PMT = app;
  window.PMT_debug = { classify, confusion, deciles, predictAll, groupStats, groupOver, overSet, exclusionRegression, overRegression, householdFromRow, predictHousehold, hh, setSelection, overShare, aboutRight };
})();
