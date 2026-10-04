//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import { reloadOnStaleBuild } from './lib/reload-on-stale-build';
import { loadRuntimeConfig } from './lib/runtime-config';

import "./global.css"

reloadOnStaleBuild();

const container = document.getElementById('root')!;

// The app's modules read the config as they load, so they're only imported once it has settled.
loadRuntimeConfig()
    .then(() => import('./root'))
    .then(({ mountApp }) => mountApp(container))
    .catch((error: unknown) => {
        console.error(error);
        container.textContent = "Analytics Hub couldn't start. Refresh the page to try again.";
    });