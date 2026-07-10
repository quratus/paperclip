#!/usr/bin/env node

import { readFileSync, existsSync } from 'fs';

const {
  PAPERCLIP_API_URL,
  PAPERCLIP_API_KEY,
  PAPERCLIP_COMPANY_ID,
  PAPERCLIP_RUN_ID,
  RUN_ISSUE_ID,
} = process.env;

const IMPLEMENTER_ID = 'fb080db2-ed18-48c1-80dc-fad19d0c3cf3';
const PROJECT_ID = '6179a8b9-b716-4e79-8b55-38f5c8871c97';

if (!PAPERCLIP_API_URL || !PAPERCLIP_API_KEY || !PAPERCLIP_COMPANY_ID || !RUN_ISSUE_ID) {
  console.error('Missing required env: PAPERCLIP_API_URL, PAPERCLIP_API_KEY, PAPERCLIP_COMPANY_ID, RUN_ISSUE_ID');
  process.exit(1);
}

const bugFile = process.argv[2];
if (!bugFile) {
  console.error('Usage: qa-output-contract.mjs <handoffs/qa-bugs-<timestamp>.json>');
  process.exit(1);
}

const { bugs } = JSON.parse(readFileSync(bugFile, 'utf8'));

function authHeaders(extra = {}) {
  const h = { 'Authorization': `Bearer ${PAPERCLIP_API_KEY}`, ...extra };
  if (PAPERCLIP_RUN_ID) h['X-Paperclip-Run-Id'] = PAPERCLIP_RUN_ID;
  return h;
}

async function apiGet(path) {
  const res = await fetch(`${PAPERCLIP_API_URL}${path}`, { headers: authHeaders() });
  if (!res.ok) throw new Error(`GET ${path} → ${res.status}: ${await res.text()}`);
  return res.json();
}

async function apiPost(path, body) {
  const res = await fetch(`${PAPERCLIP_API_URL}${path}`, {
    method: 'POST',
    headers: authHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`POST ${path} → ${res.status}: ${await res.text()}`);
  return res.json();
}

async function isDuplicate(bug) {
  const titleWords = bug.title.split(/\s+/).slice(0, 4).join(' ');
  const q = encodeURIComponent(titleWords);
  const issues = await apiGet(
    `/api/companies/${PAPERCLIP_COMPANY_ID}/issues?q=${q}&assigneeAgentId=${IMPLEMENTER_ID}&status=todo,in_progress,blocked`,
  );
  return issues.some(issue => {
    const text = `${issue.title} ${issue.description ?? ''}`.toLowerCase();
    return text.includes(bug.surface.toLowerCase()) && text.includes(titleWords.toLowerCase());
  });
}

async function fileIssue(bug) {
  const description = [
    `**Surface:** ${bug.surface}`,
    `**Repro:** ${bug.repro}`,
    `**Suspected file:** \`${bug.suspected_file}\``,
    `**Suspected area:** \`${bug.suspected_area}\``,
  ].join('\n\n');

  return apiPost(`/api/companies/${PAPERCLIP_COMPANY_ID}/issues`, {
    title: bug.title,
    description,
    assigneeAgentId: IMPLEMENTER_ID,
    priority: bug.severity,
    parentId: RUN_ISSUE_ID,
    projectId: PROJECT_ID,
    status: 'todo',
  });
}

async function attachScreenshot(issueId, screenshotPath) {
  if (!existsSync(screenshotPath)) {
    console.warn(`  Screenshot not found: ${screenshotPath} — skipping attachment`);
    return;
  }
  const form = new FormData();
  form.append(
    'file',
    new Blob([readFileSync(screenshotPath)], { type: 'image/png' }),
    screenshotPath.split('/').pop(),
  );
  const res = await fetch(
    `${PAPERCLIP_API_URL}/api/companies/${PAPERCLIP_COMPANY_ID}/issues/${issueId}/attachments`,
    { method: 'POST', headers: authHeaders(), body: form },
  );
  if (!res.ok) throw new Error(`Attachment upload → ${res.status}: ${await res.text()}`);
}

const filed = [];
let skipped = 0;

for (const bug of bugs) {
  if (await isDuplicate(bug)) {
    skipped++;
    continue;
  }
  const issue = await fileIssue(bug);
  await attachScreenshot(issue.id, bug.screenshot_path);
  filed.push(issue.identifier ?? issue.id);
}

const idList = filed.length ? ` Issues: [${filed.join(', ')}]` : '';
console.log(`Found ${bugs.length} bugs. Filed ${filed.length} new issues. Skipped ${skipped} (dedup).${idList}`);
