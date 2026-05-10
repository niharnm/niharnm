#!/usr/bin/env node

import { appendFile, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const repoRoot = process.env.GITHUB_WORKSPACE || process.cwd();
const model = process.env.GITHUB_MODELS_MODEL || 'openai/gpt-4.1-mini';
const modelsToken = process.env.GITHUB_MODELS_TOKEN || process.env.GITHUB_TOKEN;
const gitToken = process.env.GH_TOKEN || process.env.GH_AUTOMATION_TOKEN || process.env.GITHUB_TOKEN;
const allowDirectCommits = String(process.env.ALLOW_DIRECT_COMMITS || 'true').toLowerCase() === 'true';
const resultFile = process.env.GITHUB_MODELS_RESULT_FILE;
const runUrl = process.env.GITHUB_SERVER_URL && process.env.GITHUB_REPOSITORY && process.env.GITHUB_RUN_ID
  ? `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}`
  : '';

const secretValues = [
  modelsToken,
  gitToken,
  process.env.GITHUB_TOKEN,
  process.env.GH_TOKEN,
  process.env.GH_AUTOMATION_TOKEN,
].filter(Boolean);

function cleanLog(text) {
  let output = String(text || '');
  for (const secret of secretValues) output = output.split(secret).join('***');
  return output;
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd || repoRoot,
    encoding: 'utf8',
    maxBuffer: 12 * 1024 * 1024,
    env: { ...process.env, ...(options.env || {}) },
  });

  if (result.error) throw result.error;
  if (result.status !== 0 && !options.allowFailure) {
    throw new Error([
      `Command failed: ${command} ${args.join(' ')}`,
      cleanLog(result.stdout),
      cleanLog(result.stderr),
    ].filter(Boolean).join('\n'));
  }

  return {
    stdout: cleanLog(result.stdout || ''),
    stderr: cleanLog(result.stderr || ''),
    status: result.status,
  };
}

function parseTargets() {
  return String(process.env.TARGET_REPOS || '')
    .split(/[\n,]/)
    .map((repo) => repo.trim())
    .filter((repo) => repo && !repo.startsWith('#'))
    .filter((repo, index, repos) => repos.indexOf(repo) === index);
}

function rotatedTargets(targets) {
  if (targets.length < 2) return targets;
  const runNumber = Number.parseInt(process.env.GITHUB_RUN_NUMBER || '0', 10) || 0;
  const offset = runNumber % targets.length;
  const rotated = targets.slice(offset).concat(targets.slice(0, offset));
  const hostRepo = process.env.GITHUB_REPOSITORY;

  return rotated
    .map((repo, index) => ({ repo, index }))
    .sort((a, b) => {
      const aIsHost = a.repo === hostRepo ? 1 : 0;
      const bIsHost = b.repo === hostRepo ? 1 : 0;
      return aIsHost - bIsHost || a.index - b.index;
    })
    .map((entry) => entry.repo);
}

async function writeResult(markdown) {
  console.log(markdown);
  if (resultFile) await writeFile(resultFile, `${markdown}\n`, 'utf8');
  if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, `${markdown}\n`, 'utf8');
}

function findReadme(repoDir) {
  const files = run('git', ['ls-files'], { cwd: repoDir }).stdout
    .split('\n')
    .map((file) => file.trim())
    .filter(Boolean);
  const rootReadme = files.find((file) => file.toLowerCase() === 'readme.md');
  if (rootReadme) return { readmePath: rootReadme, files };
  const shallowReadme = files.find((file) => file.toLowerCase().endsWith('/readme.md') && file.split('/').length <= 2);
  return { readmePath: shallowReadme || null, files };
}

function extractJson(text) {
  const trimmed = String(text || '').trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    const match = trimmed.match(/\{[\s\S]*\}/);
    if (!match) throw new Error(`Model did not return JSON: ${trimmed.slice(0, 500)}`);
    return JSON.parse(match[0]);
  }
}

async function summarizePackageJson(repoDir) {
  const packagePath = path.join(repoDir, 'package.json');
  if (!existsSync(packagePath)) return '';
  try {
    const parsed = JSON.parse(await readFile(packagePath, 'utf8'));
    return JSON.stringify({
      name: parsed.name,
      scripts: parsed.scripts,
      dependencies: parsed.dependencies ? Object.keys(parsed.dependencies).slice(0, 20) : undefined,
      devDependencies: parsed.devDependencies ? Object.keys(parsed.devDependencies).slice(0, 20) : undefined,
    }, null, 2);
  } catch {
    return '';
  }
}

async function completeWithGithubModels(payload, allowJsonMode = true) {
  const response = await fetch('https://models.github.ai/inference/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${modelsToken}`,
      Accept: 'application/vnd.github+json',
      'Content-Type': 'application/json',
      'X-GitHub-Api-Version': '2022-11-28',
    },
    body: JSON.stringify(allowJsonMode ? { ...payload, response_format: { type: 'json_object' } } : payload),
  });

  const bodyText = await response.text();
  if (!response.ok) {
    if (allowJsonMode && /response_format|json_object/i.test(bodyText)) {
      return completeWithGithubModels(payload, false);
    }
    throw new Error(`GitHub Models request failed (${response.status}): ${cleanLog(bodyText)}`);
  }

  const body = JSON.parse(bodyText);
  return body.choices?.[0]?.message?.content || '';
}

