//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------
import { fabricItemUrl } from "@/lib/fabric-item-url";
import { runtimeConfig, type AccessInfo } from "@/lib/runtime-config";

/** Raised on the window when an API call says the signed-in user can't use Analytics Hub. */
export const ACCESS_DENIED_EVENT = "analytics-hub-access-denied";

/** Why the API turned the user away: `NotAViewer`, `PowerBIAccessDenied`, or unknown. */
export type AccessDeniedReason = "NotAViewer" | "PowerBIAccessDenied" | undefined;

export function reportAccessDenied(reason?: string): void {
    window.dispatchEvent(new CustomEvent(ACCESS_DENIED_EVENT, { detail: { reason } }));
}

/** The `error.code` of an API error body, if it has one. */
export function errorCode(body: string): string | undefined {
    try {
        const code = (JSON.parse(body) as { error?: { code?: unknown } })?.error?.code;
        return typeof code === "string" ? code : undefined;
    } catch {
        return undefined;
    }
}

/** The link people open the app with: the Fabric item, or this site on Azure. */
export function appLink(): string {
    if (runtimeConfig().host === "azure") return `${window.location.origin}/`;
    return fabricItemUrl() ?? window.location.href;
}

/** Where a group's members and owners can see and, as owners, manage it. */
export function myGroupsUrl(groupId: string): string {
    return `https://myaccount.microsoft.com/groups/${encodeURIComponent(groupId)}`;
}

/** A prefilled email asking the install's contact for access. */
export function accessRequestMailto(access: AccessInfo | undefined, link = appLink()): string | null {
    if (!access?.contact) return null;
    const group = access.groupName ? ` (${access.groupName})` : "";
    const subject = "Access to Analytics Hub";
    const body = `Hi,\n\nPlease add me to the Analytics Hub viewers${group} so I can open ${link}\n\nThanks`;
    return `mailto:${encodeURIComponent(access.contact)}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
}
