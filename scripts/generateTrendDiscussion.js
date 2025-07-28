#!/usr/bin/env node
"use strict";

/**
 * generateDiscussionPost.js
 *
 * Deps (package.json):
 *   "openai", "@octokit/rest", "@octokit/auth-app"
 * ESM: "type":"module"
 * Envs:
 *   OPENAI_API_KEY
 *   (opt) OPENAI_MODEL     # defaults to "gpt-4"
 *   GITHUB_REPOSITORY      # "owner/repo" (injected by Actions)
 *   GITHUB_APP_ID
 *   GITHUB_INSTALLATION_ID
 *   APP_PRIVATE_KEY        # full PEM (escaped `\n` handled)
 * Workflow perms: contents: read, discussions: write
 */

import process from "process";
import { OpenAI } from "openai";
import { Octokit } from "@octokit/rest";
import { createAppAuth } from "@octokit/auth-app";

// ─── ENV VARS & SANITY CHECK ──────────────────────────────────────────
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
let OPENAI_MODEL = process.env.OPENAI_MODEL;
const GITHUB_REPOSITORY = process.env.GITHUB_REPOSITORY;
const GITHUB_APP_ID = process.env.GITHUB_APP_ID;
const GITHUB_INSTALLATION_ID = process.env.GITHUB_INSTALLATION_ID;
let APP_PRIVATE_KEY = process.env.APP_PRIVATE_KEY?.replace(/\\n/g, "\n");

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

if (!OPENAI_MODEL?.trim()) OPENAI_MODEL = "gpt-4";

const [owner, repo] = GITHUB_REPOSITORY.split("/");
if (!owner || !repo) {
  console.error(`❌ Invalid GITHUB_REPOSITORY, must be "owner/repo"`);
  process.exit(1);
}

// ─── UTIL: retry transient failures ──────────────────────────────────────────
async function withRetry(fn, retries = 2, delay = 500) {
  try {
    return await fn();
  } catch (err) {
    if (retries > 0) {
      console.warn(`⚠️  Retry in ${delay}ms after error: ${err.message}`);
      await new Promise((r) => setTimeout(r, delay));
      return withRetry(fn, retries - 1, delay * 2);
    }
    throw err;
  }
}

// ─── STEP 1: GENERATE FULL DISCUSSION MARKDOWN VIA OPENAI ───────────────────
async function generateDiscussionMarkdown() {
  console.log(
    `🔍 Generating weekly tech‑trends discussion via OpenAI (model=${OPENAI_MODEL})…`
  );
  const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

  const resp = await withRetry(() =>
    openai.chat.completions.create({
      model: OPENAI_MODEL,
      messages: [
        {
          role: "system",
          content: [
            "You are a technology reporter crafting a GitHub Discussion post.",
            "Produce Markdown for *this week’s* top 5 enterprise technology trends.",
            "For each trend include:",
            "- A `###` heading with the trend title",
            "- A *factual real‑world example* in italics",
            "- A brief descriptive paragraph",
            "",
            "Reply **only** with the Markdown body, no JSON or additional commentary.",
          ].join("\n"),
        },
        {
          role: "user",
          content:
            "What are the top 5 enterprise technology trends happening this week?",
        },
      ],
      temperature: 0.7,
      max_tokens: 800,
    })
  );

  const markdown = resp.choices?.[0]?.message?.content?.trim();
  if (!markdown) {
    throw new Error("Empty response from OpenAI");
  }
  return markdown;
}

// ─── STEP 2: FETCH REPO & CATEGORY VIA GRAPHQL ──────────────────────────────
async function fetchRepoInfo(octokit) {
  const query = `
    query($owner:String!,$repo:String!) {
      repository(owner:$owner,name:$repo) {
        id
        discussionCategories(first:20) {
          nodes { id name }
        }
      }
    }
  `;
  const result = await octokit.graphql(query, { owner, repo });
  const repositoryId = result.repository.id;
  const categories = result.repository.discussionCategories.nodes;
  const cat = categories.find((c) => c.name === "Tech Trends");
  if (!cat) {
    throw new Error('Discussion category "Tech Trends" not found');
  }
  return { repositoryId, categoryId: cat.id };
}

// ─── STEP 3: POST THE DISCUSSION ────────────────────────────────────────────
async function postDiscussion(markdown) {
  const octokit = new Octokit({
    authStrategy: createAppAuth,
    auth: {
      appId: Number(GITHUB_APP_ID),
      privateKey: APP_PRIVATE_KEY,
      installationId: Number(GITHUB_INSTALLATION_ID),
    },
  });

  const { repositoryId, categoryId } = await fetchRepoInfo(octokit);

  const title = `Tech Trends — ${new Date().toLocaleDateString("en-US")}`;
  const mutation = `
    mutation($input:CreateDiscussionInput!) {
      createDiscussion(input:$input) {
        discussion { url }
      }
    }
  `;
  const resp = await octokit.graphql(mutation, {
    input: { repositoryId, categoryId, title, body: markdown },
  });

  console.log("✅ Discussion posted:");
  console.log(resp.createDiscussion.discussion.url);
}

// ─── MAIN ─────────────────────────────────────────────────────────────────
(async () => {
  try {
    const markdown = await generateDiscussionMarkdown();
    console.log("💬 Posting discussion…");
    await postDiscussion(markdown);
  } catch (err) {
    console.error("❌ Fatal error:", err.message);
    process.exit(1);
  }
})();
