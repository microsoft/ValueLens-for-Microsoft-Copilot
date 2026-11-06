//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { ArrowDown, ArrowUp, X } from "lucide-react";
import { MAX_PACK_DESCRIPTION, MAX_PACK_NAME, stageLabel, type ReportPack } from "@/lib/report-pack";
import { SMALL } from "@/lib/type-scale";
import { cn } from "@/lib/utils";
import { ACTION_BUTTON } from "@/lib/action-button";
import { isPackable, type Destination, type StageId } from "./destinations";

interface ReportPackEditorProps {
    /** The pack to edit; a new one has no name or stages yet. */
    pack: ReportPack;
    heading: string;
    /** The destinations this install has, whose stages can be picked. */
    available: readonly Destination[];
    onSave: (pack: ReportPack) => Promise<void>;
    onClose: () => void;
}

const FIELD = cn(
    "rounded-md border border-border bg-background px-300 py-200 text-[length:var(--text-300)] leading-300 text-foreground",
    "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring",
);
const ICON_BUTTON = cn(
    "flex size-[28px] items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground",
    "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:opacity-30 disabled:hover:bg-transparent",
);

function describe(error: unknown): string {
    return error instanceof Error && error.message ? error.message : String(error);
}

/**
 * Names a pack and picks its stages: tick stages from any destination, then
 * put them in reading order. Saved packs are shared with everyone who opens
 * the app.
 */