async function askGithubModels({ repo, readmePath, readme, files, packageJson, recentCommits, policy }) {
  const prompt = [
    `Repository: ${repo}`,
    `Candidate file: ${readmePath}`,
    `Recent commits:\n${recentCommits}`,
    `Tracked files, first 120:\n${files.slice(0, 120).join('\n')}`,
    packageJson ? `package.json summary:\n${packageJson}` : '',
    `Current ${readmePath}:\n---BEGIN README---\n${readme}\n---END README---`,
    'Return exactly one JSON object with this shape:',
    '{"should_change":true,"file_path":"README.md","replacement":"full replacement markdown","commit_message":"docs: clarify setup","summary":"one sentence","why_useful":"one sentence"}',
    'Set should_change to false if there is no concrete, useful README improvement. Only edit the candidate README file. Preserve correct existing information. Do not add timestamps, badges, fake features, generated-by text, automation notes, localhost ports not already documented, or filler.',
  ].filter(Boolean).join('\n\n');

  const content = await completeWithGithubModels({
    model,
    temperature: 0.2,
    max_tokens: 12000,
    messages: [
      {
        role: 'system',
        content: `${policy}\n\nYou are a conservative README maintenance planner. You do not execute commands. Return JSON only.`,
      },
      { role: 'user', content: prompt },
    ],
  });

  return extractJson(content);
}

function cleanCommitMessage(message) {
  const firstLine = String(message || '').split('\n')[0].trim().replace(/[.]+$/, '');
  const cleaned = firstLine.slice(0, 80);
  if (!cleaned) return 'docs: clarify README guidance';
  if (/^(docs|fix|chore|test|refactor)(\(.+\))?: /i.test(cleaned)) return cleaned;
  return `docs: ${cleaned.charAt(0).toLowerCase()}${cleaned.slice(1)}`.slice(0, 80);
}

function changedLineCount(diff) {
  return diff.split('\n').filter((line) => {
    if (line.startsWith('+++') || line.startsWith('---')) return false;
    return line.startsWith('+') || line.startsWith('-');
  }).length;
}

function introducedLocalhostPort(original, replacement) {
  const portPattern = /localhost:\d{2,5}/gi;
  const existingPorts = new Set((original.match(portPattern) || []).map((port) => port.toLowerCase()));
  return (replacement.match(portPattern) || []).some((port) => !existingPorts.has(port.toLowerCase()));
}

