(() => {
  "use strict";
  const payload = window.VALUE_LENS_REPORT_DEMO;
  const { report, fixture } = payload;
  const $ = (id) => document.getElementById(id);
  const esc = (v) => String(v ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const number = (v) => new Intl.NumberFormat("en-GB", { maximumFractionDigits: 2 }).format(v);
  const colors = ["#1683c5", "#9aa9b5", "#e7aa3c", "#438b73", "#a37fb4", "#d06a65", "#67adc7"];
  const state = {
    page: 0, from: Math.max(0, fixture.months.indexOf("2026-06")), to: fixture.months.length - 1,
    team: -1, license: 0, tool: -1, agent: -1, hourly: 50, scenario: "Typical", heatMetric: "users", dimensions: {},
    bookmarks: Object.fromEntries(report.pages.flatMap(p => (p.views || []).map(g => [g.id, g.selected]))),
  };
  const engine = window.ValueLensReportEngine.create(payload, state);
  const dataCache = new Map();
  function format(field, value) {
    if (value == null) return "\u2014";
    if (typeof value !== "number") return String(value);
    const definition = report.measures[field?.name?.toLowerCase()];
    const pattern = definition?.format || "";
    if (pattern.includes("%") || /share|rate|%/.test(field?.name?.toLowerCase() || "")) return `${number(value * 100)}%`;
    if (/\$|£|€/.test(pattern) || /^(AI Assisted Value|Projected Annualised Value|Copilot License Investment|Net ROI)/.test(field?.name || "")) return `$${number(value)}`;
    return number(value);
  }
  function options(label, key, values, selected, all = true) {
    return `<label class="filter-field"><span>${esc(label)}</span><select data-state="${esc(key)}">${all ? '<option value="-1">All</option>' : ""}${values.map((v, i) => `<option value="${i}"${i === selected ? " selected" : ""}>${esc(v)}</option>`).join("")}</select></label>`;
  }
  function syncViews() {
    const desired = state.tool === 2 ? "cowork" : state.tool === 1 ? "agents" : state.license === 0 ? "licensed" : state.license === 1 ? "unlicensed" : "overall";
    for (const p of report.pages) for (const g of p.views || []) {
      const v = g.views.find(x => x.name.toLowerCase() === desired);
      if (v) state.bookmarks[g.id] = v.id;
    }
  }
  function applyView(name) {
    if (!["overall", "licensed", "unlicensed", "agents", "cowork"].includes(name.toLowerCase())) return;
    state.license = name.toLowerCase() === "licensed" ? 0 : name.toLowerCase() === "unlicensed" ? 1 : -1;
    state.tool = name.toLowerCase() === "agents" ? 1 : name.toLowerCase() === "cowork" ? 2 : -1;
    state.agent = -1;
    state.dimensions = {};
    syncViews();
  }
  function visibility(page) {
    const override = Object.assign({}, ...(page.views || []).map(g => g.views.find(v => v.id === state.bookmarks[g.id])?.visibility || {}));
    const byId = new Map(page.visuals.map(v => [v.id, v]));
    const visible = (v) => (override[v.id] ?? !v.hidden) && (!v.parent || !byId.has(v.parent) || visible(byId.get(v.parent)));
    return visible;
  }
  function position(v, page) {
    const p = { ...v.position };
    const byId = new Map(page.visuals.map(x => [x.id, x]));
    let parent = byId.get(v.parent);
    while (parent) {
      p.x += parent.position.x;
      p.y += parent.position.y;
      p.z += parent.position.z;
      parent = byId.get(parent.parent);
    }
    return p;
  }
  function filterHtml(v) {
    const f = v.fields[0];
    if (!f) return "";
    const special = {
      Date: ["from", fixture.months, state.from], "Date Submitted Date": ["from", fixture.months, state.from],
      Scenario: ["scenario", ["Conservative", "Typical", "Optimistic"], state.scenario],
      "Hourly Value": ["hourly", [0, 25, 50, 75, 100, 150, 200, 500, 1000], state.hourly],
      "Heatmap Toggle": ["heatMetric", ["users", "days", "hours", "sessions"], state.heatMetric],
      "Model Fit View": ["modelView", ["Tool", "Model tier", "Model"], state.modelView || "Tool"],
      Organization: ["team", fixture.teams, state.team],
      "Agent Filter (Normalized)": ["tool", fixture.tools, state.tool],
      "License Status": ["license", fixture.licenses, state.license],
    }[f.name];
    const key = `${f.table}|${f.name}`;
    const values = special?.[1] || engine.filterOptions(f);
    const selected = special?.[2] ?? state.dimensions[key] ?? "";
    const numericIndex = special && ["from", "team", "license", "tool"].includes(special[0]);
    return `<label class="slicer-control"><span>${esc(f.label || f.name)}</span><select aria-label="${esc(f.label || f.name)}" ${special ? `data-special="${special[0]}"` : `data-dimension="${esc(key)}"`}>${!special || numericIndex && special[0] !== "from" ? '<option value="-1">All</option>' : ""}${values.map((value, i) => {
      const actual = numericIndex ? i : value;
      return `<option value="${esc(actual)}"${String(actual) === String(selected) ? " selected" : ""}>${esc(value)}</option>`;
    }).join("")}</select></label>`;
  }
  function table(data, heat = false) {
    if (!data.data.length) return '<div class="chart-empty">No data in this selection</div>';
    if (heat) {
      const time = data.fields.findIndex(f => f.role === "Columns");
      const group = data.fields.findIndex(f => f.role === "Rows");
      const measure = data.fields.findIndex(f => f.kind === "measure");
      const weeks = [...new Set(data.data.map(r => r[time]))].sort();
      const teams = [...new Set(data.data.map(r => r[group]))].sort();
      const cells = new Map(data.data.map(r => [`${r[group]}|${r[time]}`, r[measure]]));
      const max = Math.max(1, ...data.data.map(r => Number(r[measure]) || 0));
      return `<div class="table-wrap"><table class="data-table heatmap"><thead><tr><th>Organisation</th>${weeks.map(w => `<th>${esc(w)}</th>`).join("")}</tr></thead><tbody>${teams.map(t => `<tr><th>${esc(t)}</th>${weeks.map(w => {
        const n = cells.get(`${t}|${w}`);
        return `<td style="background:rgba(22,131,197,${Math.max(0, Number(n) || 0) / max * 0.6})">${esc(format(data.fields[measure], n))}</td>`;
      }).join("")}</tr>`).join("")}</tbody></table></div>`;
    }
    return `<div class="table-wrap"><table class="data-table"><thead><tr>${data.columns.map(c => `<th scope="col">${esc(c)}</th>`).join("")}</tr></thead><tbody>${data.data.map(row => `<tr>${row.map((v, i) => `<td>${esc(format(data.fields[i], v))}</td>`).join("")}</tr>`).join("")}</tbody></table></div>`;
  }
  function chart(v, data) {
    const type = v.type.toLowerCase();
    const dims = data.fields.filter(f => f.kind !== "measure" && f.aggregate == null).length;
    const numeric = data.fields.map((f, i) => ({ f, i })).filter(({ f, i }) => f.role !== "Tooltips" && data.data.some(r => typeof r[i] === "number"));
    if (!numeric.length || !data.data.length) return table(data);
    const metrics = numeric.filter(({ i }) => i >= dims);
    const series = metrics.length ? metrics : numeric;
    const category = dims ? 0 : -1;
    const grouped = new Map();
    for (const row of data.data) {
      const label = category < 0 ? "" : row[category];
      let entry = grouped.get(label);
      if (!entry) { entry = { label, points: [] }; grouped.set(label, entry); }
      for (const { f, i } of series) entry.points.push({ label: dims > 1 ? `${row.slice(1, dims).join(" / ")} / ${f.label || f.name}` : f.label || f.name, value: Number(row[i]) || 0, field: f });
    }
    const groups = category < 0 ? [...series.map(({ f, i }) => ({ label: f.label || f.name, points: [{ label: f.label || f.name, value: Number(data.data[0][i]) || 0, field: f }] }))] : [...grouped.values()];
    const labels = [...new Set(groups.flatMap(g => g.points.map(p => p.label)))];
    const color = (label) => colors[labels.indexOf(label) % colors.length];
    const legend = labels.length > 1 ? `<div class="chart-legend">${labels.map(label => `<span><i style="background:${color(label)}"></i>${esc(label)}</span>`).join("")}</div>` : "";
    const cross = (g) => category < 0 || !engine.canFilter(data.fields[0]) ? "" : `data-cross-field="${esc(`${data.fields[0].table}|${data.fields[0].name}`)}" data-cross-value="${esc(g.label)}" tabindex="0" role="button" aria-label="Filter ${esc(g.label)}"`;
    const title = (g, p) => `<title>${esc(g.label)} / ${esc(p.label)}: ${esc(format(p.field, p.value))}</title>`;
    if (/donut|pie/.test(type)) {
      const points = groups.flatMap(g => g.points.map(p => ({ ...p, label: category < 0 ? p.label : g.label })));
      const total = points.reduce((s, p) => s + p.value, 0);
      let angle = -Math.PI / 2;
      const paths = points.map((p, i) => {
        const next = angle + (total ? p.value / total * Math.PI * 2 : 0);
        const x1 = 100 + 72 * Math.cos(angle), y1 = 85 + 72 * Math.sin(angle);
        const x2 = 100 + 72 * Math.cos(next), y2 = 85 + 72 * Math.sin(next);
        const path = p.value === total ? `<circle cx="100" cy="85" r="72" fill="${colors[i % colors.length]}"/>` : `<path d="M100,85 L${x1},${y1} A72,72 0 ${next - angle > Math.PI ? 1 : 0},1 ${x2},${y2} Z" fill="${colors[i % colors.length]}"/>`;
        angle = next;
        return `<g>${path}<title>${esc(p.label)}: ${esc(format(p.field, p.value))}</title></g>`;
      }).join("");
      return `<svg class="mini-chart" viewBox="0 0 310 180" role="img" aria-label="${esc(v.title)}">${paths}${type.includes("donut") ? '<circle cx="100" cy="85" r="43" fill="white"/>' : ""}${points.map((p, i) => `<text x="185" y="${16 + i * 19}" font-size="9" fill="${colors[i % colors.length]}">${esc(p.label)}: ${esc(format(p.field, p.value))}</text>`).join("")}</svg>`;
    }
    if (type.includes("treemap")) {
      function pack(items, x, y, w, h) {
        if (!items.length) return "";
        if (items.length === 1) {
          const g = items[0], i = groups.indexOf(g);
          return `<button type="button" ${cross(g)} title="${esc(g.label)}: ${esc(format(g.points[0].field, g.points[0].value))}" style="left:${x}%;top:${y}%;width:${w}%;height:${h}%;background:${colors[i % colors.length]}">${esc(g.label)} <strong>${esc(format(g.points[0].field, g.points[0].value))}</strong></button>`;
        }
        const total = items.reduce((s, g) => s + g.points[0].value, 0);
        let split = 1, sum = items[0].points[0].value;
        while (split < items.length - 1 && sum < total / 2) sum += items[split++].points[0].value;
        const fraction = total ? sum / total : split / items.length;
        return w >= h ? pack(items.slice(0, split), x, y, w * fraction, h) + pack(items.slice(split), x + w * fraction, y, w * (1 - fraction), h)
          : pack(items.slice(0, split), x, y, w, h * fraction) + pack(items.slice(split), x, y + h * fraction, w, h * (1 - fraction));
      }
      return `<div class="treemap">${pack(groups.filter(g => g.points[0].value > 0), 0, 0, 100, 100)}</div>`;
    }
    if (type.includes("wordcloud")) {
      const words = new Map(), stop = new Set(["the", "and", "was", "a", "to", "of", "is", "in", "for"]);
      for (const g of groups) for (const word of String(g.label).toLowerCase().split(/\W+/)) if (word && !stop.has(word)) words.set(word, (words.get(word) || 0) + g.points[0].value);
      const maximum = Math.max(1, ...words.values());
      return `<div class="word-cloud">${[...words].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([word, count], i) => `<span title="${esc(word)}: ${number(count)}" style="font-size:${12 + count / maximum * 25}px;color:${colors[i % colors.length]}">${esc(word)}</span>`).join("")}</div>`;
    }
    if (type.includes("scatter")) {
      const x = data.fields.findIndex(f => f.role === "X"), y = data.fields.findIndex(f => f.role === "Y"), size = data.fields.findIndex(f => f.role === "Size");
      const mx = Math.max(1, ...data.data.map(r => Number(r[x]) || 0)), my = Math.max(1, ...data.data.map(r => Number(r[y]) || 0));
      return `<svg class="mini-chart" viewBox="0 0 460 210" role="img" aria-label="${esc(v.title)}"><path d="M35 10V180H445" fill="none" stroke="#9aa9b5"/>${data.data.map(r => `<circle cx="${35 + (Number(r[x]) || 0) / mx * 400}" cy="${180 - (Number(r[y]) || 0) / my * 160}" r="${Math.min(16, 3 + Math.sqrt(Number(r[size]) || 0))}" fill="#1683c5" opacity=".65"><title>${esc(r.slice(0, dims).join(" / "))}: ${esc(data.columns[x])} ${number(r[x])}, ${esc(data.columns[y])} ${number(r[y])}</title></circle>`).join("")}<text x="160" y="205" font-size="10">${esc(data.columns[x])}</text><text x="40" y="10" font-size="10">${esc(data.columns[y])}</text></svg>`;
    }
    if (/column/.test(type)) {
      const combo = type.includes("combo"), stacked = type.includes("stacked");
      const barLabels = labels.filter(label => !combo || groups.some(g => g.points.some(p => p.label === label && p.field.role !== "Y2")));
      const lineLabels = combo ? labels.filter(label => groups.some(g => g.points.some(p => p.label === label && p.field.role === "Y2"))) : [];
      const maximum = Math.max(1, ...groups.map(g => stacked ? g.points.filter(p => barLabels.includes(p.label)).reduce((s, p) => s + p.value, 0) : Math.max(...g.points.map(p => p.value))));
      const width = Math.max(450, groups.length * 52), plot = width - 65;
      const bars = groups.map((g, i) => {
        const x = 35 + i * plot / Math.max(1, groups.length), slot = plot / Math.max(1, groups.length) * .75;
        let top = 170;
        return `<g ${cross(g)}>${g.points.filter(p => barLabels.includes(p.label)).map((p, j) => {
          const h = p.value / maximum * 145, px = stacked ? x : x + j * slot / Math.max(1, barLabels.length);
          const py = stacked ? top - h : 170 - h;
          if (stacked) top -= h;
          return `<rect x="${px}" y="${py}" width="${stacked ? slot : slot / Math.max(1, barLabels.length)}" height="${h}" fill="${color(p.label)}">${title(g, p)}</rect>`;
        }).join("")}<text x="${x}" y="187" font-size="9" transform="rotate(25 ${x} 187)">${esc(String(g.label).slice(0, 17))}</text></g>`;
      }).join("");
      const lines = lineLabels.map(label => {
        const points = groups.map((g, i) => ({ g, p: g.points.find(p => p.label === label), x: 35 + (i + .4) * plot / Math.max(1, groups.length) }));
        return `<polyline points="${points.map(x => `${x.x},${170 - (x.p?.value || 0) * 145}`).join(" ")}" fill="none" stroke="${color(label)}" stroke-width="2"/>${points.map(x => `<circle cx="${x.x}" cy="${170 - (x.p?.value || 0) * 145}" r="3" fill="${color(label)}">${x.p ? title(x.g, x.p) : ""}</circle>`).join("")}`;
      }).join("");
      return `${legend}<div class="chart-scroll"><svg viewBox="0 0 ${width} 225" style="width:100%;min-width:${width}px;min-height:180px" role="img" aria-label="${esc(v.title)}"><path d="M30 15V170H${width - 10}" fill="none" stroke="#c7d0d8"/>${bars}${lines}<text x="0" y="12" font-size="9">${number(maximum)}</text>${combo ? `<text x="${width - 25}" y="12" font-size="9">100%</text>` : ""}</svg></div>`;
    }
    if (/line|area/.test(type)) {
      const max = Math.max(1, ...groups.flatMap(g => g.points.map(p => p.value)));
      const lines = labels.map(label => {
        const points = groups.map((g, i) => ({ x: 40 + i * 400 / Math.max(1, groups.length - 1), y: 170 - (g.points.find(p => p.label === label)?.value || 0) / max * 145, g, p: g.points.find(p => p.label === label) }));
        return `<polyline points="${points.map(p => `${p.x},${p.y}`).join(" ")}" fill="none" stroke="${color(label)}" stroke-width="2"/>${points.map(p => `<circle cx="${p.x}" cy="${p.y}" r="3" fill="${color(label)}">${p.p ? title(p.g, p.p) : ""}</circle>`).join("")}`;
      }).join("");
      return `${legend}<svg class="mini-chart" viewBox="0 0 480 210" role="img" aria-label="${esc(v.title)}"><path d="M35 15V175H455" fill="none" stroke="#c7d0d8"/>${lines}${groups.map((g, i) => i % Math.max(1, Math.ceil(groups.length / 6)) ? "" : `<text x="${40 + i * 400 / Math.max(1, groups.length - 1)}" y="193" font-size="9">${esc(String(g.label).slice(0, 10))}</text>`).join("")}</svg>`;
    }
    const tornado = type.includes("tornado");
    const hundred = type.includes("hundredpercent");
    const stacked = type.includes("stacked");
    const max = Math.max(1, ...groups.map(g => stacked ? g.points.reduce((s, p) => s + p.value, 0) : Math.max(...g.points.map(p => p.value))));
    const height = Math.max(100, groups.length * 31 + 16);
    const bars = groups.map((g, index) => {
      const y = index * 31 + 9;
      let start = 140;
      const total = g.points.reduce((s, p) => s + p.value, 0);
      return `<g ${cross(g)}><text x="2" y="${y + 10}" font-size="10">${esc(String(g.label).slice(0, 25))}</text>${g.points.map((p, j) => {
        const width = Math.max(0, p.value / (hundred ? total || 1 : max) * (tornado ? 138 : 280));
        const x = tornado ? j === 0 ? 285 - width : 285 : start;
        const by = stacked || tornado ? y : y + j * 18 / Math.max(1, g.points.length);
        if (stacked) start += width;
        return `<rect x="${x}" y="${by}" width="${width}" height="${stacked || tornado ? 14 : 16 / g.points.length}" fill="${color(p.label)}">${title(g, p)}</rect><text x="${tornado ? j ? x + width + 3 : x - 30 : stacked ? x + 3 : x + width + 3}" y="${by + 11}" font-size="9">${esc(format(p.field, p.value))}</text>`;
      }).join("")}</g>`;
    }).join("");
    return `${legend}<div class="chart-scroll"><svg viewBox="0 0 490 ${height}" style="width:100%;min-height:${height}px" role="img" aria-label="${esc(v.title)}">${bars}</svg></div>`;
  }
  function showDetails(id) {
    const v = report.pages[state.page].visuals.find(x => x.id === id);
    const data = dataCache.get(id);
    $("definition-title").textContent = v.title;
    $("definition-copy").textContent = "Every bound series and category in the current selection. Blank measures are shown as a dash.";
    $("detail-data").innerHTML = table(data);
    const defs = v.fields.filter(f => f.kind === "measure").map(f => report.measures[f.name.toLowerCase()]).filter(Boolean);
    $("dax-details").hidden = !defs.length;
    $("definition-expression").textContent = defs.map(d => `${d.name}\n${d.expression}`).join("\n\n");
    $("definition-dialog").showModal();
  }
  function renderVisual(v, page, visible) {
    if (v.isGroup || !visible(v) || !v.position) return "";
    const p = position(v, page), type = v.type.toLowerCase();
    let body = "", framed = true, data;
    if (/slicer/.test(type)) body = filterHtml(v);
    else if (type === "bookmarknavigator") {
      const g = (page.views || []).find(x => x.id === v.bookmarkGroup);
      body = g ? `<div class="bookmark-options">${g.views.map(view => `<button type="button" class="bookmark-option" data-view-group="${g.id}" data-view="${view.id}" aria-pressed="${state.bookmarks[g.id] === view.id}">${esc(view.name)}</button>`).join("")}</div>` : "";
    } else if (type === "textbox") body = `<div class="text-visual">${esc(v.title)}</div>`;
    else if (type === "actionbutton") body = `<button class="action-visual" type="button" data-action="${v.id}">${v.bookmarkTarget?.pageId ? "Open report" : "Help"}</button>`;
    else if (!v.fields.length) { body = type === "image" ? "ValueLens" : ""; framed = false; }
    else {
      const chartVisual = { ...v, predicates: [...(page.predicates || []), ...(v.predicates || [])], fields: [...v.fields] };
      if (state.page === 6 && type === "hundredpercentstackedbarchart" && state.modelView && state.modelView !== "Tool") chartVisual.fields = chartVisual.fields.map(f => f.role === "Category" ? { ...f, name: state.modelView === "Model" ? "AI_Model" : "Model Cost Tier", label: state.modelView } : f);
      data = engine.visualData(state.page === 12 && type === "pivottable" ? { ...chartVisual, type: "heatmap" } : chartVisual);
      dataCache.set(v.id, data);
      if (/card/.test(type)) body = `<div class="card-metrics">${data.columns.map((label, i) => data.fields[i].role === "Tooltips" ? "" : `<div><div class="metric-label">${esc(label)}</div><div class="metric-value${typeof data.data[0]?.[i] === "string" ? " narrative" : ""}" data-measure="${esc(data.fields[i].name)}">${esc(format(data.fields[i], data.data[0]?.[i]))}</div></div>`).join("")}</div>`;
      else if (/table/.test(type)) body = table(data, state.page === 12);
      else body = chart(v, data);
    }
    const button = data ? `<button class="info-button" data-details="${v.id}" aria-label="Show values and source definitions: ${esc(v.title)}">i</button>` : "";
    return `<article data-visual="${v.id}" class="visual${framed ? " has-frame" : ""}${/card/.test(type) ? " metric-card" : ""}${/slicer|bookmarknavigator|actionbutton|shape|image|textbox/.test(type) ? " control-visual" : ""}" style="left:${p.x}px;top:${p.y}px;width:${p.width}px;height:${p.height}px;z-index:${p.z || 0}" aria-label="${esc(v.title)}"><div class="visual-head"><span class="visual-title">${esc(v.title)}</span>${button}</div><div class="visual-body">${body}</div></article>`;
  }
  function render() {
    dataCache.clear();
    const page = report.pages[state.page];
    $("page-title").textContent = page.name.trim();
    $("page-nav").innerHTML = report.pages.map((p, i) => `<button type="button" data-page="${i}" aria-current="${i === state.page ? "page" : "false"}">${esc(p.name.trim())}</button>`).join("");
    $("filter-controls").innerHTML = options("From", "from", fixture.months, state.from, false) + options("To", "to", fixture.months, state.to, false)
      + options("Organisation", "team", fixture.teams, state.team) + options("Licence", "license", fixture.licenses, state.license)
      + options("Tool", "tool", fixture.tools, state.tool) + options("Agent", "agent", fixture.agents, state.agent);
    const visible = visibility(page);
    $("report-canvas").style.width = `${page.width}px`;
    $("report-canvas").style.height = `${page.height}px`;
    $("report-canvas").innerHTML = page.visuals.map(v => renderVisual(v, page, visible)).join("");
    const rows = engine.selectedRows();
    $("page-summary").textContent = `${fixture.months[state.from]} to ${fixture.months[state.to]} | ${number(engine.measure("AI Tasks"))} AI tasks | ${number(engine.measure("All Active Users"))} active users | ${Object.keys(state.dimensions).length} chart/slicer filters`;
    window.VALUE_LENS_REPORT_VIEW = { state, engine, render, visible: visibility(page), rows };
  }
  document.addEventListener("change", (event) => {
    const target = event.target;
    if (target.dataset.state) {
      state[target.dataset.state] = Number(target.value);
      if (state.from > state.to) {
        if (target.dataset.state === "to") state.from = state.to;
        else state.to = state.from;
      }
      syncViews();
    } else if (target.dataset.special) {
      const key = target.dataset.special;
      state[key] = ["from", "team", "license", "tool", "hourly"].includes(key) ? Number(target.value) : target.value;
      if (state.from > state.to) state.to = state.from;
      syncViews();
    } else if (target.dataset.dimension) {
      if (target.value === "-1") delete state.dimensions[target.dataset.dimension];
      else state.dimensions[target.dataset.dimension] = target.value;
    } else return;
    render();
  });
  document.addEventListener("click", (event) => {
    const button = event.target.closest("button,[data-cross-field]");
    if (!button) return;
    if (button.dataset.page != null) state.page = Number(button.dataset.page);
    else if (button.dataset.details) { showDetails(button.dataset.details); return; }
    else if (button.dataset.view) {
      const g = report.pages[state.page].views.find(x => x.id === button.dataset.viewGroup);
      state.bookmarks[g.id] = button.dataset.view;
      applyView(g.views.find(v => v.id === button.dataset.view).name);
    } else if (button.dataset.crossField) {
      const key = button.dataset.crossField;
      if (state.dimensions[key] === button.dataset.crossValue) delete state.dimensions[key];
      else state.dimensions[key] = button.dataset.crossValue;
    } else if (button.dataset.action) {
      const v = report.pages[state.page].visuals.find(x => x.id === button.dataset.action);
      const next = report.pages.findIndex(p => p.id === v.bookmarkTarget?.pageId);
      if (next < 0) { $("report-help").hidden = !$("report-help").hidden; return; }
      state.page = next;
      const group = (report.pages[next].views || []).find(g => g.views.some(x => x.id === v.bookmarkTarget?.id));
      if (group) {
        const bookmark = group.views.find(x => x.id === v.bookmarkTarget.id);
        state.bookmarks[group.id] = bookmark.id;
        applyView(bookmark.name);
      }
    } else if (button.id === "clear-filters") {
      Object.assign(state, { from: Math.max(0, fixture.months.indexOf("2026-06")), to: fixture.months.length - 1, team: -1, license: -1, tool: -1, agent: -1, dimensions: {}, hourly: 50, scenario: "Typical" });
      syncViews();
    } else return;
    render();
  });
  document.addEventListener("keydown", event => {
    if (event.target.matches("[data-cross-field]") && !event.target.matches("button") && ["Enter", " "].includes(event.key)) { event.preventDefault(); event.target.dispatchEvent(new MouseEvent("click", { bubbles: true })); }
  });
  syncViews();
  render();
})();
