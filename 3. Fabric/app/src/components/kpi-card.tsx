//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import type { ReactNode } from "react";
import { formatKpi, type KpiFormat } from "@/lib/format-kpi";
import { cn } from "@/lib/utils";

interface KpiCardProps {
    label: string;
    value: number | undefined;
    format?: KpiFormat;
    /** Smaller supporting figure shown beneath the rule. */
    detail?: ReactNode;
    /** Emphasises the card as the lead figure of its group. */
    emphasis?: boolean;
    className?: string;
}

/**
 * A single figure presented as the focus of its card — oversized tabular
 * numerals over a hairline rule, with the label subordinated above it.
 */
export function KpiCard({ label, value, format = "whole", detail, emphasis, className }: KpiCardProps) {
    const isBlank = value === undefined;

    return (
        <div
            className={cn(
                "flex flex-col gap-200 rounded-xl border border-border bg-card p-500",
                emphasis && "border-primary/40 bg-accent/40",
                className,
            )}
        >
            <span className="text-[length:var(--text-200)] leading-200 text-muted-foreground">
                {label}
            </span>
            <span
                className={cn(
                    "font-numeric font-semibold tabular-nums leading-hero-800 text-card-foreground",
                    emphasis
                        ? "text-[length:var(--text-hero-900)] leading-hero-900"
                        : "text-[length:var(--text-hero-800)]",
                    isBlank && "text-muted-foreground",
                )}
            >
                {formatKpi(value, format)}
            </span>
            {detail && (
                <div className="border-t border-border pt-200 text-[length:var(--text-200)] leading-300 text-muted-foreground">
                    {detail}
                </div>
            )}
        </div>
    );
}

interface KpiStatProps {
    label: string;
    value: number | undefined;
    format?: KpiFormat;
}

/** A compact label/figure pair for use inside a card's detail area. */
export function KpiStat({ label, value, format = "whole" }: KpiStatProps) {
    return (
        <div className="flex items-baseline justify-between gap-200">
            <span>{label}</span>
            <span className="font-numeric font-semibold tabular-nums text-[length:var(--text-300)] text-foreground">
                {formatKpi(value, format)}
            </span>
        </div>
    );
}
