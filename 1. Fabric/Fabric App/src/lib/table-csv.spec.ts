//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import { afterEach, describe, expect, it, vi } from "vitest";
import type { DataTable } from "@microsoft/fabric-visuals-core";
import { fileNameFor } from "./download";
import { downloadTableCsv, tableToCsv } from "./table-csv";

const table: DataTable = {
    columns: [
        { name: "Organization", displayName: "Team" },
        { name: "Active Users" },
        { name: "Note", displayName: "Note" },
    ],
    rows: [
        ["Sales, EMEA", 1200, 'Said "great"'],
        ["Finance", 0.5, "Line one\nline two"],
        [null, undefined, "=SUM(A1:A2)"],
        ["Ops", -3, "-12.5%"],
    ],
};

describe("tableToCsv", () => {
    const csv = tableToCsv(table);
    const lines = csv.slice(1).split("\r\n");

    it("starts with a byte-order mark so Excel reads it as UTF-8", () => {
        expect(csv.charCodeAt(0)).toBe(0xfeff);
    });

    it("heads each column with its display name, else its name", () => {
        expect(lines[0]).toBe("Team,Active Users,Note");
    });

    it("quotes values with commas, quotes or line breaks", () => {
        expect(lines[1]).toBe('"Sales, EMEA",1200,"Said ""great"""');
        expect(csv).toContain('Finance,0.5,"Line one\nline two"');
    });

    it("leaves blanks empty and defuses text a spreadsheet would run as a formula", () => {
        expect(csv).toContain(",,'=SUM(A1:A2)\r\n");
    });

    it("keeps signed numbers as they are", () => {
        expect(csv).toContain("Ops,-3,-12.5%\r\n");
    });

    it("ends every line, the last included, with CRLF", () => {
        expect(csv.endsWith("\r\n")).toBe(true);
        expect(csv.replace(/\r\n/g, "")).not.toMatch(/\r/);
    });
});

describe("fileNameFor", () => {
    it("slugs the chart title", () => {
        expect(fileNameFor("Copilot Studio credits — by month", "csv")).toBe("copilot-studio-credits-by-month.csv");
        expect(fileNameFor("Café & agents", "png")).toBe("cafe-agents.png");
    });

    it("falls back to a generic name when the title has no letters", () => {
        expect(fileNameFor("—", "csv")).toBe("chart.csv");
    });
});

describe("downloadTableCsv", () => {
    afterEach(() => {
        vi.restoreAllMocks();
        vi.useRealTimers();
    });

    it("saves the CSV under the chart's title", async () => {
        vi.useFakeTimers();
        const created: Blob[] = [];
        URL.createObjectURL = vi.fn((blob: Blob) => {
            created.push(blob);
            return "blob:csv";
        });
        URL.revokeObjectURL = vi.fn();
        const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) {
            expect(this.download).toBe("monthly-trend.csv");
            expect(this.getAttribute("href")).toBe("blob:csv");
        });

        downloadTableCsv(table, "Monthly trend");

        expect(click).toHaveBeenCalledTimes(1);
        expect(created[0].type).toBe("text/csv;charset=utf-8");
        expect((await created[0].text()).replace(/^\uFEFF/, "")).toBe(tableToCsv(table).slice(1));
        expect(document.querySelector("a[download]")).toBeNull();
        vi.runAllTimers();
        expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:csv");
    });
});
