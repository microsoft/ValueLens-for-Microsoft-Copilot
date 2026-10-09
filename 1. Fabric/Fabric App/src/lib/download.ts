//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

/** A file name from a chart title: lower case, hyphenated, with the given extension. */
export function fileNameFor(title: string, extension: string): string {
    const slug = title
        .normalize("NFKD")
        .replace(/[\u0300-\u036f]/g, "")
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 80)
        .replace(/-+$/, "");
    return `${slug || "chart"}.${extension}`;
}

/** Saves a blob through the browser's download prompt. */
export function downloadBlob(blob: Blob, fileName: string): void {
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = fileName;
    link.rel = "noopener";
    link.style.display = "none";
    document.body.append(link);
    try {
        link.click();
    } finally {
        link.remove();
        // Some browsers read the URL after the click returns.
        setTimeout(() => URL.revokeObjectURL(url), 1000);
    }
}
