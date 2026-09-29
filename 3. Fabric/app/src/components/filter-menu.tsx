//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import { useEffect, useId, useRef, type ReactNode } from "react";
import { ChevronDown } from "lucide-react";
import { cn } from "@/lib/utils";

interface FilterMenuProps {
    /** The filter's name, e.g. "Organization". */
    label: string;
    /** The current selection in words, e.g. "All organizations". */
    summary: string;
    /** Highlights the trigger when the filter is narrowing the data. */
    active: boolean;
    children: (close: () => void) => ReactNode;
    panelClassName?: string;
}

const GAP = 6;
const EDGE = 8;

/**
 * A filter trigger and its dropdown panel, built on the native popover API so
 * light-dismiss, Escape and focus return behave as the platform does.
 */
export function FilterMenu({ label, summary, active, children, panelClassName }: FilterMenuProps) {
    const panelId = useId();
    const triggerRef = useRef<HTMLButtonElement>(null);
    const panelRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        const panel = panelRef.current;
        const trigger = triggerRef.current;
        if (!panel || !trigger) return;

        const place = () => {
            const anchor = trigger.getBoundingClientRect();
            const left = Math.max(EDGE, Math.min(anchor.left, window.innerWidth - panel.offsetWidth - EDGE));
            panel.style.top = `${anchor.bottom + GAP}px`;
            panel.style.left = `${left}px`;
        };
        const onToggle = (event: Event) => {
            const open = (event as ToggleEvent).newState === "open";
            trigger.setAttribute("aria-expanded", String(open));
            if (!open) return;
            place();
            panel.querySelector<HTMLElement>("[data-autofocus], input, button")?.focus();
        };
        const onResize = () => {
            if (panel.matches(":popover-open")) place();
        };

        panel.addEventListener("toggle", onToggle);
        window.addEventListener("resize", onResize);
        return () => {
            panel.removeEventListener("toggle", onToggle);
            window.removeEventListener("resize", onResize);
        };
    }, []);

    const close = () => document.getElementById(panelId)?.hidePopover?.();

    return (
        <>
            <button
                ref={triggerRef}
                type="button"
                popoverTarget={panelId}
                aria-haspopup="dialog"
                aria-expanded="false"
                className={cn(
                    "flex h-[32px] items-center gap-200 rounded-md border px-300 text-[length:var(--text-200)] leading-200 transition-colors",
                    "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring",
                    active
                        ? "border-primary/50 bg-accent text-accent-foreground"
                        : "border-border bg-card text-foreground hover:bg-secondary",
                )}
            >
                <span className={active ? "opacity-80" : "text-muted-foreground"}>{label}</span>
                <span className="max-w-[22ch] truncate font-semibold">{summary}</span>
                <ChevronDown className="icon-size-100 shrink-0 opacity-70" aria-hidden="true" />
            </button>
            <div
                ref={panelRef}
                id={panelId}
                popover="auto"
                role="dialog"
                aria-label={label}
                className={cn(
                    "fixed inset-auto m-0 max-h-[min(70vh,480px)] w-[280px] overflow-y-auto rounded-lg border border-border bg-popover p-300 text-popover-foreground shadow-16",
                    panelClassName,
                )}
            >
                {children(close)}
            </div>
        </>
    );
}
