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

// ─── ENV VARS & SETUP ─────────────────────────────────────────────────────
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

// Check HEAD, fall back to GET
async function isUrlAlive(url) {
  try {
    const h = await fetch(url, { method: "HEAD" });
    if (h.ok) return true;
  } catch {}
  try {
    const g = await fetch(url, { method: "GET" });
    return g.ok;
  } catch {
    return false;
  }
}

// Ask OpenAI for an alternative working link
async function getReplacementLink(text) {
  const prompt = `
You provided this example text: "${text}"
The original link is broken or missing.  
Please give me a working URL from one of these domains that best matches the example:
arxiv.org, ieeexplore.ieee.org, dl.acm.org, nist.gov, cloud.google.com, aws.amazon.com.  
Reply only with a single HTTPS URL.
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
            "You are a helpful assistant that finds authoritative technical links.",
        },
        { role: "user", content: prompt.trim() },
      ],
    })
  );
  const url = resp.choices?.[0]?.message?.content?.trim();
  return url && url.startsWith("http") ? url : null;
}

// Replace broken links in the markdown
async function sanitizeAndReplaceLinks(markdown) {
  const linkRegex = /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g;
  let result = markdown;
  const seen = new Set();

  for (const [, text, url] of markdown.matchAll(linkRegex)) {
    if (seen.has(url)) continue;
    seen.add(url);

    if (!(await isUrlAlive(url))) {
      console.warn(`⚠️  Broken link detected: ${url}`);
      const replacement = await getReplacementLink(text);
      if (replacement) {
        console.log(`🔗 Replacing with: ${replacement}`);
        // escape for RegExp
        const escText = text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        const escUrl = url.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        result = result.replace(
          new RegExp(`\\[${escText}\\]\\(${escUrl}\\)`, "g"),
          `[${text}](${replacement})`
        );
      } else {
        console.warn(`❌ No replacement found for "${text}", stripping link.`);
        result = result.replace(
          new RegExp(
            `\\[${text.replace(
              /[.*+?^${}()|[\]\\]/g,
              "\\$&"
            )}\\]\\(${url.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\)`,
            "g"
          ),
          text
        );
      }
    }
  }
  return result;
}

// ─── STEP 1: GENERATE RAW DISCUSSION ──────────────────────────────────────
async function generateDiscussionMarkdown() {
  console.log(`🔍 Generating discussion via OpenAI (model=${OPENAI_MODEL})…`);
  const resp = await withRetry(() =>
    openai.chat.completions.create({
      model: OPENAI_MODEL,
      temperature: 0.8,
      max_tokens: 950,
      messages: [
        {
          role: "system",
          content: [
            "You are a technology reporter crafting a GitHub Discussion post.",
            "Produce Markdown for *this week’s* top 5 enterprise technology trends.",
            "Each trend must include:",
            "1. A `###` heading with the trend title",
            "2. A factual real-world _example_ in italics with a hyperlink to the source",
            "   - Only use vetted domains: arxiv.org, ieeexplore.ieee.org, dl.acm.org, nist.gov, cloud provider whitepapers.",
            "3. A focused description covering:",
            "   - Future direction",
            "   - Key risks & impacts",
            "   - Strategic partnerships",
            "   - Initiatives",
            "",
            "Reply ONLY with Markdown (no JSON, no commentary).",
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

  const md = resp.choices?.[0]?.message?.content?.trim();
  if (!md) throw new Error("Empty response from OpenAI");
  return md;
}

// ─── STEP 2: FETCH CATEGORY ID ───────────────────────────────────────────
async function fetchCategory(octokit) {
  const query = `
    query($owner:String!,$repo:String!) {
      repository(owner:$owner,name:$repo) {
        id
        discussionCategories(first:20) { nodes { id name } }
      }
    }
  `;
  const result = await octokit.graphql(query, { owner, repo });
  const cat = result.repository.discussionCategories.nodes.find(
    (c) => c.name === "Tech Trends"
  );
  if (!cat) throw new Error('Category "Tech Trends" not found');
  return { repositoryId: result.repository.id, categoryId: cat.id };
}

// ─── STEP 3: POST DISCUSSION ─────────────────────────────────────────────
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
    mutation($input:CreateDiscussionInput!) {
      createDiscussion(input:$input) { discussion { url } }
    }
  `;

  const resp = await octokit.graphql(mutation, {
    input: { repositoryId, categoryId, title, body: markdown },
  });

  console.log("✅ Posted:", resp.createDiscussion.discussion.url);
}

// ─── MAIN ─────────────────────────────────────────────────────────────────
(async () => {
  try {
    const rawMd = await generateDiscussionMarkdown();
    const finalMd = await sanitizeAndReplaceLinks(rawMd);
    await postDiscussion(finalMd);
  } catch (err) {
    console.error("❌ Fatal:", err.message);
    process.exit(1);
  }
})();
