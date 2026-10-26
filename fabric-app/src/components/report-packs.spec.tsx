//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import { act, fireEvent, render, screen, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useCssTheme } from "@microsoft/fabric-visuals";
import { Gauge } from "lucide-react";
import { ReportPacksContext, type ReportPacksContextValue } from "@/hooks/report-packs.context";
import { ThemeContext } from "@/hooks/theme.context";
import { BUILT_IN_PACKS, packRuns, stageDestination, stageLabel, type ReportPack } from "@/lib/report-pack";
import { destinations } from "./destinations";
import { ReportHeader } from "./report-header";
import { PackActions } from "./report-pack-actions";
import { ReportPackEditor } from "./report-pack-editor";
import { ReportPackView } from "./report-pack-view";
import { ReportsNav } from "./reports-nav";

const { run } = vi.hoisted(() => ({ run: vi.fn() }));

vi.mock("@/hooks/use-source-freshness", () => ({ useSourceFreshness: () => ({}) }));
vi.mock("@/hooks/use-load-status", () => ({ useLoadStatus: () => undefined }));
vi.mock("@/hooks/use-report-export", () => ({
    useReportExport: () => ({ busy: undefined, message: undefined, run }),
}));

// Each screen stands in as its stage headings, plus the slicers it was told apply.
vi.mock("@/screens/registry", async () => {
    const { destinations } = await import("./destinations");
    const { useStageFilter } = await import("@/hooks/stage-filter.context");
    const { useFilterContext } = await import("@/hooks/filter.context");
    const screens = Object.fromEntries(
        destinations.map((destination) => [
            destination.id,
            function FakeScreen() {
                const { show, inPack } = useStageFilter();
                const { applicable } = useFilterContext();
                return (
                    <div data-testid={`screen-${destination.id}`} data-in-pack={inPack} data-applicable={applicable.join(",")}>
                        {destination.stages
                            .filter((stage) => show(stage.id))
                            .map((stage) => (
                                <section key={stage.id} id={`stage-${stage.id}`}>
                                    <h2>{stage.label}</h2>
                                </section>
                            ))}
                    </div>
                );
            },
        ]),
    );
    return { SCREENS: screens };
});

afterEach(() => {
    vi.clearAllMocks();
});

function Themed({ children }: { children: ReactNode }) {
    const theme = useCssTheme();
    return <ThemeContext.Provider value={{ isDark: false, toggleTheme: () => undefined, theme }}>{children}</ThemeContext.Provider>;
}

const saved: ReportPack = { id: "saved-1", name: "Board update", stages: ["the-bottom-line"] };

function packsContext(overrides: Partial<ReportPacksContextValue> = {}): ReportPacksContextValue {
    return {
        status: "ready",
        packs: [...BUILT_IN_PACKS, saved],
        save: vi.fn(async (pack: ReportPack) => pack),
        remove: vi.fn(async () => undefined),
        ...overrides,
    };
}

describe("ReportPackView", () => {
    it("shows each run's stages under its destination, answering to that destination's slicers", async () => {
        const { runs, missing } = packRuns(["budget-runway", "the-bottom-line", "cost-vs-value"], destinations);
        render(
            <Themed>
                <ReportPackView runs={runs} missing={missing} />
            </Themed>,
        );
        const headings = await screen.findAllByRole("heading", { level: 2 });
        expect(headings.map((heading) => heading.textContent)).toEqual(
            ["budget-runway", "the-bottom-line", "cost-vs-value"].map((id) => stageLabel(id as never)),
        );
        for (const { destination } of runs) {
            const shown = screen.getByTestId(`screen-${destination.id}`);
            expect(shown).toHaveAttribute("data-in-pack", "true");
            expect(shown).toHaveAttribute("data-applicable", destination.filters.join(","));
            expect(screen.getByText(`From ${destination.label}`)).toBeInTheDocument();
        }
    });

    it("notes the stages this install can't show", async () => {
        const consumption = stageDestination("budget-runway").id;
        const { runs, missing } = packRuns(
            ["budget-runway", "the-bottom-line"],
            destinations.filter((destination) => destination.id !== consumption),
        );
        render(
            <Themed>
                <ReportPackView runs={runs} missing={missing} />
            </Themed>,
        );
        expect(await screen.findByRole("note")).toHaveTextContent(stageLabel("budget-runway"));
        expect(screen.queryByTestId(`screen-${consumption}`)).toBeNull();
    });
});

