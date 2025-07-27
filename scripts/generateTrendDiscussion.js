#!/usr/bin/env node

/**
 * generateTrendDiscussion.js
 * Fetches the latest tech‑trend data and opens a GitHub discussion.
 */

import fetch from "node-fetch";
import { Octokit } from "@octokit/rest";

async function fetchTrends() {
  const url = new URL("https://api.example.com/trends");
  url.searchParams.set("key", process.env.TRENDS_API_KEY);

  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Trend API returned ${res.status} ${res.statusText}`);
  }
  return res.json();
}

async function postDiscussion(markdownBody) {
  const octokit = new Octokit({ auth: process.env.GITHUB_TOKEN });
  const [owner, repo] = process.env.GITHUB_REPOSITORY.split("/");

  await octokit.rest.discussions.create({
    owner,
    repo,
    category_id: Number(process.env.DISCUSSION_CATEGORY_ID),
    title: `Weekly Tech Trends – ${new Date().toISOString().slice(0, 10)}`,
    body: markdownBody,
  });
}

(async () => {
  try {
    console.log("🔍 Fetching trends…");
    const trends = await fetchTrends();

    if (!Array.isArray(trends) || trends.length === 0) {
      console.warn("⚠️ No trends returned; skipping discussion post.");
      process.exit(0);
    }

    // Build markdown with separators
    const markdown = trends
      .map(
        (t, i) =>
          `## ${i + 1}. ${t.name}\n\n${t.summary
            .trim()
            .replace(/\r?\n/g, "\n")}`
      )
      .join("\n\n---\n\n");

    console.log("💬 Posting discussion…");
    await postDiscussion(markdown);

    console.log("✅ Discussion posted successfully!");
  } catch (err) {
    console.error("❌ Error:", err.message);
    console.error(err.stack);
    process.exit(1);
  }
})();
