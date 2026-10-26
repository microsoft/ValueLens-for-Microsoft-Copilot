//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import { CAPTURE_EXCLUDE_ATTR, captureElementAsImage } from "@microsoft/fabric-visuals-extensibility";
import type { StageId } from "@/components/destinations";
import { downloadBlob } from "@/lib/download";
import {
    AUDIENCE_LABELS,
    DATE_PRESET_LABELS,
    filterLabel,
    formatDateRange,
    isFilterInEffect,
    isTenantDefaultRange,
    shownDateRange,
    TENANT_DEFAULT_RANGE,
    type FilterKey,
    type FilterState,
    type TenantDates,
} from "@/lib/filters";
import { isRefreshPending } from "@/lib/refresh-tracker";
import { exportFileName, isStageId, stageDestination, stageLabel } from "@/lib/report-pack";

/** Marks an element that becomes one slide (or one figure in the PDF) on its own. */
export const EXPORT_ATTR = "data-export";
/** The chart or card title an export block is named after when it has no headline. */
export const EXPORT_TITLE_ATTR = "data-export-title";
/** The one-sentence headline above a chart; it becomes the slide title. */
export const HEADLINE_ATTR = "data-headline";
/** Set on loading placeholders, so an export waits until they have gone. */
export const LOADING_ATTR = "data-query-loading";

/** An element on screen that becomes one slide. */
export interface ExportBlock {
    stage: StageId;
    title: string;
    element: HTMLElement;
}

/** A block captured as a PNG data URL, with the size it was drawn at. */
export interface CapturedBlock {
    stage: StageId;
    title: string;
    image: string;
    width: number;
    height: number;
}

/** Everything an exported report shows, captured from the page. */
export interface ReportDocument {
    name: string;
    description?: string;
    generatedAt: Date;
    /** The app the report came from, for its footer and author. */
    source: string;
    /** The filters the report was drawn with, in words. */
    filters: string;
    /** How recent each source is, as the freshness line puts it. */
    freshness?: string;
    /** The date the data runs to, for the file name. */
    dataTo?: string;
    /** Labels of pack stages this install doesn't have. */
    missing: readonly string[];
    /** True when some charts were still loading or couldn't be captured. */
    incomplete: boolean;
    blocks: readonly CapturedBlock[];
}

const MAX_LISTED = 3;

function listed(values: readonly string[]): string {
    const shown = values.slice(0, MAX_LISTED).join(", ");
    return values.length > MAX_LISTED ? `${shown} and ${values.length - MAX_LISTED} more` : shown;
}

/**
 * The filters a report was drawn with, in words: "Date: 12 May – 6 Jul 2026 ·
 * Organization: Finance, Sales". Only filters among `keys` that narrow the
 * data are named. The tenant's default window is named as the last 12 weeks
 * with its dates on a large tenant, and left out on a small one, where it
 * covers every date; `tenant` is what the filter options say.
 */
export function describeFilters(
    state: FilterState,
    keys: readonly FilterKey[],
    orgLabel: string,
    tenant?: TenantDates,
): string {
    const parts: string[] = [];
    for (const key of keys) {
        const undecided = key === "dateRange" && isTenantDefaultRange(state.dateRange) && tenant?.largeTenant === undefined;
        if (!undecided && !isFilterInEffect(state, key, tenant)) continue;
        const label = filterLabel(key, orgLabel);
        switch (key) {
            case "dateRange": {
                const shown = shownDateRange(state.dateRange, tenant);
                const preset = DATE_PRESET_LABELS[TENANT_DEFAULT_RANGE.preset];
                parts.push(
                    !shown
                        ? `${label}: Default, the ${preset.toLowerCase()} for a large organization`
                        : isTenantDefaultRange(state.dateRange)
                          ? `${label}: ${preset}, ${formatDateRange(shown.from, shown.to)}`
                          : `${label}: ${formatDateRange(shown.from, shown.to)}`,
                );
                break;
            }
            case "organizations":
                parts.push(`${label}: ${listed(state.organizations)}`);
                break;
            case "licence":
                parts.push(`${label}: ${state.licence === "licensed" ? "Licensed" : "Unlicensed"}`);
                break;
            case "audience":
                parts.push(`${label}: ${AUDIENCE_LABELS[state.audience]}`);
                break;
            case "agentTypes":
                parts.push(`${label}: ${listed(state.agentTypes)}`);
                break;
            case "agentNames":
                parts.push(`${label}: ${listed(state.agentNames)}`);
                break;
        }
    }
    return parts.length > 0 ? parts.join(" · ") : "All data, no filters";
}

