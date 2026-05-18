#!/usr/bin/env node
/*
 * LeetSolve - AI-powered LeetCode auto-solver
 * Groq + Puppeteer version
 *
 * Install:
 *   npm install
 *
 * Run:
 *   node leetsolve.js
 */

const puppeteer = require("puppeteer");
const Groq = require("groq-sdk");
const readline = require("node:readline/promises");
const { stdin: input, stdout: output } = require("node:process");
const fs = require("fs");

const pdfParse = require("pdf-parse");

// const pdfParse = pdfParseModule.default || pdfParseModule;

const config = {
  leetcodeUsername: process.env.LEETCODE_USERNAME || "",
  leetcodePassword: process.env.LEETCODE_PASSWORD || "",
  groqApiKey:
    process.env.GROQ_API_KEY ||
    "",
  problemSlug: process.env.PROBLEM_SLUG || "",
  language: process.env.LANGUAGE || "",
  difficultyHint: process.env.DIFFICULTY_HINT || "",
  extraHints:
    process.env.EXTRA_HINTS ||
    "",
  maxRetries: Number(process.env.MAX_RETRIES),
  groqModel: process.env.GROQ_MODEL || "",
  headless: process.env.HEADLESS === "",
};

const labels = {
  python: "Python3",
  python3: "Python3",
  java: "Java",
  cpp: "C++",
  "c++": "C++",
  c: "C",
  javascript: "JavaScript",
};

const slugs = {
  Python3: "python3",
  Python: "python",
  Java: "java",
  "C++": "cpp",
  C: "c",
  JavaScript: "javascript",
};

const groq = new Groq({
  apiKey: config.groqApiKey,
});

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const langLabel = (value) => labels[String(value).toLowerCase()] || value;
const langSlug = (value) =>
  slugs[langLabel(value)] || String(value).toLowerCase();

async function askUser(message) {
  const rl = readline.createInterface({ input, output });
  try {
    return await rl.question(message);
  } finally {
    rl.close();
  }
}

async function waitForEnter(message) {
  await askUser(message);
}

function requireGroqApiKey() {
  if (!config.groqApiKey) {
    throw new Error(
      "Missing Groq API key. Set GROQ_API_KEY before running this script.",
    );
  }
}