describe("ReportPackEditor", () => {
    const available = [stageDestination("the-bottom-line"), stageDestination("budget-runway")];

    function renderEditor(onSave = vi.fn(async () => undefined), onClose = vi.fn()) {
        render(
            <ReportPackEditor
                pack={{ id: "new-1", name: "", stages: [] }}
                heading="New report pack"
                available={available}
                onSave={onSave}
                onClose={onClose}
            />,
        );
        return { onSave, onClose, dialog: screen.getByRole("dialog", { name: "New report pack" }) };
    }

    it("names a pack, picks its stages and puts them in order", async () => {
        const { onSave } = renderEditor();
        const save = screen.getByRole("button", { name: "Save pack" });
        expect(save).toBeDisabled();

        fireEvent.change(screen.getByLabelText("Name"), { target: { value: "  Monday update  " } });
        fireEvent.click(screen.getByRole("checkbox", { name: stageLabel("budget-runway") }));
        fireEvent.click(screen.getByRole("checkbox", { name: stageLabel("the-bottom-line") }));
        const order = screen.getByRole("list", { name: "Stages in this pack" });
        expect(within(order).getAllByRole("listitem").map((item) => item.textContent)).toEqual([
            stageLabel("budget-runway"),
            stageLabel("the-bottom-line"),
        ]);
        fireEvent.click(screen.getByRole("button", { name: `Move ${stageLabel("the-bottom-line")} up` }));

        await act(async () => {
            fireEvent.click(save);
        });
        expect(onSave).toHaveBeenCalledWith(
            expect.objectContaining({ id: "new-1", name: "Monday update", stages: ["the-bottom-line", "budget-runway"] }),
        );
    });

    it("doesn't offer Ask's conversation as a stage", () => {
        render(
            <ReportPackEditor
                pack={{ id: "new-1", name: "", stages: [] }}
                heading="New report pack"
                available={destinations.filter(({ id }) => id === "ask" || id === "appendix")}
                onSave={vi.fn(async () => undefined)}
                onClose={vi.fn()}
            />,
        );
        expect(screen.getByRole("checkbox", { name: stageLabel("glossary") })).toBeInTheDocument();
        expect(screen.queryByRole("checkbox", { name: "Ask" })).toBeNull();
        expect(screen.queryByRole("group", { name: "Ask" })).toBeNull();
    });

    it("says why a save failed and keeps the dialog open", async () => {
        renderEditor(vi.fn(async () => Promise.reject(new Error("Only Analytics Hub admins can change this"))));
        fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Pack" } });
        fireEvent.click(screen.getByRole("checkbox", { name: stageLabel("the-bottom-line") }));
        await act(async () => {
            fireEvent.click(screen.getByRole("button", { name: "Save pack" }));
        });
        expect(screen.getByRole("alert")).toHaveTextContent("Only Analytics Hub admins can change this");
        expect(screen.getByRole("dialog")).toBeInTheDocument();
    });

    it("closes on Escape", () => {
        const { onClose } = renderEditor();
        fireEvent.keyDown(document, { key: "Escape" });
        expect(onClose).toHaveBeenCalled();
    });
});

describe("ReportsNav", () => {
    it("lists every pack and starts a new one", () => {
        const onOpen = vi.fn();
        const onCreate = vi.fn();
        render(
            <ReportPacksContext.Provider value={packsContext()}>
                <ReportsNav activePack="saved-1" onOpen={onOpen} onCreate={onCreate} />
            </ReportPacksContext.Provider>,
        );
        const list = screen.getByRole("list", { name: "Reports" });
        expect(within(list).getAllByRole("button").map((button) => button.textContent)).toEqual([
            ...BUILT_IN_PACKS.map((pack) => pack.name),
            "Board update",
        ]);
        expect(within(list).getByRole("button", { name: "Board update" })).toHaveAttribute("aria-current", "page");
        fireEvent.click(within(list).getByRole("button", { name: BUILT_IN_PACKS[0].name }));
        expect(onOpen).toHaveBeenCalledWith(BUILT_IN_PACKS[0].id);
        fireEvent.click(screen.getByRole("button", { name: "New pack" }));
        expect(onCreate).toHaveBeenCalled();
    });

    it("offers only the built-in packs when the saved ones can't be reached", () => {
        render(
            <ReportPacksContext.Provider value={packsContext({ status: "unavailable", packs: BUILT_IN_PACKS })}>
                <ReportsNav onOpen={vi.fn()} onCreate={vi.fn()} />
            </ReportPacksContext.Provider>,
        );
        expect(screen.queryByRole("button", { name: "New pack" })).toBeNull();
        expect(screen.getByText(/only the built-in ones are listed/)).toBeInTheDocument();
    });
});