function isSkipped(element: Element): boolean {
    if (!(element instanceof HTMLElement)) return true;
    if (element.hidden || element.hasAttribute(CAPTURE_EXCLUDE_ATTR)) return true;
    if (element.getAttribute("data-print") === "hide" || element.classList.contains("sr-only")) return true;
    return getComputedStyle(element).display === "none";
}

/** The elements under `element` that each become a slide: marked blocks where there are any, else the element itself. */
function exportTargets(element: Element): HTMLElement[] {
    if (isSkipped(element)) return [];
    const html = element as HTMLElement;
    if (html.hasAttribute(EXPORT_ATTR)) return [html];
    if (html.querySelector(`[${EXPORT_ATTR}]`)) return [...html.children].flatMap(exportTargets);
    return html.textContent?.trim() || html.querySelector("canvas, svg, img") ? [html] : [];
}

function clean(text: string | null | undefined): string | undefined {
    const trimmed = text?.replace(/\s+/g, " ").trim();
    return trimmed || undefined;
}

/** A block's slide title: its headline, else the stage and the chart's own title, else the stage. */
export function blockTitle(element: HTMLElement, stage: string): string {
    const headline = clean(element.querySelector(`[${HEADLINE_ATTR}]`)?.textContent);
    if (headline) return headline;
    const own =
        clean(element.getAttribute(EXPORT_TITLE_ATTR)) ??
        clean(element.querySelector(`[${EXPORT_TITLE_ATTR}]`)?.getAttribute(EXPORT_TITLE_ATTR)) ??
        clean(element.querySelector("h3")?.textContent);
    return own && own !== stage ? `${stage}: ${own}` : stage;
}

/**
 * The blocks to export from a rendered page or pack, in reading order: for
 * each stage section, its marked charts and cards, and anything unmarked
 * beside them as a block of its own. The section heading is left out; the
 * stage name is carried in the slide titles instead.
 */
export function collectBlocks(root: HTMLElement): ExportBlock[] {
    const blocks: ExportBlock[] = [];
    for (const section of root.querySelectorAll<HTMLElement>('section[id^="stage-"]')) {
        const stage = section.id.slice("stage-".length);
        if (!isStageId(stage) || isSkipped(section)) continue;
        const label = stageLabel(stage);
        // The first child is the heading and its rule.
        for (const element of [...section.children].slice(1).flatMap(exportTargets)) {
            blocks.push({ stage, title: blockTitle(element, label), element });
        }
    }
    return blocks;
}

/** True while anything under `root` is still loading or refetching. */
export function isBusy(root: HTMLElement): boolean {
    return isRefreshPending() || root.querySelector(`[${LOADING_ATTR}]`) !== null;
}

export interface SettleOptions {
    /** Give up after this long and export what is there. */
    timeoutMs?: number;
    /** How long the page must stay unchanged before it counts as drawn. */
    quietMs?: number;
}

/**
 * Waits until nothing under `root` is loading and the page has stopped
 * changing for `quietMs`, so charts that draw after their data arrives are
 * drawn. Resolves false when it gave up at `timeoutMs`.
 */
