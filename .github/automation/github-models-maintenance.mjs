#!/usr/bin/env node

import { appendFile, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const repoRoot = process.env.GITHUB_WORKSPACE || process.cwd();
const model = process.env.GITHUB_MODELS_MODEL || 'openai/gpt-4.1-mini';
const modelsToken = process.env.GITHUB_MODELS_TOKEN || process.env.GITHUB_TOKEN;
const gitToken = process.env.GH_TOKEN || process.env.GH_AUTOMATION_TOKEN || process.env.GITHUB_TOKEN;
const allowDirectCommits = String(process.env.ALLOW_DIRECT_COMMITS || 'true').toLowerCase() === 'true';
const allowProjectFallback = String(process.env.ALLOW_PROJECT_FALLBACK || 'true').toLowerCase() === 'true';
const projectFallbackRepo = process.env.PROJECT_FALLBACK_REPO || 'niharnm/trend-build-lab';
const maxDailyChanges = clamp(Number.parseInt(process.env.MAX_DAILY_CHANGES || '3', 10) || 3, 1, 5);
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

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

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

function dailyChangeBudget() {
  const key = [
    new Date().toISOString().slice(0, 10),
    process.env.GITHUB_RUN_NUMBER || '0',
    process.env.GITHUB_REPOSITORY || 'repo',
  ].join(':');
  let hash = 0;
  for (const char of key) hash = ((hash * 31) + char.charCodeAt(0)) >>> 0;
  return 1 + (hash % maxDailyChanges);
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

async function askProjectBuild(signals) {
  const signalText = signals.slice(0, 18).map((item, index) => {
    return `${index + 1}. [${item.source}] ${item.title}${item.link ? ` - ${item.link}` : ''}`;
  }).join('\n');

  const prompt = [
    'Use the trend signals below to propose and generate one small, useful static web project.',
    'The project must be safe, original, and not a clone of a specific product or a fan page for a person.',
    'Prefer practical tools, visual explainers, dashboards, calculators, study helpers, or local-first utilities.',
    'Use only vanilla HTML, CSS, and JavaScript. No package manager, build step, external scripts, tracking, ads, or network calls from the app.',
    'Return exactly one JSON object with this shape:',
    '{"project_slug":"short-kebab-slug","project_name":"Project Name","rationale":"why this is useful","commit_message":"feat: start project name","files":[{"path":"README.md","content":"markdown"},{"path":"index.html","content":"html"},{"path":"styles.css","content":"css"},{"path":"app.js","content":"javascript"}]}',
    'Allowed file paths are README.md, index.html, styles.css, app.js, and data.json. Include at least README.md, index.html, styles.css, and app.js.',
    'Trend signals:',
    signalText || 'No live trend signals were available; build a generally useful local-first web utility.',
  ].join('\n\n');

  const content = await completeWithGithubModels({
    model,
    temperature: 0.45,
    max_tokens: 16000,
    messages: [
      { role: 'system', content: 'You generate small, complete, useful static web projects. Return JSON only.' },
      { role: 'user', content: prompt },
    ],
  });

  return extractJson(content);
}

function cleanCommitMessage(message) {
  const firstLine = String(message || '').split('\n')[0].trim().replace(/[.]+$/, '');
  const cleaned = firstLine.slice(0, 80);
  if (!cleaned) return 'docs: clarify README guidance';
  if (/^(docs|feat|fix|chore|test|refactor)(\(.+\))?: /i.test(cleaned)) return cleaned;
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

function decodeXml(text) {
  return String(text || '')
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/<[^>]+>/g, '')
    .trim();
}

function xmlField(block, tag) {
  const match = block.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i'));
  return decodeXml(match?.[1] || '');
}

function parseRssItems(xml, source) {
  const itemBlocks = String(xml || '').match(/<item[\s\S]*?<\/item>/gi) || [];
  return itemBlocks.map((block) => ({
    source,
    title: xmlField(block, 'title'),
    link: xmlField(block, 'link'),
  })).filter((item) => item.title).slice(0, 12);
}

async function fetchText(url) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);
  try {
    const response = await fetch(url, { signal: controller.signal, headers: { 'User-Agent': 'github-models-maintenance/1.0' } });
    if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
    return await response.text();
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchTrendSignals() {
  const sources = [
    { name: 'Google Trends US', url: 'https://trends.google.com/trending/rss?geo=US' },
    { name: 'Hacker News', url: 'https://hnrss.org/frontpage' },
  ];
  const signals = [];
  for (const source of sources) {
    try {
      const xml = await fetchText(source.url);
      signals.push(...parseRssItems(xml, source.name));
    } catch (error) {
      console.log(`Trend source skipped: ${source.name}: ${cleanLog(error.message)}`);
    }
  }
  return signals;
}

function projectSlug(value) {
  const slug = String(value || 'trend-tool')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  return slug || 'trend-tool';
}

function safeProjectFiles(files) {
  const allowed = new Set(['README.md', 'index.html', 'styles.css', 'app.js', 'data.json']);
  const normalized = [];
  for (const file of Array.isArray(files) ? files : []) {
    const filePath = String(file.path || '').replace(/^\.\//, '');
    const content = String(file.content || '');
    if (!allowed.has(filePath)) continue;
    if (!content.trim() || content.length > 20000) continue;
    if (filePath === 'index.html' && /<script\s+[^>]*src\s*=\s*["']https?:/i.test(content)) continue;
    normalized.push({ path: filePath, content: content.endsWith('\n') ? content : `${content}\n` });
  }
  const required = new Set(['README.md', 'index.html', 'styles.css', 'app.js']);
  for (const file of normalized) required.delete(file.path);
  if (required.size) throw new Error(`Project proposal was missing required files: ${[...required].join(', ')}`);
  return normalized.slice(0, 6);
}

function ensureProjectRepo(repo, workDir) {
  const repoDir = path.join(workDir, repo.replace(/[\/]/g, '__'));
  const clone = run('git', ['clone', '--depth', '25', `https://github.com/${repo}.git`, repoDir], { allowFailure: true });
  if (clone.status === 0) return { repoDir, created: false };

  const create = run('gh', [
    'repo', 'create', repo,
    '--public',
    '--description', 'Small trend-inspired project experiments built from public signals',
  ], { allowFailure: true });
  if (create.status !== 0) {
    throw new Error(`Could not clone or create ${repo}: ${clone.stderr || clone.stdout}\n${create.stderr || create.stdout}`);
  }

  run('git', ['clone', `https://github.com/${repo}.git`, repoDir]);
  return { repoDir, created: true };
}

async function tryProjectFallback(workDir) {
  if (!allowProjectFallback) return { changed: false, reason: 'Project fallback is disabled.' };

  const signals = await fetchTrendSignals();
  const proposal = await askProjectBuild(signals);
  const slug = projectSlug(proposal.project_slug || proposal.project_name);
  const date = new Date().toISOString().slice(0, 10);
  const projectDirName = `${date}-${slug}`;
  const files = safeProjectFiles(proposal.files);
  const { repoDir, created } = ensureProjectRepo(projectFallbackRepo, workDir);

  const hasHead = run('git', ['rev-parse', '--verify', 'HEAD'], { cwd: repoDir, allowFailure: true }).status === 0;
  let baseBranch = run('git', ['branch', '--show-current'], { cwd: repoDir, allowFailure: true }).stdout.trim() || 'main';
  if (!hasHead) {
    run('git', ['checkout', '-B', baseBranch], { cwd: repoDir });
  }

  const projectRoot = path.join(repoDir, 'projects', projectDirName);
  const finalProjectDirName = existsSync(projectRoot) ? `${projectDirName}-${process.env.GITHUB_RUN_NUMBER || Date.now()}` : projectDirName;
  const finalProjectRoot = path.join(repoDir, 'projects', finalProjectDirName);
  await mkdir(finalProjectRoot, { recursive: true });

  for (const file of files) {
    await writeFile(path.join(finalProjectRoot, file.path), file.content, 'utf8');
  }

  const rootReadme = path.join(repoDir, 'README.md');
  let readme = existsSync(rootReadme)
    ? await readFile(rootReadme, 'utf8')
    : '# Trend Build Lab\n\nSmall static projects generated from public trend signals and maintained as real code experiments.\n\n## Projects\n';
  if (!/## Projects/.test(readme)) readme += '\n## Projects\n';
  const projectName = String(proposal.project_name || finalProjectDirName).trim();
  const rationale = String(proposal.rationale || 'Built from public trend signals as a small static project experiment.').trim();
  readme += `\n- [${projectName}](projects/${finalProjectDirName}/) - ${rationale}\n`;
  await writeFile(rootReadme, readme.endsWith('\n') ? readme : `${readme}\n`, 'utf8');

  run('git', ['add', 'README.md', `projects/${finalProjectDirName}`], { cwd: repoDir });
  run('git', ['diff', '--cached', '--check'], { cwd: repoDir });
  const diff = run('git', ['diff', '--cached', '--stat'], { cwd: repoDir }).stdout.trim();
  if (!diff) return { changed: false, reason: 'Project fallback produced no diff.' };

  const commitMessage = cleanCommitMessage(proposal.commit_message || `feat: start ${projectName}`);
  run('git', ['commit', '-m', commitMessage], { cwd: repoDir });
  run('git', ['push', 'origin', `HEAD:${baseBranch}`], { cwd: repoDir });
  const sha = run('git', ['rev-parse', 'HEAD'], { cwd: repoDir }).stdout.trim();

  return {
    changed: true,
    repo: projectFallbackRepo,
    link: `https://github.com/${projectFallbackRepo}/commit/${sha}`,
    files: ['README.md', `projects/${finalProjectDirName}/`],
    summary: created ? `Created ${projectFallbackRepo} and added ${projectName}.` : `Added ${projectName} to the trend build lab.`,
    whyUseful: rationale,
    check: 'git diff --cached --check',
  };
}

function formatChanges(changes) {
  if (!changes.length) return ['- Repo changed: none', '- Link: none', '- Files changed: none'];
  return changes.flatMap((change, index) => [
    `### Change ${index + 1}`,
    `- Repo changed: ${change.repo}`,
    `- Link: ${change.link}`,
    `- Files changed: ${change.files.join(', ')}`,
    `- Improved: ${change.summary || 'Project maintenance'}`,
    `- Why useful: ${change.whyUseful || 'Useful, reviewable repository work.'}`,
    `- Checks: ${change.check}`,
    '',
  ]);
}

async function main() {
  if (!modelsToken) throw new Error('Missing GITHUB_MODELS_TOKEN or GITHUB_TOKEN.');
  if (!gitToken) throw new Error('Missing GH_TOKEN/GH_AUTOMATION_TOKEN/GITHUB_TOKEN for git writes.');

  const targets = parseTargets();
  if (!targets.length) throw new Error('No TARGET_REPOS configured.');

  const targetBudget = dailyChangeBudget();
  const policy = await readFile(path.join(repoRoot, '.github/automation/daily-maintenance-prompt.md'), 'utf8');
  const workDir = await mkdtemp(path.join(tmpdir(), 'github-models-maintenance-'));
  const changes = [];
  const skips = [];

  for (const repo of rotatedTargets(targets)) {
    if (changes.length >= targetBudget) break;
    console.log(`Inspecting ${repo} with ${model}`);
    try {
      const result = await tryRepo(repo, workDir, policy);
      if (result.changed) changes.push(result);
      else skips.push(`- ${repo}: ${result.reason}`);
    } catch (error) {
      skips.push(`- ${repo}: ${cleanLog(error.message)}`);
    }
  }

  if (!changes.length) {
    try {
      const fallback = await tryProjectFallback(workDir);
      if (fallback.changed) changes.push(fallback);
      else skips.push(`- ${projectFallbackRepo}: ${fallback.reason}`);
    } catch (error) {
      skips.push(`- ${projectFallbackRepo}: ${cleanLog(error.message)}`);
    }
  }

  await writeResult([
    '## Daily GitHub Maintenance',
    '',
    `- Useful-change budget for this run: ${targetBudget}`,
    `- Changes made: ${changes.length}`,
    `- Model: ${model}`,
    '',
    ...formatChanges(changes),
    changes.length ? '' : '- Improved: none',
    changes.length ? '' : '- Why useful: no safe maintenance update or fallback project could be completed',
    skips.length ? 'Skipped candidates:' : '',
    ...skips,
  ].filter((line) => line !== '').join('\n'));
}

main().catch(async (error) => {
  const message = cleanLog(error.stack || error.message || error);
  await writeResult(`## Daily GitHub Maintenance\n\nRun failed before safe changes could be made.\n\n\`\`\`\n${message}\n\`\`\``);
  process.exit(1);
});
