//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { FilterMenu } from "@/components/filter-menu";
import { useCommercialTerms } from "@/hooks/commercial-terms.context";
import { cn } from "@/lib/utils";
import {
    hasCommercialTerms,
    parseTerm,
    validateTerm,
    type CommercialTermKey,
    type CommercialTermsValues,
} from "@/queries/consumption";
import type { SavedCommercialTerms } from "@/services/commercial-terms.service";
import { SMALL } from "./data";

const FIELDS: readonly { key: CommercialTermKey; label: string; hint: string; unit: "rate" | "credits" }[] = [
    {
        key: "creditRate",
        label: "Pay-as-you-go rate",
        hint: "$ per credit, for Cowork, Work IQ and Copilot Studio",
        unit: "rate",
    },
    { key: "prepaidCreditRate", label: "Prepaid rate", hint: "$ per Capacity Pack credit", unit: "rate" },
    {
        key: "prepaidCreditBalance",
        label: "Capacity Pack balance",
        hint: "Credits Cowork uses before it pays as it goes",
        unit: "credits",
    },
];

function formatTerm(value: number | undefined, unit: "rate" | "credits"): string {
    if (value === undefined) return "not set";
    return unit === "rate"
        ? `$${value.toLocaleString("en-US", { minimumFractionDigits: 4, maximumFractionDigits: 6 })}`
        : `${value.toLocaleString("en-US", { maximumFractionDigits: 0 })} credits`;
}

function formatChanged(saved: SavedCommercialTerms): string | undefined {
    if (!saved.updatedAt) return undefined;
    const when = saved.updatedAt.toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
    return saved.updatedBy ? `Last changed by ${saved.updatedBy} on ${when}.` : `Last changed on ${when}.`;
}

type Draft = Record<CommercialTermKey, string>;

function toDraft(saved: SavedCommercialTerms | null): Draft {
    const text = (value: number | undefined) => (value === undefined ? "" : String(value));
    return {
        creditRate: text(saved?.creditRate),
        prepaidCreditRate: text(saved?.prepaidCreditRate),
        prepaidCreditBalance: text(saved?.prepaidCreditBalance),
    };
}

const INPUT =
    "h-[32px] w-full rounded-md border border-input bg-card px-200 text-[length:var(--text-300)] text-foreground tabular-nums placeholder:text-muted-foreground/70 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ring disabled:cursor-not-allowed disabled:opacity-60 aria-[invalid=true]:border-destructive";
const PRIMARY =
    "h-[32px] rounded-md bg-primary px-300 text-[length:var(--text-300)] font-semibold text-primary-foreground transition-opacity hover:opacity-90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:cursor-not-allowed disabled:opacity-50";
const SECONDARY =
    "h-[32px] rounded-md border border-border px-300 text-[length:var(--text-300)] font-semibold text-foreground transition-colors hover:bg-secondary focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:cursor-not-allowed disabled:opacity-50";

