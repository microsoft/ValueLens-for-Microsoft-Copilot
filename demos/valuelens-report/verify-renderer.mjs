export function verifyRenderer(win = window, licenses = [0, 1, -1]) {
  const doc = win.document, view = win.VALUE_LENS_REPORT_VIEW;
  const pages = win.VALUE_LENS_REPORT_DEMO.report.pages;
  const failures = [], results = [];
  let assertions = 0;
  const check = (condition, message) => {
    assertions++;
    if (!condition) failures.push(message);
  };
  const boxWithin = (a, b) => a.left >= b.left - 1 && a.top >= b.top - 1 && a.right <= b.right + 1 && a.bottom <= b.bottom + 1;
  const original = JSON.parse(JSON.stringify(view.state));
  try {
    for (const license of licenses) {
      const select = doc.querySelector('[data-state="license"]');
      select.value = String(license);
      select.dispatchEvent(new win.Event("change", { bubbles: true }));
      for (let page = 0; page < pages.length; page++) {
        view.state.page = page;
        view.render();
        const label = `${pages[page].name} / licence ${license}`;
        check(!/\b(?:NaN|undefined)\b/.test(doc.querySelector("main").textContent), `${label}: invalid numeric text`);
        for (const element of doc.querySelectorAll(".slicer-control select")) {
          check(boxWithin(element.getBoundingClientRect(), element.closest(".visual-body").getBoundingClientRect()), `${label}: clipped ${element.getAttribute("aria-label")} select`);
          check(element.getBoundingClientRect().height >= 27, `${label}: compressed select`);
        }
        for (const table of doc.querySelectorAll(".data-table")) {
          check(parseFloat(win.getComputedStyle(table).fontSize) >= 12, `${label}: unreadable table font`);
          const scroll = table.closest(".table-wrap");
          scroll.scrollTop = scroll.scrollHeight;
          scroll.scrollLeft = scroll.scrollWidth;
          check(table.getBoundingClientRect().bottom <= scroll.getBoundingClientRect().bottom + 1, `${label}: unreachable table bottom`);
          check(table.getBoundingClientRect().right <= scroll.getBoundingClientRect().right + 1, `${label}: unreachable table right edge`);
          scroll.scrollTop = scroll.scrollLeft = 0;
        }
        for (const svg of doc.querySelectorAll(".chart-scroll svg")) {
          const vb = svg.viewBox.baseVal;
          check(Math.abs(svg.getBoundingClientRect().width - vb.width) < 1, `${label}: SVG shrinks its text`);
          for (const text of svg.querySelectorAll("text")) {
            const box = text.getBBox(), matrix = text.getCTM();
            const points = [[box.x, box.y], [box.x + box.width, box.y], [box.x, box.y + box.height], [box.x + box.width, box.y + box.height]];
            check(points.every(([x, y]) => {
              const p = new win.DOMPoint(x, y).matrixTransform(matrix);
              return p.x >= -1 && p.y >= -1 && p.x <= vb.width + 1 && p.y <= vb.height + 1;
            }), `${label}: SVG clips label "${text.textContent}"`);
          }
          const scroll = svg.parentElement;
          scroll.scrollTop = scroll.scrollHeight;
          scroll.scrollLeft = scroll.scrollWidth;
          check(svg.getBoundingClientRect().bottom <= scroll.getBoundingClientRect().bottom + 1, `${label}: unreachable chart bottom`);
          check(svg.getBoundingClientRect().right <= scroll.getBoundingClientRect().right + 1, `${label}: unreachable chart right edge`);
          scroll.scrollTop = scroll.scrollLeft = 0;
        }
        results.push({ page, license, visuals: doc.querySelectorAll("[data-visual]").length });
      }
    }
    view.state.page = 0;
    const select = doc.querySelector('[data-state="license"]');
    select.value = "0";
    select.dispatchEvent(new win.Event("change", { bubbles: true }));
    const summary = doc.querySelector('[data-visual="6130720123a40061c0cb"]');
    check(!!summary?.querySelector(".compact-status"), "Activation compact source donut must be a readable percentage legend");
    check(!summary?.querySelector("svg"), "Activation must not squeeze a duplicate full donut over the main chart");
    const tornado = doc.querySelector('[data-visual="574663e5bd8a3b979fa2"]');
    const firstBar = tornado.querySelector("rect");
    check(firstBar.getBoundingClientRect().top >= summary.getBoundingClientRect().bottom, "Activation percentage legend must not cover the main chart rows");
    const tornadoScroll = tornado.querySelector(".chart-scroll");
    check(tornadoScroll.scrollHeight <= tornadoScroll.clientHeight + 1, "Activation's default organisation rows must fit above the source canvas bottom");
    view.state.page = 1;
    view.render();
    const turns = doc.querySelector('[data-visual="addepthturns"] .chart-scroll');
    check(turns.scrollWidth <= turns.clientWidth + 1 && turns.scrollHeight <= turns.clientHeight + 1, "Adoption turns chart must fit without shrinking or clipping");
    view.state.page = 8;
    view.render();
    const scatter = pages[8].visuals.find(v => v.type.toLowerCase().includes("scatter"));
    check(doc.querySelectorAll(`[data-visual="${scatter.id}"] .axis-tick`).length === 10, "Readiness scatter must show numeric ticks on both axes");
    view.state.page = 5;
    view.render();
    for (const button of [...doc.querySelectorAll("[data-view]")]) {
      doc.querySelector(`[data-view="${button.dataset.view}"]`).click();
      for (const table of doc.querySelectorAll(".data-table")) check(parseFloat(win.getComputedStyle(table).fontSize) >= 12, "Value bookmark table font");
    }
    return { assertions, failures, results };
  } finally {
    Object.assign(view.state, original);
    view.render();
  }
}
