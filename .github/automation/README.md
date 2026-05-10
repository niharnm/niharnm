# Daily GitHub Maintenance Automation

This folder supports the scheduled GitHub Actions workflow in `.github/workflows/daily-github-maintenance.yml`.

The workflow now uses GitHub Models from GitHub-hosted Actions, so it does not need an OpenAI API key and does not depend on a laptop being on.

## Required secrets

None for model calls. The workflow uses GitHub's built-in `GITHUB_TOKEN` with `models: read` permission for GitHub Models.

## Recommended secret for cross-repo writes

If the automation should edit repositories other than `niharnm/niharnm`, add this repository secret under **Settings -> Secrets and variables -> Actions -> Repository secrets**:

- `GH_AUTOMATION_TOKEN`: a GitHub personal access token with access only to the repositories in `targets.txt`. Grant the minimum permissions needed: Contents read/write, Pull requests read/write, and Metadata read.

Without `GH_AUTOMATION_TOKEN`, GitHub's default `GITHUB_TOKEN` can normally write only to this repository.

## Optional repository variables

Set these under **Settings -> Secrets and variables -> Actions -> Variables** if you want to override defaults:

- `TARGET_REPOS`: comma-separated `owner/repo` list. If omitted, the workflow reads `.github/automation/targets.txt`.
- `GITHUB_MODELS_MODEL`: GitHub Models model id. Defaults to `openai/gpt-4.1-mini`.
- `ALLOW_DIRECT_COMMITS`: `true` or `false`. Defaults to `true`; the runner still limits direct commits to small README-only changes.

## Safety behavior

The free GitHub Models runner is intentionally conservative:

- It makes at most one change per run.
- It only edits a README candidate.
- It skips changes that look too large, empty, filler-like, or unrelated.
- It runs `git diff --check` before committing.
- If direct push is disabled or unavailable, it opens a pull request instead.
