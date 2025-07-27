#!/usr/bin/env node

/**
 * generateTrendDiscussion.js
 *
 * Uses OpenAI to generate a list of tech‑trend entries (JSON),
 * then posts them to your GitHub Discussions under the “Tech Trends” category.
 *
 * Production‑ready:
 *  • Validates all required env vars (fails fast if missing)
 *  • Fallback for OPENAI_MODEL when blank or unset
 *  • Retries transient network errors with exponential back‑off
 *  • Strict JSON parsing & error logging
 *  • Dynamically looks up “Tech Trends” category via repos.listDiscussionCategories
 *  • Posts markdown to GitHub Discussions
 */

import { OpenAI } from "openai";
import { Octokit } from "@octokit/rest";
import { createAppAuth } from "@octokit/auth-app";

// ─── ENVIRONMENT SETUP ─────────────────────────────────────────────────────────
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_MODEL = (process.env.OPENAI_MODEL || "").trim() || "gpt-4";
const GITHUB_REPOSITORY = process.env.GITHUB_REPOSITORY; // set by Actions
const GITHUB_APP_ID = process.env.GITHUB_APP_ID;
const GITHUB_INSTALLATION_ID = process.env.GITHUB_INSTALLATION_ID;
const APP_PRIVATE_KEY = process.env.APP_PRIVATE_KEY?.replace(/\\n/g, "\n");

// fail fast if any required var is missing
[
  ["OPENAI_API_KEY", OPENAI_API_KEY],
  ["GITHUB_REPOSITORY", GITHUB_REPOSITORY],
  ["GITHUB_APP_ID", GITHUB_APP_ID],
  ["GITHUB_INSTALLATION_ID", GITHUB_INSTALLATION_ID],
  ["APP_PRIVATE_KEY", APP_PRIVATE_KEY],
].forEach(([name, val]) => {
  if (!val) {
    console.error(`❌ Missing required environment variable: ${name}`);
    process.exit(1);
  }
});

const [owner, repo] = GITHUB_REPOSITORY.split("/");

// ─── HELPERS ───────────────────────────────────────────────────────────────────
/**
 * Retry an async operation on failure with exponential backoff.
 */
async function withRetry(fn, retries = 2, delay = 500) {
  try {
    return await fn();
  } catch (err) {
    if (retries > 0) {
      console.warn(
        `⚠️ Operation failed (${err.message}), retrying in ${delay}ms…`
      );
      await new Promise((res) => setTimeout(res, delay));
      return withRetry(fn, retries - 1, delay * 2);
    }
    throw err;
  }
}

/**
 * Generate an array of { title, description } via OpenAI Chat.
 */
async function fetchTrends() {
  console.log(`🔍 Generating trends via OpenAI (model=${OPENAI_MODEL})…`);
  const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

  const res = await withRetry(() =>
    openai.chat.completions.create({
      model: OPENAI_MODEL,
      messages: [
        {
          role: "system",
          content:
            'You are a helpful assistant. Reply with nothing but a JSON array of objects, each having exactly two keys: "title" and "description".',
        },
        {
          role: "user",
          content:
            "List the top 5 upcoming enterprise technology trends as JSON.",
        },
      ],
      temperature: 0.7,
    })
  );

  const raw = res.choices[0].message.content.trim();
  let trends;
  try {
    trends = JSON.parse(raw);
    if (!Array.isArray(trends)) {
      throw new Error("JSON is not an array");
    }
  } catch (err) {
    console.error("❌ Failed to parse OpenAI JSON response:");
    console.error(raw);
    throw new Error(`JSON parse error: ${err.message}`);
  }

  return trends;
}

/**
 * Find the “Tech Trends” discussion category ID in this repo.
 */
async function getDiscussionCategoryId(octokit) {
  // Use the raw REST endpoint in case the plugin method isn't available
  const { data: categories } = await octokit.request(
    "GET /repos/{owner}/{repo}/discussion-categories",
    { owner, repo }
  );

  const cat = categories.find((c) => c.name === "Tech Trends");
  if (!cat) {
    throw new Error(
      'Discussion category "Tech Trends" not found. Create it or update the code.'
    );
  }
  return cat.id;
}

/**
 * Post a new discussion with the given markdown body.
 */
async function postDiscussion(markdown) {
  const octokit = new Octokit({
    authStrategy: createAppAuth,
    auth: {
      appId: Number(GITHUB_APP_ID),
      privateKey: APP_PRIVATE_KEY,
      installationId: Number(GITHUB_INSTALLATION_ID),
    },
  });

  const category_id = await getDiscussionCategoryId(octokit);
  const title = `Org Tech Trends — ${new Date().toLocaleDateString("en-US")}`;

  await octokit.rest.discussions.create({
    owner,
    repo,
    category_id,
    title,
    body: markdown,
  });
}

// ─── MAIN ───────────────────────────────────────────────────────────────────────
(async () => {
  try {
    const trends = await fetchTrends();
    if (trends.length === 0) {
      throw new Error("OpenAI returned an empty list of trends.");
    }

    // Build markdown: each trend as H3 + paragraph, separated by rules
    const markdown = trends
      .map(
        ({ title, description }) =>
          `### ${title.trim()}\n\n${description.trim().replace(/\r?\n/g, "\n")}`
      )
      .join("\n\n---\n\n");

    console.log("💬 Posting discussion to GitHub...");
    await postDiscussion(markdown);
    console.log("✅ Discussion posted successfully!");
  } catch (err) {
    console.error("❌ Fatal error:", err.message);
    console.error(err.stack);
    process.exit(1);
  }
})();
