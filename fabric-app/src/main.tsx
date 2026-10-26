//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import { forgetKeptResults } from './lib/forget-kept-results';
import { reloadOnStaleBuild } from './lib/reload-on-stale-build';
import { appName } from './lib/app-variant';
import { loadRuntimeConfig, runtimeConfig } from './lib/runtime-config';

import "./global.css"

reloadOnStaleBuild();
forgetKeptResults();

const container = document.getElementById('root')!;

// The app's modules read the config as they load, so they're only imported once it has settled.
loadRuntimeConfig()
    .then(() => {
        document.title = appName(runtimeConfig().variant);
        return import('./root');
    })
    .then(({ mountApp }) => mountApp(container))
    .catch((error: unknown) => {
        console.error(error);
        container.textContent = "The app couldn't start. Refresh the page to try again.";
    });