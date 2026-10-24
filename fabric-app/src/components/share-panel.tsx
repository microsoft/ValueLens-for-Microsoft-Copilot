//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------
import { useEffect, useId, useState, type FormEvent } from "react";
import { Check, Copy, Share2, X } from "lucide-react";
import { adminOnlyCopy, appLink, myGroupsUrl } from "@/lib/access";
import { fabricItemUrl } from "@/lib/fabric-item-url";
import { addViewer, loadAccess, removeViewer, type AccessPrincipal, type AccessState } from "@/lib/access-api";
import { runtimeConfig, type AccessInfo } from "@/lib/runtime-config";
import { ScopedDelegation } from "@/components/share-delegations";
import { BandPopover } from "@/components/band-popover";
import { cn } from "@/lib/utils";

const TEXT = "text-[length:var(--text-200)] leading-200";
const LINK = cn(TEXT, "text-primary underline underline-offset-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring");
const BUTTON = "flex items-center justify-center gap-200 rounded-md border border-border px-300 py-100 transition-colors hover:bg-secondary focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:cursor-not-allowed disabled:opacity-60";

/**
 * Sharing from inside the app: copy its link, see who it is shared with, and on Azure let admins
 * and owners of the viewer group add and remove people. Fabric has no API the app can call for
 * this, so there it points to the group in My Groups.
 *
 * With org-scoped access on, Azure also lets admins and leaders choose what people see. On Fabric
 * that stays with admins, through the installer.
 */
export function SharePanel() {
    const config = runtimeConfig();

    return (
        <BandPopover label="Share" icon={Share2}>
            {() => (
                <section aria-label="Share the app" className="flex flex-col gap-300">
                    <CopyLink />
                    {config.host === "azure" ? <AzureAccess access={config.access} /> : <FabricAccess access={config.access} />}
                    {config.host === "azure" && config.access?.rlsOrgAttribute && <ScopedDelegation contact={config.access.contact} />}
                </section>
            )}
        </BandPopover>
    );
}

function CopyLink() {
    const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
    const link = appLink();

    const copy = async () => {
        try {
            await navigator.clipboard.writeText(link);
            setState("copied");
        } catch {
            setState("failed");
        }
    };

    return (
        <div className="flex flex-col gap-100">
            <button type="button" onClick={copy} className={cn(BUTTON, TEXT)}>
                {state === "copied" ? <Check className="icon-size-200" aria-hidden="true" /> : <Copy className="icon-size-200" aria-hidden="true" />}
                {state === "copied" ? "Link copied" : "Copy app link"}
            </button>
            {state === "failed" && (
                <input
                    readOnly
                    value={link}
                    aria-label="App link"
                    onFocus={(event) => event.currentTarget.select()}
                    className={cn(TEXT, "w-full rounded-md border border-border bg-background px-200 py-100")}
                />
            )}
        </div>
    );
}

function FabricAccess({ access }: { access?: AccessInfo }) {
    if (!access)
        return <p className={cn(TEXT, "text-muted-foreground")}>Give people access by sharing the app item in Fabric.</p>;
    const group = access.groupName ?? "the viewer group";
    const item = fabricItemUrl();
    return (
        <div className="flex flex-col gap-100">
            <p className={cn(TEXT, "text-muted-foreground")}>
                To give someone access, add them to <span className="font-semibold text-foreground">{group}</span>.
            </p>
            <a href={myGroupsUrl(access.groupId)} target="_blank" rel="noreferrer" className={LINK}>
                Add members in My Groups
            </a>
            {access.appShared ? (
                <p className={cn(TEXT, "text-muted-foreground")}>
                    Anyone in <span className="font-semibold text-foreground">{group}</span> can open it.
                </p>
            ) : (
                <>
                    <p className={cn(TEXT, "text-muted-foreground")}>
                        The app item also has to be shared with {group} once: open it in Fabric, choose Share, enter {group} and choose Grant.
                        Until then, people in the group can't open it.
                    </p>
                    {item && (
                        <a href={item} target="_blank" rel="noreferrer" className={LINK}>
                            Open the app item in Fabric
                        </a>
                    )}
                </>
            )}
            {access.requestUrl && (
                <a href={access.requestUrl} target="_blank" rel="noreferrer" className={LINK}>
                    Where people ask for access
                </a>
            )}
            {access.contact && <p className={cn(TEXT, "text-muted-foreground")}>Access requests go to {access.contact}.</p>}
            {access.rlsOrgAttribute && <p className={cn(TEXT, "text-muted-foreground")}>{adminOnlyCopy(access.contact)}</p>}
        </div>
    );
}