export function waitForSettled(root: HTMLElement, { timeoutMs = 45_000, quietMs = 800 }: SettleOptions = {}): Promise<boolean> {
    return new Promise((resolve) => {
        const start = Date.now();
        let last = start;
        const observer = new MutationObserver(() => {
            last = Date.now();
        });
        observer.observe(root, { subtree: true, childList: true, attributes: true, characterData: true });
        const tick = () => {
            const now = Date.now();
            if (isBusy(root)) last = now;
            if (now - last >= quietMs || now - start >= timeoutMs) {
                observer.disconnect();
                resolve(now - last >= quietMs);
                return;
            }
            setTimeout(tick, 100);
        };
        setTimeout(tick, 100);
    });
}

function blobToDataUrl(blob: Blob): Promise<string> {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result));
        reader.onerror = () => reject(reader.error ?? new Error("The image couldn't be read."));
        reader.readAsDataURL(blob);
    });
}

/**
 * Captures each block as a PNG, as it is drawn on screen. A block that can't
 * be captured is left out rather than failing the export; `failed` counts them.
 */
export async function captureBlocks(
    blocks: readonly ExportBlock[],
    onProgress?: (done: number, total: number) => void,
    capture: (element: HTMLElement) => Promise<Blob> = captureElementAsImage,
): Promise<{ captured: CapturedBlock[]; failed: number }> {
    const captured: CapturedBlock[] = [];
    let failed = 0;
    for (const [index, block] of blocks.entries()) {
        onProgress?.(index, blocks.length);
        const { width, height } = block.element.getBoundingClientRect();
        try {
            const image = await blobToDataUrl(await capture(block.element));
            captured.push({ stage: block.stage, title: block.title, image, width: width || 1, height: height || 1 });
        } catch {
            failed++;
        }
    }
    onProgress?.(blocks.length, blocks.length);
    return { captured, failed };
}

/* Slides ---------------------------------------------------------------- */

/** 16:9 widescreen, in inches. */
export const SLIDE_WIDTH = 13.333;
export const SLIDE_HEIGHT = 7.5;
const MARGIN = 0.5;
const FONT = "Segoe UI";
const INK = "242424";
const MUTED = "616161";

export interface SlideText {
    text: string;
    x: number;
    y: number;
    w: number;
    h: number;
    fontSize: number;
    bold?: boolean;
    color: string;
    align?: "left" | "right";
}

export interface SlideImage {
    data: string;
    x: number;
    y: number;
    w: number;
    h: number;
}

export interface SlideSpec {
    texts: SlideText[];
    image?: SlideImage;
}

/** The largest box with the image's proportions that fits the frame, centred in it. */
export function fitImage(
    width: number,
    height: number,
    frame: { x: number; y: number; w: number; h: number },
): { x: number; y: number; w: number; h: number } {
    const scale = Math.min(frame.w / width, frame.h / height);
    const w = width * scale;
    const h = height * scale;
    return { x: frame.x + (frame.w - w) / 2, y: frame.y + (frame.h - h) / 2, w, h };
}

const longDate = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "long", year: "numeric" });

function coverNotes(doc: ReportDocument): string[] {
    const notes: string[] = [];
    if (doc.missing.length > 0) notes.push(`Not included, as this install doesn't have them: ${doc.missing.join(", ")}.`);
    if (doc.incomplete) notes.push("Some charts were still loading or couldn't be captured, so they are left out.");
    return notes;
}

