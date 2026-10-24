//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { onlyStages, pageStages, StageFilterContext, type StageFilter } from "@/hooks/stage-filter.context";
import { OnDemand } from "./on-demand";

function renderList(id: string, filter?: StageFilter) {
    const list = (
        <OnDemand id={id} label="Show the ranking" note="Every person, ranked by sessions.">
            <p>The ranking</p>
        </OnDemand>
    );
    return render(filter ? <StageFilterContext.Provider value={filter}>{list}</StageFilterContext.Provider> : list);
}

afterEach(cleanup);

describe("OnDemand", () => {
    it("holds the list back on a live page until asked", () => {
        renderList("held", pageStages("leaderboard"));
        expect(screen.queryByText("The ranking")).toBeNull();
        expect(screen.getByText("Every person, ranked by sessions.")).toBeTruthy();
        fireEvent.click(screen.getByRole("button", { name: "Show the ranking" }));
        expect(screen.getByText("The ranking")).toBeTruthy();
        expect(screen.queryByRole("button")).toBeNull();
    });

    it("remembers an opened list for the rest of the session", () => {
        renderList("remembered", pageStages("leaderboard"));
        fireEvent.click(screen.getByRole("button", { name: "Show the ranking" }));
        cleanup();
        renderList("remembered", pageStages("leaderboard"));
        expect(screen.getByText("The ranking")).toBeTruthy();
        cleanup();
        renderList("another", pageStages("leaderboard"));
        expect(screen.queryByText("The ranking")).toBeNull();
    });

    it("shows the list at once in a download, a report pack or outside a page", () => {
        for (const filter of [pageStages("all"), onlyStages(["leaderboard"]), undefined]) {
            renderList("printed", filter);
            expect(screen.getByText("The ranking")).toBeTruthy();
            cleanup();
        }
    });
});
