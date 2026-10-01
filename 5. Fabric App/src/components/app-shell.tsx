//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import { useEffect, useRef, useState, type ReactNode } from "react";
import { Moon, Sun } from "lucide-react";
import { paletteClass, usePaletteTheme } from "@/hooks/use-palette-theme";
import { ThemeContext, useThemeContext } from "@/hooks/theme.context";
import { useIsRefreshing } from "@/lib/refresh-tracker";
import { scrollToAnchor } from "@/lib/scroll-to-anchor";
import { cn } from "@/lib/utils";
import { destinations, isDestinationReady, isReference, stageAnchor, type Destination, type DestinationId, type StageId } from "./destinations";
import { FilterBar } from "./filter-bar";

interface AppShellProps {
    active: DestinationId;
    onNavigate: (id: DestinationId) => void;
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
export function AppShell({ active, onNavigate, children }: AppShellProps) {
    const themeContext = useThemeContext();
    const { isDark, toggleTheme } = themeContext;
    const paletteTheme = usePaletteTheme(active);
    const refreshing = useIsRefreshing();
    const current = destinations.find((destination) => destination.id === active);
    const mainRef = useRef<HTMLElement>(null);
    const [readingStage, setReadingStage] = useState<StageId>();

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
    }, [active]);

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

    const reference = destinations.filter(isReference);

    return (
        <div className={cn("flex h-screen w-full overflow-hidden bg-background text-foreground", paletteClass(active))}>
            <nav
                aria-label="Sections"
                className="flex w-[248px] shrink-0 flex-col gap-500 overflow-y-auto border-r border-border bg-card px-400 py-500"
            >
                <div className="flex flex-col gap-100 px-200">
                    <span className="text-[length:var(--text-500)] leading-500 font-semibold">ValueLens</span>
                    <span className="text-[length:var(--text-200)] leading-200 text-muted-foreground">
                        for Microsoft Copilot
                    </span>
                </div>

                <ul className="flex flex-1 flex-col gap-100-nudge">
                    {destinations.filter((destination) => !isReference(destination)).map(renderDestination)}
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

            <main ref={mainRef} className="min-w-0 flex-1 overflow-y-auto [scrollbar-gutter:stable]">
                <div className="mx-auto flex max-w-[1400px] flex-col gap-600 px-700 pt-600 pb-800">
                    {current && (
                        <header className="flex items-center gap-400">
                            <span className="flex size-[48px] shrink-0 items-center justify-center rounded-lg bg-accent text-primary">
                                <current.icon className="icon-size-400" aria-hidden="true" />
                            </span>
                            <span className="flex flex-col gap-100">
                                <h1 className="text-[length:var(--text-hero-700)] leading-hero-700 font-semibold">
                                    {current.label}
                                </h1>
                                <span className="text-[length:var(--text-300)] leading-300 text-muted-foreground">
                                    {current.blurb}
                                </span>
                            </span>
                        </header>
                    )}
                    {current && current.filters.length > 0 && <FilterBar destinationLabel={current.label} />}
                    <ThemeContext.Provider value={{ ...themeContext, theme: paletteTheme }}>
                        <div
                            aria-busy={refreshing || undefined}
                            data-refreshing={refreshing || undefined}
                            className="flex flex-col gap-700 transition-opacity duration-200 data-[refreshing]:opacity-55 data-[refreshing]:delay-150"
                        >
                            {children}
                        </div>
                    </ThemeContext.Provider>
                </div>
            </main>
        </div>
    );
}
