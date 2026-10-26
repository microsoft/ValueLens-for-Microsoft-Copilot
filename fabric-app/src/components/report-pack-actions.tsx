//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import { useState } from "react";
import { Copy, Pencil, Trash2 } from "lucide-react";
import { useReportPacks } from "@/hooks/report-packs.context";
import { copyOfPack, type ReportPack } from "@/lib/report-pack";
import { SMALL } from "@/lib/type-scale";
import { cn } from "@/lib/utils";
import { ACTION_BUTTON } from "@/lib/action-button";

interface PackActionsProps {
    pack: ReportPack;
    /** Opens the editor on a pack, under a heading. */
    onEdit: (pack: ReportPack, heading: string) => void;
    /** Called once the pack is gone, to leave its page. */
    onDeleted: () => void;
}

/**
 * Edit, copy or delete the open pack. Built-in packs can only be copied, and
 * nothing can be changed while the saved packs can't be reached. Deleting asks
 * first, in place rather than with a browser dialog an embedding host may block.
 */
export function PackActions({ pack, onEdit, onDeleted }: PackActionsProps) {
    const { status, remove } = useReportPacks();
    const [confirming, setConfirming] = useState(false);
    const [deleting, setDeleting] = useState(false);
    const [error, setError] = useState<string>();
    const ready = status === "ready";

    const confirmDelete = async () => {
        setDeleting(true);
        setError(undefined);
        try {
            await remove(pack.id);
            onDeleted();
        } catch (failure) {
            setError(failure instanceof Error && failure.message ? failure.message : String(failure));
            setDeleting(false);
            setConfirming(false);
        }
    };

    if (confirming) {
        return (
            <span role="group" aria-label={`Delete ${pack.name}?`} className="flex items-center gap-200">
                <span className={cn(SMALL, "text-foreground")}>Delete this pack for everyone?</span>
                <button
                    type="button"
                    className={cn(ACTION_BUTTON, "border-destructive text-destructive")}
                    disabled={deleting}
                    onClick={() => void confirmDelete()}
                >
                    {deleting ? "Deleting…" : "Delete"}
                </button>
                <button type="button" className={ACTION_BUTTON} disabled={deleting} onClick={() => setConfirming(false)}>
                    Keep
                </button>
            </span>
        );
    }

    return (
        <>
            {!pack.builtIn && (
                <button type="button" className={ACTION_BUTTON} disabled={!ready} onClick={() => onEdit(pack, "Edit report pack")}>
                    <Pencil className="icon-size-100 shrink-0" aria-hidden="true" />
                    Edit
                </button>
            )}
            <button type="button" className={ACTION_BUTTON} disabled={!ready} onClick={() => onEdit(copyOfPack(pack), "Save a copy")}>
                <Copy className="icon-size-100 shrink-0" aria-hidden="true" />
                Save a copy
            </button>
            {!pack.builtIn && (
                <button type="button" className={ACTION_BUTTON} disabled={!ready} onClick={() => setConfirming(true)}>
                    <Trash2 className="icon-size-100 shrink-0" aria-hidden="true" />
                    Delete
                </button>
            )}
            {error && (
                <span role="alert" className={cn(SMALL, "basis-full text-right text-destructive")}>
                    {error}
                </span>
            )}
        </>
    );
}
