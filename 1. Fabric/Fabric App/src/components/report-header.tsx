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
    /** Further actions after the downloads, such as editing a pack. */
    actions?: ReactNode;
    /** Offer the downloads and actions; off for a conversation like Ask, which can't be exported. */
    downloadable?: boolean;
    /** A further line under the freshness, such as whose data is shown. */
    meta?: ReactNode;
}

const LABELS: Record<ExportFormat, string> = { pdf: "Download PDF", pptx: "Download PowerPoint" };

/**
 * The heading of a destination or report pack: what it is, how fresh its data
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
    actions,
    downloadable = true,
    meta,
}: ReportHeaderProps) {
    const { filters, orgAttribute } = useFilterContext();
    const exporter = useReportExport();

    const start = (format: ExportFormat) =>
        void exporter.run(format, {
            name: title,
            description: blurb,
            root: contentRef.current,
            filters: describeFilters(filters, filterKeys, orgAttribute.label),
            freshness: describeFreshness(sources, dates),
            dataTo: earliestDate(sources.map((source) => dates[source])),
            missing,
        });

    return (
        <header className="flex flex-wrap items-center gap-400">
            <span className="flex size-[48px] shrink-0 items-center justify-center rounded-lg bg-accent text-primary">
                <Icon className="icon-size-400" aria-hidden="true" />
            </span>
            <span className="flex min-w-0 flex-1 flex-col gap-100">
                <h1 className="text-[length:var(--text-hero-700)] leading-hero-700 font-semibold">{title}</h1>
                {blurb && <span className="text-[length:var(--text-300)] leading-300 text-muted-foreground">{blurb}</span>}
                <FreshnessLabel sources={sources} dates={dates} />
                {meta}
            </span>
            {downloadable && (
                <span className="flex flex-col items-end gap-100" data-print="hide">
                    <span role="group" aria-label={`Download ${title}`} className="flex flex-wrap items-center justify-end gap-200">
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
                    <span role="status" className={cn(SMALL, "max-w-[48ch] text-right text-muted-foreground")}>
                        {exporter.message}
                    </span>
                </span>
            )}
        </header>
    );
}
