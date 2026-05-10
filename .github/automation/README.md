# Daily GitHub Maintenance Automation

This folder supports the scheduled GitHub Actions workflow in `.github/workflows/daily-github-maintenance.yml`.

## Required secret

Add this repository secret under **Settings -> Secrets and variables -> Actions -> Repository secrets**:

- `OPENAI_API_KEY`: OpenAI API key used by Codex CLI in the hosted runner.

## Recommended secret for cross-repo writes

If the automation should edit repositories other than `niharnm/niharnm`, add:

- `GH_AUTOMATION_TOKEN`: a fine-grained GitHub personal access token with access only to the repositories in `targets.txt`. Grant the minimum permissions needed: Contents read/write, Pull requests read/write, and Metadata read.

Without `GH_AUTOMATION_TOKEN`, GitHub's default `GITHUB_TOKEN` can normally write only to this repository.

## Optional repository variables

Set these under **Settings -> Secrets and variables -> Actions -> Variables** if you want to override defaults:

- `TARGET_REPOS`: comma-separated `owner/repo` list. If omitted, the workflow reads `.github/automation/targets.txt`.
- `CODEX_MODEL`: model for Codex CLI. Defaults to `gpt-5.5`.
- `ALLOW_DIRECT_COMMITS`: `true` or `false`. Defaults to `true`; the prompt still limits direct commits to tiny, low-risk changes.

The workflow runs daily from GitHub-hosted infrastructure, so it does not depend on a laptop being on.