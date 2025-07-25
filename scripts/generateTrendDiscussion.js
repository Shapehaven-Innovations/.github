#!/usr/bin/env node
// scripts/generateTrendDiscussion.js

(async () => {
  const { OPENAI_API_KEY, GITHUB_TOKEN, GITHUB_REPOSITORY } = process.env;
  if (!OPENAI_API_KEY || !GITHUB_TOKEN || !GITHUB_REPOSITORY) {
    console.error(
      "⚠️ Missing one of OPENAI_API_KEY, GITHUB_TOKEN or GITHUB_REPOSITORY"
    );
    process.exit(1);
  }

  const [owner, repo] = GITHUB_REPOSITORY.split("/");

  // 1️⃣ Fetch this week's trends from OpenAI
  const aiRes = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${OPENAI_API_KEY}`,
    },
    body: JSON.stringify({
      model: "gpt-3.5-turbo",
      messages: [
        { role: "system", content: "You’re a tech trends reporter." },
        {
          role: "user",
          content: `What are the top tech trends for the week of ${new Date().toLocaleDateString()}?`,
        },
      ],
      temperature: 0.7,
    }),
  });
  const aiJson = await aiRes.json();
  if (!aiRes.ok) {
    console.error("❌ OpenAI error:", aiJson);
    process.exit(1);
  }
  const body = aiJson.choices[0].message.content.trim();

  // 2️⃣ Query GitHub GraphQL for repo ID + categories
  const repoCatQuery = `
    query RepoWithCats($owner:String!,$repo:String!,$first:Int!) {
      repository(owner:$owner,name:$repo) {
        id
        discussionCategories(first:$first) {
          nodes { id name }
        }
      }
    }
  `;
  const qcRes = await fetch("https://api.github.com/graphql", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${GITHUB_TOKEN}`,
    },
    body: JSON.stringify({
      query: repoCatQuery,
      variables: { owner, repo, first: 20 },
    }),
  });
  const qcJson = await qcRes.json();
  if (!qcRes.ok || qcJson.errors) {
    console.error("❌ GitHub GraphQL error:", qcJson.errors || qcJson);
    process.exit(1);
  }
  const repositoryId = qcJson.data.repository.id;
  const cats = qcJson.data.repository.discussionCategories.nodes;
  const category = cats.find((c) => c.name === "Tech Trends");
  if (!category) {
    console.error(`❌ Category "Tech Trends" not found in ${owner}/${repo}`);
    process.exit(1);
  }
  const categoryId = category.id;

  // 3️⃣ Create the discussion
  const createMutation = `
    mutation CreateDiscussion($input:CreateDiscussionInput!) {
      createDiscussion(input:$input) {
        discussion { url }
      }
    }
  `;
  const cdRes = await fetch("https://api.github.com/graphql", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${GITHUB_TOKEN}`,
    },
    body: JSON.stringify({
      query: createMutation,
      variables: {
        input: {
          repositoryId,
          categoryId,
          title: `Tech Trends – Week of ${new Date().toLocaleDateString()}`,
          body,
        },
      },
    }),
  });
  const cdJson = await cdRes.json();
  if (!cdRes.ok || cdJson.errors) {
    console.error("❌ CreateDiscussion error:", cdJson.errors || cdJson);
    process.exit(1);
  }

  console.log(
    "✅ Discussion created at",
    cdJson.data.createDiscussion.discussion.url
  );
})();
