//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------
import { describe, expect, it } from "vitest";
import { destinations, isPackable, isReference, openStage } from "./destinations";
import { PREFETCH_AHEAD, prefetchTargets } from "./prefetch-targets";

const key = ({ id, stage }: { id: string; stage: string }) => `${id}/${stage}`;
const all = Number.POSITIVE_INFINITY;

describe("prefetchTargets", () => {
    it("fetches only the next two tabs by default", () => {
        expect(PREFETCH_AHEAD).toBe(2);
        expect(prefetchTargets(destinations, "executive", "the-bottom-line").map(key)).toEqual([
            "adoption/adoption",
            "value/task-breakdown",
        ]);
    });

    it("starts after the page on screen and wraps round, then the open page's other tabs", () => {
        const targets = prefetchTargets(destinations, "adoption", "adoption", all).map(key);
        const at = destinations.findIndex((destination) => destination.id === "adoption");
        const others = [...destinations.slice(at + 1), ...destinations.slice(0, at)]
            .filter((destination) => !isReference(destination) && isPackable(destination))
            .map((destination) => `${destination.id}/${openStage(destination)}`);
        const tabs = destinations[at].stages
            .filter((stage) => stage.ready && stage.id !== "adoption")
            .map((stage) => `adoption/${stage.id}`);
        expect(targets).toEqual([...others, ...tabs]);
        expect(targets[0]).toBe("value/task-breakdown");
        expect(targets).toContain("executive/the-bottom-line");
    });

    it("from the executive summary, lists every other page in menu order, then its own tabs", () => {
        expect(prefetchTargets(destinations, "executive", "the-bottom-line", all).map(key)).toEqual([
            "adoption/adoption",
            "value/task-breakdown",
            "consumption/consumption-overview",
            "efficiency/cowork-fit",
            "leaderboards/leaderboard",
            "work-patterns/m365-activity",
            "readiness/license-readiness",
            "governance/estate-health",
            "feedback/feedback",
            "executive/is-it-growing",
            "executive/where-it-is-landing",
            "executive/what-needs-attention",
        ]);
    });

    it("leaves out reference pages, Ask and the tab on screen", () => {
        const targets = prefetchTargets(destinations, "executive", "the-bottom-line", all);
        const ids = targets.map((target) => target.id);
        expect(ids).not.toContain("assumptions");
        expect(ids).not.toContain("appendix");
        expect(ids).not.toContain("ask");
        expect(targets.map(key)).not.toContain("executive/the-bottom-line");
    });

    it("only fetches pages the install has, and fills spare places with the open page's tabs", () => {
        const available = destinations.filter((destination) => ["executive", "adoption"].includes(destination.id));
        expect(prefetchTargets(available, "executive", "the-bottom-line").map(key)).toEqual([
            "adoption/adoption",
            "executive/is-it-growing",
        ]);
    });

    it("fetches the first pages' first tabs while a report pack is open", () => {
        const ids = prefetchTargets(destinations, undefined, undefined).map((target) => target.id);
        expect(ids).toEqual(["executive", "adoption"]);
        const every = prefetchTargets(destinations, undefined, undefined, all).map((target) => target.id);
        expect(new Set(every).size).toBe(every.length);
    });

    it("fetches nothing when the limit is zero", () => {
        expect(prefetchTargets(destinations, "executive", "the-bottom-line", 0)).toEqual([]);
    });
});
