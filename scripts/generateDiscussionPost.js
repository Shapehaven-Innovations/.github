#!/usr/bin/env node
"use strict";

import process from "process";
import fetch from "node-fetch";
import { parseStringPromise } from "xml2js";
import { OpenAI } from "openai";
import { Octokit } from "@octokit/rest";
import { createAppAuth } from "@octokit/auth-app";

// ─── CONFIG ───────────────────────────────────────────────────────────────
const NUM_TRENDS = 5;
const {
  OPENAI_API_KEY,
  OPENAI_MODEL: _OPENAI_MODEL,
  GITHUB_REPOSITORY,
  APP_ID,
  INSTALLATION_ID,
  APP_PRIVATE_KEY: rawPEM,
} = process.env;

const OPENAI_MODEL = (_OPENAI_MODEL || "").trim() || "gpt-4";
const APP_PRIVATE_KEY = rawPEM && rawPEM.replace(/\\n/g, "\n");
if (
  !OPENAI_API_KEY ||
  !GITHUB_REPOSITORY ||
  !APP_ID ||
  !INSTALLATION_ID ||
  !APP_PRIVATE_KEY
) {
  console.error("❌ Missing one or more required env vars.");
  process.exit(1);
}
const [owner, repo] = GITHUB_REPOSITORY.split("/");
if (!owner || !repo) {
  console.error(`❌ Invalid GITHUB_REPOSITORY, must be "owner/repo"`);
  process.exit(1);
}
const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

// ─── HELPERS ──────────────────────────────────────────────────────────────
async function withRetry(fn, retries = 2, delay = 500) {
  try {
    return await fn();
  } catch (err) {
    if (retries > 0) {
      await new Promise((r) => setTimeout(r, delay));
      return withRetry(fn, retries - 1, delay * 2);
    }
    throw err;
  }
}

async function isUrlAlive(url) {
  try {
    const res = await fetch(url, { method: "HEAD" });
    if (res.ok) return true;
  } catch {}
  try {
    const res = await fetch(url, { method: "GET" });
    return res.ok;
  } catch {
    return false;
  }
}

// fetch and parse Google News RSS for “enterprise technology”
async function fetchGoogleNewsHeadlines() {
  const RSS_URL =
    "https://news.google.com/rss/search?q=enterprise+technology&hl=en-US&gl=US&ceid=US:en";
  const xml = await withRetry(() => fetch(RSS_URL).then((r) => r.text()));
  const json = await parseStringPromise(xml);
  const items = json.rss.channel[0].item.slice(0, NUM_TRENDS);
  return items.map((i) => ({
    title: i.title[0],
    url: i.link[0],
  }));
}

// ask OpenAI to generate a 2–4 sentence write-up
async function summarizeTrend({ title, url }) {
  const prompt = `
You are a technology reporter. 
Write a concise 2–4 sentence enterprise-tech trend summary for the article at:
Title: "${title}"
URL: ${url}

Include:
- future direction
- key risks & impacts
- strategic partnerships
- initiatives
Reply ONLY with the summary.`;
  const resp = await withRetry(() =>
    openai.chat.completions.create({
      model: OPENAI_MODEL,
      temperature: 0.7,
      max_tokens: 200,
      messages: [
        { role: "system", content: "You are a concise tech journalist." },
        { role: "user", content: prompt.trim() },
      ],
    })
  );
  return resp.choices[0].message.content.trim();
}

function toMarkdown(index, { title, url, summary }) {
  return `### ${index + 1}. ${title}

*_[Read the full article](${url})_*

${summary}`;
}

// ─── ASSEMBLE & SANITIZE ─────────────────────────────────────────────────
async function assembleValidTrends() {
  const raw = await fetchGoogleNewsHeadlines();
  const mdBlocks = [];

  for (let i = 0; i < raw.length; i++) {
    const { title, url } = raw[i];

    if (!(await isUrlAlive(url))) {
      console.warn(`⚠️  Skipping dead link: ${url}`);
      continue;
    }

    const summary = await summarizeTrend({ title, url });
    mdBlocks.push(toMarkdown(i, { title, url, summary }));

    if (mdBlocks.length >= NUM_TRENDS) break;
  }

  if (mdBlocks.length < NUM_TRENDS) {
    throw new Error(`Only found ${mdBlocks.length} live trends – aborting.`);
  }

  return mdBlocks.join("\n\n");
}

// ─── GITHUB DISCUSSION SETUP ──────────────────────────────────────────────
async function fetchCategory(octokit) {
  const query = `
    query($owner:String!,$repo:String!) {
      repository(owner:$owner,name:$repo) {
        id
        discussionCategories(first:20) { nodes { id name } }
      }
    }`;
  const result = await octokit.graphql(query, { owner, repo });
  const cat = result.repository.discussionCategories.nodes.find(
    (c) => c.name === "Tech Trends"
  );
  if (!cat) throw new Error('Category "Tech Trends" not found');
  return { repositoryId: result.repository.id, categoryId: cat.id };
}

async function postDiscussion(markdown) {
  const octokit = new Octokit({
    authStrategy: createAppAuth,
    auth: {
      appId: Number(APP_ID),
      privateKey: APP_PRIVATE_KEY,
      installationId: Number(INSTALLATION_ID),
    },
  });

  const { repositoryId, categoryId } = await fetchCategory(octokit);
  const title = `Enterprise Tech Trends — ${new Date().toLocaleDateString(
    "en-US"
  )}`;
  const mutation = `
    mutation($input:CreateDiscussionInput!) {
      createDiscussion(input:$input) { discussion { url } }
    }`;

  const resp = await octokit.graphql(mutation, {
    input: { repositoryId, categoryId, title, body: markdown },
  });

  console.log("✅ Posted:", resp.createDiscussion.discussion.url);
}

// ─── MAIN ─────────────────────────────────────────────────────────────────
(async () => {
  try {
    console.log("🔍 Fetching top enterprise-tech headlines…");
    const md = await assembleValidTrends();
    console.log("📝 Generated Markdown:\n", md);
    await postDiscussion(md);
  } catch (err) {
    console.error("❌ Fatal:", err.message);
    process.exit(1);
  }
})();