export function ReportPackEditor({ pack, heading, available, onSave, onClose }: ReportPackEditorProps) {
    const headingId = useId();
    const nameId = useId();
    const descriptionId = useId();
    const nameRef = useRef<HTMLInputElement>(null);
    const [name, setName] = useState(pack.name);
    const [description, setDescription] = useState(pack.description ?? "");
    const [stages, setStages] = useState<StageId[]>(pack.stages);
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState<string>();

    useEffect(() => nameRef.current?.focus(), []);

    useEffect(() => {
        const onKey = (event: KeyboardEvent) => {
            if (event.key === "Escape") onClose();
        };
        document.addEventListener("keydown", onKey);
        return () => document.removeEventListener("keydown", onKey);
    }, [onClose]);

    const toggle = (stage: StageId) =>
        setStages((current) => (current.includes(stage) ? current.filter((id) => id !== stage) : [...current, stage]));
    const move = (index: number, by: -1 | 1) =>
        setStages((current) => {
            const next = [...current];
            [next[index], next[index + by]] = [next[index + by], next[index]];
            return next;
        });

    const trimmed = name.trim();
    const canSave = trimmed.length > 0 && stages.length > 0 && !saving;

    const submit = async (event: FormEvent) => {
        event.preventDefault();
        if (!canSave) return;
        setSaving(true);
        setError(undefined);
        try {
            await onSave({ ...pack, name: trimmed, description: description.trim() || undefined, stages, builtIn: undefined });
        } catch (failure) {
            setError(describe(failure));
            setSaving(false);
        }
    };

    return (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-500" data-print="hide">
            <form
                role="dialog"
                aria-modal="true"
                aria-labelledby={headingId}
                onSubmit={submit}
                className="flex max-h-full w-full max-w-[880px] flex-col overflow-hidden rounded-xl border border-border bg-card text-foreground shadow-16"
            >
                <div className="flex items-center justify-between gap-300 border-b border-border px-500 py-400">
                    <h2 id={headingId} className="text-[length:var(--text-400)] leading-400 font-semibold">
                        {heading}
                    </h2>
                    <button type="button" className={ICON_BUTTON} onClick={onClose} aria-label="Close">
                        <X className="icon-size-200" aria-hidden="true" />
                    </button>
                </div>

                <div className="grid min-h-0 flex-1 gap-500 overflow-y-auto px-500 py-400 md:grid-cols-2">
                    <div className="flex flex-col gap-400">
                        <div className="flex flex-col gap-100">
                            <label htmlFor={nameId} className={cn(SMALL, "font-semibold")}>
                                Name
                            </label>
                            <input
                                ref={nameRef}
                                id={nameId}
                                className={FIELD}
                                value={name}
                                maxLength={MAX_PACK_NAME}
                                required
                                onChange={(event) => setName(event.target.value)}
                            />
                        </div>
                        <div className="flex flex-col gap-100">
                            <label htmlFor={descriptionId} className={cn(SMALL, "font-semibold")}>
                                Description <span className="font-normal text-muted-foreground">(optional)</span>
                            </label>
                            <textarea
                                id={descriptionId}
                                className={cn(FIELD, "min-h-[64px] resize-y")}
                                value={description}
                                maxLength={MAX_PACK_DESCRIPTION}
                                onChange={(event) => setDescription(event.target.value)}
                            />
                        </div>
                        <div className="flex flex-col gap-200">
                            <span className={cn(SMALL, "font-semibold")}>In this pack, in order</span>
                            {stages.length === 0 ? (
                                <p className={cn(SMALL, "text-muted-foreground")}>Tick the stages to include.</p>
                            ) : (
                                <ol aria-label="Stages in this pack" className="flex flex-col divide-y divide-border rounded-lg border border-border">
                                    {stages.map((stage, index) => {
                                        const label = stageLabel(stage);
                                        return (
                                            <li key={stage} className="flex items-center gap-200 py-100 pr-100 pl-300">
                                                <span className="flex-1 text-[length:var(--text-300)] leading-300">{label}</span>
                                                <button
                                                    type="button"
                                                    className={ICON_BUTTON}
                                                    disabled={index === 0}
                                                    onClick={() => move(index, -1)}
                                                    aria-label={`Move ${label} up`}
                                                >
                                                    <ArrowUp className="icon-size-100" aria-hidden="true" />
                                                </button>
                                                <button
                                                    type="button"
                                                    className={ICON_BUTTON}
                                                    disabled={index === stages.length - 1}
                                                    onClick={() => move(index, 1)}
                                                    aria-label={`Move ${label} down`}
                                                >
                                                    <ArrowDown className="icon-size-100" aria-hidden="true" />
                                                </button>
                                                <button
                                                    type="button"
                                                    className={ICON_BUTTON}
                                                    onClick={() => toggle(stage)}
                                                    aria-label={`Remove ${label}`}
                                                >
                                                    <X className="icon-size-100" aria-hidden="true" />
                                                </button>
                                            </li>
                                        );
                                    })}
                                </ol>
                            )}
                        </div>
                    </div>

                    <div className="flex flex-col gap-300">
                        <span className={cn(SMALL, "font-semibold")}>Stages</span>
                        {available.filter(isPackable).map((destination) => {
                            const ready = destination.stages.filter((stage) => stage.ready);
                            if (ready.length === 0) return null;
                            return (
                                <fieldset key={destination.id} className="flex flex-col gap-100">
                                    <legend className={cn(SMALL, "mb-100 text-muted-foreground")}>{destination.label}</legend>
                                    {ready.map((stage) => (
                                        <label
                                            key={stage.id}
                                            className="flex items-center gap-200 text-[length:var(--text-300)] leading-300"
                                        >
                                            <input
                                                type="checkbox"
                                                className="size-[16px] accent-[var(--color-brand)]"
                                                checked={stages.includes(stage.id)}
                                                onChange={() => toggle(stage.id)}
                                            />
                                            {stage.label}
                                        </label>
                                    ))}
                                </fieldset>
                            );
                        })}
                    </div>
                </div>

                <div className="flex flex-wrap items-center justify-end gap-300 border-t border-border px-500 py-300">
                    {error && (
                        <p role="alert" className={cn(SMALL, "mr-auto text-destructive")}>
                            {error}
                        </p>
                    )}
                    <button type="button" className={ACTION_BUTTON} onClick={onClose}>
                        Cancel
                    </button>
                    <button
                        type="submit"
                        disabled={!canSave}
                        className={cn(ACTION_BUTTON, "border-primary bg-primary text-primary-foreground hover:bg-primary/90 disabled:hover:bg-primary")}
                    >
                        {saving ? "Saving…" : "Save pack"}
                    </button>
                </div>
            </form>
        </div>
    );
}
