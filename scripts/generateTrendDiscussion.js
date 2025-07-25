// scripts/generateTrendDiscussion.js
(async () => {
  const {
    OPENAI_API_KEY,
    GITHUB_TOKEN,
    DISCUSSION_CATEGORY_ID,
    GITHUB_REPOSITORY,
  } = process.env;

  // Derive repo-owner and repo-name ("<ORG>/.github")
  const [owner, repo] = GITHUB_REPOSITORY.split("/");

  // 1️⃣ Fetch this week’s trends from OpenAI
  const openaiRes = await fetch("https://api.openai.com/v1/chat/completions", {
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
  if (!openaiRes.ok) throw new Error(`OpenAI API error: ${openaiRes.status}`);
  const { choices } = await openaiRes.json();
  const body = choices[0].message.content.trim();

  // 2️⃣ Look up the repository’s node ID via GraphQL
  const lookupRes = await fetch("https://api.github.com/graphql", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${GITHUB_TOKEN}`,
    },
    body: JSON.stringify({
      query: `
        query RepoId($owner:String!, $repo:String!) {
          repository(owner:$owner, name:$repo) { id }
        }
      `,
      variables: { owner, repo },
    }),
  });
  const lookupJson = await lookupRes.json();
  const repositoryId = lookupJson.data.repository.id;

  // 3️⃣ Create the discussion via GraphQL createDiscussion mutation
  const createRes = await fetch("https://api.github.com/graphql", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${GITHUB_TOKEN}`,
    },
    body: JSON.stringify({
      query: `
        mutation CreateDiscussion($input: CreateDiscussionInput!) {
          createDiscussion(input: $input) {
            discussion { id }
          }
        }
      `,
      variables: {
        input: {
          repositoryId,
          categoryId: DISCUSSION_CATEGORY_ID,
          title: `Tech Trends – Week of ${new Date().toLocaleDateString()}`,
          body,
        },
      },
    }),
  });
  const createJson = await createRes.json();
  if (createJson.errors) {
    console.error(createJson.errors);
    throw new Error("Failed to create discussion");
  }

  console.log(
    "✅ Repo discussion created:",
    createJson.data.createDiscussion.discussion.id
  );
})();
