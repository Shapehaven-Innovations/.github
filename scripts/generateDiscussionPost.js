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

// ─── CONFIGURATION ────────────────────────────────────────────────────────
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

// ─── UTILITY FUNCTIONS ────────────────────────────────────────────────────
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
    const head = await fetch(url, { method: "HEAD" });
    if (head.ok) return true;
  } catch {}
  try {
    const get = await fetch(url, { method: "GET" });
    return get.ok;
  } catch {
    return false;
  }
}

async function getReplacementLink(exampleTitle) {
  const prompt = `
The link for "${exampleTitle}" is broken. 
Please provide a working HTTPS URL from one of these domains that best matches it:
arxiv.org, ieeexplore.ieee.org, dl.acm.org, nist.gov.
Reply ONLY with the URL.
`;
  const resp = await withRetry(() =>
    openai.chat.completions.create({
      model: OPENAI_MODEL,
      temperature: 0.0,
      max_tokens: 60,
      messages: [
        {
          role: "system",
          content:
            "You are a strict assistant providing only valid technical URLs.",
        },
        { role: "user", content: prompt.trim() },
      ],
    })
  );
  const url = resp.choices?.[0]?.message?.content.trim();
  return url?.startsWith("http") ? url : null;
}

// Fetch N trends in JSON form
async function fetchTrendCandidates(count) {
  const system = `
You are an enterprise technology reporter. 
Output a JSON array of exactly ${count} objects, each with:
- "title": short trend title
- "exampleTitle": italicized real-world example name
- "url": HTTPS link from one of these vetted domains: arxiv.org, ieeexplore.ieee.org, dl.acm.org, nist.gov.
- "description": 5–7 sentences covering future direction, key risks, partnerships, initiatives.
Reply ONLY with JSON.`;
  const user = `List the top ${count} enterprise technology trends happening this week.`;
  const resp = await withRetry(() =>
    openai.chat.completions.create({
      model: OPENAI_MODEL,
      temperature: 0.7,
      max_tokens: 1200,
      messages: [
        { role: "system", content: system.trim() },
        { role: "user", content: user },
      ],
    })
  );
  try {
    return JSON.parse(resp.choices[0].message.content);
  } catch {
    throw new Error("❌ Failed to parse JSON from OpenAI response.");
  }
}

// Fetch one additional trend if any candidate fails entirely
async function fetchAdditionalTrend() {
  const system = `
You are an enterprise technology reporter. 
Output ONE JSON object with the same schema:
{"title","exampleTitle","url","description"} 
ensuring the URL is from a vetted domain. Reply ONLY with JSON.`;
  const user = "Provide one more enterprise technology trend.";
  const resp = await withRetry(() =>
    openai.chat.completions.create({
      model: OPENAI_MODEL,
      temperature: 0.7,
      max_tokens: 500,
      messages: [
        { role: "system", content: system.trim() },
        { role: "user", content: user },
      ],
    })
  );
  try {
    return JSON.parse(resp.choices[0].message.content);
  } catch {
    throw new Error("❌ Failed to parse additional trend JSON.");
  }
}

function toMarkdown({ title, exampleTitle, url, description }) {
  return `### ${title}

*_${exampleTitle}_*  
${description.trim()}`;
}

// Assemble exactly NUM_TRENDS valid trends
async function assembleValidTrends() {
  const raw = await fetchTrendCandidates(NUM_TRENDS);
  const valid = [];

  for (const item of raw) {
    if (await isUrlAlive(item.url)) {
      valid.push(item);
    } else {
      console.warn(`⚠️ Broken link for "${item.exampleTitle}": ${item.url}`);
      const replacement = await getReplacementLink(item.exampleTitle);
      if (replacement && (await isUrlAlive(replacement))) {
        console.log(`🔗 Replaced with: ${replacement}`);
        item.url = replacement;
        valid.push(item);
      } else {
        console.warn(
          `❌ No replacement for "${item.title}", fetching a new trend`
        );
        const extra = await fetchAdditionalTrend();
        if (await isUrlAlive(extra.url)) {
          valid.push(extra);
        }
      }
    }
    if (valid.length >= NUM_TRENDS) break;
  }

  // If still short, keep fetching
  while (valid.length < NUM_TRENDS) {
    console.log("🔄 Fetching supplemental trend…");
    const extra = await fetchAdditionalTrend();
    if (await isUrlAlive(extra.url)) valid.push(extra);
  }

  return valid.slice(0, NUM_TRENDS).map(toMarkdown).join("\n\n");
}

// ─── STEP 2: FETCH GITHUB DISCUSSION CATEGORY ─────────────────────────────
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

// ─── STEP 3: POST TO GITHUB DISCUSSIONS ──────────────────────────────────
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
  const title = `Tech Trends — ${new Date().toLocaleDateString("en-US")}`;
  const mutation = `
    mutation($input: CreateDiscussionInput!) {
      createDiscussion(input:$input) { discussion { url } }
    }`;

  const resp = await octokit.graphql(mutation, {
    input: { repositoryId, categoryId, title, body: markdown },
  });
  console.log("✅ Posted at:", resp.createDiscussion.discussion.url);
}

// ─── MAIN ─────────────────────────────────────────────────────────────────
(async () => {
  try {
    console.log("🔍 Building valid trends…");
    const md = await assembleValidTrends();
    await postDiscussion(md);
  } catch (err) {
    console.error("❌ Fatal:", err);
    process.exit(1);
  }
})();
