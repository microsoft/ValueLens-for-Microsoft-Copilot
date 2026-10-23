//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import type { ReactNode, RefObject } from "react";
import { FileDown, Presentation, type LucideIcon } from "lucide-react";
import { useFilterContext } from "@/hooks/filter.context";
import { useReportExport, type ExportFormat } from "@/hooks/use-report-export";
import type { FilterKey } from "@/lib/filters";
import { describeFreshness, type FreshnessDates, type FreshnessSource } from "@/lib/freshness";
import { describeFilters } from "@/lib/report-export";
import { earliestDate } from "@/lib/report-pack";
import { SMALL } from "@/lib/type-scale";
import { cn } from "@/lib/utils";
import { ACTION_BUTTON } from "@/lib/action-button";
import { FreshnessLabel } from "./freshness-label";

interface ReportHeaderProps {
    icon: LucideIcon;
    title: string;
    blurb?: string;
    /** The sources behind what is shown, and the dates they run to. */
    sources: readonly FreshnessSource[];
    dates: FreshnessDates;
    /** The filters what is shown responds to, to name on the export's cover. */
    filterKeys: readonly FilterKey[];
    /** Labels of stages that can't be shown in this install, noted on the cover. */
    missing?: readonly string[];
    /** The rendered page or pack the downloads capture. */
    contentRef: RefObject<HTMLElement | null>;
    /** Readies the content for a download and returns how to put it back. */
    prepareExport?: () => () => void;
    /** Further actions after the downloads, such as editing a pack. */
    actions?: ReactNode;
    /** Offer the downloads and actions; off for a conversation like Ask, which can't be exported. */
    downloadable?: boolean;
    /** A further line under the freshness, such as whose data is shown. */
    meta?: ReactNode;
    /** The product the page belongs to, shown above its title. */
    crumb?: string;
}

const LABELS: Record<ExportFormat, string> = { pdf: "Download PDF", pptx: "Download PowerPoint" };

/**
 * The page head of a destination or report pack, as the App Editions draw it
 * in the toolbar: which product it belongs to, what it is, how fresh its data
 * is, and downloads of it as a PDF or a PowerPoint deck drawn with the
 * current filters.
 */
export function ReportHeader({
    icon: Icon,
    title,
    blurb,
    sources,
    dates,
    filterKeys,
    missing,
    contentRef,
    prepareExport,
    actions,
    downloadable = true,
    meta,
    crumb,
}: ReportHeaderProps) {
    const { filters, orgAttribute, options } = useFilterContext();
    const exporter = useReportExport();

    const start = (format: ExportFormat) =>
        void exporter.run(format, {
            name: title,
            description: blurb,
            root: contentRef.current,
            filters: describeFilters(filters, filterKeys, orgAttribute.label, options),
            freshness: describeFreshness(sources, dates),
            dataTo: earliestDate(sources.map((source) => dates[source])),
            missing,
            prepare: prepareExport,
        });

    return (
        <header className="flex flex-wrap items-start gap-x-600 gap-y-300">
            <span className="flex min-w-[min(100%,320px)] flex-1 flex-col gap-100">
                {crumb && (
                    <span className={cn(SMALL, "flex items-center gap-100 font-medium text-muted-foreground")}>
                        <Icon className="icon-size-100 shrink-0 text-primary" aria-hidden="true" />
                        {crumb}
                    </span>
                )}
                <h1 className="font-heading text-[21px] leading-[28px] font-semibold tracking-[-0.01em]">{title}</h1>
                {blurb && <span className="text-[length:var(--text-300)] leading-300 text-muted-foreground">{blurb}</span>}
                <FreshnessLabel sources={sources} dates={dates} />
                {meta}
            </span>
            {downloadable && (
                <span className="flex flex-col items-start gap-100 sm:items-end" data-print="hide">
                    <span role="group" aria-label={`Download ${title}`} className="flex flex-wrap items-center gap-200 sm:justify-end">
                        {(["pdf", "pptx"] as const).map((format) => {
                            const FormatIcon = format === "pdf" ? FileDown : Presentation;
                            return (
                                <button
                                    key={format}
                                    type="button"
                                    className={ACTION_BUTTON}
                                    disabled={exporter.busy !== undefined}
                                    aria-busy={exporter.busy === format || undefined}
                                    onClick={() => start(format)}
                                >
                                    <FormatIcon className="icon-size-100 shrink-0" aria-hidden="true" />
                                    {LABELS[format]}
                                </button>
                            );
                        })}
                        {actions}
                    </span>
                    <span role="status" className={cn(SMALL, "max-w-[48ch] text-muted-foreground sm:text-right")}>
                        {exporter.message}
                    </span>
                </span>
            )}
        </header>
    );
}