function AzureAccess({ access }: { access?: AccessInfo }) {
    const [state, setState] = useState<AccessState | null>(null);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        let cancelled = false;
        loadAccess()
            .then((value) => !cancelled && setState(value))
            .catch((err: unknown) => !cancelled && setError(err instanceof Error ? err.message : String(err)));
        return () => {
            cancelled = true;
        };
    }, []);

    if (error) return <p role="alert" className={cn(TEXT, "text-destructive")}>{error}</p>;
    if (!state) return <p className={cn(TEXT, "text-muted-foreground")}>Loading who has access…</p>;
    if (!state.group)
        return <p className={cn(TEXT, "text-muted-foreground")}>People with a role for the app in Microsoft Entra can open it.</p>;

    const groupName = state.group.name || access?.groupName || "the viewer group";
    if (!state.canManage) {
        return (
            <div className="flex flex-col gap-100">
                <p className={cn(TEXT, "text-muted-foreground")}>
                    Anyone in <span className="font-semibold text-foreground">{groupName}</span> can open it.
                    {access?.contact ? ` Ask ${access.contact} to add people.` : " Ask an admin of the app to add people."}
                </p>
                <a href={myGroupsUrl(state.group.id)} target="_blank" rel="noreferrer" className={LINK}>
                    See the group in My Groups
                </a>
            </div>
        );
    }
    return <ManageViewers groupId={state.group.id} groupName={groupName} initial={state.members ?? []} />;
}

function ManageViewers({ groupId, groupName, initial }: { groupId: string; groupName: string; initial: AccessPrincipal[] }) {
    const [members, setMembers] = useState(() => sortByName(initial));
    const [name, setName] = useState("");
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const inputId = useId();

    const run = async (work: () => Promise<void>) => {
        setBusy(true);
        setError(null);
        try {
            await work();
        } catch (err) {
            setError(err instanceof Error ? err.message : String(err));
        } finally {
            setBusy(false);
        }
    };

    const add = (event: FormEvent) => {
        event.preventDefault();
        const value = name.trim();
        if (!value) return;
        void run(async () => {
            const added = await addViewer(value);
            setMembers((current) => sortByName([...current.filter((m) => m.id !== added.id), added]));
            setName("");
        });
    };

    const remove = (member: AccessPrincipal) => void run(async () => {
        await removeViewer(member.id);
        setMembers((current) => current.filter((m) => m.id !== member.id));
    });

    return (
        <div className="flex flex-col gap-200">
            <p className={cn(TEXT, "text-muted-foreground")}>
                <span className="font-semibold text-foreground">{groupName}</span> · {members.length} {members.length === 1 ? "member" : "members"}
            </p>
            <form onSubmit={add} className="flex flex-col gap-100">
                <label htmlFor={inputId} className={cn(TEXT, "text-muted-foreground")}>Add a person's email or a group's name</label>
                <div className="flex gap-100">
                    <input
                        id={inputId}
                        value={name}
                        onChange={(event) => setName(event.target.value)}
                        disabled={busy}
                        autoComplete="off"
                        className={cn(TEXT, "min-w-0 flex-1 rounded-md border border-border bg-background px-200 py-100")}
                    />
                    <button type="submit" disabled={busy || !name.trim()} className={cn(BUTTON, TEXT)}>
                        Add
                    </button>
                </div>
            </form>
            {error && <p role="alert" className={cn(TEXT, "text-destructive")}>{error}</p>}
            {members.length > 0 && (
                <ul aria-label="Viewers" className="flex max-h-[240px] flex-col gap-100 overflow-y-auto">
                    {members.map((member) => (
                        <li key={member.id} className="flex items-center justify-between gap-200">
                            <span className="flex min-w-0 flex-col">
                                <span className={cn(TEXT, "truncate")}>{member.name}</span>
                                {member.email && (
                                    <span className="truncate text-[length:var(--text-100)] leading-100 text-muted-foreground">{member.email}</span>
                                )}
                            </span>
                            <button
                                type="button"
                                onClick={() => remove(member)}
                                disabled={busy}
                                aria-label={`Remove ${member.name}`}
                                className="rounded-md p-100 text-muted-foreground hover:bg-secondary hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:opacity-60"
                            >
                                <X className="icon-size-200" aria-hidden="true" />
                            </button>
                        </li>
                    ))}
                </ul>
            )}
            <a href={myGroupsUrl(groupId)} target="_blank" rel="noreferrer" className={LINK}>
                Open the group in My Groups
            </a>
        </div>
    );
}

function sortByName(members: AccessPrincipal[]): AccessPrincipal[] {
    return [...members].sort((a, b) => a.name.localeCompare(b.name));
}
