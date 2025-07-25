#!/usr/bin/env node
// scripts/generateTrendDiscussion.js

(async () => {
  const { OPENAI_API_KEY, GITHUB_TOKEN, GITHUB_REPOSITORY } = process.env;
  if (!OPENAI_API_KEY) {
    console.error("❌ Missing OPENAI_API_KEY");
    process.exit(1);
  }
  if (!GITHUB_TOKEN) {
    console.error("❌ Missing GITHUB_TOKEN");
    process.exit(1);
  }

  // e.g. "my-org/.github"
  const [owner, repo] = GITHUB_REPOSITORY.split("/");

  // Format for title
  const weekOf = new Date().toLocaleDateString("en-US", {
    month: "long",
    day: "numeric",
    year: "numeric",
  });

  // 1️⃣ Fetch tech trends from OpenAI
  const aiRes = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${OPENAI_API_KEY}`,
    },
    body: JSON.stringify({
      model: "gpt-3.5-turbo",
      messages: [
        { role: "system", content: "You are a tech trends reporter." },
        {
          role: "user",
          content: `What are the top tech trends for the week of ${weekOf}?`,
        },
      ],
      max_tokens: 500,
      temperature: 0.7,
    }),
  });

  if (!aiRes.ok) {
    const err = await aiRes.text();
    console.error("❌ OpenAI API error:", err);
    process.exit(1);
  }

  const { choices } = await aiRes.json();
  const body = choices[0].message.content.trim();

  // 2️⃣ Query GitHub GraphQL for repository ID & discussion categories
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
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${GITHUB_TOKEN}`,
    },
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
  const categoryNode = qcJson.data.repository.discussionCategories.nodes.find(
    (c) => c.name === "Tech Trends"
  );
  if (!categoryNode) {
    console.error('❌ Could not find a "Tech Trends" category in this repo');
    process.exit(1);
  }
  const categoryId = categoryNode.id;

  // 3️⃣ Create the discussion via GraphQL
  const createMutation = `
    mutation CreateDiscussion($input:CreateDiscussionInput!){
      createDiscussion(input:$input){
        discussion { url }
      }
    }
  `;
  const cmRes = await fetch("https://api.github.com/graphql", {
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
