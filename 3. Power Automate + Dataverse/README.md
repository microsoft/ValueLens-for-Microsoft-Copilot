# Power Automate + Dataverse has moved to the archive

On 23 October 2026 this path moved to
[`archive/3. Power Automate + Dataverse/`](../archive/3.%20Power%20Automate%20%2B%20Dataverse/README.md),
and it's no longer supported.

- **Installs you already have keep running.** The scripts, templates and flows work as before from
  their new location.
- **It no longer gets dashboard changes.** New pages, measures and fixes go to the app and the
  active paths only.
- **Running the refresh from a clone on a schedule?** After you pull, point the scheduled task at
  `archive\3. Power Automate + Dataverse\scripts\Invoke-DataverseCoreRefresh.ps1`.
- **Files that earlier runs left here stay here.** A `processed` or `private` folder isn't moved for
  you, and git still ignores it. By default, new runs write to the archive folder instead.

**New install?** Start with [the app](../README.md#start-here-the-app-preview), or pick one of the
[active data paths](../README.md#where-your-data-comes-from).
