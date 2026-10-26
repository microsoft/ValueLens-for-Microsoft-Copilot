//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import { ShieldCheck } from "lucide-react";
import { scopeRequestMailto } from "@/lib/access";
import { describeScope, scopeSummary, type AccessScopeState } from "@/lib/access-scope";
import { runtimeConfig } from "@/lib/runtime-config";
import { BODY, SMALL } from "@/lib/type-scale";

/** "Showing: people below avery@example.com", under the page title. Nothing when org-scoped access is off. */
export function AccessScopeChip({ state }: { state: AccessScopeState }) {
    const text = scopeSummary(state);
    if (!text) return null;
    const title =
        state.kind === "bypass"
            ? "Your role in the workspace shows you every org, whatever scope you've been given."
            : state.kind === "scoped" && state.isDefault
              ? "You haven't been given a scope of your own, so you see what everyone sees by default."
              : state.kind === "scoped"
                ? `Your scopes: ${state.scopes.map(describeScope).join("; ")}`
                : undefined;
    return (
        <span className={`${SMALL} inline-flex items-center gap-100 text-muted-foreground`} title={title}>
            <ShieldCheck className="icon-size-100 shrink-0" aria-hidden="true" />
            {text}
        </span>
    );
}

/** Shown in place of the pages when org-scoped access is on and the person has no scope yet. */
export function NoScopeNotice() {
    const access = runtimeConfig().access;
    const mailto = scopeRequestMailto(access);
    const contact = access?.contact;
    return (
        <section
            role="status"
            aria-labelledby="no-scope-title"
            className="flex max-w-[640px] flex-col gap-300 rounded-lg border border-border bg-card p-600"
        >
            <h2 id="no-scope-title" className="text-[length:var(--text-500)] leading-500 font-semibold">
                You don't have a scope yet
            </h2>
            <p className={`${BODY} text-muted-foreground`}>
                The app only shows each person the orgs they've been given. Nobody has chosen what you can see yet, so
                every page would be empty.
            </p>
            <p className={BODY}>
                {contact && mailto ? (
                    <>
                        Ask{" "}
                        <a className="underline" href={mailto}>
                            {contact}
                        </a>{" "}
                        to give you a scope.
                    </>
                ) : access?.requestUrl ? (
                    <a className="underline" href={access.requestUrl}>
                        Ask for a scope
                    </a>
                ) : (
                    "Ask an admin of the app to give you a scope."
                )}
            </p>
        </section>
    );
}