describe("PackActions", () => {
    it("lets a built-in pack be copied but not edited or deleted", () => {
        const onEdit = vi.fn();
        render(
            <ReportPacksContext.Provider value={packsContext()}>
                <PackActions pack={BUILT_IN_PACKS[0]} onEdit={onEdit} onDeleted={vi.fn()} />
            </ReportPacksContext.Provider>,
        );
        expect(screen.queryByRole("button", { name: "Edit" })).toBeNull();
        expect(screen.queryByRole("button", { name: "Delete" })).toBeNull();
        fireEvent.click(screen.getByRole("button", { name: "Save a copy" }));
        expect(onEdit).toHaveBeenCalledWith(
            expect.objectContaining({ name: `${BUILT_IN_PACKS[0].name} (copy)`, stages: BUILT_IN_PACKS[0].stages }),
            "Save a copy",
        );
    });

    it("asks before deleting a saved pack", async () => {
        const context = packsContext();
        const onDeleted = vi.fn();
        render(
            <ReportPacksContext.Provider value={context}>
                <PackActions pack={saved} onEdit={vi.fn()} onDeleted={onDeleted} />
            </ReportPacksContext.Provider>,
        );
        fireEvent.click(screen.getByRole("button", { name: "Delete" }));
        expect(screen.getByText("Delete this pack for everyone?")).toBeInTheDocument();
        expect(context.remove).not.toHaveBeenCalled();
        await act(async () => {
            fireEvent.click(screen.getByRole("button", { name: "Delete" }));
        });
        expect(context.remove).toHaveBeenCalledWith("saved-1");
        expect(onDeleted).toHaveBeenCalled();
    });

    it("changes nothing until the saved packs are known", () => {
        render(
            <ReportPacksContext.Provider value={packsContext({ status: "loading" })}>
                <PackActions pack={saved} onEdit={vi.fn()} onDeleted={vi.fn()} />
            </ReportPacksContext.Provider>,
        );
        for (const name of ["Edit", "Save a copy", "Delete"]) expect(screen.getByRole("button", { name })).toBeDisabled();
    });
});

describe("ReportHeader", () => {
    it("exports what is shown with the filters, freshness and data date", () => {
        const root = document.createElement("div");
        render(
            <Themed>
                <ReportHeader
                    icon={Gauge}
                    title="Exec pre-read"
                    blurb="The headline story"
                    sources={["auditLog"]}
                    dates={{ auditLog: "2026-10-05T00:00:00" }}
                    filterKeys={["dateRange", "licence"]}
                    missing={["Budget runway"]}
                    contentRef={{ current: root }}
                />
            </Themed>,
        );
        expect(screen.getByRole("heading", { level: 1, name: "Exec pre-read" })).toBeInTheDocument();
        fireEvent.click(screen.getByRole("button", { name: "Download PowerPoint" }));
        expect(run).toHaveBeenCalledWith("pptx", {
            name: "Exec pre-read",
            description: "The headline story",
            root,
            filters: "All data, no filters",
            freshness: expect.stringContaining("Audit log"),
            dataTo: "2026-10-05",
            missing: ["Budget runway"],
        });
        fireEvent.click(screen.getByRole("button", { name: "Download PDF" }));
        expect(run).toHaveBeenLastCalledWith("pdf", expect.objectContaining({ name: "Exec pre-read" }));
    });

    it("offers no downloads on a page that can't be exported", () => {
        render(
            <Themed>
                <ReportHeader
                    icon={Gauge}
                    title="Ask"
                    sources={[]}
                    dates={{}}
                    filterKeys={[]}
                    contentRef={{ current: null }}
                    downloadable={false}
                />
            </Themed>,
        );
        expect(screen.getByRole("heading", { level: 1, name: "Ask" })).toBeInTheDocument();
        expect(screen.queryByRole("button", { name: "Download PDF" })).toBeNull();
        expect(screen.queryByRole("button", { name: "Download PowerPoint" })).toBeNull();
    });

    it("shows a further line, such as whose data is shown, under the freshness", () => {
        render(
            <Themed>
                <ReportHeader
                    icon={Gauge}
                    title="Exec pre-read"
                    sources={[]}
                    dates={{}}
                    filterKeys={[]}
                    contentRef={{ current: null }}
                    meta={<span>Showing: everyone</span>}
                />
            </Themed>,
        );
        expect(screen.getByRole("banner")).toHaveTextContent("Showing: everyone");
    });
});
