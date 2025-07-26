#!/usr/bin/env node
/**
 * scripts/generateTrendDiscussion.js
 *
 * Authenticates as your GitHub App → fetches an installation token →
 * then posts the discussion under the App’s identity.
 */

import fetch from "node-fetch";
import { createAppAuth } from "@octokit/auth-app";

(async () => {
  const {
    OPENAI_API_KEY,
    GITHUB_REPOSITORY,
    GITHUB_APP_ID,
    GITHUB_INSTALLATION_ID,
    APP_PRIVATE_KEY,
  } = process.env;

  // ── 1) Validate inputs ──────────────────────────────────────────
  if (!OPENAI_API_KEY) {
    console.error("❌ Missing OPENAI_API_KEY");
    process.exit(1);
  }
  if (!GITHUB_REPOSITORY) {
    console.error("❌ Missing GITHUB_REPOSITORY");
    process.exit(1);
  }
  if (!GITHUB_APP_ID || !GITHUB_INSTALLATION_ID || !APP_PRIVATE_KEY) {
    console.error(
      "❌ Missing one of GITHUB_APP_ID, GITHUB_INSTALLATION_ID, or APP_PRIVATE_KEY"
    );
    process.exit(1);
  }

  // ── 2) Generate an installation token for your App ──────────────
  const auth = createAppAuth({
    appId: GITHUB_APP_ID,
    privateKey: APP_PRIVATE_KEY.replace(/\\n/g, "\n"),
    installationId: Number(GITHUB_INSTALLATION_ID),
  });
  const { token: GH_TOKEN } = await auth({ type: "installation" });

  // Common headers for GitHub GraphQL
  const ghHeaders = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${GH_TOKEN}`,
    Accept: "application/vnd.github+json",
  };

  // ── 3) Call OpenAI for your post body ───────────────────────────
  const weekOf = new Date().toLocaleDateString("en-US", {
    month: "long",
    day: "numeric",
    year: "numeric",
  });
  const aiRes = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${OPENAI_API_KEY}`,
    },
    body: JSON.stringify({
      model: "gpt-3.5-turbo",
      messages: [
        {
          role: "system",
          content: "You are a Senior IT technical reporter.",
        },
        {
          role: "user",
          content: `What are the top tech trends for the week of ${weekOf}? Provide detailed examples. Format as a GitHub discussion post.`,
        },
      ],
      max_tokens: 500,
      temperature: 0.7,
    }),
  });
  if (!aiRes.ok) {
    console.error("❌ OpenAI API error:", await aiRes.text());
    process.exit(1);
  }
  const { choices } = await aiRes.json();
  const body = choices[0].message.content.trim();

  // ── 4) Look up the repository ID & Discussion category ID ───────
  const [owner, repo] = GITHUB_REPOSITORY.split("/");
  const repoCatsQuery = `
    query RepoWithCats($owner:String!,$repo:String!){
      repository(owner:$owner,name:$repo){
        id
        discussionCategories(first:20){
          nodes { id name }
        }
      }
    }
  `;
  const qcRes = await fetch("https://api.github.com/graphql", {
    method: "POST",
    headers: ghHeaders,
    body: JSON.stringify({
      query: repoCatsQuery,
      variables: { owner, repo },
    }),
  });
  const qcJson = await qcRes.json();
  if (qcJson.errors) {
    console.error("❌ GitHub GraphQL error (repo/categories):", qcJson.errors);
    process.exit(1);
  }
  const repositoryId = qcJson.data.repository.id;
  const category = qcJson.data.repository.discussionCategories.nodes.find(
    (c) => c.name === "Tech Trends"
  );
  if (!category) {
    console.error('❌ Could not find a "Tech Trends" category');
    process.exit(1);
  }

  // ── 5) Create the Discussion as your App ────────────────────────
  const createMutation = `
    mutation CreateDiscussion($input:CreateDiscussionInput!){
      createDiscussion(input:$input){
        discussion { url }
      }
    }
  `;
  const cmRes = await fetch("https://api.github.com/graphql", {
    method: "POST",
    headers: ghHeaders,
    body: JSON.stringify({
      query: createMutation,
      variables: {
        input: {
          repositoryId,
          categoryId: category.id,
          title: `Tech Trends – Week of ${weekOf}`,
          body,
        },
      },
    }),
  });
  const cmJson = await cmRes.json();
  if (cmJson.errors) {
    console.error("❌ GitHub GraphQL error (createDiscussion):", cmJson.errors);
    process.exit(1);
  }

  console.log(
    "✅ Discussion created:",
    cmJson.data.createDiscussion.discussion.url
  );
})();
