#!/usr/bin/env node

/**
 * generateTrendDiscussion.js
 *
 * Uses OpenAI to generate a list of tech‑trend entries (JSON),
 * then posts them to your GitHub Discussions under the “Tech Trends” category,
 * authenticating with the built‑in GITHUB_TOKEN.
 */

import { OpenAI } from "openai";
import { Octokit } from "@octokit/rest";

// ─── ENVIRONMENT SETUP ─────────────────────────────────────────────────────────
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_MODEL = (process.env.OPENAI_MODEL || "").trim() || "gpt-4";
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const GITHUB_REPOSITORY = process.env.GITHUB_REPOSITORY; // injected by Actions

// Fail fast if any required var is missing
[
  ["OPENAI_API_KEY", OPENAI_API_KEY],
  ["GITHUB_TOKEN", GITHUB_TOKEN],
  ["GITHUB_REPOSITORY", GITHUB_REPOSITORY],
].forEach(([name, val]) => {
  if (!val) {
    console.error(`❌ Missing required environment variable: ${name}`);
    process.exit(1);
  }
});

const [owner, repo] = GITHUB_REPOSITORY.split("/");

// ─── HELPERS ───────────────────────────────────────────────────────────────────
async function withRetry(fn, retries = 2, delay = 500) {
  try {
    return await fn();
  } catch (err) {
    if (retries > 0) {
      console.warn(`⚠️ ${err.message} — retrying in ${delay}ms…`);
      await new Promise((res) => setTimeout(res, delay));
      return withRetry(fn, retries - 1, delay * 2);
    }
    throw err;
  }
}

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
            'You are a helpful assistant. Reply **only** with a JSON array of objects, each with exactly two keys: "title" and "description".',
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

  const raw = resp.choices[0].message.content.trim();
  let trends;
  try {
    trends = JSON.parse(raw);
    if (!Array.isArray(trends)) throw new Error("JSON is not an array");
  } catch (err) {
    console.error("❌ Failed to parse OpenAI JSON:");
    console.error(raw);
    throw err;
  }
  return trends;
}

async function getDiscussionCategoryId(octokit) {
  // correct REST endpoint for discussion categories
  const { data: categories } = await octokit.request(
    "GET /repos/{owner}/{repo}/discussion-categories",
    { owner, repo }
  );
  const cat = categories.find((c) => c.name === "Tech Trends");
  if (!cat) {
    throw new Error(
      'Discussion category "Tech Trends" not found. Create it in your repo settings.'
    );
  }
  return cat.id;
}

async function postDiscussion(markdown) {
  const octokit = new Octokit({ auth: GITHUB_TOKEN });
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
    if (!trends.length) throw new Error("No trends returned from OpenAI");

    const markdown = trends
      .map(
        ({ title, description }) =>
          `### ${title.trim()}\n\n${description.trim().replace(/\r?\n/g, "\n")}`
      )
      .join("\n\n---\n\n");

    console.log("💬 Posting discussion to GitHub…");
    await postDiscussion(markdown);
    console.log("✅ Discussion posted successfully!");
  } catch (err) {
    console.error("❌ Fatal error:", err.message);
    process.exit(1);
  }
})();
