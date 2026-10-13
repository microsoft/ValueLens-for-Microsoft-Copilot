//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import { useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { FileStack, Moon, Sun } from "lucide-react";
import { DataToContext } from "@/hooks/data-to.context";
import { useReportPacks } from "@/hooks/report-packs.context";
import { useSourceFreshness } from "@/hooks/use-source-freshness";
import { paletteClass, usePaletteTheme } from "@/hooks/use-palette-theme";
import { ThemeContext, useThemeContext } from "@/hooks/theme.context";
import { AuthContext } from "@/hooks/auth.context";
import { useSourceAvailability } from "@/hooks/source-availability.context";
import { useAccessScope } from "@/hooks/use-access-scope";
import { useIsRefreshing } from "@/lib/refresh-tracker";
import { PAGE_SOURCES } from "@/lib/freshness";
import { earliestDate, newPackId, packFilters, packSources, stageLabel, type PackRun, type ReportPack } from "@/lib/report-pack";
import { runtimeConfig } from "@/lib/runtime-config";
import { scrollToAnchor } from "@/lib/scroll-to-anchor";
import { cn } from "@/lib/utils";
import { getAccessToken } from "@/services/rayfin-auth.service";
import {
    availableDestinations,
    destinations,
    isDestinationReady,
    isPackable,
    isReference,
    stageAnchor,
    type Destination,
    type DestinationId,
    type StageId,
} from "./destinations";
import { AccessScopeChip, NoScopeNotice } from "./access-scope";
import { FilterBar } from "./filter-bar";
import { ReportHeader } from "./report-header";
import { PackActions } from "./report-pack-actions";
import { ReportPackEditor } from "./report-pack-editor";
import { ReportsNav } from "./reports-nav";
import { SharePanel } from "./share-panel";

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
        <a href={version.releaseUrl} className="px-200 text-[length:var(--text-200)] leading-200 text-muted-foreground underline">
            {label}
        </a>
    ) : (
        <span className="px-200 text-[length:var(--text-200)] leading-200 text-muted-foreground">{label}</span>
    );
}

/** What the canvas shows: one destination, or a report pack's stages from any of them. */
export type AppView =
    | { kind: "destination"; id: DestinationId }
    | { kind: "pack"; pack: ReportPack; runs: readonly PackRun[]; missing: readonly StageId[] };

interface AppShellProps {
    view: AppView;
    onNavigate: (id: DestinationId) => void;
    onOpenPack: (id: string) => void;
    children: ReactNode;
}

/** How far down the canvas a stage's heading has to pass before it counts as the one being read. */
const READING_LINE = 0.3;

/**
 * Sidebar-and-canvas frame. The sidebar is the whole navigation model — the
 * destinations replacing the report's pages and bookmark bars, with the
 * active destination's stages listed beneath it and tracked as you scroll,
 * and the report's appendix set apart below them as reference.
 *
 * Each destination carries its own palette: the sidebar shows every hue at
 * once so they read as distinct places, and the canvas — chrome and charts
 * alike — takes on the hue of the one that is open.
 */
