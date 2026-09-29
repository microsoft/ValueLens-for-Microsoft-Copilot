//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

function prefersReducedMotion(): boolean {
    return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/**
 * Brings the element with this DOM id to the top of its scroll container and
 * moves focus there, so keyboard and screen-reader users land where the page
 * scrolled. Scrolling is instant when the reader asks for reduced motion.
 */
export function scrollToAnchor(id: string): void {
    const element = document.getElementById(id);
    if (!element) return;
    element.scrollIntoView({ behavior: prefersReducedMotion() ? "auto" : "smooth", block: "start" });
    element.focus({ preventScroll: true });
}
