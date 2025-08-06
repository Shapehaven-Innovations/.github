#!/usr/bin/env node
"use strict";

/**
 * generateDiscussionPost.js
 *
 * Deps (package.json):
 *   "openai", "@octokit/rest", "@octokit/auth-app", "node-fetch"
 * ESM: "type":"module"
 * Envs:
 *   OPENAI_API_KEY
 *   (opt) OPENAI_MODEL     # defaults to "gpt-4"
 *   GITHUB_REPOSITORY      # "owner/repo" (injected by Actions)
 *   APP_ID
 *   INSTALLATION_ID
 *   APP_PRIVATE_KEY        # full PEM (escaped `\n` handled)
 */

import process from "process";
import fetch from "node-fetch";
import { OpenAI } from "openai";
import { Octokit } from "@octokit/rest";
import { createAppAuth } from "@octokit/auth-app";

// ─── ENV VARS & SANITY CHECK ──────────────────────────────────────────
const {
  OPENAI_API_KEY,
  OPENAI_MODEL: _OPENAI_MODEL,
  GITHUB_REPOSITORY,
  APP_ID,
  INSTALLATION_ID,
  APP_PRIVATE_KEY: rawPrivateKey,
} = process.env;

let OPENAI_MODEL = _OPENAI_MODEL?.trim() || "gpt-4";
const APP_PRIVATE_KEY = rawPrivateKey?.replace(/\\n/g, "\n");

for (const [name, val] of [
  ["OPENAI_API_KEY", OPENAI_API_KEY],
  ["GITHUB_REPOSITORY", GITHUB_REPOSITORY],
  ["APP_ID", APP_ID],
  ["INSTALLATION_ID", INSTALLATION_ID],
  ["APP_PRIVATE_KEY", APP_PRIVATE_KEY],
]) {
  if (!val) {
    console.error(`❌ Missing required env var ${name}`);
    process.exit(1);
  }
}

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
      console.warn(`⚠️  retry in ${delay}ms after error: ${err.message}`);
      await new Promise((res) => setTimeout(res, delay));
      return withRetry(fn, retries - 1, delay * 2);
    }
    throw err;
  }
}

// ─── STEP 1: GENERATE FULL DISCUSSION MD VIA OPENAI ─────────────────────────
async function generateDiscussionMarkdown() {
  console.log(`🔍 Generating discussion via OpenAI (model=${OPENAI_MODEL})…`);
  const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

  const resp = await withRetry(() =>
    openai.chat.completions.create({
      model: OPENAI_MODEL,
      temperature: 0.7,
      max_tokens: 900,
      messages: [
        {
          role: "system",
          content: [
            "You are a technology reporter crafting a GitHub Discussion post.",
            "Produce Markdown for *this week’s* top 5 enterprise technology trends.",
            "For each trend, include:",
            "1. A `###` heading with the trend title",
            "2. A factual real-world _example_ in italics followed by a hyperlink to the **original source**.",
            "   - **ONLY** use links from these domains: arxiv.org, ieeexplore.ieee.org, dl.acm.org, nist.gov, developer/vendor whitepapers (e.g., cloud.google.com, aws.amazon.com).",
            "   - **Ensure** every URL is valid (status 200).",
            "3. A **focused description** covering:",
            "   - Where the future is headed",
            "   - Key risks & potential impacts",
            "   - Strategic partnerships or initiatives driving it",
            "",
            "Reply **only** with pure Markdown (no JSON, no commentary).",
          ].join("\n"),
        },
        {
          role: "user",
          content:
            "What are the top 5 enterprise technology trends happening this week?",
        },
      ],
    })
  );

  const markdown = resp.choices?.[0]?.message?.content?.trim();
  if (!markdown) throw new Error("Empty response from OpenAI");
  return markdown;
}

// ─── VALIDATE: ensure no 404s ───────────────────────────────────────────────
async function validateLinks(markdown) {
  const urlRegex = /\[.*?\]\((https?:\/\/[^\s)]+)\)/g;
  const invalid = [];
  let match;
  while ((match = urlRegex.exec(markdown))) {
    const url = match[1];
    try {
      const res = await fetch(url, { method: "HEAD" });
      if (!res.ok) invalid.push(url);
    } catch {
      invalid.push(url);
    }
  }
  if (invalid.length) {
    console.error("❌ Invalid links detected:", invalid);
    return false;
  }
  return true;
}

// ─── WRAP: retry generation until links are valid ──────────────────────────
async function generateValidDiscussion(maxAttempts = 3) {
  for (let i = 1; i <= maxAttempts; i++) {
    const md = await generateDiscussionMarkdown();
    if (await validateLinks(md)) return md;
    console.warn(`⚠️  Attempt ${i} had bad links — regenerating…`);
  }
  throw new Error(
    `Failed to generate discussion with all valid links after ${maxAttempts} attempts`
  );
}

// ─── STEP 2: FETCH REPO & CATEGORY VIA GRAPHQL ──────────────────────────────
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
  const cat = result.repository.discussionCategories.nodes.find(
    (c) => c.name === "Tech Trends"
  );
  if (!cat) throw new Error('Discussion category "Tech Trends" not found');
  return { repositoryId, categoryId: cat.id };
}

// ─── STEP 3: POST THE DISCUSSION ────────────────────────────────────────────
async function postDiscussion(markdown) {
  const octokit = new Octokit({
    authStrategy: createAppAuth,
    auth: {
      appId: Number(APP_ID),
      privateKey: APP_PRIVATE_KEY,
      installationId: Number(INSTALLATION_ID),
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

  console.log("✅ Discussion posted at:", resp.createDiscussion.discussion.url);
}

// ─── MAIN ─────────────────────────────────────────────────────────────────
(async () => {
  try {
    console.log("💬 Generating & validating discussion…");
    const markdown = await generateValidDiscussion();
    console.log("💬 Posting discussion…");
    await postDiscussion(markdown);
  } catch (err) {
    console.error("❌ Fatal error:", err.message);
    process.exit(1);
  }
})();
