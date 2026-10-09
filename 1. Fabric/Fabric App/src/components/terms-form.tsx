//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import { useEffect, useId, useRef, useState, type FormEvent, type ReactNode } from "react";
import { useCommercialTerms } from "@/hooks/commercial-terms.context";
import { CURRENCIES } from "@/lib/currency";
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

/** Text that can depend on the reporting currency chosen in the form. */
type CurrencyText = string | ((currency: string) => string);

function textFor(text: string | ((currency: string) => string | undefined) | undefined, currency: string): string | undefined {
    return typeof text === "function" ? text(currency) : text;
}

export interface TermField {
    key: CommercialTermKey;
    label: CurrencyText;
    /** What the box takes, and what applies when it is left empty. */
    hint: CurrencyText;
    /** Shown in the empty box: the value that applies when nothing is typed. */
    placeholder?: string | ((currency: string) => string | undefined);
    inputMode: "decimal" | "numeric";
    /** Shown, checked and saved only while this holds for the chosen currency. Hidden fields are cleared on save. */
    showWhen?: (currency: string) => boolean;
}

/**
 * The reporting currency, saved with the other fields. `choose` shows a
 * picker for it; otherwise `value` is saved as it is, so a rate typed in
 * stays tied to the currency it was typed for.
 */
export interface TermsCurrency {
    value: string;
    choose: boolean;
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
    currency?: TermsCurrency;
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
export function TermsForm({ fields, intro, resetLabel, unavailableText, note, close, currency }: TermsFormProps) {
    const { status, unavailableReason, saved, save } = useCommercialTerms();
    const [draft, setDraft] = useState<Draft>(() => toDraft(fields, saved));
    const [picked, setChosen] = useState(currency?.value ?? "");
    const [touched, setTouched] = useState(false);
    const [saving, setSaving] = useState(false);
    const [saveError, setSaveError] = useState<string>();
    const formRef = useRef<HTMLFormElement>(null);
    const baseId = useId();
    const startCurrency = currency?.value ?? "";
    // Without a picker the currency is the page's; with one, the panel resets it each time it opens.
    const chosen = currency?.choose ? picked : startCurrency;

    useEffect(() => {
        const panel = formRef.current?.closest("[popover]");
        if (!panel) return;
        const onToggle = (event: Event) => {
            if ((event as ToggleEvent).newState !== "open") return;
            setDraft(toDraft(fields, saved));
            setChosen(startCurrency);
            setTouched(false);
            setSaveError(undefined);
        };
        panel.addEventListener("toggle", onToggle);
        return () => panel.removeEventListener("toggle", onToggle);
    }, [fields, saved, startCurrency]);

    const shown = fields.filter((field) => !field.showWhen || field.showWhen(chosen));
    const values: CommercialTermsValues = {};
    const errors: Partial<Record<CommercialTermKey, string>> = {};
    for (const field of fields) {
        if (!shown.includes(field)) {
            values[field.key] = undefined;
            continue;
        }
        const value = parseTerm(draft[field.key] ?? "");
        const error = validateTerm(field.key, value);
        if (error) errors[field.key] = error;
        else values[field.key] = value;
    }
    if (currency) values.currency = chosen;
    const valid = Object.keys(errors).length === 0;
    const editable = status === "ready";
    const anySaved = fields.some((field) => saved?.[field.key] !== undefined) || (!!currency?.choose && saved?.currency !== undefined);

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
        if (currency?.choose) cleared.currency = undefined;
        void commit(cleared);
    };

    const chooseCurrency = (code: string) => {
        setChosen(code);
        // A rate is per dollar in one currency, so it doesn't carry over to another.
        setDraft((current) => {
            const next = { ...current };
            for (const field of fields) {
                if (!field.showWhen) continue;
                const keep = code === startCurrency ? saved?.[field.key] : undefined;
                next[field.key] = keep === undefined ? "" : String(keep);
            }
            return next;
        });
    };

    const changed = saved ? formatChanged(saved) : undefined;
    const currencyId = `${baseId}-currency`;

    return (
        <form ref={formRef} noValidate onSubmit={onSubmit} className="flex flex-col gap-300">
            <p className={cn(SMALL, "text-muted-foreground")}>{intro}</p>

            {status === "unavailable" && (
                <p role="status" className={cn(SMALL, "rounded-md bg-secondary px-200 py-200-nudge text-foreground")}>
                    {unavailableText} {unavailableReason}
                </p>
            )}

            {currency?.choose && (
                <div className="flex flex-col gap-100">
                    <label htmlFor={currencyId} className={cn(SMALL, "font-semibold text-foreground")}>
                        Reporting currency
                    </label>
                    <select
                        id={currencyId}
                        value={chosen}
                        disabled={!editable || saving}
                        data-autofocus
                        aria-describedby={`${currencyId}-hint`}
                        onChange={(event) => chooseCurrency(event.target.value)}
                        className={INPUT}
                    >
                        {CURRENCIES.map((option) => (
                            <option key={option.code} value={option.code}>
                                {option.code} · {option.name}
                            </option>
                        ))}
                    </select>
                    <span id={`${currencyId}-hint`} className={cn(SMALL, "text-muted-foreground")}>
                        Value and cost on this page are shown in it.
                    </span>
                </div>
            )}

            {shown.map((field, index) => {
                const id = `${baseId}-${field.key}`;
                const error = touched ? errors[field.key] : undefined;
                return (
                    <div key={field.key} className="flex flex-col gap-100">
                        <label htmlFor={id} className={cn(SMALL, "font-semibold text-foreground")}>
                            {textFor(field.label, chosen)}
                        </label>
                        <input
                            id={id}
                            type="text"
                            inputMode={field.inputMode}
                            autoComplete="off"
                            spellCheck={false}
                            data-autofocus={(index === 0 && !currency?.choose) || undefined}
                            value={draft[field.key] ?? ""}
                            placeholder={textFor(field.placeholder, chosen) ?? ""}
                            disabled={!editable || saving}
                            aria-invalid={error ? true : undefined}
                            aria-describedby={`${id}-hint${error ? ` ${id}-error` : ""}`}
                            onChange={(event) => setDraft((current) => ({ ...current, [field.key]: event.target.value }))}
                            onBlur={() => setTouched(true)}
                            className={INPUT}
                        />
                        <span id={`${id}-hint`} className={cn(SMALL, "text-muted-foreground")}>
                            {textFor(field.hint, chosen)}
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
