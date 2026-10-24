//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import { cn } from "@/lib/utils";

interface SegmentedControlProps<T extends string> {
    /** Names the group for assistive technology, e.g. "Cohort". */
    label: string;
    options: readonly { id: T; label: string; disabled?: boolean; hint?: string }[];
    value: T;
    onChange: (value: T) => void;
    className?: string;
}

/**
 * The segmented toggle that replaces Power BI's bookmark buttons, drawn as
 * the CSV apps draw theirs: a quiet track with the chosen option raised. Every
 * destination uses it to swap between cohorts and lenses without refetching,
 * so it behaves identically wherever it appears.
 */
export function SegmentedControl<T extends string>({
    label,
    options,
    value,
    onChange,
    className,
}: SegmentedControlProps<T>) {
    return (
        <div
            role="group"
            aria-label={label}
            className={cn("flex max-w-full gap-100-nudge overflow-x-auto rounded-[9px] bg-segment p-[3px] [scrollbar-width:none]", className)}
        >
            {options.map((option) => (
                <button
                    key={option.id}
                    type="button"
                    onClick={() => onChange(option.id)}
                    aria-pressed={option.id === value}
                    disabled={option.disabled}
                    title={option.hint}
                    className={cn(
                        "h-[28px] shrink-0 rounded-md px-300 text-[13px] whitespace-nowrap transition-colors",
                        "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring",
                        "disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:text-muted-foreground",
                        option.id === value
                            ? "bg-card font-semibold text-foreground shadow-[0_1px_2px_rgb(16_40_37/0.14)]"
                            : "font-medium text-muted-foreground hover:text-foreground",
                    )}
                >
                    {option.label}
                </button>
            ))}
        </div>
    );
}
