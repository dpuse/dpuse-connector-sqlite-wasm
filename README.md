# DPUse Connector SQLite Wasm

<!-- OPENING_START -->

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)
[![DPUse version](https://img.shields.io/badge/dynamic/json?url=https%3A%2F%2Fapi.dpuse.app%2Fconfigs%2Fdpuse-connector-sqlite-wasm&query=%24.data.version&prefix=v&label=DPUse&color=blue)](https://github.com/dpuse/dpuse-connector-sqlite-wasm/releases/latest)
[![CI](https://github.com/dpuse/dpuse-connector-sqlite-wasm/actions/workflows/ci.yml/badge.svg)](https://github.com/dpuse/dpuse-connector-sqlite-wasm/actions/workflows/ci.yml)

Stores data views for investigation in a SQLite database saved in the browser (OPFS).

[Report a Vulnerability](https://github.com/dpuse/dpuse-connector-sqlite-wasm/security/advisories/new) · [Open an Issue](https://github.com/dpuse/dpuse-connector-sqlite-wasm/issues)

## About DPUse

[DPUse](https://www.dpuse.app) (Data Positioning & Use) is an in-browser application that positions your data for use through three core activities: sourcing, contextualising, and publishing.

**Sourcing** uses a library of [Connectors](https://www.dpuse.app/connectors) to establish [Connections](https://www.dpuse.app) to applications, databases, file stores, and curated datasets; these connections are subsequently used to configure structured [Data Views](https://www.dpuse.app) from the underlying sources.

**Contextualising** extracts chronological events from those [Data Views](https://www.dpuse.app) and maps them into comprehensive [Context Models](https://www.dpuse.app). This gives the DPUse Engine the structural framework needed to generate deterministic transactions, facts, or observations.

**Publishing** uses a library of [Presenters](https://www.dpuse.app) to render standard [Presentations](https://www.dpuse.app) immediately using the contextualised data; additionally, [Cookbooks](https://www.dpuse.app) of [Recipes](https://www.dpuse.app) let you build Data Apps using your preferred tools.

In addition, DPUse provides [Tools](https://www.dpuse.app) used by the application, and you can use them to construct connectors and presenters.

## Introduction

Stores data views for investigation in a SQLite database saved in the browser's private file system (OPFS). Data stays on this device. Only one tab can use it at a time. Lighter than DuckDB: a small download and little memory, with slower grouping on large data.

<!-- OPENING_END -->

<!-- SUPPORTED_ACTIONS_START -->

## Supported Actions

Connectors conform to a unified interface contract by implementing a specific subset of standard actions. These standardised actions allow the DPUse application to interact with any underlying data source in the same way, enabling Connectors to be built independently and loaded dynamically at runtime.

This connector is a Bidirectional connector that supports both read and write actions. Connectors can also function as a Source (read-only) or Destination (write-only), depending on the actions they support. The table below lists all connector actions and highlights those supported by this connector.

| Action               | Supported |
| :------------------- | :-------: |
| Abort Operation      |     ✓     |
| Audit Object Content |           |
| Close Store          |     ✓     |
| Create Object        |           |
| Describe Connection  |           |
| Drop Object          |     ✓     |
| Find Object          |           |
| Get Info             |           |
| Get Readable Stream  |           |
| Get Record           |           |
| List Nodes           |           |
| Load Object Records  |     ✓     |
| Open Store           |     ✓     |
| Preview Object       |           |
| Query Records        |     ✓     |
| Remove Records       |           |
| Retrieve Chunks      |           |
| Retrieve Records     |           |
| Upsert Records       |           |

<!-- SUPPORTED_ACTIONS_END -->

<!-- USAGE_START -->

## Usage

This connector is automatically uploaded to the DPUse Engine cloud once released and becomes instantly available to all new browser app instances, with existing instances notified of the update.

You may view or clone this repository for your own purposes, such as building a new, similar connector, though there is currently no process to accept third-party connectors into DPUse at this stage.

```bash
git clone https://github.com/dpuse/dpuse-connector-sqlite-wasm.git
cd dpuse-connector-sqlite-wasm
npm install
```

_Requires [Node.js](https://nodejs.org/) 24 or later, [npm](https://www.npmjs.com/) 12 or later, and [TypeScript](https://www.typescriptlang.org/) 6.0.3 or later._

This repository is managed using the common set of actions provided by [@dpuse/dpuse-development](https://github.com/dpuse/dpuse-development). See the `scripts` block in [package.json](https://github.com/dpuse/dpuse-connector-sqlite-wasm/blob/main/package.json) for details.

<!-- USAGE_END -->

<!-- DEPENDENCY_LICENSES_START -->

## Dependency Licenses

License data is updated each time `npm run document` is run, using [license-checker](https://github.com/RSeidelsohn/license-checker-rseidelsohn). The following table lists every package whose code, styles or assets are included in this project's build, as recorded by the build itself. Modules loaded at run time are not included; each documents its own. These dependencies have been checked and confirmed to use Apache-2.0 or MIT, all of which allow commercial use. All are used unmodified, so any licence conditions that apply only to modified versions are not triggered. Developers cloning this repository should independently verify development dependencies.

| Dependency                                                       |    Version    | License(s) | Document                                                                        |
| :--------------------------------------------------------------- | :-----------: | :--------- | :------------------------------------------------------------------------------ |
| [@dpuse/dpuse-shared](https://github.com/dpuse/dpuse-shared)     |    1.0.160    | MIT        | [LICENSE](licenses/downloads/@dpuse/dpuse-shared@1.0.160-LICENSE.txt)           |
| [@sqlite.org/sqlite-wasm](https://github.com/sqlite/sqlite-wasm) | 3.54.1-build1 | Apache-2.0 | [LICENSE](licenses/downloads/@sqlite.org/sqlite-wasm@3.54.1-build1-LICENSE.txt) |
| [valibot](https://github.com/open-circle/valibot)                |     1.5.0     | MIT        | [LICENSE](licenses/downloads/valibot@1.5.0-LICENSE.txt)                         |

### Dependency Tree

The dependency tree below shows how each package in the table above is reached — direct and transitive — along with its installed version, release date, and update status. A package that does not ship itself, such as one whose parts are bundled separately, is left out and what ships beneath it is shown in its place. Packages flagged ❗ have a newer version available; ⚠️ indicates a package that hasn't been updated in the last 6 months or longer. Neither flag necessarily indicates a problem: we let new releases stabilise before upgrading, and some packages are mature and stable (have limited or no dependencies), so they require no active development.

- **[@dpuse/dpuse-shared](https://github.com/dpuse/dpuse-shared)** 1.0.160 — this month: 2026-10-28 → latest: 1.0.162 — this month: 2026-10-29 ❗
    - **[valibot](https://github.com/open-circle/valibot)** 1.5.0 — 1 mth ago: 2026-09-09
- **[@sqlite.org/sqlite-wasm](https://github.com/sqlite/sqlite-wasm)** 3.54.1-build1 — this month: 2026-10-19

<!-- DEPENDENCY_LICENSES_END -->

<!-- BUNDLE_START -->

## Bundle Analysis

This report is updated with each release, from the bundle the release builds, using [Sonda](https://sonda.dev/), which analyses final source maps to reveal the actual effects of tree-shaking and minification rather than relying on pre-build estimates.

_Note: Sonda's Vite reports currently exclude CSS files, since Vite does not generate source maps for CSS._

| Chunk/Module/File                                                     | Composition                                                                                     |
| :-------------------------------------------------------------------- | :---------------------------------------------------------------------------------------------- |
| **dist/dpuse-connector-sqlite-wasm.es.js**                            | 297.4&nbsp;kB&nbsp;·&nbsp;gzip&nbsp;75.7&nbsp;kB&nbsp;·&nbsp;100.0%&nbsp;of&nbsp;the&nbsp;build |
| &nbsp;&nbsp;&nbsp;&nbsp;@sqlite.org/sqlite-wasm → dist/index.mjs      | `████████████████░░░░`&nbsp;81.6%&nbsp;·&nbsp;242.6&nbsp;kB                                     |
| &nbsp;&nbsp;&nbsp;&nbsp;@dpuse/dpuse-shared → dist/dpuse-shared.es.js | `█░░░░░░░░░░░░░░░░░░░`&nbsp;2.9%&nbsp;·&nbsp;8.5&nbsp;kB                                        |
| &nbsp;&nbsp;&nbsp;&nbsp;src → sqliteStore.ts + 1 more                 | `░░░░░░░░░░░░░░░░░░░░`&nbsp;2.5%&nbsp;·&nbsp;7.4&nbsp;kB                                        |
| &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;↳ 2 smaller files     | `░░░░░░░░░░░░░░░░░░░░`&nbsp;2.5%&nbsp;·&nbsp;7.4&nbsp;kB                                        |
| &nbsp;&nbsp;&nbsp;&nbsp;(bundler output, whitespace & JSON)           | `███░░░░░░░░░░░░░░░░░`&nbsp;13.1%&nbsp;·&nbsp;38.9&nbsp;kB                                      |

Bars show each row's share of its output file. ↳ rows are part of the row above.

- n more = the row also holds n more files from the same package or folder, each no larger than the one named. A package can appear under several output files, each holding different files, never the same file twice.

(bundler output, whitespace & JSON) = bytes Sonda can't trace to a source file: whitespace (indentation and line breaks), code the bundler generates (region comments, the combined import/export lines, its small runtime helper and wrappers), and imported JSON such as `config.json`, which the bundler doesn't map. The JSON and the generated code are real bytes that ship; the whitespace mostly disappears once compressed.

<!-- BUNDLE_END -->

<!-- QUALITY_SECURITY_START -->

## Quality & Security

This section is updated each time `npm run document` is run. Settings come from the repository's workflow files and GitHub. Test coverage and the Fallow score are measured at the same time.

### Testing

| Check                | Status | What it does                                                                                                                                                                                                                                                                                                          |
| :------------------- | :----- | :-------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Unit tests           | ✅ On  | [Vitest](https://vitest.dev) runs the unit tests. Part of the [CI workflow](https://github.com/dpuse/dpuse-connector-sqlite-wasm/actions/workflows/ci.yml) on every push and pull request to `main`.                                                                                                                  |
| Property-based tests | ❌ Off | [fast-check](https://fast-check.dev) runs many random inputs per test to find edge cases, alongside the unit tests.                                                                                                                                                                                                   |
| Test coverage        | ✅ On  | ![Coverage](https://img.shields.io/endpoint?url=https%3A%2F%2Fraw.githubusercontent.com%2Fdpuse%2Fdpuse-connector-sqlite-wasm%2Fmain%2Fcode-health-reports%2Fvitest%2Fbadge.json) [Vitest's V8 coverage](https://vitest.dev/guide/coverage) measures the share of source lines the unit tests run. The target is 80%. |

### Code Quality

| Check         | Status | What it does                                                                                                                                                                                                                                                                                                           |
| :------------ | :----- | :--------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Code analysis | ✅ On  | [![Quality Gate Status](https://sonarcloud.io/api/project_badges/measure?project=dpuse_dpuse-connector-sqlite-wasm&metric=alert_status)](https://sonarcloud.io/summary/new_code?id=dpuse_dpuse-connector-sqlite-wasm) [SonarCloud](https://sonarcloud.io) checks every push for bugs, code smells and vulnerabilities. |
| Linting       | ✅ On  | [ESLint](https://eslint.org) checks the code for errors and style problems. Part of the [CI workflow](https://github.com/dpuse/dpuse-connector-sqlite-wasm/actions/workflows/ci.yml) on every push and pull request to `main`.                                                                                         |

### Security Analysis

| Check           | Status | What it does                                                                                                                                                                                                                                                                                                                                                                                     |
| :-------------- | :----- | :----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Push protection | ❌ Off | [GitHub push protection](https://docs.github.com/en/code-security/secret-scanning/push-protection-for-repositories-and-organizations) blocks pushes that contain credentials.                                                                                                                                                                                                                    |
| Static analysis | ✅ On  | [![CodeQL](https://github.com/dpuse/dpuse-connector-sqlite-wasm/actions/workflows/codeql.yml/badge.svg)](https://github.com/dpuse/dpuse-connector-sqlite-wasm/security/code-scanning) [CodeQL](https://codeql.github.com) scans GitHub Actions and JavaScript/TypeScript for security vulnerabilities, using the extended security queries, on every push and pull request to `main` and weekly. |
| Secret scanning | ❌ Off | [GitHub secret scanning](https://docs.github.com/en/code-security/secret-scanning) detects credentials, such as API keys and tokens, committed to the repository.                                                                                                                                                                                                                                |

### Dependencies

| Check               | Status | What it does                                                                                                                                                                                                                                                                                                                       |
| :------------------ | :----- | :--------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Vulnerability audit | ✅ On  | [npm audit](https://docs.npmjs.com/cli/commands/npm-audit) fails when a shipped dependency has any known vulnerability, or a development dependency has a high or critical one. Part of the [CI workflow](https://github.com/dpuse/dpuse-connector-sqlite-wasm/actions/workflows/ci.yml) on every push and pull request to `main`. |
| Supply chain risk   | ✅ On  | [Socket](https://socket.dev) flags malicious packages, typosquatting and suspicious behaviour that may not yet have a CVE.                                                                                                                                                                                                         |
| Security alerts     | ✅ On  | [Dependabot](https://docs.github.com/en/code-security/dependabot) alerts when a dependency has a known vulnerability, using the GitHub Advisory Database.                                                                                                                                                                          |
| Security updates    | ❌ Off | [Dependabot](https://docs.github.com/en/code-security/dependabot) opens pull requests that update vulnerable dependencies. These are handled manually.                                                                                                                                                                             |
| Version updates     | ❌ Off | [Dependabot](https://docs.github.com/en/code-security/dependabot) opens pull requests for new dependency versions. These are handled manually.                                                                                                                                                                                     |

### OpenSSF 🚧

[![OpenSSF Scorecard](https://api.scorecard.dev/projects/github.com/dpuse/dpuse-connector-sqlite-wasm/badge)](https://scorecard.dev/viewer/?uri=github.com/dpuse/dpuse-connector-sqlite-wasm)

This project is working towards the [OpenSSF Best Practices](https://www.bestpractices.dev) Passing badge, a self-certification covering security policy, vulnerability reporting, build processes, code quality, and more. Currently the [OpenSSF Scorecard](https://scorecard.dev) provides an independent automated assessment of the project's security practices and is an ongoing area of improvement.

### Reporting Vulnerabilities

Please do not open public GitHub issues for security vulnerabilities. See [SECURITY.md](./SECURITY.md) for how to report one privately, the full disclosure policy, and expected response times.

<!-- QUALITY_SECURITY_END -->

<!-- CONTRIBUTING_LICENSE_START -->

## Contributing

This repository is maintained solely by its owner and does not, at present, accept external contributions into the canonical repo. Its source is published openly under the MIT License — every DPUse project is fully open source except DPUse Engine, which remains closed and proprietary.

For security vulnerabilities, see [Reporting Vulnerabilities](#reporting-vulnerabilities). For bugs, inconsistencies, or other feedback, [open a GitHub issue](https://github.com/dpuse/dpuse-connector-sqlite-wasm/issues) — feedback is read, but responses and fixes are at the maintainer's discretion.

## License

This project is licensed under the MIT License, permitting free use, modification, and distribution.

[MIT](./LICENSE) © 2026 Jonathan Terrell

<!-- CONTRIBUTING_LICENSE_END -->