function htmlToText(html) {
  return String(html || "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function truncateText(text, maxChars) {
  const value = String(text || "");
  if (value.length <= maxChars) {
    return value;
  }
  return `${value.slice(0, maxChars)}\n\n[Truncated to reduce token usage]`;
}

function starterCode(problem, languageSlug) {
  const snippet = (problem.codeSnippets || []).find(
    (item) => item.langSlug === languageSlug,
  );
  return snippet ? snippet.code : "";
}

function stripFence(text) {
  let value = String(text || "").trim();

  if (!value.startsWith("```")) {
    return value;
  }

  const lines = value.split(/\r?\n/);
  value = lines
    .slice(1, lines[lines.length - 1].trim() === "```" ? -1 : undefined)
    .join("\n")
    .trim();

  return value;
}

async function solveWithGroq(problem, starter, attempt) {
  requireGroqApiKey();

  const retry =
    attempt > 1
      ? `\nAttempt ${attempt}: Previous submission failed. Provide a more robust solution.`
      : "";

  const description = truncateText(htmlToText(problem.content), 4500);
  const examples = truncateText(problem.exampleTestcases || "", 1600);
  const starterSnippet = truncateText(starter, 1800);

  const prompt = `
You are an expert competitive programmer. Solve the following LeetCode problem.

Problem: ${problem.title}
Difficulty: ${config.difficultyHint}
Language: ${config.language}

Description:
${description}

Example Test Cases:
${examples}

Starter Code:
${starterSnippet}

Additional Instructions:
${config.extraHints}
${retry}

Rules:
1. Return ONLY the complete working solution code.
2. Do not include markdown fences.
3. Do not include explanations, comments about the approach, or extra text.
4. The code must be directly pasteable into LeetCode's editor.
5. Handle edge cases and optimize time and space complexity.
`.trim();

  console.log(`[*] Sending to Groq (attempt ${attempt})...`);

  let lastError;
  for (let apiAttempt = 1; apiAttempt <= 2; apiAttempt += 1) {
    try {
      const completion = await groq.chat.completions.create({
        model: config.groqModel,
        messages: [
          {
            role: "user",
            content: prompt,
          },
        ],
        temperature: 0.2,
      });

      const solution = stripFence(completion.choices?.[0]?.message?.content);
      if (!solution) {
        throw new Error("Groq returned an empty solution.");
      }

      console.log(`[OK] Groq returned solution (${solution.length} chars)`);
      return solution;
    } catch (error) {
      lastError = error;
      const status = error.status || error.response?.status;
      const retryable = !status || status === 429 || status >= 500;

      if (!retryable || apiAttempt === 2) {
        break;
      }

      console.log("[!] Groq request failed. Retrying once...");
      await sleep(1200);
    }
  }

  throw lastError;
}

async function createBrowser() {
  const browser = await puppeteer.launch({
    headless: config.headless,
    defaultViewport: null,
    args: [
      "--start-maximized",
      "--disable-blink-features=AutomationControlled",
      "--no-sandbox",
    ],
  });
  const [page] = await browser.pages();
  await page.evaluateOnNewDocument(() =>
    Object.defineProperty(navigator, "webdriver", { get: () => false }),
  );
  return { browser, page };
}

async function login(page) {
  console.log("[*] Opening LeetCode login page...");
  await page.goto("https://leetcode.com/accounts/login/", {
    waitUntil: "domcontentloaded",
    timeout: 60000,
  });

  try {
    await page.waitForSelector("#id_login", { timeout: 15000 });
    await page.type("#id_login", config.leetcodeUsername, { delay: 20 });
    await page.type("#id_password", config.leetcodePassword, { delay: 20 });
    await Promise.allSettled([
      page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 20000 }),
      page.click("#signin_btn"),
    ]);
  } catch (error) {
    console.log("[!] Automatic login skipped: " + error.message);
  }

  if (page.url().includes("/accounts/login")) {
    console.log("[*] Complete login or verification manually in Chrome.");
    await waitForEnter("After successful login press ENTER here... ");
  }

  await page.goto("https://leetcode.com/problemset/", {
    waitUntil: "domcontentloaded",
    timeout: 60000,
  });

  console.log("[OK] Login completed");
}

async function fetchProblem(page, slug) {
  console.log("[*] Fetching problem: " + slug);
  const cookies = await page.cookies();
  const cookieHeader = cookies
    .map((cookie) => cookie.name + "=" + cookie.value)
    .join("; ");
  const csrf =
    (cookies.find((cookie) => cookie.name === "csrftoken") || {}).value || "";
  const query =
    "query getQuestion($titleSlug: String!) { question(titleSlug: $titleSlug) { title titleSlug difficulty content exampleTestcases metaData codeSnippets { lang langSlug code } } }";

  const response = await fetch("https://leetcode.com/graphql", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Referer: "https://leetcode.com/problems/" + slug + "/",
      "x-csrftoken": csrf,
      Cookie: cookieHeader,
    },
    body: JSON.stringify({ query, variables: { titleSlug: slug } }),
  });

  if (!response.ok) {
    throw new Error("GraphQL request failed: HTTP " + response.status);
  }

  const payload = await response.json();
  const problem = payload && payload.data && payload.data.question;
  if (!problem) {
    throw new Error("Problem not found: " + slug);
  }

  console.log(
    "[OK] Problem fetched: " + problem.title + " (" + problem.difficulty + ")",
  );
  return problem;
}

async function clickByText(page, selector, text, timeout) {
  await page.waitForFunction(
    (sel, needle) =>
      [...document.querySelectorAll(sel)].some((el) =>
        (el.textContent || "").includes(needle),
      ),
    { timeout },
    selector,
    text,
  );

  await page.evaluate(
    (sel, needle) => {
      const el = [...document.querySelectorAll(sel)].find((node) =>
        (node.textContent || "").includes(needle),
      );
      if (el) {
        el.click();
      }
    },
    selector,
    text,
  );
}