function pushBranchAndCreatePr({ repoDir, repo, baseBranch, branchName, title, body }) {
  run('git', ['push', '-u', 'origin', branchName], { cwd: repoDir });
  const output = run('gh', [
    'pr', 'create',
    '--repo', repo,
    '--base', baseBranch,
    '--head', branchName,
    '--title', title,
    '--body', body,
  ], { cwd: repoDir }).stdout.trim();
  return output.split('\n').find((line) => /^https?:\/\//.test(line)) || output;
}

async function tryRepo(repo, workDir, policy) {
  const repoDir = path.join(workDir, repo.replace(/[\/]/g, '__'));
  run('git', ['clone', '--depth', '25', `https://github.com/${repo}.git`, repoDir]);
  const baseBranch = run('git', ['branch', '--show-current'], { cwd: repoDir }).stdout.trim();
  const recentCommits = run('git', ['log', '--oneline', '-n', '8'], { cwd: repoDir }).stdout.trim();
  const { readmePath, files } = findReadme(repoDir);

  if (!readmePath) return { changed: false, reason: 'No README.md candidate found.' };

  const readmeFile = path.join(repoDir, readmePath);
  const original = await readFile(readmeFile, 'utf8');
  if (original.length > 18000) {
    return { changed: false, reason: `${readmePath} is too large for safe free-model replacement.` };
  }

  const packageJson = await summarizePackageJson(repoDir);
  const proposal = await askGithubModels({ repo, readmePath, readme: original, files, packageJson, recentCommits, policy });

  if (!proposal.should_change) return { changed: false, reason: proposal.summary || 'Model found no useful README change.' };
  if (proposal.file_path !== readmePath) {
    return { changed: false, reason: `Model tried to edit ${proposal.file_path}; only ${readmePath} is allowed.` };
  }

  let replacement = String(proposal.replacement || '');
  if (!replacement.trim()) return { changed: false, reason: 'Model returned an empty replacement.' };
  if (!replacement.endsWith('\n')) replacement += '\n';

  if (replacement.length < Math.max(80, original.length * 0.45) || replacement.length > original.length * 2.2) {
    return { changed: false, reason: 'Replacement size looked unsafe, so it was skipped.' };
  }
  if (/generated by|daily maintenance|automation run|streak/i.test(replacement)) {
    return { changed: false, reason: 'Replacement contained automation/filler wording, so it was skipped.' };
  }
  if (introducedLocalhostPort(original, replacement)) {
    return { changed: false, reason: 'Replacement introduced a localhost port that was not already documented.' };
  }

  await writeFile(readmeFile, replacement, 'utf8');
  const diff = run('git', ['diff', '--', readmePath], { cwd: repoDir }).stdout;
  if (!diff.trim()) return { changed: false, reason: 'Replacement produced no diff.' };

  const touchedLines = changedLineCount(diff);
  if (touchedLines > 90) {
    run('git', ['checkout', '--', readmePath], { cwd: repoDir, allowFailure: true });
    return { changed: false, reason: `Diff touched ${touchedLines} lines, over the safety limit.` };
  }

  run('git', ['diff', '--check'], { cwd: repoDir });
  const commitMessage = cleanCommitMessage(proposal.commit_message);
  run('git', ['add', readmePath], { cwd: repoDir });

  if (!allowDirectCommits) {
    const branchName = `automation/github-models-${Date.now()}`;
    run('git', ['switch', '-c', branchName], { cwd: repoDir });
    run('git', ['commit', '-m', commitMessage], { cwd: repoDir });
    const prBody = `${proposal.summary || 'README maintenance update.'}\n\nRun: ${runUrl || 'GitHub Actions'}`;
    const prUrl = pushBranchAndCreatePr({ repoDir, repo, baseBranch, branchName, title: commitMessage, body: prBody });
    return { changed: true, repo, link: prUrl, files: [readmePath], summary: proposal.summary, whyUseful: proposal.why_useful, check: 'git diff --check' };
  }

  run('git', ['commit', '-m', commitMessage], { cwd: repoDir });
  try {
    run('git', ['push', 'origin', `HEAD:${baseBranch}`], { cwd: repoDir });
    const sha = run('git', ['rev-parse', 'HEAD'], { cwd: repoDir }).stdout.trim();
    return { changed: true, repo, link: `https://github.com/${repo}/commit/${sha}`, files: [readmePath], summary: proposal.summary, whyUseful: proposal.why_useful, check: 'git diff --check' };
  } catch {
    const branchName = `automation/github-models-${Date.now()}`;
    const prBody = `${proposal.summary || 'README maintenance update.'}\n\nDirect push failed, so this was opened as a PR.\n\nRun: ${runUrl || 'GitHub Actions'}`;
    const prUrl = pushBranchAndCreatePr({ repoDir, repo, baseBranch, branchName, title: commitMessage, body: prBody });
    return { changed: true, repo, link: prUrl, files: [readmePath], summary: proposal.summary, whyUseful: proposal.why_useful, check: 'git diff --check; direct push failed so opened PR' };
  }
}

async function main() {
  if (!modelsToken) throw new Error('Missing GITHUB_MODELS_TOKEN or GITHUB_TOKEN.');
  if (!gitToken) throw new Error('Missing GH_TOKEN/GH_AUTOMATION_TOKEN/GITHUB_TOKEN for git writes.');

  const targets = parseTargets();
  if (!targets.length) throw new Error('No TARGET_REPOS configured.');

  const policy = await readFile(path.join(repoRoot, '.github/automation/daily-maintenance-prompt.md'), 'utf8');
  const workDir = await mkdtemp(path.join(tmpdir(), 'github-models-maintenance-'));
  const skips = [];

  for (const repo of rotatedTargets(targets)) {
    console.log(`Inspecting ${repo} with ${model}`);
    try {
      const result = await tryRepo(repo, workDir, policy);
      if (result.changed) {
        await writeResult([
          '## Daily GitHub Maintenance',
          '',
          `- Repo changed: ${result.repo}`,
          `- Link: ${result.link}`,
          `- Files changed: ${result.files.join(', ')}`,
          `- Improved: ${result.summary || 'README documentation'}`,
          `- Why useful: ${result.whyUseful || 'Makes project setup or usage clearer.'}`,
          `- Checks: ${result.check}`,
          `- Model: ${model}`,
        ].join('\n'));
        return;
      }
      skips.push(`- ${repo}: ${result.reason}`);
    } catch (error) {
      skips.push(`- ${repo}: ${cleanLog(error.message)}`);
    }
  }

  await writeResult([
    '## Daily GitHub Maintenance',
    '',
    '- Repo changed: none',
    '- Link: none',
    '- Files changed: none',
    '- Improved: none',
    '- Why useful: no safe README update was found by the free GitHub Models runner',
    '- Checks: repository readback only',
    `- Model: ${model}`,
    '',
    'Skipped candidates:',
    ...skips,
  ].join('\n'));
}

main().catch(async (error) => {
  const message = cleanLog(error.stack || error.message || error);
  await writeResult(`## Daily GitHub Maintenance\n\nRun failed before a safe change could be made.\n\n\`\`\`\n${message}\n\`\`\``);
  process.exit(1);
});
