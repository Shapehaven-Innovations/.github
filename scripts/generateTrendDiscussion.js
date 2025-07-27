#!/usr/bin/env node

/**
 * generateTrendDiscussion.js
 *
 * Uses OpenAI to generate a list of tech‑trend entries (JSON),
 * then posts them as a **new organization discussion** under the “Tech Trends” category.
 */

import { OpenAI } from "openai";
import { Octokit } from "@octokit/rest";

// ─── ENVIRONMENT SETUP ─────────────────────────────────────────────────────────
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_MODEL = (process.env.OPENAI_MODEL || "").trim() || "gpt-4";
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const GITHUB_REPOSITORY = process.env.GITHUB_REPOSITORY; // e.g. "shapehaven-innovations/.github"

// fail FAST if any required var is missing
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

// Derive your org slug from the repo context:
const ORG = GITHUB_REPOSITORY.split("/")[0];

/**
 * Retry an async function on failure with exponential back‑off.
 */
async function withRetry(fn, retries = 2, delay = 500) {
  try {
    return await fn();
  } catch (err) {
    if (retries > 0) {
      console.warn(`⚠️  ${err.message}, retrying in ${delay}ms…`);
      await new Promise((r) => setTimeout(r, delay));
      return withRetry(fn, retries - 1, delay * 2);
    }
    throw err;
  }
}

/**
 * Fetch top‑5 trends via OpenAI Chat.
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
            "You are a helpful assistant. Reply **only** with a JSON array of objects, " +
            'each with exactly two keys: "title" and "description".',
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
  try {
    const data = JSON.parse(raw);
    if (!Array.isArray(data)) throw new Error("parsed JSON is not an array");
    return data;
  } catch (err) {
    console.error("❌ Failed to parse OpenAI JSON response:");
    console.error(raw);
    throw err;
  }
}

/**
 * Look up the “Tech Trends” category ID at the organization level.
 */
async function getOrgDiscussionCategoryId(octokit) {
  const { data: categories } = await octokit.request(
    "GET /orgs/{org}/discussion-categories",
    { org: ORG }
  );
  const cat = categories.find((c) => c.name === "Tech Trends");
  if (!cat) {
    throw new Error(
      `Discussion category "Tech Trends" not found in org ${ORG}.`
    );
  }
  return cat.id;
}

/**
 * Post a new **organization** discussion.
 */
async function postOrgDiscussion(markdown) {
  const octokit = new Octokit({ auth: GITHUB_TOKEN });

  const category_id = await getOrgDiscussionCategoryId(octokit);
  const title = `Org Tech Trends — ${new Date().toLocaleDateString("en-US")}`;

  await octokit.request("POST /orgs/{org}/discussions", {
    org: ORG,
    category_id,
    title,
    body: markdown,
  });
}

(async () => {
  try {
    const trends = await fetchTrends();
    if (trends.length === 0) {
      throw new Error("OpenAI returned an empty list of trends.");
    }

    const markdown = trends
      .map(
        ({ title, description }) =>
          `### ${title.trim()}\n\n${description.trim().replace(/\r?\n/g, "\n")}`
      )
      .join("\n\n---\n\n");

    console.log("💬 Posting discussion to GitHub…");
    await postOrgDiscussion(markdown);
    console.log("✅ Discussion posted successfully!");
  } catch (err) {
    console.error("❌ Fatal error:", err.message);
    process.exit(1);
  }
})();
