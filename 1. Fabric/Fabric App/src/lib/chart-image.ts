//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import { writeImageToClipboard } from "@microsoft/fabric-visuals-extensibility";
import { downloadBlob } from "./download";

/** The part of a Vega view that can draw itself to a canvas. */
export interface RasterView {
    toCanvas(scaleFactor?: number): Promise<HTMLCanvasElement>;
}

export type ImageOutcome = "copied" | "downloaded";

function canvasToPng(canvas: HTMLCanvasElement): Promise<Blob> {
    return new Promise((resolve, reject) => {
        canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error("The chart couldn't be drawn as an image."))), "image/png");
    });
}

function isTransparent(colour: string): boolean {
    return !colour || colour === "transparent" || /^rgba\(.*,\s*0\)$/.test(colour);
}

/** The colour the chart sits on: its card's, else the theme's card colour, else white. */
export function backgroundOf(element: Element | null | undefined): string {
    for (let node = element; node; node = node.parentElement) {
        const colour = getComputedStyle(node).backgroundColor;
        if (!isTransparent(colour)) return colour;
    }
    const card = getComputedStyle(document.documentElement).getPropertyValue("--color-card").trim();
    return card || "#ffffff";
}

/**
 * Draws a Vega view on an opaque background at the screen's pixel density, so
 * a dark-mode chart doesn't paste as light text on a transparent picture.
 */
export async function viewToPng(view: RasterView, background: string, scale = window.devicePixelRatio || 1): Promise<Blob> {
    const drawn = await view.toCanvas(scale);
    const canvas = document.createElement("canvas");
    canvas.width = drawn.width;
    canvas.height = drawn.height;
    const context = canvas.getContext("2d");
    if (!context) return canvasToPng(drawn);
    context.fillStyle = background;
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(drawn, 0, 0);
    return canvasToPng(canvas);
}

/**
 * The chart as a PNG: the whole framed visual with its title when the
 * container can capture it, else the bare Vega view.
 */
export async function captureChart(capture: () => Promise<Blob>, fallback?: () => Promise<Blob>): Promise<Blob> {
    try {
        return await capture();
    } catch (error) {
        if (!fallback) throw error;
        return fallback();
    }
}

/**
 * Puts the picture on the clipboard, or saves it when the clipboard can't take
 * it — as inside the Fabric iframe, which isn't granted clipboard writes.
 */
export async function copyOrDownloadImage(blob: Blob, title: string, fileName: string): Promise<ImageOutcome> {
    try {
        await writeImageToClipboard(blob, { title });
        return "copied";
    } catch {
        downloadBlob(blob, fileName);
        return "downloaded";
    }
}
