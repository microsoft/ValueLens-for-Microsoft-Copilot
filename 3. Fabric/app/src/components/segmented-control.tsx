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
    options: readonly { id: T; label: string }[];
    value: T;
    onChange: (value: T) => void;
    className?: string;
}

/**
 * The segmented toggle that replaces Power BI's bookmark buttons. Every
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
        <div role="group" aria-label={label} className={cn("flex rounded-md border border-border p-100-nudge", className)}>
            {options.map((option) => (
                <button
                    key={option.id}
                    type="button"
                    onClick={() => onChange(option.id)}
                    aria-pressed={option.id === value}
                    className={cn(
                        "rounded-sm px-300 py-100 text-[length:var(--text-200)] font-medium transition-colors",
                        "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring",
                        option.id === value
                            ? "bg-accent text-accent-foreground"
                            : "text-muted-foreground hover:text-foreground",
                    )}
                >
                    {option.label}
                </button>
            ))}
        </div>
    );
}
