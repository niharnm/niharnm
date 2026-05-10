# Daily GitHub Maintenance Automation

This folder supports the scheduled GitHub Actions workflow in `.github/workflows/daily-github-maintenance.yml`.

The workflow uses GitHub Models from GitHub-hosted Actions, so it does not need an OpenAI API key and does not depend on a laptop being on.

## Required secrets

None for model calls. The workflow uses GitHub's built-in `GITHUB_TOKEN` with `models: read` permission for GitHub Models.

## Recommended secret for cross-repo writes

If the automation should edit repositories other than `niharnm/niharnm`, add this repository secret under **Settings -> Secrets and variables -> Actions -> Repository secrets**:

- `GH_AUTOMATION_TOKEN`: a GitHub personal access token with access only to the repositories in `targets.txt`. Grant the minimum permissions needed: Contents read/write, Pull requests read/write, and Metadata read.

For the optional project fallback to create `niharnm/trend-build-lab` automatically, `GH_AUTOMATION_TOKEN` must also be allowed to create repositories. If it cannot create a repo, the fallback will skip and report the reason.

Without `GH_AUTOMATION_TOKEN`, GitHub's default `GITHUB_TOKEN` can normally write only to this repository.

## Optional repository variables

Set these under **Settings -> Secrets and variables -> Actions -> Variables** if you want to override defaults:

- `TARGET_REPOS`: comma-separated `owner/repo` list. If omitted, the workflow reads `.github/automation/targets.txt`.
- `GITHUB_MODELS_MODEL`: GitHub Models model id. Defaults to `openai/gpt-4.1-mini`.
- `ALLOW_DIRECT_COMMITS`: `true` or `false`. Defaults to `true`; the runner still limits direct commits to small README-only changes.
- `MAX_DAILY_CHANGES`: maximum useful changes per run. Defaults to `5` and is clamped from `1` to `5`.
- `ALLOW_PROJECT_FALLBACK`: `true` or `false`. Defaults to `true`.
- `PROJECT_FALLBACK_REPO`: fallback repo for trend-inspired static projects. Defaults to `niharnm/trend-build-lab`.

## Behavior

The runner uses a variable daily useful-change budget from `1` through `MAX_DAILY_CHANGES`. That budget controls how many useful changes it may attempt, not how many commits it must force.

If no safe maintenance change is found, the fallback can build one small static web project in the fallback repo. It uses public trend signals from Google Trends RSS and Hacker News RSS, then commits a small vanilla HTML/CSS/JS project under `projects/`.

## Safety behavior

The GitHub Models runner is intentionally conservative:

- It never creates filler commits just to force activity.
- It makes at most the configured number of useful changes per run.
- Maintenance edits are README-only and safety checked.
- It skips changes that look too large, empty, filler-like, or unrelated.
- It rejects new guessed localhost ports in README updates.
- It runs `git diff --check` before committing.
- If direct push is disabled or unavailable, maintenance edits open a pull request instead.