/** The deck's slides: a cover with the filters and freshness, then one slide per block. */
export function deckSlides(doc: ReportDocument): SlideSpec[] {
    const width = SLIDE_WIDTH - MARGIN * 2;
    const footer = [doc.name, doc.freshness && `Data: ${doc.freshness}`].filter(Boolean).join(" · ");
    const cover: SlideSpec = {
        texts: [
            { text: doc.name, x: MARGIN, y: 2.2, w: width, h: 1, fontSize: 36, bold: true, color: INK },
            ...(doc.description
                ? [{ text: doc.description, x: MARGIN, y: 3.2, w: width, h: 0.6, fontSize: 18, color: MUTED }]
                : []),
            {
                text: [
                    `Filters: ${doc.filters}`,
                    doc.freshness && `Data: ${doc.freshness}`,
                    `Generated ${longDate.format(doc.generatedAt)} from ${doc.source}`,
                    ...coverNotes(doc),
                ]
                    .filter(Boolean)
                    .join("\n"),
                x: MARGIN,
                y: 4.1,
                w: width,
                h: 2.2,
                fontSize: 14,
                color: MUTED,
            },
        ],
    };
    const slides = doc.blocks.map((block, index): SlideSpec => ({
        texts: [
            { text: block.title, x: MARGIN, y: 0.3, w: width, h: 0.9, fontSize: 22, bold: true, color: INK },
            { text: footer, x: MARGIN, y: SLIDE_HEIGHT - 0.5, w: width - 1, h: 0.3, fontSize: 10, color: MUTED },
            {
                text: String(index + 2),
                x: SLIDE_WIDTH - MARGIN - 1,
                y: SLIDE_HEIGHT - 0.5,
                w: 1,
                h: 0.3,
                fontSize: 10,
                color: MUTED,
                align: "right",
            },
        ],
        image: {
            data: block.image,
            ...fitImage(block.width, block.height, { x: MARGIN, y: 1.35, w: width, h: SLIDE_HEIGHT - 1.35 - 0.7 }),
        },
    }));
    return [cover, ...slides];
}

/** The deck as a .pptx file. pptxgenjs is bundled and only loaded when a deck is made. */
export async function buildPptx(doc: ReportDocument): Promise<Blob> {
    const { default: PptxGenJS } = await import("pptxgenjs");
    const pptx = new PptxGenJS();
    pptx.layout = "LAYOUT_WIDE";
    pptx.title = doc.name;
    pptx.author = doc.source;
    for (const spec of deckSlides(doc)) {
        const slide = pptx.addSlide();
        for (const text of spec.texts) {
            slide.addText(text.text, {
                x: text.x,
                y: text.y,
                w: text.w,
                h: text.h,
                fontSize: text.fontSize,
                bold: text.bold,
                color: text.color,
                fontFace: FONT,
                align: text.align ?? "left",
                valign: "top",
                fit: "shrink",
            });
        }
        if (spec.image) slide.addImage(spec.image);
    }
    return (await pptx.write({ outputType: "blob" })) as Blob;
}

/* Print ------------------------------------------------------------------ */

const ESCAPES: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };

