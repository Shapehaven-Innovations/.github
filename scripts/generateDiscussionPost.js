#!/usr/bin/env node
"use strict";

/**
 * scripts/generateDiscussionPost.js
 *
 * Deps (package.json):
 *   "openai", "@octokit/rest", "@octokit/auth-app", "node-fetch"
 * ESM: "type":"module"
 * Envs:
 *   OPENAI_API_KEY
 *   (opt) OPENAI_MODEL       # defaults to "gpt-4"
 *   GITHUB_REPOSITORY        # "owner/repo"
 *   APP_ID                   # GitHub App ID
 *   INSTALLATION_ID          # GitHub App installation ID
 *   APP_PRIVATE_KEY          # full PEM, escaped `\n` handled
 * Workflow perms: contents: read, discussions: write
 */

import process from "process";
import fetch from "node-fetch";
import { OpenAI } from "openai";
import { Octokit } from "@octokit/rest";
import { createAppAuth } from "@octokit/auth-app";

// ─── ENV VARS & SANITY CHECK ────────────────────────────────────────────
const {
  OPENAI_API_KEY,
  OPENAI_MODEL: _OPENAI_MODEL,
  GITHUB_REPOSITORY,
  APP_ID,
  INSTALLATION_ID,
  APP_PRIVATE_KEY: rawKey,
} = process.env;

const OPENAI_MODEL = (_OPENAI_MODEL || "").trim() || "gpt-4";
const APP_PRIVATE_KEY = rawKey && rawKey.replace(/\\n/g, "\n");

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

// ─── UTIL: retry transient failures ────────────────────────────────────────
async function withRetry(fn, retries = 2, delay = 500) {
  try {
    return await fn();
  } catch (err) {
    if (retries > 0) {
      console.warn(`⚠️  retrying in ${delay}ms after error: ${err.message}`);
      await new Promise((r) => setTimeout(r, delay));
      return withRetry(fn, retries - 1, delay * 2);
    }
    throw err;
  }
}

// ─── STEP 1: GENERATE RAW DISCUSSION VIA OPENAI ────────────────────────────
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
            "2. A factual real-world _example_ in italics, followed by a hyperlink to the original source.",
            "   - **Only** use vetted domains (arxiv.org, ieeexplore.ieee.org, dl.acm.org, nist.gov, cloud provider whitepapers).",
            "3. A **focused description** covering:",
            "   - Where the future is headed",
            "   - Key risks & potential impacts",
            "   - Strategic partnerships or initiatives driving it",
            "",
            "Reply **only** with pure Markdown (no JSON, no extra commentary).",
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

// ─── STEP 1.5: STRIP ANY BROKEN LINKS ──────────────────────────────────────
async function sanitizeLinks(markdown) {
  const linkRegex = /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g;
  let safe = markdown;
  const seen = new Set();

  for (const [, text, url] of markdown.matchAll(linkRegex)) {
    if (seen.has(url)) continue;
    seen.add(url);

    let ok = false;
    try {
      const res = await fetch(url, { method: "HEAD" });
      ok = res.ok;
      if (!ok) {
        console.warn(
          `⚠️  Stripping invalid link: ${url} (status: ${res.status})`
        );
      }
    } catch (err) {
      console.warn(`⚠️  Stripping invalid link: ${url} (${err.message})`);
    }

    if (!ok) {
      // replace the entire [text](url) with just text
      safe = safe.replace(
        new RegExp(
          `\\[${text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\]\\(${url.replace(
            /[.*+?^${}()|[\]\\]/g,
            "\\$&"
          )}\\)`
        ),
        text
      );
    }
  }

  return safe;
}

// ─── STEP 2: FETCH REPO & DISCUSSION CATEGORY ─────────────────────────────
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
  const repoId = result.repository.id;
  const category = result.repository.discussionCategories.nodes.find(
    (c) => c.name === "Tech Trends"
  );

  if (!category) {
    throw new Error('Discussion category "Tech Trends" not found');
  }

  return { repositoryId: repoId, categoryId: category.id };
}

// ─── STEP 3: POST TO GITHUB DISCUSSIONS ────────────────────────────────────
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
    mutation($input: CreateDiscussionInput!) {
      createDiscussion(input: $input) {
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
    const rawMd = await generateDiscussionMarkdown();
    const safeMd = await sanitizeLinks(rawMd);
    await postDiscussion(safeMd);
  } catch (err) {
    console.error("❌ Fatal error:", err.message);
    process.exit(1);
  }
})();
