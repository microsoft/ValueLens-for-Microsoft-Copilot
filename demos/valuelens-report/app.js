(() => {
  "use strict";

  const payload = window.VALUE_LENS_REPORT_DEMO;
  if (!payload) throw new Error("The local report fixture did not load.");
  const { report, fixture } = payload;
  const pageNav = document.getElementById("page-nav");
  const pageTitle = document.getElementById("page-title");
  const filterControls = document.getElementById("filter-controls");
  const canvas = document.getElementById("report-canvas");
  const pageSummary = document.getElementById("page-summary");
  const definitionDialog = document.getElementById("definition-dialog");
  const definitions = report.measures || {};
  const glossary = report.glossary || [];
  const defaultView = (report.pages[0]?.views || [])
    .flatMap((group) => group.views.filter((view) => view.id === group.selected))
    .at(0)?.name?.toLowerCase();
  const state = {
    page: 0,
    from: fixture.months.findIndex((month) => month >= "2026-06"),
    to: fixture.months.length - 1,
    team: -1,
    license: defaultView === "licensed" ? 0 : defaultView === "unlicensed" ? 1 : -1,
    tool: defaultView === "agents" ? 1 : defaultView === "cowork" ? 2 : -1,
    agent: -1,
    bookmarks: Object.fromEntries(
      report.pages.flatMap((page) => (page.views || []).map((group) => [group.id, group.selected])),
    ),
  };
  if (state.from < 0) state.from = 0;

  const esc = (value) => String(value ?? "").replace(/[&<>"']/g, (char) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[char]);
  const num = (value) => new Intl.NumberFormat("en-US", { maximumFractionDigits: 1 }).format(value);
  const percent = (value) => `${num(value * 100)}%`;
  const monthLabel = (month) => {
    const [year, monthNum] = month.split("-").map(Number);
    return new Intl.DateTimeFormat("en-US", { month: "short", year: "numeric", timeZone: "UTC" })
      .format(new Date(Date.UTC(year, monthNum - 1, 1)));
  };

  function filteredRows() {
    return fixture.rows.filter((row) =>
      row[0] >= state.from &&
      row[0] <= state.to &&
      (state.team < 0 || row[1] === state.team) &&
      (state.license < 0 || row[2] === state.license) &&
      (state.tool < 0 || row[3] === state.tool) &&
      (state.agent < 0 || row[4] === state.agent));
  }

  function filteredFeedback() {
    return fixture.feedbackRows.filter((row) =>
      row[0] >= state.from && row[0] <= state.to);
  }

  function currentPage() {
    return report.pages[state.page];
  }

  function hiddenVisualsForPage(page) {
    const hidden = new Set(
      (page.views || []).flatMap((group) => {
        const selected = state.bookmarks[group.id] || group.selected;
        return group.views.find((view) => view.id === selected)?.hiddenVisualIds || [];
      }),
    );
    const activeViews = (page.views || []).map((group) =>
      group.views.find((view) => view.id === (state.bookmarks[group.id] || group.selected))?.name.toLowerCase() || "",
    );
    for (const visual of page.visuals) {
      const context = `${visual.title} ${visual.fields.map((field) => `${field.name} ${field.label}`).join(" ")}`.toLowerCase();
      if (
        (activeViews.includes("licensed") && context.includes("unlicensed")) ||
        (activeViews.includes("unlicensed") && /\blicensed\b/.test(context.replaceAll("unlicensed", ""))) ||
        (activeViews.includes("agents") && /\blicensed\b|\bunlicensed\b/.test(context.replaceAll("unlicensed", "")))
      ) hidden.add(visual.id);
    }
    return hidden;
  }

  function optionList(label, values, value, key) {
    const options = [];
    if (key !== "from" && key !== "to") options.push(`<option value="-1">All</option>`);
    values.forEach((entry, index) => {
      options.push(`<option value="${index}"${index === value ? " selected" : ""}>${esc(entry)}</option>`);
    });
    return `<label class="filter-field"><span>${esc(label)}</span><select data-filter="${key}">${options.join("")}</select></label>`;
  }

  function applyBookmarkFilter(viewName) {
    const name = viewName.toLowerCase();
    if (name === "overall") {
      state.license = -1;
      state.tool = -1;
      state.agent = -1;
    } else if (name === "licensed") {
      state.license = 0;
      state.tool = -1;
      state.agent = -1;
    } else if (name === "unlicensed") {
      state.license = 1;
      state.tool = -1;
      state.agent = -1;
    } else if (name === "agents") {
      state.license = -1;
      state.tool = 1;
      state.agent = -1;
    } else if (name === "cowork") {
      state.license = -1;
      state.tool = 2;
      state.agent = -1;
    }
    syncBookmarkToFilters();
  }

  function syncBookmarkToFilters() {
    const desired = state.license === 0
      ? "licensed"
      : state.license === 1
        ? "unlicensed"
        : state.tool === 1
          ? "agents"
          : state.tool === 2
            ? "cowork"
            : "overall";
    for (const page of report.pages) {
      for (const group of page.views || []) {
        const matching = group.views.find((view) => view.name.toLowerCase() === desired);
        if (matching) state.bookmarks[group.id] = matching.id;
      }
    }
  }

  function renderFilters() {
    const months = fixture.months.map(monthLabel);
    filterControls.innerHTML = [
      optionList("From", months, state.from, "from"),
      optionList("To", months, state.to, "to"),
      optionList("Organisation", fixture.teams, state.team, "team"),
      optionList("Licence", fixture.licenses, state.license, "license"),
      optionList("Tool", fixture.tools, state.tool, "tool"),
      optionList("Agent", fixture.agents, state.agent, "agent"),
    ].join("");
    filterControls.querySelectorAll("select").forEach((select) => {
      select.addEventListener("change", () => {
        const key = select.dataset.filter;
        const value = Number(select.value);
        state[key] = value;
        if (key === "license" || key === "tool") syncBookmarkToFilters();
        if (state.from > state.to) {
          if (key === "from") state.to = state.from;
          else state.from = state.to;
        }
        render();
      });
    });
  }

  function currentStats(rows = filteredRows()) {
    const promptRows = rows.filter((row) => row[10] === 1);
    const usageRows = rows.filter((row) => row[14] === 1);
    const observedRows = rows.filter((row) => row[13] === 1);
    const people = new Set(usageRows.map((row) => row[8]));
    const population = fixture.userTeams
      .map((team, user) => user)
      .filter((user) =>
        (state.team < 0 || fixture.userTeams[user] === state.team) &&
        (state.license < 0 || fixture.userLicenses[user] === state.license));
    const activePeople = new Set([...people].filter((user) => population.includes(user)));
    const licensedPopulation = population.filter((user) => fixture.userLicenses[user] === 0);
    const unlicensedPopulation = population.filter((user) => fixture.userLicenses[user] === 1);
    const activeLicensed = new Set([...activePeople].filter((user) => fixture.userLicenses[user] === 0));
    const activeUnlicensed = new Set([...activePeople].filter((user) => fixture.userLicenses[user] === 1));
    const agentPeople = new Set(promptRows.filter((row) => row[3] === 1 || row[3] === 2).map((row) => row[8]));
    const coworkPeople = new Set(promptRows.filter((row) => row[3] === 2).map((row) => row[8]));
    const copilotPeople = new Set(promptRows.filter((row) => row[3] === 0).map((row) => row[8]));
    const sessions = new Set(observedRows.map((row) => row[9]));
    const hours = promptRows.reduce((total, row) => total + Number(row[11] || 0) / 60, 0);
    const licensedByMonth = new Map();
    for (const row of promptRows) {
      if (row[2] !== 0) continue;
      if (!licensedByMonth.has(row[0])) licensedByMonth.set(row[0], new Set());
      licensedByMonth.get(row[0]).add(row[8]);
    }
    const investment = [...licensedByMonth.values()].reduce((sum, peopleInMonth) => sum + peopleInMonth.size * 30, 0);
    const feedback = filteredFeedback();
    return {
      rows: promptRows.length,
      people: activePeople.size,
      population: population.length,
      inactivePeople: Math.max(0, population.length - activePeople.size),
      licensedPopulation: licensedPopulation.length,
      unlicensedPopulation: unlicensedPopulation.length,
      activeLicensed: activeLicensed.size,
      inactiveLicensed: Math.max(0, licensedPopulation.length - activeLicensed.size),
      activeUnlicensed: activeUnlicensed.size,
      inactiveUnlicensed: Math.max(0, unlicensedPopulation.length - activeUnlicensed.size),
      agentPeople: agentPeople.size,
      coworkPeople: coworkPeople.size,
      copilotPeople: copilotPeople.size,
      copilotOnlyPeople: [...copilotPeople].filter((user) => !agentPeople.has(user)).length,
      sessions: sessions.size,
      hours,
      value: hours * 50,
      investment,
      roi: hours * 50 - investment,
      feedback: feedback.length,
      satisfaction: feedback.length ? feedback.filter((row) => fixture.feedbackTypes[row[1]].toLowerCase().includes("up")).length / feedback.length : 0,
    };
  }

  function measureValue(name, rows = filteredRows()) {
    const key = name.toLowerCase();
    let scopedRows = rows;
    if (/cowork/.test(key)) scopedRows = rows.filter((row) => row[3] === 2);
    else if (/agent/.test(key)) scopedRows = rows.filter((row) => row[3] === 1);
    else if (/copilot/.test(key)) scopedRows = rows.filter((row) => row[3] === 0);
    const stats = currentStats(scopedRows);
    if (/percent|share|rate|%/.test(key)) {
      if (/inactive.*licensed/.test(key)) return stats.licensedPopulation ? stats.inactiveLicensed / stats.licensedPopulation : 0;
      if (/active.*licensed/.test(key)) return stats.licensedPopulation ? stats.activeLicensed / stats.licensedPopulation : 0;
      if (/inactive.*unlicensed/.test(key)) return stats.unlicensedPopulation ? stats.inactiveUnlicensed / stats.unlicensedPopulation : 0;
      if (/active.*unlicensed/.test(key)) return stats.unlicensedPopulation ? stats.activeUnlicensed / stats.unlicensedPopulation : 0;
      if (/inactive/.test(key)) return stats.population ? stats.inactivePeople / stats.population : 0;
      return stats.population ? stats.people / stats.population : 0;
    }
    if (/inactive.*licensed/.test(key)) return stats.inactiveLicensed;
    if (/active.*licensed/.test(key)) return stats.activeLicensed;
    if (/inactive.*unlicensed/.test(key)) return stats.inactiveUnlicensed;
    if (/active.*unlicensed/.test(key)) return stats.activeUnlicensed;
    if (/total licensed|licensed population|^licensed users\b/.test(key)) return stats.licensedPopulation;
    if (/total unlicensed|unlicensed population|^unlicensed users\b/.test(key)) return stats.unlicensedPopulation;
    if (/total users|user population/.test(key)) return stats.population;
    if (/inactive users/.test(key)) return stats.inactivePeople;
    if (/headline/.test(key)) return stats.people;
    if (/using copilot|not using agents/.test(key)) return stats.copilotOnlyPeople;
    if (/agent users|users using agents/.test(key)) return stats.agentPeople;
    if (/cowork users/.test(key)) return stats.coworkPeople;
    if (/ai task|ai prompt|prompt|interaction|row/.test(key)) return stats.rows;
    if (/active user|people|users|licensed users/.test(key)) return stats.people;
    if (/session/.test(key)) return stats.sessions;
    if (/hour|time saved/.test(key)) return stats.hours;
    if (/roi|net roi/.test(key)) return stats.roi;
    if (/investment|cost/.test(key)) return stats.investment;
    if (/value/.test(key)) return stats.value;
    if (/feedback|thumb/.test(key)) return stats.feedback;
    if (/agent/.test(key)) return stats.agentPeople;
    if (/share|rate|percent|%/.test(key)) return stats.rows ? stats.people / Math.max(fixture.peopleCount, 1) : 0;
    return rows.length;
  }

  function valueLabel(name, value) {
    const key = name.toLowerCase();
    if (/share|rate|percent|%/.test(key)) return percent(value);
    if (/value|roi|investment|cost/.test(key)) return `$${num(value)}`;
    if (/hour/.test(key)) return `${num(value)} h`;
    return num(value);
  }

  function fieldDimension(field) {
    const name = (field.name || field.label || "").toLowerCase();
    if (/month|date|week/.test(name)) return "month";
    if (/organization|department|org/.test(name)) return "team";
    if (/licen|environment/.test(name)) return "license";
    if (/agent filter|tool/.test(name)) return "tool";
    if (/agent/.test(name)) return "agent";
    if (/model/.test(name)) return "model";
    if (/task breakdown category|cowork task category/.test(name)) return "taskDetail";
    if (/behavior/.test(name)) return "behavior";
    if (/task|outcome/.test(name)) return "task";
    if (/feedback/.test(name)) return "feedback";
    if (/status|lifecycle/.test(name)) return "status";
    return "";
  }

  function seriesFor(field, rows, measureFields = []) {
    const dimension = fieldDimension(field || {});
    if (dimension === "feedback") {
      const counts = new Map();
      for (const row of filteredFeedback()) counts.set(row[1], (counts.get(row[1]) || 0) + 1);
      return [...counts.entries()]
        .map(([index, value]) => ({ label: fixture.feedbackTypes[index] || "Other", value }))
        .sort((a, b) => b.value - a.value)
        .slice(0, 7);
    }
    if (dimension === "status") {
      const counts = new Map();
      for (const row of fixture.registryRows) counts.set(row[2], (counts.get(row[2]) || 0) + 1);
      return [...counts.entries()]
        .filter(([index]) => index >= 0)
        .map(([index, value]) => ({ label: fixture.registryStatuses[index] || "Other", value }))
        .sort((a, b) => b.value - a.value)
        .slice(0, 7);
    }
    if (!dimension && measureFields.length) {
      return measureFields.slice(0, 7).map((measure) => ({
        label: measure.label || measure.name,
        value: measureValue(measure.name, rows),
      }));
    }
    if (dimension === "team" && measureFields.length && /user/.test(measureFields[0].name.toLowerCase())) {
      const measureName = measureFields[0].name.toLowerCase();
      const activeByTeam = new Map();
      for (const row of rows) {
        if (row[14] !== 1 || row[1] < 0) continue;
        if (!activeByTeam.has(row[1])) activeByTeam.set(row[1], new Set());
        activeByTeam.get(row[1]).add(row[8]);
      }
      return fixture.teams.map((label, team) => {
        const population = fixture.userTeams
          .map((userTeam, user) => ({ userTeam, user }))
          .filter(({ userTeam, user }) =>
            userTeam === team &&
            (state.team < 0 || userTeam === state.team) &&
            (state.license < 0 || fixture.userLicenses[user] === state.license));
        const active = activeByTeam.get(team) || new Set();
        const value = /inactive/.test(measureName)
          ? Math.max(0, population.length - active.size)
          : /active/.test(measureName)
            ? active.size
            : population.length;
        return { label, value };
      }).filter((item) => item.value > 0).sort((a, b) => b.value - a.value).slice(0, 7);
    }
    const values = {
      month: fixture.months,
      team: fixture.teams,
      license: fixture.licenses,
      tool: fixture.tools,
      agent: fixture.agents,
      behavior: fixture.behaviors,
      task: fixture.tasks,
      taskDetail: fixture.taskDetails,
      model: fixture.models,
    };
    const getter = {
      month: (row) => row[0],
      team: (row) => row[1],
      license: (row) => row[2],
      tool: (row) => row[3],
      agent: (row) => row[4],
      behavior: (row) => row[5],
      task: (row) => row[6],
      taskDetail: (row) => row[12],
      model: (row) => row[7],
    }[dimension];
    if (!getter) return [{ label: "All activity", value: rows.length }];
    const groups = new Map();
    for (const row of rows) {
      const index = getter(row);
      if (index < 0) continue;
      if (!groups.has(index)) groups.set(index, []);
      groups.get(index).push(row);
    }
    return [...groups.entries()]
      .map(([index, groupRows]) => ({
        label: values[dimension]?.[index] || "Other",
        value: measureFields.length ? measureValue(measureFields[0].name, groupRows) : groupRows.length,
      }))
      .sort((a, b) => b.value - a.value)
      .slice(0, 7);
  }

  function chartSvg(type, series, label) {
    if (!series.length) return `<div class="chart-empty">No rows match these filters</div>`;
    const max = Math.max(...series.map((item) => item.value), 1);
    const lineLike = /line|area|combo/i.test(type);
    const scatter = /scatter/i.test(type);
    const donut = /donut|pie/i.test(type);
    const usable = series.slice(0, 6);
    if (donut) {
      const colors = ["#1488c8", "#49a1d1", "#77b8dc", "#9acbe4", "#cadfeb", "#dce6ec"];
      const total = usable.reduce((sum, item) => sum + item.value, 0) || 1;
      let start = 0;
      const stops = usable.map((item, index) => {
        const end = start + item.value / total * 360;
        const segment = `${colors[index]} ${start}deg ${end}deg`;
        start = end;
        return segment;
      });
      return `<div class="donut-wrap"><div class="donut" style="background:conic-gradient(${stops.join(",")})"><span>${num(total)}</span></div><div class="donut-legend">${usable.slice(0, 4).map((item, index) => `<span><i style="background:${colors[index]}"></i>${esc(item.label)}</span>`).join("")}</div></div>`;
    }
    const rows = usable.map((item, index) => {
      const y = 16 + index * 16;
      const width = Math.max(2, 188 * item.value / max);
      return `<line class="chart-grid" x1="0" x2="205" y1="${y + 6}" y2="${y + 6}"/><rect class="chart-bar${index % 2 ? " alt" : ""}" x="0" y="${y}" width="${width}" height="8" rx="1"/><text class="chart-label" x="0" y="${y - 2}">${esc(item.label.slice(0, 24))}</text><text class="chart-label" x="212" y="${y + 7}">${num(item.value)}</text>`;
    }).join("");
    if (lineLike || scatter) {
      const points = usable.map((item, index) => {
        const x = 9 + index * 34;
        const y = 97 - Math.round(68 * item.value / max);
        return `${x},${y}`;
      });
      const dots = usable.map((item, index) => {
        const x = 9 + index * 34;
        const y = 97 - Math.round(68 * item.value / max);
        return `<circle cx="${x}" cy="${y}" r="3" fill="#1488c8"><title>${esc(item.label)}: ${num(item.value)}</title></circle>`;
      }).join("");
      return `<svg class="mini-chart" viewBox="0 0 235 116" preserveAspectRatio="none" role="img" aria-label="${esc(label)}"><line class="chart-grid" x1="0" x2="230" y1="98" y2="98"/>${lineLike ? `<polyline points="${points.join(" ")}" fill="none" stroke="#1488c8" stroke-width="2"/>` : ""}${dots}${usable.map((item, index) => `<text class="chart-label" x="${9 + index * 34}" y="112">${esc(item.label.slice(0, 6))}</text>`).join("")}</svg>`;
    }
    return `<svg class="mini-chart" viewBox="0 0 245 126" preserveAspectRatio="none" role="img" aria-label="${esc(label)}">${rows}</svg>`;
  }

  function tableHtml(visual, rows) {
    const dimensionField = visual.fields.find((field) => field.kind !== "measure" && field.label);
    const measureFields = visual.fields.filter((field) => field.kind === "measure");
    const series = seriesFor(dimensionField, rows, measureFields).slice(0, 6);
    const measureLabel = measureFields[0]?.label || "Activity";
    if (!series.length) return `<div class="chart-empty">No rows match these filters</div>`;
    return `<div class="table-wrap"><table class="data-table"><thead><tr><th>${esc(dimensionField?.label || "Group")}</th><th>${esc(measureLabel)}</th></tr></thead><tbody>${series.map((item) => `<tr><td>${esc(item.label)}</td><td>${num(item.value)}</td></tr>`).join("")}</tbody></table></div>`;
  }

  function slicerHtml(visual) {
    const field = visual.fields.find((item) => item.label);
    const label = field?.label || visual.title || "Filter";
    const dimension = fieldDimension(field || {});
    const list = {
      team: fixture.teams,
      license: fixture.licenses,
      tool: fixture.tools,
      agent: fixture.agents,
      model: fixture.models,
      task: fixture.tasks,
      feedback: fixture.feedbackTypes,
      status: fixture.registryStatuses,
    }[dimension] || [];
    const stateKey = dimension === "team" ? "team" : dimension === "license" ? "license" : dimension === "tool" ? "tool" : dimension === "agent" ? "agent" : "";
    if (!stateKey || !list.length) return `<div class="slicer-control"><label>${esc(label)}</label><select disabled><option>All</option></select></div>`;
    const options = [`<option value="-1">All</option>`].concat(
      list.map((item, index) => `<option value="${index}"${state[stateKey] === index ? " selected" : ""}>${esc(item)}</option>`),
    );
    return `<div class="slicer-control"><label>${esc(label)}</label><select data-canvas-filter="${stateKey}">${options.join("")}</select></div>`;
  }

  function titleDefinition(field) {
    if (!field || field.kind !== "measure") return null;
    return definitions[(field.name || field.label).toLowerCase()] || null;
  }

  function visualValue(visual, rows) {
    const measureField = visual.fields.find((field) => field.kind === "measure");
    const name = measureField?.name || visual.title;
    return { name, value: measureValue(name, rows), definition: titleDefinition(measureField) };
  }

  function bookmarkNavigatorHtml(page, visual) {
    const group = (page.views || []).find((item) => item.id === visual.bookmarkGroup);
    if (!group || !group.views.length) return `<button type="button" class="action-visual" data-next-page="${(state.page + 1) % report.pages.length}">Next page →</button>`;
    const selected = state.bookmarks[group.id] || group.selected;
    return `<div class="bookmark-options" role="group" aria-label="${esc(group.name)}">${group.views.map((view) =>
      `<button type="button" class="bookmark-option" data-bookmark-group="${esc(group.id)}" data-bookmark-id="${esc(view.id)}" aria-pressed="${view.id === selected}">${esc(view.name)}</button>`,
    ).join("")}</div>`;
  }

  function renderVisual(visual, page, rows, positionIndex, hiddenVisuals) {
    const type = visual.type;
    const lower = type.toLowerCase();
    const position = visual.position;
    if (!position || position.width < 5 || position.height < 5 || visual.hidden || hiddenVisuals.has(visual.id)) return "";
    const style = `left:${position.x / page.width * 100}%;top:${position.y / page.height * 100}%;width:${position.width / page.width * 100}%;height:${position.height / page.height * 100}%;z-index:${position.z || positionIndex + 1}`;
    const compact = position.width < 135 || position.height < 65;
    const value = visualValue(visual, rows);
    const definition = value.definition;
    const info = definition
      ? `<button type="button" class="info-button" data-definition="${esc(definition.name)}" aria-label="Show definition for ${esc(definition.name)}">i</button>`
      : "";
    const head = lower === "textbox" ? "" : `<div class="visual-head"><span class="visual-title" title="${esc(visual.title)}">${esc(visual.title)}</span>${info}</div>`;
    let body;
    let extraClass = "";

    if (lower === "slicer" || lower === "advancedslicervisual") {
      body = slicerHtml(visual);
      extraClass = " has-frame";
    } else if (lower === "cardvisual" || lower === "card" || lower === "kpicard") {
      const label = definition?.name || visual.title;
      body = `<div class="metric-label">${esc(label)}</div><div class="metric-value">${esc(valueLabel(value.name, value.value))}</div>`;
      extraClass = " metric-card has-frame";
    } else if (lower === "textbox") {
      body = `<div class="text-visual">${esc(visual.title)}</div>`;
      extraClass = " has-frame text-box";
    } else if (lower === "pivotTable".toLowerCase() || lower === "tableex" || lower === "table") {
      body = tableHtml(visual, rows);
      extraClass = " has-frame";
    } else if (lower === "actionbutton") {
      const targetPage = visual.bookmarkTarget
        ? report.pages.findIndex((item) => item.id === visual.bookmarkTarget.pageId)
        : -1;
      const label = targetPage >= 0 ? `Open ${report.pages[targetPage].name.trim()}` : "Help";
      body = `<button type="button" class="action-visual" data-action-page="${targetPage}" data-action-bookmark="${esc(visual.bookmarkTarget?.id || "")}" aria-label="${esc(label)}">${esc(targetPage >= 0 ? "Open report" : "Help")}</button>`;
    } else if (lower === "bookmarknavigator") {
      body = bookmarkNavigatorHtml(page, visual);
    } else if (lower === "shape" || lower === "image" || lower === "unknown" || lower === "?") {
      body = `<div class="shape-visual" aria-label="${esc(visual.title || "Report element")}">${lower === "image" ? "ValueLens" : ""}</div>`;
      extraClass = " has-frame";
    } else {
      const dimension = visual.fields.find((field) => field.kind !== "measure");
      const measureFields = visual.fields.filter((field) => field.kind === "measure");
      body = chartSvg(type, seriesFor(dimension, rows, measureFields), visual.title);
      extraClass = " has-frame";
    }
    return `<article class="visual${extraClass}${compact ? " compact" : ""}" style="${style}" aria-label="${esc(visual.title)}">${head}<div class="visual-body">${body}</div></article>`;
  }

  function renderCanvas() {
    const page = currentPage();
    const rows = filteredRows();
    const hiddenVisuals = hiddenVisualsForPage(page);
    pageTitle.textContent = page.name.trim();
    canvas.style.width = `${page.width}px`;
    canvas.style.height = `${page.height}px`;
    canvas.innerHTML = page.visuals.map((visual, index) => renderVisual(visual, page, rows, index, hiddenVisuals)).join("");
    canvas.querySelectorAll("[data-canvas-filter]").forEach((select) => {
      select.addEventListener("change", () => {
        const key = select.dataset.canvasFilter;
        state[key] = Number(select.value);
        if (key === "license" || key === "tool") syncBookmarkToFilters();
        render();
      });
    });
    canvas.querySelectorAll("[data-next-page]").forEach((button) => {
      button.addEventListener("click", () => {
        state.page = Number(button.dataset.nextPage);
        render();
      });
    });
    canvas.querySelectorAll("[data-bookmark-id]").forEach((button) => {
      button.addEventListener("click", () => {
        state.bookmarks[button.dataset.bookmarkGroup] = button.dataset.bookmarkId;
        const group = (page.views || []).find((item) => item.id === button.dataset.bookmarkGroup);
        const view = group?.views.find((item) => item.id === button.dataset.bookmarkId);
        if (view) applyBookmarkFilter(view.name);
        render();
      });
    });
    canvas.querySelectorAll("[data-action-page]").forEach((button) => {
      button.addEventListener("click", () => {
        const pageIndex = Number(button.dataset.actionPage);
        if (pageIndex < 0) return;
        state.page = pageIndex;
        const targetId = button.dataset.actionBookmark;
        const targetGroup = (report.pages[pageIndex].views || []).find((group) =>
          group.views.some((view) => view.id === targetId));
        if (targetGroup) {
          state.bookmarks[targetGroup.id] = targetId;
          const targetView = targetGroup.views.find((view) => view.id === targetId);
          if (targetView) applyBookmarkFilter(targetView.name);
        }
        render();
      });
    });
    canvas.querySelectorAll("[data-definition]").forEach((button) => {
      button.addEventListener("click", () => showDefinition(button.dataset.definition));
    });
    const stats = currentStats(rows);
    const period = state.from === state.to
      ? monthLabel(fixture.months[state.from])
      : `${monthLabel(fixture.months[state.from])} – ${monthLabel(fixture.months[state.to])}`;
    pageSummary.innerHTML = `<span>${page.visuals.length} report visuals · ${rows.length.toLocaleString("en-US")} synthetic rows after filters</span><span>${esc(period)} · ${num(stats.people)} active people</span>`;
    resizeCanvas();
  }

  function resizeCanvas() {
    const viewport = document.querySelector(".report-viewport");
    const width = viewport.clientWidth;
    if (width >= 1280) {
      canvas.style.transform = "none";
      viewport.style.height = `${canvas.offsetHeight + 10}px`;
      return;
    }
    const scale = width / 1280;
    canvas.style.transform = `scale(${scale})`;
    viewport.style.height = `${canvas.offsetHeight * scale + 10}px`;
  }

  function renderNav() {
    pageNav.innerHTML = report.pages.map((page, index) =>
      `<button type="button" data-page="${index}" aria-current="${index === state.page ? "page" : "false"}" title="${esc(page.name.trim())}">${esc(page.name.trim())}</button>`,
    ).join("");
    pageNav.querySelectorAll("[data-page]").forEach((button) => {
      button.addEventListener("click", () => {
        state.page = Number(button.dataset.page);
        render();
      });
    });
  }

  function showDefinition(measureName) {
    const definition = definitions[String(measureName).toLowerCase()];
    const glossaryEntry = glossary.find((entry) => String(entry.metric).toLowerCase() === String(measureName).toLowerCase());
    document.getElementById("definition-title").textContent = glossaryEntry?.metric || definition?.name || measureName;
    document.getElementById("definition-copy").textContent =
      glossaryEntry?.description || definition?.description || "This visual uses the report model measure shown below.";
    const details = document.getElementById("dax-details");
    details.hidden = !definition?.expression;
    document.getElementById("definition-expression").textContent = definition?.expression || "";
    definitionDialog.showModal();
  }

  function render() {
    renderNav();
    renderFilters();
    renderCanvas();
  }

  document.getElementById("clear-filters").addEventListener("click", () => {
    state.from = Math.max(0, fixture.months.findIndex((month) => month >= "2026-06"));
    state.to = fixture.months.length - 1;
    state.team = state.license = state.tool = state.agent = -1;
    syncBookmarkToFilters();
    render();
  });
  window.addEventListener("resize", resizeCanvas);
  render();
})();
