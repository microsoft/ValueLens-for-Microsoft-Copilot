//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------
import { useCallback, useEffect, useId, useState, type FormEvent } from "react";
import { Check, X } from "lucide-react";
import {
    addDelegation,
    approveDelegation,
    loadDelegations,
    removeDelegation,
    type Delegation,
    type DelegationState,
    type RefreshNotice,
} from "@/lib/access-api";
import { adminOnlyCopy } from "@/lib/access";
import { describeScope } from "@/lib/access-scope";
import { cn } from "@/lib/utils";

const TEXT = "text-[length:var(--text-200)] leading-200";
const SMALL = "text-[length:var(--text-100)] leading-100 text-muted-foreground";
const FIELD = cn(TEXT, "min-w-0 rounded-md border border-border bg-background px-200 py-100");
const BUTTON = "flex items-center justify-center gap-200 rounded-md border border-border px-300 py-100 transition-colors hover:bg-secondary focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:cursor-not-allowed disabled:opacity-60";
const ICON_BUTTON = "rounded-md p-100 text-muted-foreground hover:bg-secondary hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:opacity-60";

type Enabled = Extract<DelegationState, { enabled: true }>;

/**
 * Scoped delegation on Azure, when org-scoped access is on. Admins give anyone the people below a
 * person, or an org, and can let them share. Leaders who were allowed to share give their own org.
 * Nobody gives "everyone" here: that's the installer's job.
 */
export function ScopedDelegation({ contact }: { contact?: string }) {
    const [state, setState] = useState<Enabled | null>(null);
    const [loaded, setLoaded] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [notice, setNotice] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);

    const reload = useCallback(async () => {
        const value = await loadDelegations();
        setState(value.enabled ? value : null);
        setLoaded(true);
    }, []);

    useEffect(() => {
        let cancelled = false;
        loadDelegations()
            .then((value) => {
                if (cancelled) return;
                setState(value.enabled ? value : null);
                setLoaded(true);
            })
            .catch((err: unknown) => !cancelled && setError(err instanceof Error ? err.message : String(err)));
        return () => {
            cancelled = true;
        };
    }, []);

    const run = async (work: () => Promise<{ refresh?: RefreshNotice } | undefined>, done?: string): Promise<boolean> => {
        setBusy(true);
        setError(null);
        setNotice(null);
        try {
            const result = await work();
            setNotice([done, result?.refresh?.message].filter(Boolean).join(" ") || null);
            await reload();
            return true;
        } catch (err) {
            setError(err instanceof Error ? err.message : String(err));
            return false;
        } finally {
            setBusy(false);
        }
    };

    if (!loaded) return error ? <p role="alert" className={cn(TEXT, "text-destructive")}>{error}</p> : null;
    if (!state) return null;
    if (!state.me.canDelegate) return <p className={cn(TEXT, "text-muted-foreground")}>{adminOnlyCopy(contact)}</p>;

    const { me } = state;
    return (
        <section aria-label="What people see" className="flex flex-col gap-200 border-t border-border pt-300">
            <p className={cn(TEXT, "font-semibold")}>What people see</p>
            <p className={cn(TEXT, "text-muted-foreground")}>
                {me.isAdmin
                    ? "Give someone the data for the people below a person, or for an org."
                    : "Give someone the data for your org: the people below you."}
            </p>
            <AddDelegation
                isAdmin={me.isAdmin}
                orgAttribute={state.orgAttribute}
                busy={busy}
                onAdd={(input) =>
                    run(async () => {
                        const result = await addDelegation(input);
                        return result.delegation.status === "active"
                            ? result
                            : { refresh: { status: "queued", message: `${input.upn} is waiting for an admin to add them to the viewer group.` } };
                    }, "Added.")
                }
            />
            {error && <p role="alert" className={cn(TEXT, "text-destructive")}>{error}</p>}
            {notice && <p role="status" className={cn(TEXT, "text-muted-foreground")}>{notice}</p>}
            {me.isAdmin && state.pending.length > 0 && (
                <DelegationList
                    label="Waiting for an admin"
                    items={state.pending}
                    showGrantedBy
                    busy={busy}
                    onApprove={(d) => void run(() => approveDelegation(d.id), `Approved ${d.upn}.`)}
                    onRemove={(d) => void run(() => removeDelegation(d.id), `Removed ${d.upn}.`)}
                />
            )}
            {state.delegations.length > 0 ? (
                <DelegationList
                    label={me.isAdmin ? "Given here" : "Given by you"}
                    items={state.delegations}
                    showGrantedBy={me.isAdmin}
                    busy={busy}
                    onRemove={(d) => void run(() => removeDelegation(d.id), `Removed ${d.upn}.`)}
                />
            ) : (
                <p className={SMALL}>{me.isAdmin ? "No one has been given a scope here yet." : "You haven't given anyone your org yet."}</p>
            )}
            <p className={SMALL}>Changes reach Power BI after a refresh, usually within a few minutes.</p>
        </section>
    );
}

