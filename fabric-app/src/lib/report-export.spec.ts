//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import { afterEach, describe, expect, it, vi } from "vitest";
import { defaultFilters, formatDateRange, tenantDefaultFilters } from "@/lib/filters";
import {
    blockTitle,
    buildPptx,
    captureBlocks,
    collectBlocks,
    deckSlides,
    describeFilters,
    fitImage,
    LOADING_ATTR,
    PRINT_ROOT_ID,
    printReport,
    reportMarkup,
    SLIDE_HEIGHT,
    SLIDE_WIDTH,
    waitForSettled,
    type ReportDocument,
} from "./report-export";
import { stageLabel } from "./report-pack";

const { downloadBlob } = vi.hoisted(() => ({ downloadBlob: vi.fn() }));
vi.mock("@/lib/download", async (importOriginal) => ({
    ...(await importOriginal<typeof import("@/lib/download")>()),
    downloadBlob,
}));

const PIXEL = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";

function document_(overrides: Partial<ReportDocument> = {}): ReportDocument {
    return {
        name: "Exec pre-read",
        description: "The headline story",
        generatedAt: new Date("2026-10-12T09:00:00Z"),
        source: "ValueLens",
        filters: "All data, no filters",
        freshness: "Audit log to 5 Oct",
        dataTo: "2026-10-05",
        missing: [],
        incomplete: false,
        blocks: [
            { stage: "the-bottom-line", title: "Usage is up a fifth", image: PIXEL, width: 800, height: 400 },
            { stage: "the-bottom-line", title: "The bottom line: Active users", image: PIXEL, width: 400, height: 400 },
            { stage: "budget-runway", title: "Budget runway", image: PIXEL, width: 1000, height: 300 },
        ],
        ...overrides,
    };
}

afterEach(() => {
    document.body.innerHTML = "";
    document.documentElement.classList.remove("vl-printing");
    vi.restoreAllMocks();
    downloadBlob.mockReset();
});

describe("describeFilters", () => {
    it("says so when nothing narrows the data", () => {
        expect(describeFilters(defaultFilters, ["dateRange", "organizations", "licence"], "Department")).toBe(
            "All data, no filters",
        );
    });

    it("names only the filters that apply, listing a few values and counting the rest", () => {
        const state = {
            ...defaultFilters,
            dateRange: { preset: "custom" as const, from: "2026-07-01", to: "2026-09-30" },
            organizations: ["Finance", "Sales", "Legal", "HR", "IT"],
            licence: "licensed" as const,
            agentNames: ["Not on this page"],
        };
        expect(describeFilters(state, ["dateRange", "organizations", "licence"], "Department")).toBe(
            `Date: ${formatDateRange("2026-07-01", "2026-09-30")} · Department: Finance, Sales, Legal and 2 more · License: Licensed`,
        );
    });
});

function stageSection(stage: string, inner: string): string {
    return `<section id="stage-${stage}"><div><h2>Heading</h2></div>${inner}</section>`;
}

describe("collectBlocks", () => {
    it("takes each stage's marked blocks in order, leaving out the heading and anything hidden", () => {
        const root = document.createElement("div");
        root.innerHTML = [
            stageSection(
                "the-bottom-line",
                `<div data-export=""><p data-headline="">Usage is up a fifth</p><canvas></canvas></div>
                 <div class="grid">
                    <div data-export="" data-export-title="Active users"><svg></svg></div>
                    <p class="sr-only">Screen reader only</p>
                    <div hidden data-export="">Hidden</div>
                    <div data-print="hide">Filters</div>
                 </div>`,
            ),
            stageSection("not-a-stage", `<div data-export="">Ignored</div>`),
            stageSection("budget-runway", `<p>Months of credit left at the current rate.</p>`),
        ].join("");
        document.body.append(root);

        const blocks = collectBlocks(root);
        expect(blocks.map(({ stage, title }) => [stage, title])).toEqual([
            ["the-bottom-line", "Usage is up a fifth"],
            ["the-bottom-line", `${stageLabel("the-bottom-line")}: Active users`],
            ["budget-runway", stageLabel("budget-runway")],
        ]);
    });

    it("titles a block after its headline, else its chart, else its stage", () => {
        const element = document.createElement("div");
        element.innerHTML = `<h3>Credits by month</h3>`;
        expect(blockTitle(element, "Budget runway")).toBe("Budget runway: Credits by month");
        element.innerHTML = `<h3>Budget runway</h3>`;
        expect(blockTitle(element, "Budget runway")).toBe("Budget runway");
        element.innerHTML = `<p data-headline="">  Credit runs out   in March </p><h3>Credits</h3>`;
        expect(blockTitle(element, "Budget runway")).toBe("Credit runs out in March");
    });
});

describe("waitForSettled", () => {
    it("resolves once the page stops changing", async () => {
        const root = document.createElement("div");
        await expect(waitForSettled(root, { quietMs: 150, timeoutMs: 2000 })).resolves.toBe(true);
    });

    it("gives up while something is still loading", async () => {
        const root = document.createElement("div");
        root.innerHTML = `<div ${LOADING_ATTR}=""></div>`;
        await expect(waitForSettled(root, { quietMs: 100, timeoutMs: 400 })).resolves.toBe(false);
    });
});

