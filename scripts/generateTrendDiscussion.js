#!/usr/bin/env node
"use strict";

/**
 * generateTrendDiscussion.js
 *
 
 *
 * Requirements:
 *  • package.json deps: "openai", "@octokit/rest", "@octokit/auth-app"
 *  • Node 18+ (ESM module; "type":"module" in package.json)
 *  • Envs:
 *     – OPENAI_API_KEY
 *     – (optional) OPENAI_MODEL (defaults to "gpt-4")
 *     – GITHUB_REPOSITORY (in form "owner/repo", provided by Actions)
 *     – GITHUB_APP_ID
 *     – GITHUB_INSTALLATION_ID
 *     – APP_PRIVATE_KEY (full PEM; escaped `\n` → real newlines handled)
 *  • Workflow permissions: contents: read, discussions: write
 */

import process from "process";
import { OpenAI } from "openai";
import { Octokit } from "@octokit/rest";
import { createAppAuth } from "@octokit/auth-app";

// ─── ENV VARS & VALIDATION ────────────────────────────────────────────────────
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
let OPENAI_MODEL = process.env.OPENAI_MODEL;
const GITHUB_REPOSITORY = process.env.GITHUB_REPOSITORY;
const GITHUB_APP_ID = process.env.GITHUB_APP_ID;
const GITHUB_INSTALLATION_ID = process.env.GITHUB_INSTALLATION_ID;

// handle APP_PRIVATE_KEY multi‐line or escaped
let APP_PRIVATE_KEY = process.env.APP_PRIVATE_KEY;
if (APP_PRIVATE_KEY?.includes("\\n")) {
  APP_PRIVATE_KEY = APP_PRIVATE_KEY.replace(/\\n/g, "\n");
}

// fail fast on missing
for (const [name, val] of [
  ["OPENAI_API_KEY", OPENAI_API_KEY],
  ["GITHUB_REPOSITORY", GITHUB_REPOSITORY],
  ["GITHUB_APP_ID", GITHUB_APP_ID],
  ["GITHUB_INSTALLATION_ID", GITHUB_INSTALLATION_ID],
  ["APP_PRIVATE_KEY", APP_PRIVATE_KEY],
]) {
  if (!val) {
    console.error(`❌ Missing required env var ${name}`);
    process.exit(1);
  }
}

// default model
if (!OPENAI_MODEL?.trim()) {
  OPENAI_MODEL = "gpt-4";
}

const [owner, repo] = GITHUB_REPOSITORY.split("/");
if (!owner || !repo) {
  console.error(
    `❌ GITHUB_REPOSITORY must be "owner/repo", got "${GITHUB_REPOSITORY}"`
  );
  process.exit(1);
}

// ─── HELPER: retry transient failures ──────────────────────────────────────────
async function withRetry(fn, retries = 2, delay = 500) {
  try {
    return await fn();
  } catch (err) {
    if (retries > 0) {
      console.warn(`⚠️ Retry in ${delay}ms after error: ${err.message}`);
      await new Promise((r) => setTimeout(r, delay));
      return withRetry(fn, retries - 1, delay * 2);
    }
    throw err;
  }
}

// ─── STEP 1: Generate trends via OpenAI ────────────────────────────────────────
async function fetchTrends() {
  console.log(`🔍 Generating trends via OpenAI (model=${OPENAI_MODEL})…`);
  const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

  const resp = await withRetry(() =>
    openai.chat.completions.create({
      model: OPENAI_MODEL,
      messages: [
        {
          role: "system",
          content:
            'You are a helpful assistant. Reply *only* with a JSON array of objects, each with keys "title" (string) and "description" (string).',
        },
        {
          role: "user",
          content:
            "List the top 5 upcoming enterprise technology trends as JSON.",
        },
      ],
      temperature: 0.7,
      max_tokens: 500,
    })
  );

  const raw = resp.choices?.[0]?.message?.content?.trim();
  if (!raw) {
    throw new Error("Empty response from OpenAI");
  }

  let trends;
  try {
    trends = JSON.parse(raw);
  } catch (e) {
    console.error("❌ Failed to parse OpenAI JSON:", raw);
    throw new Error(e.message);
  }
  if (!Array.isArray(trends) || trends.length === 0) {
    throw new Error("Parsed data is not a non‑empty array");
  }
  return trends;
}

// ─── STEP 2: Lookup category via REST ──────────────────────────────────────────
async function getCategoryId(octokit) {
  const { data } = await octokit.request(
    "GET /repos/{owner}/{repo}/discussions/categories",
    { owner, repo }
  );
  const cat = data.find((c) => c.name === "Tech Trends");
  if (!cat) {
    throw new Error('Discussion category "Tech Trends" not found');
  }
  return cat.id;
}

// ─── STEP 3: Post discussion as GitHub App ────────────────────────────────────
async function postDiscussion(markdown) {
  const octokit = new Octokit({
    authStrategy: createAppAuth,
    auth: {
      appId: Number(GITHUB_APP_ID),
      privateKey: APP_PRIVATE_KEY,
      installationId: Number(GITHUB_INSTALLATION_ID),
    },
  });

  const category_id = await getCategoryId(octokit);
  const title = `Tech Trends — ${new Date().toLocaleDateString("en-US")}`;

  await octokit.rest.discussions.create({
    owner,
    repo,
    category_id,
    title,
    body: markdown,
  });

  console.log("✅ Discussion posted by GitHub App!");
}

// ─── ORCHESTRATION ────────────────────────────────────────────────────────────
(async () => {
  try {
    const trends = await fetchTrends();
    const markdown = trends
      .map(
        ({ title, description }) =>
          `### ${title.trim()}\n\n${description.trim().replace(/\r?\n/g, "\n")}`
      )
      .join("\n\n---\n\n");

    console.log("💬 Posting discussion to GitHub...");
    await postDiscussion(markdown);
  } catch (err) {
    console.error("❌ Fatal error:", err.message);
    process.exit(1);
  }
})();
