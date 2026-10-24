//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import { useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { FileStack, MessageSquareText, Moon, SlidersHorizontal, Sun } from "lucide-react";
import { DataToContext } from "@/hooks/data-to.context";
import { useReportPacks } from "@/hooks/report-packs.context";
import { useSourceFreshness } from "@/hooks/use-source-freshness";
import { paletteClass, usePaletteTheme } from "@/hooks/use-palette-theme";
import { ThemeContext, useThemeContext } from "@/hooks/theme.context";
import { AuthContext } from "@/hooks/auth.context";
import { useSourceAvailability } from "@/hooks/source-availability.context";
import { useAccessScope } from "@/hooks/use-access-scope";
import { pageStages, StageFilterContext } from "@/hooks/stage-filter.context";
import { useIsRefreshing } from "@/lib/refresh-tracker";
import { appName } from "@/lib/app-variant";
import { PAGE_SOURCES } from "@/lib/freshness";
import { earliestDate, newPackId, packFilters, packSources, stageLabel, type PackRun, type ReportPack } from "@/lib/report-pack";
import { runtimeConfig } from "@/lib/runtime-config";
import { cn } from "@/lib/utils";
import { getAccessToken } from "@/services/rayfin-auth.service";
import {
    availableDestinations,
    availableProducts,
    destinations,
    isBandDestination,
    isDestinationReady,
    isPackable,
    productDestinations,
    products,
    tabLabel,
    type DestinationId,
    type ProductId,
    type StageId,
} from "./destinations";
import { AccessScopeChip, NoScopeNotice } from "./access-scope";
import { FilterBar } from "./filter-bar";
import { ReportHeader } from "./report-header";
import { PackActions } from "./report-pack-actions";
import { ReportPackEditor } from "./report-pack-editor";
import { ReportsNav } from "./reports-nav";
import { BAND_BUTTON } from "./band-button";
import { BandPopover } from "./band-popover";
import { SharePanel } from "./share-panel";
import { StageTabs } from "./stage-tabs";

interface VersionResponse {
    latest?: string;
    updateAvailable?: boolean;
    releaseUrl?: string;
}

function UpdateNotice() {
    const auth = useContext(AuthContext);
    const [version, setVersion] = useState<VersionResponse | null>(null);
    const isAzureAdmin = runtimeConfig().host === "azure" && (auth?.user?.roles ?? []).includes("AnalyticsHub.Admin");

    useEffect(() => {
        if (!isAzureAdmin) return;
        let cancelled = false;
        getAccessToken()
            .then((token) => fetch("/api/version", { cache: "no-store", headers: { authorization: `Bearer ${token}` } }))
            .then((response) => response.ok ? response.json() as Promise<VersionResponse> : null)
            .then((value) => !cancelled && setVersion(value))
            .catch(() => undefined);
        return () => {
            cancelled = true;
        };
    }, [isAzureAdmin]);

    if (!isAzureAdmin || !version?.updateAvailable) return null;

    const label = `Update available: ${version.latest ?? "latest"}`;
    return version.releaseUrl ? (
        <a href={version.releaseUrl} className="text-[12.5px] leading-200 text-band-muted underline underline-offset-2 hover:text-band-foreground">
            {label}
        </a>
    ) : (
        <span className="text-[12.5px] leading-200 text-band-muted">{label}</span>
    );
}

const CREATOR_PROFILE_URL = "https://github.com/Keithland89";

/** The page's footer: who made the app, linked to their profile. */
function CreatorCredit() {
    return (
        <footer data-print="hide" className="mx-auto w-full max-w-[1480px] px-[var(--page-x)] pt-100 pb-600 text-[12.5px] leading-200 text-muted-foreground">
            Created by{" "}
            <a
                href={CREATOR_PROFILE_URL}
                target="_blank"
                rel="noreferrer"
                className="underline underline-offset-2 hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
            >
                Keith McGrane
            </a>
        </footer>
    );
}

/** What the canvas shows: one destination at one of its stages, or a report pack's stages from any of them. */
export type AppView =
    | { kind: "destination"; id: DestinationId; stage?: StageId }
    | { kind: "pack"; pack: ReportPack; runs: readonly PackRun[]; missing: readonly StageId[] };

interface AppShellProps {
    view: AppView;
    onNavigate: (id: DestinationId, stage?: StageId) => void;
    onOpenPack: (id: string) => void;
    children: ReactNode;
}

interface BandTab {
    key: string;
    label: string;
    current: boolean;
    ready: boolean;
    open: () => void;
}

const COLUMN = "mx-auto w-full max-w-[1480px] px-[var(--page-x)]";

