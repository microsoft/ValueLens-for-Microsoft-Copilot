//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import { FileStack, Plus } from "lucide-react";
import { useReportPacks } from "@/hooks/report-packs.context";
import { cn } from "@/lib/utils";

interface ReportsNavProps {
    /** The pack being read, if any. */
    activePack?: string;
    onOpen: (id: string) => void;
    onCreate: () => void;
}

const ITEM = cn(
    "flex w-full items-center gap-300 rounded-md px-300 py-200 text-left transition-colors",
    "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring",
);

/**
 * The band's Reports list: the packs, built-in and saved, each read as one
 * page and exported as one document, and a way to make another.
 */
export function ReportsNav({ activePack, onOpen, onCreate }: ReportsNavProps) {
    const { status, unavailableReason, packs } = useReportPacks();

    return (
        <div className="flex flex-col gap-100">
            <span id="nav-reports" className="px-300 text-[length:var(--text-200)] leading-200 font-semibold text-muted-foreground">
                Reports
            </span>
            <ul aria-labelledby="nav-reports" className="flex flex-col gap-100-nudge">
                {packs.map((pack) => {
                    const isActive = pack.id === activePack;
                    return (
                        <li key={pack.id}>
                            <button
                                type="button"
                                onClick={() => onOpen(pack.id)}
                                aria-current={isActive ? "page" : undefined}
                                className={cn(
                                    ITEM,
                                    isActive ? "bg-accent text-accent-foreground" : "text-muted-foreground hover:bg-secondary hover:text-foreground",
                                )}
                            >
                                <FileStack className="icon-size-200 shrink-0 text-primary" aria-hidden="true" />
                                <span className={cn("min-w-0 truncate text-[length:var(--text-300)] leading-300", isActive && "font-semibold")}>
                                    {pack.name}
                                </span>
                            </button>
                        </li>
                    );
                })}
            </ul>
            {status === "ready" && (
                <button type="button" onClick={onCreate} className={cn(ITEM, "text-muted-foreground hover:bg-secondary hover:text-foreground")}>
                    <Plus className="icon-size-200 shrink-0" aria-hidden="true" />
                    <span className="text-[length:var(--text-300)] leading-300">New pack</span>
                </button>
            )}
            {status === "unavailable" && (
                <p className="px-300 text-[length:var(--text-100)] leading-100 text-muted-foreground" title={unavailableReason}>
                    Saved packs can't be loaded right now, so only the built-in ones are listed.
                </p>
            )}
        </div>
    );
}
