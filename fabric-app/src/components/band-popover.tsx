//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from "react";
import type { LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { BAND_BUTTON } from "./band-button";

interface BandPopoverProps {
    label: string;
    icon: LucideIcon;
    /** Marks the button as where the reader is, e.g. Reports while a pack is open. */
    current?: boolean;
    /** The panel's content; given a way to close the panel, for actions that move away. */
    children: (close: () => void) => ReactNode;
    className?: string;
}

/**
 * A band action that opens a panel beneath it: the Reports list and Share.
 * It closes on Escape, which returns focus to the button, and on a click
 * anywhere outside it. On a phone the panel spans the screen's width.
 */
export function BandPopover({ label, icon: Icon, current, children, className }: BandPopoverProps) {
    const [open, setOpen] = useState(false);
    const panelId = useId();
    const root = useRef<HTMLDivElement>(null);
    const button = useRef<HTMLButtonElement>(null);
    const close = useCallback(() => setOpen(false), []);

    useEffect(() => {
        if (!open) return;
        const onPointerDown = (event: PointerEvent) => {
            if (!root.current?.contains(event.target as Node)) setOpen(false);
        };
        const onKeyDown = (event: KeyboardEvent) => {
            if (event.key !== "Escape") return;
            setOpen(false);
            button.current?.focus();
        };
        document.addEventListener("pointerdown", onPointerDown);
        document.addEventListener("keydown", onKeyDown);
        return () => {
            document.removeEventListener("pointerdown", onPointerDown);
            document.removeEventListener("keydown", onKeyDown);
        };
    }, [open]);

    return (
        <div ref={root} className={cn("sm:relative", className)}>
            <button
                ref={button}
                type="button"
                onClick={() => setOpen((value) => !value)}
                aria-expanded={open}
                aria-controls={open ? panelId : undefined}
                aria-current={current ? "page" : undefined}
                className={BAND_BUTTON}
            >
                <Icon className="icon-size-200 shrink-0" aria-hidden="true" />
                <span className="max-md:sr-only">{label}</span>
            </button>
            {open && (
                <div
                    id={panelId}
                    className={cn(
                        "absolute z-30 flex max-h-[min(70vh,560px)] flex-col overflow-y-auto rounded-xl border border-border bg-popover p-300 text-popover-foreground shadow-16",
                        "inset-x-300 top-[calc(100%-4px)] sm:inset-x-auto sm:top-[calc(100%+8px)] sm:right-0 sm:w-[360px]",
                    )}
                >
                    {children(close)}
                </div>
            )}
        </div>
    );
}