function escapeHtml(value: string): string {
    return value.replace(/[&<>"']/g, (character) => ESCAPES[character]);
}

/** The id of the element the print stylesheet shows in place of the app. */
export const PRINT_ROOT_ID = "vl-print-report";

const REPORT_STYLE = `
@page { size: A4 landscape; margin: 12mm; }
.vl-report { font-family: "Segoe UI", system-ui, sans-serif; color: #242424; background: #fff; }
.vl-report .cover { min-height: 150mm; display: flex; flex-direction: column; justify-content: center; gap: 4mm; break-after: page; }
.vl-report h1 { font-size: 28pt; margin: 0; }
.vl-report .muted { color: #616161; font-size: 11pt; margin: 0; }
.vl-report .stage { break-before: page; }
.vl-report .stage:first-of-type { break-before: auto; }
.vl-report h2 { font-size: 18pt; margin: 0 0 1mm; }
.vl-report figure { margin: 6mm 0 0; break-inside: avoid; }
.vl-report figcaption { font-size: 13pt; font-weight: 600; margin-bottom: 2mm; }
.vl-report img { display: block; max-width: 100%; max-height: 150mm; width: auto; height: auto; }
`;

/** The report as markup: a cover, then each stage with its blocks under its own heading. */
export function reportMarkup(doc: ReportDocument): string {
    const data = doc.freshness ? `Data: ${doc.freshness}` : undefined;
    const cover = [
        `<h1>${escapeHtml(doc.name)}</h1>`,
        doc.description && `<p class="muted">${escapeHtml(doc.description)}</p>`,
        `<p class="muted">Filters: ${escapeHtml(doc.filters)}</p>`,
        data && `<p class="muted">${escapeHtml(data)}</p>`,
        `<p class="muted">Generated ${escapeHtml(longDate.format(doc.generatedAt))} from ${escapeHtml(doc.source)}</p>`,
        ...coverNotes(doc).map((note) => `<p class="muted">${escapeHtml(note)}</p>`),
    ].filter(Boolean);

    const stages: string[] = [];
    let current: StageId | undefined;
    for (const block of doc.blocks) {
        if (block.stage !== current) {
            if (current) stages.push("</section>");
            current = block.stage;
            const label = stageLabel(block.stage);
            stages.push(
                `<section class="stage"><h2>${escapeHtml(label)}</h2>`,
                `<p class="muted">${escapeHtml([stageDestination(block.stage).label, data].filter(Boolean).join(" · "))}</p>`,
            );
        }
        stages.push(
            `<figure><figcaption>${escapeHtml(block.title)}</figcaption>`,
            `<img src="${escapeHtml(block.image)}" alt="${escapeHtml(block.title)}"></figure>`,
        );
    }
    if (current) stages.push("</section>");

    return `<style>${REPORT_STYLE}</style><article class="vl-report"><div class="cover">${cover.join("")}</div>${stages.join("")}</article>`;
}

/** The report as a standalone web page, for printing to PDF where the app can't open the print dialog. */
export function reportHtml(doc: ReportDocument): string {
    return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${escapeHtml(doc.name)}</title></head><body>${reportMarkup(doc)}</body></html>`;
}

const PRINT_SETTLE_MS = 300;
const PRINT_WAIT_MS = 10 * 60_000;

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Opens the print dialog on the report, laid out for paper by the print
 * stylesheet, so "Save as PDF" makes the PDF. Where the host blocks the
 * dialog — a sandboxed frame without modals — the report downloads as a web
 * page to print from instead.
 */
export async function printReport(doc: ReportDocument): Promise<"printed" | "downloaded"> {
    const container = document.createElement("div");
    container.id = PRINT_ROOT_ID;
    container.innerHTML = reportMarkup(doc);
    document.body.append(container);
    document.documentElement.classList.add("vl-printing");
    // Browsers suggest the page title as the PDF's file name.
    const pageTitle = document.title;
    document.title = exportFileName(doc.name, doc.dataTo, "pdf").replace(/\.pdf$/, "");

    let opened = false;
    let closed = false;
    const onBefore = () => {
        opened = true;
    };
    const onAfter = () => {
        closed = true;
    };
    window.addEventListener("beforeprint", onBefore);
    window.addEventListener("afterprint", onAfter);
    try {
        // Images must be decoded before the dialog lays the page out.
        await Promise.all(
            [...container.querySelectorAll("img")].map((image) =>
                Promise.resolve()
                    .then(() => image.decode())
                    .catch(() => undefined),
            ),
        );
        try {
            window.print();
        } catch {
            // Treated as blocked below.
        }
        await sleep(PRINT_SETTLE_MS);
        if (!opened) {
            downloadBlob(new Blob([reportHtml(doc)], { type: "text/html" }), exportFileName(doc.name, doc.dataTo, "html"));
            return "downloaded";
        }
        // Most browsers hold `print()` until the dialog closes; the rest say so with `afterprint`.
        const start = Date.now();
        while (!closed && Date.now() - start < PRINT_WAIT_MS) await sleep(250);
        return "printed";
    } finally {
        window.removeEventListener("beforeprint", onBefore);
        window.removeEventListener("afterprint", onAfter);
        document.title = pageTitle;
        document.documentElement.classList.remove("vl-printing");
        container.remove();
    }
}