function AddDelegation({
    isAdmin,
    orgAttribute,
    busy,
    onAdd,
}: {
    isAdmin: boolean;
    orgAttribute: string;
    busy: boolean;
    onAdd: (input: { upn: string; scope: { type: "hierarchy" | "org"; value?: string }; note?: string; canDelegate?: boolean }) => Promise<boolean>;
}) {
    const [upn, setUpn] = useState("");
    const [type, setType] = useState<"hierarchy" | "org">("hierarchy");
    const [value, setValue] = useState("");
    const [note, setNote] = useState("");
    const [canDelegate, setCanDelegate] = useState(false);
    const ids = { upn: useId(), type: useId(), value: useId(), note: useId(), share: useId() };
    const ready = !!upn.trim() && (!isAdmin || !!value.trim());

    const submit = (event: FormEvent) => {
        event.preventDefault();
        if (!ready) return;
        void onAdd({
            upn: upn.trim(),
            scope: isAdmin ? { type, value: value.trim() } : { type: "hierarchy" },
            ...(note.trim() ? { note: note.trim() } : {}),
            ...(isAdmin && canDelegate ? { canDelegate: true } : {}),
        }).then((added) => {
            if (!added) return;
            setUpn("");
            setValue("");
            setNote("");
            setCanDelegate(false);
        });
    };

    return (
        <form onSubmit={submit} className="flex flex-col gap-100">
            <label htmlFor={ids.upn} className={cn(TEXT, "text-muted-foreground")}>Person's work email</label>
            <input id={ids.upn} type="email" value={upn} onChange={(e) => setUpn(e.target.value)} disabled={busy} autoComplete="off" className={FIELD} />
            {isAdmin ? (
                <>
                    <label htmlFor={ids.type} className={cn(TEXT, "text-muted-foreground")}>What they see</label>
                    <select id={ids.type} value={type} onChange={(e) => setType(e.target.value as "hierarchy" | "org")} disabled={busy} className={FIELD}>
                        <option value="hierarchy">People below a person</option>
                        <option value="org">An org</option>
                    </select>
                    <label htmlFor={ids.value} className={cn(TEXT, "text-muted-foreground")}>
                        {type === "hierarchy" ? "Email of the person at the top" : `Org name (${orgAttribute})`}
                    </label>
                    <input id={ids.value} value={value} onChange={(e) => setValue(e.target.value)} disabled={busy} autoComplete="off" className={FIELD} />
                    <label htmlFor={ids.share} className={cn(TEXT, "flex items-center gap-100")}>
                        <input id={ids.share} type="checkbox" checked={canDelegate} onChange={(e) => setCanDelegate(e.target.checked)} disabled={busy} />
                        Can share their org
                    </label>
                </>
            ) : (
                <p className={SMALL}>They'll see the people below you.</p>
            )}
            <label htmlFor={ids.note} className={cn(TEXT, "text-muted-foreground")}>Note (optional)</label>
            <input id={ids.note} value={note} maxLength={400} onChange={(e) => setNote(e.target.value)} disabled={busy} autoComplete="off" className={FIELD} />
            <button type="submit" disabled={busy || !ready} className={cn(BUTTON, TEXT)}>
                Give access
            </button>
        </form>
    );
}

function DelegationList({
    label,
    items,
    showGrantedBy,
    busy,
    onApprove,
    onRemove,
}: {
    label: string;
    items: Delegation[];
    showGrantedBy: boolean;
    busy: boolean;
    onApprove?: (d: Delegation) => void;
    onRemove: (d: Delegation) => void;
}) {
    return (
        <div className="flex flex-col gap-100">
            <p className={cn(TEXT, "font-semibold")}>{label}</p>
            <ul aria-label={label} className="flex max-h-[240px] flex-col gap-100 overflow-y-auto">
                {items.map((d) => (
                    <li key={d.id} className="flex items-center justify-between gap-200">
                        <span className="flex min-w-0 flex-col">
                            <span className={cn(TEXT, "truncate")}>{d.upn}</span>
                            <span className={cn(SMALL, "truncate")}>
                                Sees {describeScope(d.scope)}
                                {d.canDelegate ? " · can share" : ""}
                                {showGrantedBy && d.grantedBy ? ` · added by ${d.grantedBy}` : ""}
                            </span>
                            {d.status === "pending_group" && !onApprove && <span className={cn(SMALL, "font-semibold")}>Waiting for an admin</span>}
                            {d.note && <span className={cn(SMALL, "truncate")}>{d.note}</span>}
                        </span>
                        <span className="flex shrink-0 items-center gap-100">
                            {onApprove && (
                                <button type="button" onClick={() => onApprove(d)} disabled={busy} aria-label={`Approve ${d.upn}`} className={ICON_BUTTON}>
                                    <Check className="icon-size-200" aria-hidden="true" />
                                </button>
                            )}
                            <button type="button" onClick={() => onRemove(d)} disabled={busy} aria-label={`Remove ${d.upn}'s scope`} className={ICON_BUTTON}>
                                <X className="icon-size-200" aria-hidden="true" />
                            </button>
                        </span>
                    </li>
                ))}
            </ul>
        </div>
    );
}
