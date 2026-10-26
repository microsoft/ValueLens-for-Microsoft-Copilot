//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import * as teams from "@microsoft/teams-js";

let initialised: Promise<void> | undefined;

/** Whether this is the tab's `?host=teams` URL, which the tab and its sign-in pop-up load in every host. */
export function isTeamsTabUrl(search = window.location.search): boolean {
    return new URLSearchParams(search).get("host") === "teams";
}

/** Initialises TeamsJS once per page, so the check at load and the sign-in pop-up share one call. */
export function initialiseTeams(): Promise<void> {
    initialised ??= teams.app.initialize();
    return initialised;
}

/**
 * Whether a TeamsJS host (Teams, Outlook or the Microsoft 365 app) answered. getAuthToken only works once one has,
 * so the query can't stand in for it. Only the tab URL asks: TeamsJS takes any opener for a host, so a browser
 * window another app opened would wait out its minute-long timeout. That minute is the only cap, so a slow host
 * never drops the tab to browser sign-in.
 */
export async function detectTeamsHost(search = window.location.search): Promise<boolean> {
    if (!isTeamsTabUrl(search)) return false;
    try {
        await initialiseTeams();
        return true;
    } catch {
        return false;
    }
}

/** Forgets the initialise. For tests. */
export function resetTeamsHost(): void {
    initialised = undefined;
}
