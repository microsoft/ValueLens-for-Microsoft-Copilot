//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import { useCallback, useEffect, useRef, useState } from "react";
import { useThemeContext } from "@/hooks/theme.context";
import { appName } from "@/lib/app-variant";
import { downloadBlob } from "@/lib/download";
import {
    buildPptx,
    captureBlocks,
    collectBlocks,
    printReport,
    waitForSettled,
    type ReportDocument,
} from "@/lib/report-export";
import { exportFileName } from "@/lib/report-pack";
import { runtimeConfig } from "@/lib/runtime-config";

export type ExportFormat = "pdf" | "pptx";

export interface ExportRequest {
    name: string;
    description?: string;
    /** The rendered page or pack to export. */
    root: HTMLElement | null;
    filters: string;
    freshness?: string;
    dataTo?: string;
    missing?: readonly string[];
    /**
     * Readies `root` for capture, such as drawing every stage of a page that
     * shows one at a time, and returns how to put it back.
     */
    prepare?: () => () => void;
}

export interface ReportExport {
    /** The format being made, while an export runs. */
    busy: ExportFormat | undefined;
    /** Progress, the outcome, or why it failed, for a status line. */
    message: string | undefined;
    run: (format: ExportFormat, request: ExportRequest) => Promise<void>;
}

function nextFrame(): Promise<void> {
    return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}

/**
 * Exports what is on screen as a deck or a printed PDF. Charts are captured
 * in the light theme, whatever the app is showing, so a report reads the same
 * on paper and on a projector; the theme is switched back straight after.
 */
export function useReportExport(): ReportExport {
    const themeContext = useThemeContext();
    const theme = useRef(themeContext);
    const [busy, setBusy] = useState<ExportFormat>();
    const [message, setMessage] = useState<string>();

    useEffect(() => {
        theme.current = themeContext;
    });

    const run = useCallback(async (format: ExportFormat, request: ExportRequest) => {
        const root = request.root;
        if (!root) return;
        setBusy(format);
        setMessage("Waiting for the charts to finish loading…");
        // By the time it is restored the page has re-rendered, so `theme.current` holds the light theme's toggle.
        let swapped = theme.current.isDark;
        let unprepare = request.prepare?.();
        const restore = () => {
            unprepare?.();
            unprepare = undefined;
            if (!swapped) return;
            swapped = false;
            theme.current.toggleTheme();
        };
        try {
            if (swapped) theme.current.toggleTheme();
            await nextFrame();
            await nextFrame();
            const settled = await waitForSettled(root);
            const blocks = collectBlocks(root);
            if (blocks.length === 0) {
                setMessage("There's nothing on this page to export yet.");
                return;
            }
            const { captured, failed } = await captureBlocks(blocks, (done, total) =>
                setMessage(`Capturing charts: ${done} of ${total}`),
            );
            restore();
            if (captured.length === 0) {
                setMessage("The charts couldn't be captured, so nothing was exported.");
                return;
            }
            const doc: ReportDocument = {
                name: request.name,
                description: request.description,
                generatedAt: new Date(),
                source: appName(runtimeConfig().variant),
                filters: request.filters,
                freshness: request.freshness,
                dataTo: request.dataTo,
                missing: request.missing ?? [],
                incomplete: !settled || failed > 0,
                blocks: captured,
            };
            if (format === "pptx") {
                setMessage("Building the PowerPoint…");
                downloadBlob(await buildPptx(doc), exportFileName(doc.name, doc.dataTo, "pptx"));
                setMessage("PowerPoint downloaded");
            } else {
                setMessage("Opening the print dialog. Choose Save as PDF.");
                const outcome = await printReport(doc);
                setMessage(
                    outcome === "printed"
                        ? undefined
                        : "This host blocks the print dialog, so the report downloaded as a web page. Open it and print to PDF.",
                );
            }
        } catch (error) {
            setMessage(`The export failed: ${error instanceof Error ? error.message : String(error)}`);
        } finally {
            restore();
            setBusy(undefined);
        }
    }, []);

    return { busy, message, run };
}
