# Repository Guidelines

## Project Structure & Module Organization
- `src/extension.ts` registers commands and wires status bar UI.
- `src/metrics.ts` collects CPU, memory, and disk data; `src/formatter.ts` builds tooltips and clipboard payloads.
- Tests live in `src/test`; mirror features with `*.test.ts` and keep helpers beside suites when possible.
- Compiled output is stored in `out/` (generated; do not edit); assets stay in `images/`.
- Release artifacts (`*.vsix`) and docs (`README.md`, `CHANGELOG.md`) sit in the repository root; automation is under `.github/workflows`.

## Build, Test, and Development Commands
- `npm install` restores dependencies.
- `npm run compile` runs the TypeScript build into `out/`.
- `npm run watch` keeps the compiler active during iteration.
- `npm run lint` executes ESLint with the shared config in `eslint.config.mjs`.
- `npm test` launches the VS Code integration tests (pretest runs compile and lint).
- `npm run package` produces a `.vsix` distributable via `vsce`.

## Coding Style & Naming Conventions
- Use TypeScript strict mode defaults, four-space indentation, and trailing semicolons.
- Prefer single quotes; use template literals only when interpolation brings clarity.
- Name classes and types in `PascalCase`, functions and variables in `camelCase`, and constants in `UPPER_SNAKE_CASE`.
- Keep import specifiers `camelCase` or `PascalCase` to satisfy the enforced naming rule.
- Run `npm run lint` before pushing; avoid disabling warnings without a follow-up issue.

## Testing Guidelines
- Tests use Mocha through `@vscode/test-cli`; keep them under `src/test`.
- Follow `<feature>.test.ts` naming and group `describe` blocks by commands or formatting behaviours.
- Mock timers with VS Code helpers when verifying update intervals.
- Assert tooltip and clipboard output whenever metrics logic changes.
- Always run `npm test` (or `npm run compile` plus targeted suites) before opening a PR.

## Commit & Pull Request Guidelines
- Adopt Conventional Commits (`feat:`, `fix:`, `refactor:`, `docs:`) as seen in history.
- Limit commits to a single concern and update `CHANGELOG.md` for user-visible changes.
- PR descriptions should cover problem, solution, and test evidence (`npm test`, lint results).
- Link related issues with `#ID` and capture status bar screenshots for UX updates.
- Request review for significant refactors or dependency bumps and mention manual verification steps.
