//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import { createRef, forwardRef, useEffect, useImperativeHandle } from "react";
import { render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { DataTable } from "@microsoft/fabric-visuals-core";

const { mounts } = vi.hoisted(() => ({ mounts: { count: 0 } }));

vi.mock("@microsoft/fabric-visuals", async () => {
    const Stub = forwardRef<{ id: string }, { data: DataTable }>(function Stub({ data }, ref) {
        useImperativeHandle(ref, () => ({ id: "handle" }));
        useEffect(() => {
            mounts.count += 1;
        }, []);
        return <div data-testid="vega">{data.rows.map((row) => row[0]).join(",")}</div>;
    });
    return { VegaVisual: Stub };
});
vi.mock("@microsoft/fabric-visuals/embeddable", async () => ({
    EmbeddableVegaVisual: (await import("@microsoft/fabric-visuals")).VegaVisual,
}));

const { VegaVisual } = await import("./vega-visual");
const { rowCountKey } = await import("@/lib/chart-height");

function table(labels: string[]): DataTable {
    return { columns: [{ name: "Label" }, { name: "Value" }], rows: labels.map((label, i) => [label, i]) };
}

describe("rowCountKey", () => {
    it("keys a table on its row count", () => {
        expect(rowCountKey(table(["a", "b", "c"]))).toBe(3);
        expect(rowCountKey(table([]))).toBe(0);
    });

    it("has no key for data that isn't a table", () => {
        expect(rowCountKey(undefined)).toBeUndefined();
        expect(rowCountKey(null)).toBeUndefined();
        expect(rowCountKey({ values: [] })).toBeUndefined();
    });
});

describe("VegaVisual", () => {
    const props = { spec: {} as never, theme: {} as never };

    it("redraws from scratch when the row count changes", () => {
        mounts.count = 0;
        const view = render(<VegaVisual data={table(["a", "b", "c"])} {...props} />);
        expect(mounts.count).toBe(1);

        view.rerender(<VegaVisual data={table(["x", "y", "z"])} {...props} />);
        expect(mounts.count).toBe(1);

        view.rerender(<VegaVisual data={table(["x"])} {...props} />);
        expect(mounts.count).toBe(2);
        expect(view.getByTestId("vega").textContent).toBe("x");
    });

    it("still hands its ref to the chart", () => {
        const ref = createRef<{ id: string }>();
        render(<VegaVisual ref={ref as never} data={table(["a"])} {...props} />);
        expect(ref.current).toEqual({ id: "handle" });
    });
});
