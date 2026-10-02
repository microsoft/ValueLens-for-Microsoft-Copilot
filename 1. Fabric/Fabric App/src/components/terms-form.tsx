//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import { useEffect, useId, useRef, useState, type FormEvent, type ReactNode } from "react";
import { useCommercialTerms } from "@/hooks/commercial-terms.context";
import { INPUT, PRIMARY, SECONDARY } from "@/lib/form-controls";
import { SMALL } from "@/lib/type-scale";
import { cn } from "@/lib/utils";
import {
    parseTerm,
    validateTerm,
    type CommercialTermKey,
    type CommercialTermsValues,
} from "@/queries/consumption/commercial-terms";
import type { SavedCommercialTerms } from "@/services/commercial-terms.service";

export interface TermField {
    key: CommercialTermKey;
    label: string;
    /** What the box takes, and what applies when it is left empty. */
    hint: string;
    /** Shown in the empty box: the value that applies when nothing is typed. */
    placeholder?: string;
    inputMode: "decimal" | "numeric";
}

interface TermsFormProps {
    fields: readonly TermField[];
    /** The line above the boxes: what the terms price. */
    intro: ReactNode;
    /** The button that clears these fields back to their defaults. */
    resetLabel: string;
    /** Why nothing can be saved when the app's database can't be reached. */
    unavailableText: string;
    /** The closing line: where else these terms do, or don't, apply. */
    note: string;
    close: () => void;
}

type Draft = Partial<Record<CommercialTermKey, string>>;

function toDraft(fields: readonly TermField[], saved: SavedCommercialTerms | null): Draft {
    const draft: Draft = {};
    for (const field of fields) {
        const value = saved?.[field.key];
        draft[field.key] = value === undefined ? "" : String(value);
    }
    return draft;
}

function formatChanged(saved: SavedCommercialTerms): string | undefined {
    if (!saved.updatedAt) return undefined;
    const when = saved.updatedAt.toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
    return saved.updatedBy ? `Last changed by ${saved.updatedBy} on ${when}.` : `Last changed on ${when}.`;
}

/**
 * Some of the app's shared terms, typed in and saved for everyone. Saving
 * sends only these fields, so terms set elsewhere in the app are kept.
 * Sits in a {@link FilterMenu} panel, and starts again from what is saved
 * each time the panel opens.
 */
export function TermsForm({ fields, intro, resetLabel, unavailableText, note, close }: TermsFormProps) {
    const { status, unavailableReason, saved, save } = useCommercialTerms();
    const [draft, setDraft] = useState<Draft>(() => toDraft(fields, saved));
    const [touched, setTouched] = useState(false);
    const [saving, setSaving] = useState(false);
    const [saveError, setSaveError] = useState<string>();
    const formRef = useRef<HTMLFormElement>(null);
    const baseId = useId();

    useEffect(() => {
        const panel = formRef.current?.closest("[popover]");
        if (!panel) return;
        const onToggle = (event: Event) => {
            if ((event as ToggleEvent).newState !== "open") return;
            setDraft(toDraft(fields, saved));
            setTouched(false);
            setSaveError(undefined);
        };
        panel.addEventListener("toggle", onToggle);
        return () => panel.removeEventListener("toggle", onToggle);
    }, [fields, saved]);

    const values: CommercialTermsValues = {};
    const errors: Partial<Record<CommercialTermKey, string>> = {};
    for (const field of fields) {
        const value = parseTerm(draft[field.key] ?? "");
        const error = validateTerm(field.key, value);
        if (error) errors[field.key] = error;
        else values[field.key] = value;
    }
    const valid = Object.keys(errors).length === 0;
    const editable = status === "ready";
    const anySaved = fields.some((field) => saved?.[field.key] !== undefined);

    const commit = async (next: CommercialTermsValues) => {
        setSaving(true);
        setSaveError(undefined);
        try {
            await save(next);
            close();
        } catch (error) {
            setSaveError(error instanceof Error && error.message ? error.message : String(error));
        } finally {
            setSaving(false);
        }
    };

    const onSubmit = (event: FormEvent) => {
        event.preventDefault();
        setTouched(true);
        if (valid && editable && !saving) void commit(values);
    };

    const reset = () => {
        const cleared: CommercialTermsValues = {};
        for (const field of fields) cleared[field.key] = undefined;
        void commit(cleared);
    };

    const changed = saved ? formatChanged(saved) : undefined;

    return (
        <form ref={formRef} noValidate onSubmit={onSubmit} className="flex flex-col gap-300">
            <p className={cn(SMALL, "text-muted-foreground")}>{intro}</p>

            {status === "unavailable" && (
                <p role="status" className={cn(SMALL, "rounded-md bg-secondary px-200 py-200-nudge text-foreground")}>
                    {unavailableText} {unavailableReason}
                </p>
            )}

            {fields.map((field, index) => {
                const id = `${baseId}-${field.key}`;
                const error = touched ? errors[field.key] : undefined;
                return (
                    <div key={field.key} className="flex flex-col gap-100">
                        <label htmlFor={id} className={cn(SMALL, "font-semibold text-foreground")}>
                            {field.label}
                        </label>
                        <input
                            id={id}
                            type="text"
                            inputMode={field.inputMode}
                            autoComplete="off"
                            spellCheck={false}
                            data-autofocus={index === 0 || undefined}
                            value={draft[field.key] ?? ""}
                            placeholder={field.placeholder ?? ""}
                            disabled={!editable || saving}
                            aria-invalid={error ? true : undefined}
                            aria-describedby={`${id}-hint${error ? ` ${id}-error` : ""}`}
                            onChange={(event) => setDraft((current) => ({ ...current, [field.key]: event.target.value }))}
                            onBlur={() => setTouched(true)}
                            className={INPUT}
                        />
                        <span id={`${id}-hint`} className={cn(SMALL, "text-muted-foreground")}>
                            {field.hint}
                        </span>
                        {error && (
                            <span id={`${id}-error`} className={cn(SMALL, "text-destructive")}>
                                {error}
                            </span>
                        )}
                    </div>
                );
            })}

            {saveError && (
                <p role="alert" className={cn(SMALL, "text-destructive")}>
                    Couldn't save: {saveError}
                </p>
            )}

            <div className="flex flex-wrap gap-200 border-t border-border pt-300">
                <button type="submit" disabled={!editable || saving} className={PRIMARY}>
                    {saving ? "Saving…" : "Save for everyone"}
                </button>
                <button type="button" disabled={!editable || saving || !anySaved} onClick={reset} className={SECONDARY}>
                    {resetLabel}
                </button>
            </div>

            <p className={cn(SMALL, "text-muted-foreground")}>
                {changed && <>{changed} </>}
                Anyone who can open this app can change these. {note}
            </p>
        </form>
    );
}
