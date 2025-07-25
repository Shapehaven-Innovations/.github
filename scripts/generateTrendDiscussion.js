// .github/scripts/generateTrendDiscussion.js
import { request } from "@octokit/request";
import fetch from "node-fetch";

async function run() {
  const {
    GITHUB_REPOSITORY,
    OPENAI_API_KEY,
    GITHUB_TOKEN,
    DISCUSSION_CATEGORY_ID,
  } = process.env;

  // Derive org from the repo (e.g. "my-org/.github")
  const org = GITHUB_REPOSITORY.split("/")[0];

  // 1. Ask ChatGPT for this week’s trends
  const chatRes = await fetch("https://api.openai.com/v1/chat/completions", {
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
  const { choices } = await chatRes.json();
  const content = choices[0].message.content.trim();

  // 2. Create an **organization discussion**
  await request("POST /orgs/{org}/discussions", {
    org,
    category_id: DISCUSSION_CATEGORY_ID,
    title: `Tech Trends – Week of ${new Date().toLocaleDateString()}`,
    body: content,
    mediaType: { previews: ["symmetra-preview"] },
    headers: {
      authorization: `token ${GITHUB_TOKEN}`,
    },
  });

  console.log("✅ Org discussion created");
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