describe("captureBlocks", () => {
    it("captures what it can and counts what it couldn't", async () => {
        const good = document.createElement("div");
        const bad = document.createElement("div");
        const capture = vi.fn((element: HTMLElement) =>
            element === good ? Promise.resolve(new Blob(["png"], { type: "image/png" })) : Promise.reject(new Error("tainted")),
        );
        const progress = vi.fn();
        const { captured, failed } = await captureBlocks(
            [
                { stage: "the-bottom-line", title: "Good", element: good },
                { stage: "budget-runway", title: "Bad", element: bad },
            ],
            progress,
            capture,
        );
        expect(failed).toBe(1);
        expect(captured).toHaveLength(1);
        expect(captured[0]).toMatchObject({ stage: "the-bottom-line", title: "Good", width: 1, height: 1 });
        expect(captured[0].image).toMatch(/^data:image\/png;base64,/);
        expect(progress).toHaveBeenLastCalledWith(2, 2);
    });
});

describe("deck", () => {
    it("fits an image inside its frame, centred, keeping its proportions", () => {
        expect(fitImage(200, 100, { x: 0, y: 0, w: 10, h: 10 })).toEqual({ x: 0, y: 2.5, w: 10, h: 5 });
        expect(fitImage(100, 200, { x: 1, y: 1, w: 10, h: 10 })).toEqual({ x: 3.5, y: 1, w: 5, h: 10 });
    });

    it("opens with a cover naming the filters, freshness and what was left out, then a slide per block", () => {
        const slides = deckSlides(document_({ missing: ["Agent quality"], incomplete: true }));
        expect(slides).toHaveLength(4);
        const cover = slides[0].texts.map(({ text }) => text).join("\n");
        expect(cover).toContain("Exec pre-read");
        expect(cover).toContain("Filters: All data, no filters");
        expect(cover).toContain("Data: Audit log to 5 Oct");
        expect(cover).toContain("Agent quality");
        expect(cover).toContain("still loading");

        const [title, footer, page] = slides[1].texts;
        expect(title.text).toBe("Usage is up a fifth");
        expect(footer.text).toBe("Exec pre-read · Data: Audit log to 5 Oct");
        expect(page.text).toBe("2");
        expect(slides[3].texts[2].text).toBe("4");
        for (const slide of slides.slice(1)) {
            const image = slide.image!;
            expect(image.x).toBeGreaterThanOrEqual(0);
            expect(image.x + image.w).toBeLessThanOrEqual(SLIDE_WIDTH);
            expect(image.y + image.h).toBeLessThanOrEqual(SLIDE_HEIGHT);
        }
    });

    it("builds a PowerPoint file", async () => {
        const blob = await buildPptx(document_());
        expect(blob.size).toBeGreaterThan(1000);
    });
});

describe("print", () => {
    it("lays the report out by stage, escaping what it shows", () => {
        const markup = reportMarkup(
            document_({
                name: "<script>alert(1)</script>",
                blocks: [{ stage: "budget-runway", title: `"Runway" & <b>`, image: PIXEL, width: 1, height: 1 }],
            }),
        );
        expect(markup).not.toContain("<script>");
        expect(markup).toContain("&lt;script&gt;");
        expect(markup).toContain("&quot;Runway&quot; &amp; &lt;b&gt;");
        expect(markup).toContain(`<h2>${stageLabel("budget-runway")}</h2>`);
        expect(markup.match(/<section class="stage">/g)).toHaveLength(1);
        expect(markup).toContain("from ValueLens</p>");
        expect(reportMarkup(document_({ source: "Consumption Central" }))).toContain("from Consumption Central</p>");
    });

    it("prints the report in place of the app, then tidies up", async () => {
        document.title = "ValueLens";
        let during: { shown: boolean; printing: boolean; title: string } | undefined;
        vi.spyOn(window, "print").mockImplementation(() => {
            window.dispatchEvent(new Event("beforeprint"));
            during = {
                shown: document.getElementById(PRINT_ROOT_ID) !== null,
                printing: document.documentElement.classList.contains("vl-printing"),
                title: document.title,
            };
            window.dispatchEvent(new Event("afterprint"));
        });
        await expect(printReport(document_())).resolves.toBe("printed");
        expect(during).toEqual({ shown: true, printing: true, title: "exec-pre-read-data-to-2026-10-05" });
        expect(downloadBlob).not.toHaveBeenCalled();
        expect(document.getElementById(PRINT_ROOT_ID)).toBeNull();
        expect(document.documentElement.classList.contains("vl-printing")).toBe(false);
        expect(document.title).toBe("ValueLens");
    });

    it("downloads the report as a page to print when the host blocks the print dialog", async () => {
        vi.spyOn(window, "print").mockImplementation(() => undefined);
        await expect(printReport(document_())).resolves.toBe("downloaded");
        expect(downloadBlob).toHaveBeenCalledWith(expect.any(Blob), "exec-pre-read-data-to-2026-10-05.html");
        expect(document.getElementById(PRINT_ROOT_ID)).toBeNull();
    });
});

describe("describeFilters under the tenant's default dates", () => {
    const tenant = { firstDate: "2026-01-01", lastDate: "2026-10-04" };

    it("names the last 12 weeks and their dates on a large tenant", () => {
        expect(describeFilters(tenantDefaultFilters, ["dateRange"], "Department", { ...tenant, largeTenant: true })).toBe(
            `Date: Last 12 weeks, ${formatDateRange("2026-07-13", "2026-10-04")}`,
        );
    });

    it("leaves them out on a small tenant, where they cover every date", () => {
        expect(describeFilters(tenantDefaultFilters, ["dateRange"], "Department", { ...tenant, largeTenant: false })).toBe(
            "All data, no filters",
        );
    });

    it("says what they are when the options couldn't say", () => {
        expect(describeFilters(tenantDefaultFilters, ["dateRange"], "Department")).toBe(
            "Date: Default, the last 12 weeks for a large organization",
        );
    });
});
