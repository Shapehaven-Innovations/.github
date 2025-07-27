#!/usr/bin/env node
"use strict";

/**
 * generateTrendDiscussion.js
 *
\
 *
 * Requirements:
 *  • Node 18+ (uses global fetch or install node-fetch)
 *  • Envs: OPENAI_API_KEY, (optional) OPENAI_MODEL, GITHUB_TOKEN, GITHUB_REPOSITORY
 *  • Workflow permissions: discussions: write
 */

async function main() {
  // ─── ENV VARS ───────────────────────────────────────────────────────────────
  const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
  let OPENAI_MODEL = process.env.OPENAI_MODEL;
  const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
  const GITHUB_REPOSITORY = process.env.GITHUB_REPOSITORY;

  if (!OPENAI_API_KEY) {
    console.error("❌ Missing environment variable: OPENAI_API_KEY");
    process.exit(1);
  }
  // Fallback if the secret is unset or blank
  if (!OPENAI_MODEL || !OPENAI_MODEL.trim()) {
    OPENAI_MODEL = "gpt-4";
  }
  if (!GITHUB_TOKEN) {
    console.error("❌ Missing environment variable: GITHUB_TOKEN");
    process.exit(1);
  }
  if (!GITHUB_REPOSITORY) {
    console.error("❌ Missing environment variable: GITHUB_REPOSITORY");
    process.exit(1);
  }

  const [owner, repo] = GITHUB_REPOSITORY.split("/");
  if (!owner || !repo) {
    console.error(
      `❌ Invalid GITHUB_REPOSITORY (“${GITHUB_REPOSITORY}”). Expect “owner/repo”.`
    );
    process.exit(1);
  }

  // ─── HELPERS ─────────────────────────────────────────────────────────────────
  async function withRetry(fn, retries = 2, delay = 500) {
    try {
      return await fn();
    } catch (err) {
      if (retries > 0) {
        console.warn(`⚠️ Retry in ${delay}ms after error: ${err.message}`);
        await new Promise((r) => setTimeout(r, delay));
        return withRetry(fn, retries - 1, delay * 2);
      }
      throw err;
    }
  }

  // ─── STEP 1: Generate trends via OpenAI ────────────────────────────────────────
  let markdownBody;
  try {
    const weekOf = new Date().toLocaleDateString("en-US", {
      month: "long",
      day: "numeric",
      year: "numeric",
    });

    console.log(`🔍 Generating trends from OpenAI (model=${OPENAI_MODEL})…`);
    const aiRes = await withRetry(() =>
      fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${OPENAI_API_KEY}`,
        },
        body: JSON.stringify({
          model: OPENAI_MODEL,
          messages: [
            {
              role: "system",
              content:
                'You are a helpful assistant. Reply *only* with a JSON array of objects, each with keys "title" and "description".',
            },
            {
              role: "user",
              content: `List the top 5 upcoming enterprise technology trends for the week of ${weekOf} as JSON.`,
            },
          ],
          temperature: 0.7,
          max_tokens: 500,
        }),
      })
    );

    if (!aiRes.ok) {
      const text = await aiRes.text();
      throw new Error(`OpenAI error ${aiRes.status}: ${text}`);
    }

    const { choices } = await aiRes.json();
    const raw = choices?.[0]?.message?.content?.trim();
    if (!raw) throw new Error("Empty response from OpenAI");

    let trends;
    try {
      trends = JSON.parse(raw);
    } catch (e) {
      console.error("❌ Failed to parse JSON from OpenAI:");
      console.error(raw);
      throw e;
    }
    if (!Array.isArray(trends) || trends.length === 0) {
      throw new Error("Parsed OpenAI JSON is not a non‑empty array");
    }

    markdownBody = trends
      .map(
        ({ title, description }) =>
          `### ${title.trim()}\n\n${description.trim().replace(/\r?\n/g, "\n")}`
      )
      .join("\n\n---\n\n");
  } catch (err) {
    console.error("❌ Error generating trends:", err);
    process.exit(1);
  }

  // ─── STEP 2: Fetch repo ID & category ID via GraphQL ──────────────────────────
  let repositoryId, categoryId;
  try {
    console.log("🔎 Fetching repository ID and discussion categories…");
    const query = `
      query ($owner: String!, $repo: String!) {
        repository(owner: $owner, name: $repo) {
          id
          discussionCategories(first: 20) {
            nodes { id name }
          }
        }
      }
    `;
    const ghRes = await fetch("https://api.github.com/graphql", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${GITHUB_TOKEN}`,
      },
      body: JSON.stringify({ query, variables: { owner, repo } }),
    });
    const ghJson = await ghRes.json();
    if (ghJson.errors) throw new Error(JSON.stringify(ghJson.errors));

    repositoryId = ghJson.data.repository.id;
    const cats = ghJson.data.repository.discussionCategories.nodes;
    const cat = cats.find((c) => c.name === "Tech Trends");
    if (!cat) throw new Error('Category "Tech Trends" not found');
    categoryId = cat.id;
  } catch (err) {
    console.error("❌ Error fetching GitHub data:", err);
    process.exit(1);
  }

  // ─── STEP 3: Create the Discussion via GraphQL ───────────────────────────────
  try {
    console.log("💬 Creating GitHub Discussion…");
    const mutation = `
      mutation ($input: CreateDiscussionInput!) {
        createDiscussion(input: $input) {
          discussion { url }
        }
      }
    `;
    const variables = {
      input: {
        repositoryId,
        categoryId,
        title: `Tech Trends – Week of ${new Date().toLocaleDateString("en-US", {
          month: "long",
          day: "numeric",
          year: "numeric",
        })}`,
        body: markdownBody,
      },
    };

    const createRes = await fetch("https://api.github.com/graphql", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${GITHUB_TOKEN}`,
      },
      body: JSON.stringify({ query: mutation, variables }),
    });

    const createJson = await createRes.json();
    if (createJson.errors) throw new Error(JSON.stringify(createJson.errors));

    console.log(
      "✅ Discussion created at:",
      createJson.data.createDiscussion.discussion.url
    );
  } catch (err) {
    console.error("❌ Error creating discussion:", err);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("❌ Fatal error:", err);
  process.exit(1);
});