/**
 * The CSV apps' frame. A dark teal band carries the brand, a switcher
 * across the products this install shows — ValueLens and Consumption
 * Central — the open product's tabs, and the app-wide actions: the
 * assumptions, Ask, report packs, sharing and the theme. Under it a white
 * toolbar holds the page head, the page's sub-views as a segmented control,
 * and its filters, which stay pinned as the page scrolls. With one product
 * the switcher is left out.
 *
 * ValueLens has a tab per destination, its stages the sub-views. Consumption
 * Central is one destination, so its stages are the tabs. A page shows one
 * stage at a time, so it only queries what is on screen. Charts still take
 * each destination's series order; the chrome is the one teal everywhere.
 */
export function AppShell({ view, onNavigate, onOpenPack, children }: AppShellProps) {
    const themeContext = useThemeContext();
    const { isDark, toggleTheme } = themeContext;
    const active = view.kind === "destination" ? view.id : undefined;
    const activeStage = view.kind === "destination" ? view.stage : undefined;
    // A pack takes on the series order of the destination it opens with.
    const palette: DestinationId = active ?? (view.kind === "pack" ? view.runs[0]?.destination.id : undefined) ?? "executive";
    const paletteTheme = usePaletteTheme(palette);
    const refreshing = useIsRefreshing();
    const current = destinations.find((destination) => destination.id === active);
    const viewKey = view.kind === "destination" ? view.id : `pack:${view.pack.id}`;
    const scrollRef = useRef<HTMLDivElement>(null);
    const contentRef = useRef<HTMLDivElement>(null);
    const { save } = useReportPacks();
    const [editing, setEditing] = useState<{ pack: ReportPack; heading: string }>();
    const closeEditor = useCallback(() => setEditing(undefined), []);
    const savePack = async (pack: ReportPack) => {
        const saved = await save(pack);
        setEditing(undefined);
        onOpenPack(saved.id);
    };
    // A page's download holds every stage, so they all render while it is drawn.
    const [wholePage, setWholePage] = useState(false);
    const stageFilter = useMemo(
        () => pageStages(wholePage || !activeStage ? "all" : activeStage),
        [wholePage, activeStage],
    );
    const showWholePage = useCallback(() => {
        setWholePage(true);
        return () => setWholePage(false);
    }, []);

    const headerSources = useMemo(
        () => (view.kind === "pack" ? packSources(view.runs) : PAGE_SOURCES[view.id]),
        [view],
    );
    const dates = useSourceFreshness(headerSources);
    const dataTo = earliestDate(headerSources.map((source) => dates[source]));
    const filterKeys = useMemo(
        () => (view.kind === "pack" ? packFilters(view.runs) : (current?.filters ?? [])),
        [view, current],
    );
    const title = view.kind === "pack" ? view.pack.name : current?.label;
    const sources = useSourceAvailability();
    const accessScope = useAccessScope();
    const noScope = accessScope.kind === "none";
    // Pages whose model the install didn't set up, or whose source has no data, are left out.
    const available = useMemo(() => availableDestinations(runtimeConfig().semanticModels, sources), [sources]);
    const shownProducts = useMemo(() => availableProducts(available), [available]);

    // The product the band shows: the open page's own, the first page of a
    // pack's, or — for Ask and the assumptions, which belong to every
    // product — whichever was showing before.
    const ownProduct: ProductId | undefined =
        current && !isBandDestination(current)
            ? current.product
            : view.kind === "pack"
              ? view.runs[0]?.destination.product
              : undefined;
    const [lastProduct, setLastProduct] = useState<ProductId>(ownProduct ?? shownProducts[0]?.id ?? "valuelens");
    if (ownProduct && ownProduct !== lastProduct) setLastProduct(ownProduct);
    const product = ownProduct ?? lastProduct;
    const productLabel = products.find((candidate) => candidate.id === product)?.label;

    const productTabs = useMemo(() => productDestinations(available, product), [available, product]);
    // A product of one destination shows that destination's stages as its tabs.
    const single = productTabs.length === 1 ? productTabs[0] : undefined;
    const bandTabs: BandTab[] = single
        ? single.stages.map((stage) => ({
              key: stage.id,
              label: stage.label,
              current: single.id === active && stage.id === activeStage,
              ready: stage.ready,
              open: () => onNavigate(single.id, stage.id),
          }))
        : productTabs.map((destination) => ({
              key: destination.id,
              label: tabLabel(destination),
              current: destination.id === active,
              ready: isDestinationReady(destination),
              open: () => onNavigate(destination.id),
          }));
    const subViews = useMemo(
        () => (current && current.id !== single?.id ? current.stages.filter((stage) => stage.ready) : []),
        [current, single],
    );
    const showFilters = !noScope && !!title && filterKeys.length > 0;
    const ask = available.find((destination) => destination.id === "ask");
    const assumptions = available.find((destination) => destination.id === "assumptions");

    useEffect(() => {
        if (scrollRef.current) scrollRef.current.scrollTop = 0;
    }, [viewKey, activeStage]);

    return (
        // The shell and its scroll area are positioned so absolute descendants (sr-only text
        // especially) stay inside them; otherwise they extend the document and add a second scrollbar.
        <div
            className={cn("relative flex h-screen w-full flex-col overflow-hidden bg-background text-foreground", paletteClass(palette))}
            data-print="flow"
        >
            <div ref={scrollRef} data-print="flow" className="relative flex min-h-0 flex-1 flex-col overflow-y-auto [scrollbar-gutter:stable]">
                <header data-band="" data-print="hide" className="bg-band text-band-foreground">
                    <div className={cn(COLUMN, "relative flex flex-wrap items-center gap-x-600 gap-y-300 pt-400 pb-300-nudge")}>
                        <div className="flex min-w-0 flex-col">
                            <span className="font-heading text-[19px] leading-[24px] font-semibold tracking-[-0.01em]">{appName(runtimeConfig().variant)}</span>
                            <span className="text-[12.5px] leading-200 text-band-muted">for Microsoft Copilot</span>
                        </div>

                        {shownProducts.length > 1 && (
                            <nav aria-label="Products" className="order-last w-full lg:order-none lg:w-auto">
                                <ul className="flex w-max max-w-full gap-100-nudge overflow-x-auto rounded-full bg-white/8 p-[3px] scrollbar-none">
                                    {shownProducts.map((candidate) => {
                                        const isCurrent = candidate.id === product && view.kind === "destination" && !!current && !isBandDestination(current);
                                        return (
                                            <li key={candidate.id} className="shrink-0">
                                                <button
                                                    type="button"
                                                    title={candidate.blurb}
                                                    aria-current={isCurrent ? "true" : undefined}
                                                    onClick={() => {
                                                        const first = productDestinations(available, candidate.id)[0];
                                                        if (first) onNavigate(first.id);
                                                    }}
                                                    className={cn(
                                                        "h-[30px] rounded-full px-400 text-[13px] whitespace-nowrap transition-colors",
                                                        candidate.id === product
                                                            ? "bg-band-foreground font-semibold text-band"
                                                            : "font-medium text-band-muted hover:text-band-foreground",
                                                    )}
                                                >
                                                    {candidate.label}
                                                </button>
                                            </li>
                                        );
                                    })}
                                </ul>
                            </nav>
                        )}

                        <div className="ml-auto flex flex-wrap items-center justify-end gap-200">
                            <UpdateNotice />
                            {assumptions && (
                                <button
                                    type="button"
                                    title={assumptions.blurb}
                                    onClick={() => onNavigate(assumptions.id)}
                                    aria-current={active === assumptions.id ? "page" : undefined}
                                    className={BAND_BUTTON}
                                >
                                    <SlidersHorizontal className="icon-size-200 shrink-0" aria-hidden="true" />
                                    <span className="max-md:sr-only">{assumptions.label}</span>
                                </button>
                            )}
                            {ask && (
                                <button
                                    type="button"
                                    title={ask.blurb}
                                    onClick={() => onNavigate(ask.id)}
                                    aria-current={active === ask.id ? "page" : undefined}
                                    className={BAND_BUTTON}
                                >
                                    <MessageSquareText className="icon-size-200 shrink-0" aria-hidden="true" />
                                    <span className="max-md:sr-only">{ask.label}</span>
                                </button>
                            )}
                            <BandPopover label="Reports" icon={FileStack} current={view.kind === "pack"}>
                                {(close) => (
                                    <ReportsNav
                                        activePack={view.kind === "pack" ? view.pack.id : undefined}
                                        onOpen={(id) => {
                                            close();
                                            onOpenPack(id);
                                        }}
                                        onCreate={() => {
                                            close();
                                            setEditing({ pack: { id: newPackId(), name: "", stages: [] }, heading: "New report pack" });
                                        }}
                                    />
                                )}
                            </BandPopover>
                            <SharePanel />
                            <button type="button" onClick={toggleTheme} aria-pressed={isDark} className={BAND_BUTTON}>
                                {isDark ? (
                                    <Sun className="icon-size-200 shrink-0" aria-hidden="true" />
                                ) : (
                                    <Moon className="icon-size-200 shrink-0" aria-hidden="true" />
                                )}
                                <span className="max-md:sr-only">{isDark ? "Light mode" : "Dark mode"}</span>
                            </button>
                        </div>
                    </div>

                    <nav aria-label="Sections" className={COLUMN}>
                        <ul aria-label={productLabel ? `${productLabel} tabs` : undefined} className="-mx-[14px] flex gap-100 overflow-x-auto scrollbar-none">
                            {bandTabs.map((tab) => (
                                <li key={tab.key} className="shrink-0">
                                    <button
                                        type="button"
                                        onClick={tab.open}
                                        disabled={!tab.ready}
                                        title={tab.ready ? undefined : "Coming next"}
                                        aria-current={tab.current ? "page" : undefined}
                                        className={cn(
                                            "relative px-[14px] pt-[10px] pb-300 text-[length:var(--text-300)] leading-300 whitespace-nowrap transition-colors",
                                            "after:absolute after:inset-x-[14px] after:bottom-0 after:h-[3px] after:rounded-t-[3px]",
                                            tab.current
                                                ? "font-semibold text-band-foreground after:bg-band-accent"
                                                : "font-medium text-band-muted hover:text-band-foreground",
                                            !tab.ready && "cursor-not-allowed opacity-50 hover:text-band-muted",
                                        )}
                                    >
                                        {tab.label}
                                    </button>
                                </li>
                            ))}
                        </ul>
                    </nav>
                </header>

                <main data-print="flow" className="relative flex flex-1 flex-col">
                    <div className={cn("bg-card", !showFilters && "border-b border-border")} data-print="flow">
                        <div className={cn(COLUMN, "flex flex-col gap-400 pt-500", showFilters ? "pb-100" : "pb-400")}>
                            {view.kind === "pack" ? (
                                <ReportHeader
                                    key={viewKey}
                                    icon={FileStack}
                                    crumb="Report pack"
                                    title={view.pack.name}
                                    blurb={view.pack.description}
                                    sources={headerSources}
                                    dates={dates}
                                    filterKeys={filterKeys}
                                    missing={view.missing.map(stageLabel)}
                                    contentRef={contentRef}
                                    meta={<AccessScopeChip state={accessScope} />}
                                    downloadable={!noScope}
                                    actions={
                                        <PackActions
                                            pack={view.pack}
                                            onEdit={(pack, heading) => setEditing({ pack, heading })}
                                            onDeleted={() => onNavigate("executive")}
                                        />
                                    }
                                />
                            ) : (
                                current && (
                                    <ReportHeader
                                        key={viewKey}
                                        icon={current.icon}
                                        crumb={isBandDestination(current) ? undefined : productLabel}
                                        title={current.label}
                                        blurb={current.blurb}
                                        sources={headerSources}
                                        dates={dates}
                                        filterKeys={filterKeys}
                                        contentRef={contentRef}
                                        prepareExport={showWholePage}
                                        meta={<AccessScopeChip state={accessScope} />}
                                        downloadable={isPackable(current) && !noScope}
                                    />
                                )
                            )}
                            {!noScope && current && subViews.length > 1 && (
                                <StageTabs
                                    label={`${current.label} stages`}
                                    stages={subViews}
                                    open={activeStage}
                                    onOpen={(stage) => onNavigate(current.id, stage)}
                                />
                            )}
                        </div>
                    </div>
                    {showFilters && (
                        // Pinned as the page scrolls, as the filters always have been.
                        <div data-print="hide" className="z-10 border-b border-border bg-card sm:sticky sm:top-0">
                            <div className={COLUMN}>
                                <FilterBar destinationLabel={title} />
                            </div>
                        </div>
                    )}

                    <div className={cn(COLUMN, "flex flex-col gap-600 pt-500 pb-800")} data-print="flow">
                        {noScope ? (
                            <NoScopeNotice />
                        ) : (
                            <ThemeContext.Provider value={{ ...themeContext, theme: paletteTheme }}>
                                <DataToContext.Provider value={dataTo}>
                                    <div
                                        ref={contentRef}
                                        aria-busy={refreshing || undefined}
                                        data-refreshing={refreshing || undefined}
                                        className="flex flex-col gap-700 transition-opacity duration-200 data-[refreshing]:opacity-55 data-[refreshing]:delay-150"
                                    >
                                        {view.kind === "destination" ? (
                                            <StageFilterContext.Provider value={stageFilter}>{children}</StageFilterContext.Provider>
                                        ) : (
                                            children
                                        )}
                                    </div>
                                </DataToContext.Provider>
                            </ThemeContext.Provider>
                        )}
                    </div>
                </main>

                <CreatorCredit />
            </div>

            {editing && (
                <ReportPackEditor
                    key={editing.pack.id}
                    pack={editing.pack}
                    heading={editing.heading}
                    available={available}
                    onSave={savePack}
                    onClose={closeEditor}
                />
            )}
        </div>
    );
}
