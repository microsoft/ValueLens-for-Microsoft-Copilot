//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import { useRef, type KeyboardEvent } from "react";
import { cn } from "@/lib/utils";
import type { StageId } from "./destinations";

interface StageTabsProps {
    /** Names the tab list for assistive technology, e.g. "Adoption stages". */
    label: string;
    stages: readonly { id: StageId; label: string }[];
    open: StageId | undefined;
    onOpen: (stage: StageId) => void;
}

const KEYS: Record<string, (index: number, count: number) => number> = {
    ArrowRight: (index, count) => (index + 1) % count,
    ArrowLeft: (index, count) => (index - 1 + count) % count,
    Home: () => 0,
    End: (_, count) => count - 1,
};

/**
 * A page's stages as its sub-views, drawn as the App Editions' segmented
 * control under the page title. A page shows one stage at a time, so it only
 * queries what is open. They keep tab semantics: arrow keys move between them.
 */
export function StageTabs({ label, stages, open, onOpen }: StageTabsProps) {
    const refs = useRef<(HTMLButtonElement | null)[]>([]);

    const onKeyDown = (event: KeyboardEvent, index: number) => {
        const move = KEYS[event.key];
        if (!move) return;
        event.preventDefault();
        const next = move(index, stages.length);
        refs.current[next]?.focus();
        onOpen(stages[next].id);
    };

    return (
        <div
            role="tablist"
            aria-label={label}
            data-print="hide"
            className="flex max-w-full gap-100-nudge self-start overflow-x-auto rounded-[9px] bg-segment p-[3px] scrollbar-none"
        >
            {stages.map((stage, index) => {
                const selected = stage.id === open;
                return (
                    <button
                        key={stage.id}
                        ref={(element) => {
                            refs.current[index] = element;
                        }}
                        type="button"
                        role="tab"
                        aria-selected={selected}
                        tabIndex={selected ? 0 : -1}
                        onClick={() => onOpen(stage.id)}
                        onKeyDown={(event) => onKeyDown(event, index)}
                        className={cn(
                            "h-[32px] shrink-0 rounded-md px-[14px] text-[length:var(--text-300)] whitespace-nowrap transition-colors",
                            "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring",
                            selected
                                ? "bg-card font-semibold text-foreground shadow-[0_1px_2px_rgb(16_40_37/0.14)]"
                                : "font-medium text-muted-foreground hover:text-foreground",
                        )}
                    >
                        {stage.label}
                    </button>
                );
            })}
        </div>
    );
}
