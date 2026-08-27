import fs from 'node:fs';
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';

const APP_URL = process.env.BLOOP_E2E_APP_URL ?? 'http://127.0.0.1:8082';
const SERVER_URL = process.env.BLOOP_E2E_SERVER_URL ?? 'wss://rgai-letta.resonancegroupusa.com';
const TOKEN_FILE = process.env.BLOOP_E2E_TOKEN_FILE ?? '/tmp/bloop-e2e-token';
const AGENT_ID = process.env.BLOOP_E2E_AGENT_ID ?? 'agent-local-0f4723b5-be01-46c5-82d2-064dab32254d';
const CONVERSATION_ID = fs.readFileSync(new URL('./.conversation-id', import.meta.url), 'utf8').trim();
const token = fs.readFileSync(TOKEN_FILE, 'utf8').trim();
const executablePath = process.env.BLOOP_E2E_CHROMIUM ?? `${process.env.HOME}/.cache/ms-playwright/chromium-1217/chrome-linux64/chrome`;

const browser = await chromium.launch({ headless: true, executablePath, args: ['--no-sandbox'] });
const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
const pageErrors = [];
page.on('pageerror', (error) => pageErrors.push(error.message));

async function seed() {
  const url = `${APP_URL}/dev-seed?type=remote&url=${encodeURIComponent(SERVER_URL)}&token=${encodeURIComponent(token)}`;
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.waitForURL('**/agents', { timeout: 20_000 });
  const profileId = await page.evaluate(() => JSON.parse(localStorage.getItem('letta.profiles.v1') || '[]')[0]?.id);
  assert.ok(profileId, 'dev seed did not create a profile');
  await page.evaluate((id) => localStorage.setItem(`milo.runtime.permission.v1:${id}`, 'unrestricted'), profileId);
}

function chatUrl() {
  return `${APP_URL}/chat?conversationId=${encodeURIComponent(CONVERSATION_ID)}&agentId=${encodeURIComponent(AGENT_ID)}&agentName=Milo&title=${encodeURIComponent('Bloop E2E reliability')}`;
}

async function waitConnected() {
  await page.getByText('Milo · Connected').waitFor({ timeout: 20_000 });
}


async function toolReloadRecovery() {
  const marker = `E2E_TOOL_${Date.now()}`;
  const finalMarker = `${marker}_DONE`;
  const prompt = `[BLOOP E2E] Use Bash to run: sleep 8; printf ${marker}. Then reply exactly ${finalMarker}.`;
  const bashBefore = await page.getByText(/Bash/).count();
  await page.locator('textarea[placeholder="Message Milo…"]').fill(prompt);
  await page.getByRole('button', { name: 'Send' }).click();
  await page.getByRole('button', { name: 'Stop' }).waitFor({ timeout: 10_000 });
  await page.waitForFunction(
    (count) => Array.from(document.querySelectorAll('body *')).filter((el) => /Bash/.test(el.textContent || '')).length > count,
    bashBefore,
    { timeout: 40_000 },
  );
  console.log('PASS tool-call-visible-before-reload');

  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.getByText(/Milo · (Running|Connected|Catching up…|Reconnecting…)/).waitFor({ timeout: 20_000 });
  await page.getByText(finalMarker, { exact: true }).waitFor({ timeout: 90_000 });
  console.log('PASS mid-tool-reload-recovers-final-answer');
  await page.getByText(/Bash/).last().waitFor({ timeout: 10_000 });
  console.log('PASS tool-card-survives-reload');
}
async function basicRoundTrip() {
  const marker = `E2E_OK_${Date.now()}`;
  const prompt = `[BLOOP E2E] Reply with exactly ${marker}.`;
  await page.locator('textarea[placeholder="Message Milo…"]').fill(prompt);
  await page.getByRole('button', { name: 'Send' }).click();
  await page.getByText(prompt, { exact: true }).waitFor({ timeout: 5_000 });
  console.log('PASS optimistic-user-visible');
  await page.getByText(marker, { exact: true }).waitFor({ timeout: 60_000 });
  console.log('PASS assistant-response-visible');
  await page.reload({ waitUntil: 'domcontentloaded' });
  await waitConnected();
  await page.getByText(prompt, { exact: true }).waitFor({ timeout: 15_000 });
  await page.getByText(marker, { exact: true }).waitFor({ timeout: 15_000 });
  console.log('PASS reload-history-reconstructs');
}

async function reasoningEffortPersists() {
  await page.getByRole('button', { name: /Model .*Change model/ }).click();
  await page.getByRole('button', { name: /^Effort medium(?:, selected)?$/ }).click();
  await page.waitForTimeout(1500);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await waitConnected();
  await page.getByRole('button', { name: /Model .*Change model/ }).click();
  await page.getByRole('button', { name: 'Effort medium, selected', exact: true }).waitFor({ timeout: 15_000 });
  console.log('PASS reasoning-effort-persists-and-highlights');
}

try {
  await seed();
  await page.goto(chatUrl(), { waitUntil: 'domcontentloaded' });
  await waitConnected();
  await basicRoundTrip();
  await toolReloadRecovery();
  await reasoningEffortPersists();
  assert.equal(pageErrors.length, 0, `page errors: ${pageErrors.join(' | ')}`);
  console.log('PASS no-page-errors');
} finally {
  await browser.close();
}