function TermsForm({ close }: { close: () => void }) {
    const { status, unavailableReason, saved, model, save } = useCommercialTerms();
    const [draft, setDraft] = useState<Draft>(() => toDraft(saved));
    const [touched, setTouched] = useState(false);
    const [saving, setSaving] = useState(false);
    const [saveError, setSaveError] = useState<string>();
    const formRef = useRef<HTMLFormElement>(null);
    const baseId = useId();

    // Each time the panel opens it starts from what is saved, not from an abandoned edit.
    useEffect(() => {
        const panel = formRef.current?.closest("[popover]");
        if (!panel) return;
        const onToggle = (event: Event) => {
            if ((event as ToggleEvent).newState !== "open") return;
            setDraft(toDraft(saved));
            setTouched(false);
            setSaveError(undefined);
        };
        panel.addEventListener("toggle", onToggle);
        return () => panel.removeEventListener("toggle", onToggle);
    }, [saved]);

    const values: CommercialTermsValues = {};
    const errors: Partial<Record<CommercialTermKey, string>> = {};
    for (const field of FIELDS) {
        const value = parseTerm(draft[field.key]);
        const error = validateTerm(field.key, value);
        if (error) errors[field.key] = error;
        else values[field.key] = value;
    }
    const valid = Object.keys(errors).length === 0;
    const editable = status === "ready";

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

    const changed = saved ? formatChanged(saved) : undefined;

    return (
        <form ref={formRef} noValidate onSubmit={onSubmit} className="flex flex-col gap-300">
            <p className={cn(SMALL, "text-muted-foreground")}>
                Every cost on this page is worked out at these prices. Leave a box empty to use the model's.
            </p>

            {status === "unavailable" && (
                <p role="status" className={cn(SMALL, "rounded-md bg-secondary px-200 py-200-nudge text-foreground")}>
                    Rates can't be saved here right now, so costs use the model's. {unavailableReason}
                </p>
            )}

            {FIELDS.map((field) => {
                const id = `${baseId}-${field.key}`;
                const error = touched ? errors[field.key] : undefined;
                const modelValue = model?.[field.key];
                return (
                    <div key={field.key} className="flex flex-col gap-100">
                        <label htmlFor={id} className={cn(SMALL, "font-semibold text-foreground")}>
                            {field.label}
                        </label>
                        <input
                            id={id}
                            type="text"
                            inputMode={field.unit === "rate" ? "decimal" : "numeric"}
                            autoComplete="off"
                            spellCheck={false}
                            data-autofocus={field.key === "creditRate" || undefined}
                            value={draft[field.key]}
                            placeholder={modelValue === undefined ? "" : String(modelValue)}
                            disabled={!editable || saving}
                            aria-invalid={error ? true : undefined}
                            aria-describedby={`${id}-hint${error ? ` ${id}-error` : ""}`}
                            onChange={(event) => setDraft((current) => ({ ...current, [field.key]: event.target.value }))}
                            onBlur={() => setTouched(true)}
                            className={INPUT}
                        />
                        <span id={`${id}-hint`} className={cn(SMALL, "text-muted-foreground")}>
                            {field.hint}. Model: {formatTerm(modelValue, field.unit)}
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
                <button
                    type="button"
                    disabled={!editable || saving || !hasCommercialTerms(saved ?? undefined)}
                    onClick={() => void commit({})}
                    className={SECONDARY}
                >
                    Use model values
                </button>
            </div>

            <p className={cn(SMALL, "text-muted-foreground")}>
                {changed && <>{changed} </>}
                Anyone who can open this app can change these. The Power BI report keeps the model's.
            </p>
        </form>
    );
}

/**
 * The rates and pack balance every cost on the Consumption page is priced
 * at, with a form to set them for everyone who opens the app. Sits where the
 * filter bar does on the other destinations.
 */
export function RatesBar() {
    const { status, saved, model } = useCommercialTerms();
    const overridden = hasCommercialTerms(saved ?? undefined);
    const summary = status === "loading" ? "Loading…" : overridden ? "Set in this app" : "From the model";

    const inUse = FIELDS.map((field) => {
        const own = saved?.[field.key];
        return { ...field, value: own ?? model?.[field.key], own: own !== undefined };
    });
    const known = status !== "loading" && inUse.some((term) => term.value !== undefined);

    return (
        <div
            role="group"
            aria-label="Rates and packs"
            className="sticky top-0 z-10 -mx-700 -mb-200 flex flex-wrap items-center gap-x-400 gap-y-200 border-b border-border bg-background px-700 py-300"
        >
            <FilterMenu label="Rates & packs" summary={summary} active={overridden} panelClassName="w-[320px]">
                {(close) => <TermsForm close={close} />}
            </FilterMenu>
            {known && (
                <dl className={cn(SMALL, "flex flex-wrap items-baseline gap-x-400 gap-y-100 text-muted-foreground")}>
                    {inUse.map((term) => (
                        <div key={term.key} className="flex items-baseline gap-100">
                            <dt>{term.label}</dt>
                            <dd className={cn("tabular-nums", term.own ? "font-semibold text-foreground" : undefined)}>
                                {formatTerm(term.value, term.unit)}
                            </dd>
                        </div>
                    ))}
                </dl>
            )}
            {status === "unavailable" && (
                <span className={cn(SMALL, "text-muted-foreground")}>Saved rates unavailable, so the model's apply.</span>
            )}
        </div>
    );
}