async function openProblem(page, slug, language) {
  const url = "https://leetcode.com/problems/" + slug + "/";

  console.log("[*] Opening problem page: " + url);

  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      await page.goto(url, {
        waitUntil: "domcontentloaded",
        timeout: 90000,
      });

      await sleep(5000);

      await page.waitForSelector(".monaco-editor, .view-lines", {
        timeout: 30000,
      });

      break;
    } catch (error) {
      console.log(
        `[!] Page open failed (attempt ${attempt}): ${error.message}`,
      );

      if (attempt === 3) {
        throw error;
      }

      await sleep(3000);
    }
  }

  try {
    await page.$$eval("button", (buttons) => {
      const button = buttons.find((item) =>
        /Python|Java|C\+\+|JavaScript|C/.test(item.textContent || ""),
      );

      if (button) {
        button.click();
      }
    });

    await sleep(1000);

    await clickByText(page, "*", langLabel(language), 10000);

    console.log("[OK] Language set to " + langLabel(language));
  } catch (error) {
    console.log("[!] Could not auto-select language: " + error.message);
  }
}

async function injectCode(page, solution) {
  console.log("[*] Injecting solution into code editor...");
  await page.waitForSelector(".monaco-editor, .view-lines", { timeout: 30000 });

  const injected = await page.evaluate((code) => {
    const model =
      globalThis.monaco &&
      globalThis.monaco.editor &&
      globalThis.monaco.editor.getModels()[0];
    if (!model) {
      return false;
    }
    model.setValue(code);
    return true;
  }, solution);

  if (injected) {
    console.log("[OK] Code injected via Monaco API");
    return;
  }

  await page.click(".view-lines");
  await page.keyboard.down("Control");
  await page.keyboard.press("A");
  await page.keyboard.up("Control");
  await page.keyboard.press("Backspace");
  await page.keyboard.type(solution);
  console.log("[OK] Code injected via keyboard");
}

async function submitAndWait(page) {
  console.log("[*] Clicking Submit button...");
  await clickByText(page, "button", "Submit", 30000);
  console.log("[*] Waiting for judge result (up to 60s)...");

  const verdicts = [
    "Accepted",
    "Wrong Answer",
    "Time Limit",
    "Runtime Error",
    "Compile Error",
  ];

  return page
    .waitForFunction(
      (items) =>
        items.find((item) => document.body.innerText.includes(item)) || "",
      { timeout: 60000, polling: 500 },
      verdicts,
    )
    .then((handle) => handle.jsonValue())
    .catch(() => "UNKNOWN (timeout)");
}

async function main() {
  requireGroqApiKey();

  const pdfPath = process.argv[2] || "questions.pdf";

  const problemSlugs = await extractProblemsFromPDF(pdfPath);

  if (!problemSlugs.length) {
    throw new Error("No LeetCode problems found in PDF.");
  }

  console.log("[*] Problems found:", problemSlugs);

  const { browser, page } = await createBrowser();

  try {
    await login(page);

    for (const slug of problemSlugs) {
      console.log("\n==============================");

      console.log("[*] Solving:", slug);

      const problem = await fetchProblem(page, slug);

      const starter = starterCode(problem, langSlug(config.language));

      await openProblem(page, slug, config.language);

      let accepted = false;

      for (let attempt = 1; attempt <= config.maxRetries; attempt += 1) {
        const solution = await solveWithGroq(problem, starter, attempt);

        await injectCode(page, solution);

        const result = await submitAndWait(page);

        console.log(`[RESULT - Attempt ${attempt}]: ${result}`);

        if (String(result).includes("Accepted")) {
          console.log(`[SUCCESS] ${slug}`);

          accepted = true;

          break;
        }

        console.log("[!] Retrying...");

        await sleep(2000);
      }

      if (!accepted) {
        console.log(`[FAILED] ${slug}`);
      }

      await sleep(3000);
    }

    await waitForEnter("Press Enter to close browser...");
  } finally {
    await browser.close();
  }
}

async function extractProblemsFromPDF(pdfPath) {
  const buffer = fs.readFileSync(pdfPath);

  const data = await pdfParse(buffer);

  const text = data.text;

  const matches = [...text.matchAll(/leetcode\.com\/problems\/([a-z0-9-]+)/gi)];

  const slugs = [...new Set(matches.map((m) => m[1]))];

  return slugs;
}

main().catch((error) => {
  console.error("[FULL ERROR STACK]");
  console.error(error);
  console.error(error.stack);

  process.exit(1);
});
