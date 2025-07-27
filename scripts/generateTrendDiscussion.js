#!/usr/bin/env node

/**
 * generateTrendDiscussion.js
 * — uses OpenAI to generate a list of tech‑trend entries (JSON),
 *   then posts them to your GitHub Discussions under “Tech Trends.”
 */

import { OpenAI } from "openai";
import { Octokit } from "@octokit/rest";
import { createAppAuth } from "@octokit/auth-app";

// ─── Environment ─────────────────────────────────────────────────────────────
const {
  OPENAI_API_KEY,
  OPENAI_MODEL = "gpt-4",
  GITHUB_REPOSITORY,
  GITHUB_APP_ID,
  GITHUB_INSTALLATION_ID,
  APP_PRIVATE_KEY,
} = process.env;

function assertEnv(name, val) {
  if (!val) {
    console.error(`❌ Missing environment variable ${name}`);
    process.exit(1);
  }
}
[
  "OPENAI_API_KEY",
  "GITHUB_REPOSITORY",
  "GITHUB_APP_ID",
  "GITHUB_INSTALLATION_ID",
  "APP_PRIVATE_KEY",
].forEach((n) => assertEnv(n, process.env[n]));

const [owner, repo] = GITHUB_REPOSITORY.split("/");

// ─── Helpers ────────────────────────────────────────────────────────────────
async function retry(fn, retries = 2, backoff = 500) {
  try {
    return await fn();
  } catch (err) {
    if (retries > 0) {
      console.warn(`⚠️ Retrying after error: ${err.message}`);
      await new Promise((r) => setTimeout(r, backoff));
      return retry(fn, retries - 1, backoff * 2);
    }
    throw err;
  }
}

// ─── Generate Trends via OpenAI ─────────────────────────────────────────────
async function fetchTrends() {
  const openai = new OpenAI({ apiKey: OPENAI_API_KEY });
  console.log(`🔍 Generating trends via OpenAI (${OPENAI_MODEL})…`);

  const completion = await retry(() =>
    openai.chat.completions.create({
      model: OPENAI_MODEL,
      messages: [
        {
          role: "system",
          content:
            'You are a helpful assistant.  Reply with a JSON array of objects, each having exactly two keys: "title" (a short heading) and "description" (one paragraph).  Do not output any other text.',
        },
        {
          role: "user",
          content:
            "List the top 5 upcoming enterprise technology trends, as JSON.",
        },
      ],
      temperature: 0.7,
    })
  );

  const text = completion.choices[0].message.content.trim();
  let trends;
  try {
    trends = JSON.parse(text);
    if (!Array.isArray(trends)) {
      throw new Error("Response is not a JSON array");
    }
  } catch (err) {
    throw new Error(`Failed to parse OpenAI JSON:\n${text}\n→ ${err.message}`);
  }
  return trends;
}

// ─── Post to GitHub Discussions ─────────────────────────────────────────────
async function getCategoryId(octokit) {
  const { data: cats } = await octokit.rest.discussions.listCategories({
    owner,
    repo,
  });
  const cat = cats.find((c) => c.name === "Tech Trends");
  if (!cat) throw new Error('Discussion category "Tech Trends" not found');
  return cat.id;
}

async function postDiscussion(body) {
  const octokit = new Octokit({
    authStrategy: createAppAuth,
    auth: {
      id: Number(GITHUB_APP_ID),
      privateKey: APP_PRIVATE_KEY.replace(/\\n/g, "\n"),
      installationId: Number(GITHUB_INSTALLATION_ID),
    },
  });

  const category_id = await getCategoryId(octokit);
  const title = `Org Tech Trends — ${new Date().toLocaleDateString("en-US")}`;

  await octokit.rest.discussions.create({
    owner,
    repo,
    category_id,
    title,
    body,
  });
}

// ─── Orchestration ──────────────────────────────────────────────────────────
(async () => {
  try {
    const trends = await fetchTrends();
    if (trends.length === 0) {
      throw new Error("OpenAI returned an empty array");
    }

    const markdown = trends
      .map(
        ({ title, description }) =>
          `### ${title.trim()}\n\n${description.trim().replace(/\r?\n/g, "\n")}`
      )
      .join("\n\n---\n\n");

    console.log("💬 Posting discussion…");
    await postDiscussion(markdown);
    console.log("✅ Discussion posted successfully!");
  } catch (err) {
    console.error("❌ Fatal error:", err.message);
    console.error(err.stack);
    process.exit(1);
  }
})();