export function AppShell({ view, onNavigate, onOpenPack, children }: AppShellProps) {
    const themeContext = useThemeContext();
    const { isDark, toggleTheme } = themeContext;
    const active = view.kind === "destination" ? view.id : undefined;
    // A pack takes on the hue of the destination it opens with.
    const palette: DestinationId = active ?? (view.kind === "pack" ? view.runs[0]?.destination.id : undefined) ?? "executive";
    const paletteTheme = usePaletteTheme(palette);
    const refreshing = useIsRefreshing();
    const current = destinations.find((destination) => destination.id === active);
    const viewKey = view.kind === "destination" ? view.id : `pack:${view.pack.id}`;
    const mainRef = useRef<HTMLElement>(null);
    const contentRef = useRef<HTMLDivElement>(null);
    const { save } = useReportPacks();
    const [editing, setEditing] = useState<{ pack: ReportPack; heading: string }>();
    const closeEditor = useCallback(() => setEditing(undefined), []);
    const savePack = async (pack: ReportPack) => {
        const saved = await save(pack);
        setEditing(undefined);
        onOpenPack(saved.id);
    };

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
    const [readingStage, setReadingStage] = useState<StageId>();
    const sources = useSourceAvailability();
    const accessScope = useAccessScope();
    const noScope = accessScope.kind === "none";
    // Pages whose model the install didn't set up, or whose source has no data, are left out of the sidebar.
    const available = useMemo(() => availableDestinations(runtimeConfig().semanticModels, sources), [sources]);

    useEffect(() => {
        const main = mainRef.current;
        if (!main) return;
        main.scrollTop = 0;

        const built = (destinations.find((destination) => destination.id === active)?.stages ?? []).filter(
            (stage) => stage.ready,
        );
        let frame = 0;

        // Screens load their data after mounting and grow as they do, so stage
        // positions are read on every scroll rather than cached.
        const update = () => {
            frame = 0;
            const line = main.getBoundingClientRect().top + main.clientHeight * READING_LINE;
            let reading: StageId | undefined = built[0]?.id;
            for (const stage of built) {
                const element = document.getElementById(stageAnchor(stage.id));
                if (element && element.getBoundingClientRect().top <= line) reading = stage.id;
            }
            // A short last stage can never reach the reading line, so hitting the end selects it.
            const atEnd = main.scrollTop > 0 && main.scrollTop + main.clientHeight >= main.scrollHeight - 1;
            if (atEnd && built.length > 0) reading = built[built.length - 1].id;
            setReadingStage(reading);
        };
        const onScroll = () => {
            if (!frame) frame = requestAnimationFrame(update);
        };

        frame = requestAnimationFrame(update);
        main.addEventListener("scroll", onScroll, { passive: true });
        return () => {
            main.removeEventListener("scroll", onScroll);
            cancelAnimationFrame(frame);
        };
    }, [active, viewKey]);

    const goToStage = (id: StageId) => scrollToAnchor(stageAnchor(id));

    const renderDestination = (destination: Destination) => {
        const Icon = destination.icon;
        const isActive = destination.id === active;
        const ready = isDestinationReady(destination);
        return (
            <li key={destination.id} className={paletteClass(destination.id)}>
                <button
                    type="button"
                    onClick={() => onNavigate(destination.id)}
                    aria-current={isActive ? "page" : undefined}
                    disabled={!ready}
                    className={cn(
                        "flex w-full items-center gap-300 rounded-md px-300 py-200 text-left transition-colors",
                        "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring",
                        isActive
                            ? "bg-accent text-accent-foreground"
                            : "text-muted-foreground hover:bg-secondary hover:text-foreground",
                        !ready && "cursor-not-allowed opacity-50 hover:bg-transparent",
                    )}
                >
                    <Icon className="icon-size-200 shrink-0 text-primary" aria-hidden="true" />
                    <span className="flex flex-col">
                        <span className={cn("text-[length:var(--text-300)] leading-300", isActive && "font-semibold")}>
                            {destination.label}
                        </span>
                        <span className="text-[length:var(--text-100)] leading-100 opacity-70">
                            {ready ? destination.blurb : "Coming next"}
                        </span>
                    </span>
                </button>

                {isActive && destination.stages.length > 1 && (
                    <ul
                        aria-label={`${destination.label} stages`}
                        className="mt-100 mb-200 ml-500 flex flex-col border-l border-border"
                    >
                        {destination.stages.map((stage) => {
                            const isReading = stage.id === readingStage;
                            return (
                                <li key={stage.id}>
                                    {stage.ready ? (
                                        <button
                                            type="button"
                                            onClick={() => goToStage(stage.id)}
                                            aria-current={isReading ? "location" : undefined}
                                            className={cn(
                                                "-ml-px flex w-full border-l-2 py-100 pr-200 pl-[18px] text-left text-[length:var(--text-200)] leading-200 transition-colors",
                                                "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring",
                                                isReading
                                                    ? "border-primary font-semibold text-foreground"
                                                    : "border-transparent text-muted-foreground hover:text-foreground",
                                            )}
                                        >
                                            {stage.label}
                                        </button>
                                    ) : (
                                        <span className="-ml-px flex items-baseline justify-between gap-200 border-l-2 border-transparent py-100 pr-200 pl-[18px] text-[length:var(--text-200)] leading-200 text-muted-foreground opacity-60">
                                            {stage.label}
                                            <span className="text-[length:var(--text-100)] leading-100">Soon</span>
                                        </span>
                                    )}
                                </li>
                            );
                        })}
                    </ul>
                )}
            </li>
        );
    };

    const reference = available.filter(isReference);

    return (
        // The shell and both scroll areas are positioned so absolute descendants (sr-only text
        // especially) stay inside them; otherwise they extend the document and add a second scrollbar.
        <div
            className={cn(
                "relative flex h-screen w-full overflow-hidden bg-background text-foreground",
                paletteClass(palette),
            )}
            data-print="flow"
        >
            <nav
                aria-label="Sections"
                data-print="hide"
                className="relative flex w-[248px] shrink-0 flex-col gap-500 overflow-y-auto border-r border-border bg-card px-400 py-500"
            >
                <div className="flex flex-col gap-100 px-200">
                    <span className="text-[length:var(--text-500)] leading-500 font-semibold">Analytics Hub</span>
                    <span className="text-[length:var(--text-200)] leading-200 text-muted-foreground">
                        for Microsoft Copilot
                    </span>
                </div>

                <ul className="flex flex-1 flex-col gap-100-nudge">
                    {available.filter((destination) => !isReference(destination)).map(renderDestination)}
                </ul>

                {reference.length > 0 && (
                    <div className="flex flex-col gap-100 border-t border-border pt-400">
                        <span
                            id="nav-reference"
                            className="px-300 text-[length:var(--text-200)] leading-200 font-semibold text-muted-foreground"
                        >
                            Reference
                        </span>
                        <ul aria-labelledby="nav-reference" className="flex flex-col gap-100-nudge">
                            {reference.map(renderDestination)}
                        </ul>
                    </div>
                )}

                <ReportsNav
                    activePack={view.kind === "pack" ? view.pack.id : undefined}
                    onOpen={onOpenPack}
                    onCreate={() => setEditing({ pack: { id: newPackId(), name: "", stages: [] }, heading: "New report pack" })}
                />

                <SharePanel />

                <UpdateNotice />

                <button
                    type="button"
                    onClick={toggleTheme}
                    aria-pressed={isDark}
                    className="flex items-center gap-300 rounded-md border border-border px-300 py-200 text-[length:var(--text-300)] text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
                >
                    {isDark ? (
                        <Sun className="icon-size-200" aria-hidden="true" />
                    ) : (
                        <Moon className="icon-size-200" aria-hidden="true" />
                    )}
                    {isDark ? "Light mode" : "Dark mode"}
                </button>
            </nav>

            <main ref={mainRef} data-print="flow" className="relative min-w-0 flex-1 overflow-y-auto [scrollbar-gutter:stable]">
                <div className="mx-auto flex max-w-[1400px] flex-col gap-600 px-700 pt-600 pb-800" data-print="flow">
                    {view.kind === "pack" ? (
                        <ReportHeader
                            key={viewKey}
                            icon={FileStack}
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
                                title={current.label}
                                blurb={current.blurb}
                                sources={headerSources}
                                dates={dates}
                                filterKeys={filterKeys}
                                contentRef={contentRef}
                                meta={<AccessScopeChip state={accessScope} />}
                                downloadable={isPackable(current) && !noScope}
                            />
                        )
                    )}
                    {noScope ? (
                        <NoScopeNotice />
                    ) : (
                        <>
                            {title && filterKeys.length > 0 && <FilterBar destinationLabel={title} />}
                            <ThemeContext.Provider value={{ ...themeContext, theme: paletteTheme }}>
                                <DataToContext.Provider value={dataTo}>
                                    <div
                                        ref={contentRef}
                                        aria-busy={refreshing || undefined}
                                        data-refreshing={refreshing || undefined}
                                        className="flex flex-col gap-700 transition-opacity duration-200 data-[refreshing]:opacity-55 data-[refreshing]:delay-150"
                                    >
                                        {children}
                                    </div>
                                </DataToContext.Provider>
                            </ThemeContext.Provider>
                        </>
                    )}
                </div>
            </main>

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
