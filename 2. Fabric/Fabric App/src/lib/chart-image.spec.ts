//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { backgroundOf, captureChart, copyOrDownloadImage, viewToPng } from "./chart-image";

const { writeImageToClipboard, downloadBlob } = vi.hoisted(() => ({ writeImageToClipboard: vi.fn(), downloadBlob: vi.fn() }));
vi.mock("@microsoft/fabric-visuals-extensibility", () => ({ writeImageToClipboard }));
vi.mock("./download", () => ({ downloadBlob }));

const png = new Blob(["png"], { type: "image/png" });

afterEach(() => {
    vi.clearAllMocks();
    vi.restoreAllMocks();
});

describe("copyOrDownloadImage", () => {
    it("puts the picture on the clipboard with the chart's title", async () => {
        writeImageToClipboard.mockResolvedValue(undefined);
        await expect(copyOrDownloadImage(png, "Monthly trend", "monthly-trend.png")).resolves.toBe("copied");
        expect(writeImageToClipboard).toHaveBeenCalledWith(png, { title: "Monthly trend" });
        expect(downloadBlob).not.toHaveBeenCalled();
    });

    it("saves the picture when the clipboard API is missing", async () => {
        writeImageToClipboard.mockRejectedValue(new Error("clipboardUnavailable"));
        await expect(copyOrDownloadImage(png, "Monthly trend", "monthly-trend.png")).resolves.toBe("downloaded");
        expect(downloadBlob).toHaveBeenCalledWith(png, "monthly-trend.png");
    });

    it("saves the picture when the frame isn't allowed to write to the clipboard", async () => {
        writeImageToClipboard.mockRejectedValue(new DOMException("Blocked", "NotAllowedError"));
        await expect(copyOrDownloadImage(png, "Monthly trend", "monthly-trend.png")).resolves.toBe("downloaded");
        expect(downloadBlob).toHaveBeenCalledWith(png, "monthly-trend.png");
    });
});

describe("captureChart", () => {
    it("uses the container's capture when it works", async () => {
        const fallback = vi.fn();
        await expect(captureChart(() => Promise.resolve(png), fallback)).resolves.toBe(png);
        expect(fallback).not.toHaveBeenCalled();
    });

    it("falls back to the bare chart when the capture fails", async () => {
        const bare = new Blob(["bare"]);
        await expect(captureChart(() => Promise.reject(new Error("CSP")), () => Promise.resolve(bare))).resolves.toBe(bare);
    });

    it("rethrows when there's nothing to fall back to", async () => {
        await expect(captureChart(() => Promise.reject(new Error("CSP")))).rejects.toThrow("CSP");
    });
});

describe("viewToPng", () => {
    let drawn: HTMLCanvasElement;
    const context = { fillStyle: "", fillRect: vi.fn(), drawImage: vi.fn() };

    beforeEach(() => {
        drawn = document.createElement("canvas");
        drawn.width = 200;
        drawn.height = 100;
        vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(context as unknown as CanvasRenderingContext2D);
        vi.spyOn(HTMLCanvasElement.prototype, "toBlob").mockImplementation((callback) => callback(png));
    });

    it("draws the view at the given scale on an opaque background", async () => {
        const view = { toCanvas: vi.fn().mockResolvedValue(drawn) };
        await expect(viewToPng(view, "rgb(20, 20, 20)", 2)).resolves.toBe(png);
        expect(view.toCanvas).toHaveBeenCalledWith(2);
        expect(context.fillStyle).toBe("rgb(20, 20, 20)");
        expect(context.fillRect).toHaveBeenCalledWith(0, 0, 200, 100);
        expect(context.drawImage).toHaveBeenCalledWith(drawn, 0, 0);
    });

    it("fails when the canvas can't be encoded", async () => {
        vi.spyOn(HTMLCanvasElement.prototype, "toBlob").mockImplementation((callback) => callback(null));
        await expect(viewToPng({ toCanvas: () => Promise.resolve(drawn) }, "#fff", 1)).rejects.toThrow();
    });
});

describe("backgroundOf", () => {
    it("takes the nearest opaque background", () => {
        const card = document.createElement("div");
        card.style.backgroundColor = "rgb(1, 2, 3)";
        const chart = document.createElement("div");
        card.append(chart);
        document.body.append(card);
        expect(backgroundOf(chart)).toBe("rgb(1, 2, 3)");
        card.remove();
    });

    it("falls back to white without a card", () => {
        expect(backgroundOf(null)).toBe("#ffffff");
    });
});
