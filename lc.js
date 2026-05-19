#!/usr/bin/env node
/*
 * LeetSolve - AI-powered LeetCode auto-solver
 * Groq + Puppeteer version
 *
 * Install:
 *   npm install
 *
 * Run:
 *   node leetsolve.js [questions.pdf] [report_template.pdf|report_template.docx]
 *
 * Report Generation:
 *   If a report template is provided (2nd argument), after solving each problem
 *   the tool will analyze the template structure and generate a matching report
 *   as both PDF and DOCX in the ./reports/ folder.
 *
 *   Supported template formats: .pdf, .docx
 */

const puppeteer = require("puppeteer");
const Groq = require("groq-sdk");
const readline = require("node:readline/promises");
const { stdin: input, stdout: output } = require("node:process");
const fs = require("fs");
const path = require("path");

const PDFParser = require("pdf2json");

// ─── Config ────────────────────────────────────────────────────────────────────
const config = {
  leetcodeUsername: process.env.LEETCODE_USERNAME || "",
  leetcodePassword: process.env.LEETCODE_PASSWORD || "",
  groqApiKey: process.env.GROQ_API_KEY || "",
  problemSlug: process.env.PROBLEM_SLUG || "",
  language: process.env.LANGUAGE || "",
  difficultyHint: process.env.DIFFICULTY_HINT || "",
  extraHints: process.env.EXTRA_HINTS || "",
  maxRetries: Number(process.env.MAX_RETRIES),
  groqModel: process.env.GROQ_MODEL ,
  headless: process.env.HEADLESS,
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

const groq = new Groq({ apiKey: config.groqApiKey });

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const langLabel = (value) => labels[String(value).toLowerCase()] || value;
const langSlug = (value) =>
  slugs[langLabel(value)] || String(value).toLowerCase();

// ─── Helpers ────────────────────────────────────────────────────────────────────
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
  if (value.length <= maxChars) return value;
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
  if (!value.startsWith("```")) return value;
  const lines = value.split(/\r?\n/);
  value = lines
    .slice(1, lines[lines.length - 1].trim() === "```" ? -1 : undefined)
    .join("\n")
    .trim();
  return value;
}

// ─── Groq Solver ────────────────────────────────────────────────────────────────
async function solveWithGroq(problem, starter, attempt, previousError = "") {
  requireGroqApiKey();

  const retry =
    attempt > 1
      ? `
Previous submission failed on LeetCode.

LeetCode Feedback:
${truncateText(previousError, 2500)}

Generate a COMPLETELY corrected solution.

Requirements:
- Fix all bugs
- Handle edge cases
- Pass hidden test cases
- Optimize runtime and memory
- Return ONLY valid ${config.language} code
`
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
        messages: [{ role: "user", content: prompt }],
        temperature: 0.2,
      });

      const solution = stripFence(completion.choices?.[0]?.message?.content);
      if (!solution) throw new Error("Groq returned an empty solution.");

      console.log(`[OK] Groq returned solution (${solution.length} chars)`);
      return solution;
    } catch (error) {
      lastError = error;
      const status = error.status || error.response?.status;
      const retryable = !status || status === 429 || status >= 500;

      if (!retryable || apiAttempt === 2) break;
      console.log("[!] Groq request failed. Retrying once...");
      await sleep(1200);
    }
  }

  throw lastError;
}

// ─── Browser ────────────────────────────────────────────────────────────────────
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

  if (!response.ok)
    throw new Error("GraphQL request failed: HTTP " + response.status);

  const payload = await response.json();
  const problem = payload && payload.data && payload.data.question;
  if (!problem) throw new Error("Problem not found: " + slug);

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
      if (el) el.click();
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
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 90000 });
      await sleep(5000);
      await page.waitForSelector(".monaco-editor, .view-lines", {
        timeout: 30000,
      });
      break;
    } catch (error) {
      console.log(
        `[!] Page open failed (attempt ${attempt}): ${error.message}`,
      );
      if (attempt === 3) throw error;
      await sleep(3000);
    }
  }

  try {
    await page.$$eval("button", (buttons) => {
      const button = buttons.find((item) =>
        /Python|Java|C\+\+|JavaScript|C/.test(item.textContent || ""),
      );
      if (button) button.click();
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
    if (!model) return false;
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

// ─── PDF Extraction ─────────────────────────────────────────────────────────────
async function extractProblemsFromPDF(pdfPath) {
  return new Promise((resolve, reject) => {
    const pdfParser = new PDFParser();

    pdfParser.on("pdfParser_dataError", (errData) => {
      console.error("[PDF ERROR]", errData.parserError);
      reject(errData.parserError);
    });

    pdfParser.on("pdfParser_dataReady", (pdfData) => {
      try {
        let text = "";

        for (const page of pdfData.Pages || []) {
          for (const textObj of page.Texts || []) {
            for (const run of textObj.R || []) {
              text += decodeURIComponent(run.T) + " ";
            }
          }
        }

        console.log("[*] Extracted text:");
        console.log(text);

        const matches = [
          ...text.matchAll(/leetcode\.com\/problems\/([a-z0-9-]+)/gi),
        ];

        const foundSlugs = [...new Set(matches.map((m) => m[1]))];

        resolve(foundSlugs);
      } catch (err) {
        reject(err);
      }
    });

    pdfParser.loadPDF(pdfPath);
  });
}

// ─── Report Template Feature ────────────────────────────────────────────────────

/**
 * Extracts text content from a template file (.pdf or .docx).
 * Returns a plain-text representation of the template structure.
 */
async function extractTemplateText(templatePath) {
  const ext = path.extname(templatePath).toLowerCase();

  if (ext === ".pdf") {
    return new Promise((resolve, reject) => {
      const pdfParser = new PDFParser();

      pdfParser.on("pdfParser_dataError", (errData) => {
        reject(errData.parserError);
      });

      pdfParser.on("pdfParser_dataReady", (pdfData) => {
        try {
          let text = "";

          for (const page of pdfData.Pages || []) {
            for (const textObj of page.Texts || []) {
              for (const run of textObj.R || []) {
                text += decodeURIComponent(run.T) + " ";
              }
            }
          }

          resolve(text);
        } catch (err) {
          reject(err);
        }
      });

      pdfParser.loadPDF(templatePath);
    });
  }

  if (ext === ".docx") {
    try {
      const mammoth = require("mammoth");
      const result = await mammoth.extractRawText({
        path: templatePath,
      });

      return result.value;
    } catch (e) {
      const AdmZip = require("adm-zip");

      const zip = new AdmZip(templatePath);

      const entry = zip.getEntry("word/document.xml");

      if (!entry) {
        throw new Error("Cannot read docx template.");
      }

      const xml = entry.getData().toString("utf8");

      return xml
        .replace(/<[^>]+>/g, " ")
        .replace(/\s+/g, " ")
        .trim();
    }
  }

  throw new Error(`Unsupported template format: ${ext}`);
}

/**
 * Uses Groq to analyze the template and generate a filled report
 * based on a solved problem's details.
 *
 * @param {string} templateText - Raw text extracted from the template
 * @param {object} reportData   - Problem, solution, result info
 * @returns {string} - Filled report as markdown text (structured for docx/pdf generation)
 */
async function generateReportContent(templateText, reportData) {
  requireGroqApiKey();

  const prompt = `
You are a technical report writer. A user has a report template and wants you to fill it out
based on a solved LeetCode problem.

TEMPLATE STRUCTURE (extracted from user's report template):
---
${truncateText(templateText, 3000)}
---

PROBLEM DETAILS:
- Title: ${reportData.problem.title}
- Slug: ${reportData.problem.titleSlug}
- Difficulty: ${reportData.problem.difficulty}
- URL: https://leetcode.com/problems/${reportData.problem.titleSlug}/
- Language Used: ${reportData.language}
- Submission Result: ${reportData.result}
- Date: ${new Date().toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" })}

PROBLEM DESCRIPTION (plain text):
${truncateText(htmlToText(reportData.problem.content), 2000)}

SOLUTION CODE:
\`\`\`${reportData.languageSlug}
${truncateText(reportData.solution, 2000)}
\`\`\`

INSTRUCTIONS:
1. Use the EXACT SAME STRUCTURE and SECTIONS as the template above.
2. Replace placeholders / template fields with the actual problem data.
3. If the template has a title section, use the problem title.
4. If the template has a description section, fill with the problem description.
5. If the template has a solution/code section, fill with the solution code.
6. If the template has a result/status section, fill with "${reportData.result}".
7. If the template has fields you cannot fill (student name, ID, etc.), leave them as-is or use "[YOUR NAME]" style placeholders.
8. Return the report as clean Markdown that mirrors the template's structure.
9. Do not add extra sections that aren't in the template.
10. Do not include any preamble or explanation — output ONLY the filled report content.
`.trim();

  console.log("[*] Generating report content via Groq...");

  const completion = await groq.chat.completions.create({
    model: config.groqModel,
    messages: [{ role: "user", content: prompt }],
    temperature: 0.3,
    max_tokens: 2000,
  });

  const content = completion.choices?.[0]?.message?.content || "";
  console.log("[OK] Report content generated");
  return content;
}

/**
 * Generates a .docx report file using the docx npm package.
 * Falls back to a well-formatted plain markdown file if docx is not available.
 *
 * @param {string} markdownContent  - The filled report markdown
 * @param {string} outputPath       - Path to write the .docx
 * @param {object} reportData       - Problem/result metadata
 */
async function generateDocxReport(markdownContent, outputPath, reportData) {
  try {
    const {
      Document,
      Packer,
      Paragraph,
      TextRun,
      HeadingLevel,
      AlignmentType,
      BorderStyle,
      ShadingType,
      WidthType,
      Table,
      TableRow,
      TableCell,
    } = require("docx");

    const statusColor = reportData.result.includes("Accepted")
      ? "1A7F37"
      : "CF222E";
    const statusBg = reportData.result.includes("Accepted")
      ? "DCFCE7"
      : "FEE2E2";

    // Parse the markdown into paragraphs for the document body
    const lines = markdownContent.split("\n");
    const children = [];

    // ── Cover block ──
    children.push(
      new Paragraph({
        alignment: AlignmentType.CENTER,
        spacing: { before: 0, after: 120 },
        children: [
          new TextRun({
            text: "LeetSolve",
            bold: true,
            size: 14,
            color: "6366F1",
            font: "Arial",
          }),
        ],
      }),
    );

    // ── Parse markdown lines into docx paragraphs ──
    for (const rawLine of lines) {
      const line = rawLine.trimEnd();

      if (!line.trim()) {
        children.push(
          new Paragraph({ spacing: { before: 0, after: 80 }, children: [] }),
        );
        continue;
      }

      // H1
      if (line.startsWith("# ")) {
        children.push(
          new Paragraph({
            heading: HeadingLevel.HEADING_1,
            spacing: { before: 320, after: 160 },
            children: [
              new TextRun({
                text: line.slice(2),
                bold: true,
                size: 32,
                font: "Arial",
                color: "1E293B",
              }),
            ],
          }),
        );
        continue;
      }

      // H2
      if (line.startsWith("## ")) {
        children.push(
          new Paragraph({
            heading: HeadingLevel.HEADING_2,
            spacing: { before: 240, after: 120 },
            border: {
              bottom: {
                style: BorderStyle.SINGLE,
                size: 4,
                color: "E2E8F0",
                space: 1,
              },
            },
            children: [
              new TextRun({
                text: line.slice(3),
                bold: true,
                size: 26,
                font: "Arial",
                color: "334155",
              }),
            ],
          }),
        );
        continue;
      }

      // H3
      if (line.startsWith("### ")) {
        children.push(
          new Paragraph({
            heading: HeadingLevel.HEADING_3,
            spacing: { before: 160, after: 80 },
            children: [
              new TextRun({
                text: line.slice(4),
                bold: true,
                size: 22,
                font: "Arial",
                color: "475569",
              }),
            ],
          }),
        );
        continue;
      }

      // Code block (```lang ... ```) - simple: treat as monospace paragraph
      if (line.startsWith("```")) {
        // Skip fence lines themselves
        continue;
      }

      // Bullet
      if (line.match(/^[-*] /)) {
        children.push(
          new Paragraph({
            spacing: { before: 40, after: 40 },
            indent: { left: 720, hanging: 360 },
            children: [
              new TextRun({
                text: "• ",
                bold: true,
                font: "Arial",
                size: 22,
                color: "6366F1",
              }),
              new TextRun({
                text: line.slice(2),
                font: "Arial",
                size: 22,
                color: "334155",
              }),
            ],
          }),
        );
        continue;
      }

      // Bold inline **text**
      const parts = line.split(/(\*\*[^*]+\*\*)/g);
      const runs = parts.map((part) => {
        if (part.startsWith("**") && part.endsWith("**")) {
          return new TextRun({
            text: part.slice(2, -2),
            bold: true,
            font: "Arial",
            size: 22,
            color: "1E293B",
          });
        }
        return new TextRun({
          text: part,
          font: "Arial",
          size: 22,
          color: "334155",
        });
      });

      children.push(
        new Paragraph({ spacing: { before: 40, after: 80 }, children: runs }),
      );
    }

    // ── Status banner ──
    const border = { style: BorderStyle.SINGLE, size: 1, color: "E2E8F0" };
    const borders = {
      top: border,
      bottom: border,
      left: border,
      right: border,
    };

    children.push(
      new Table({
        width: { size: 9360, type: WidthType.DXA },
        columnWidths: [6960, 2400],
        rows: [
          new TableRow({
            children: [
              new TableCell({
                borders,
                width: { size: 6960, type: WidthType.DXA },
                shading: { fill: "F8FAFC", type: ShadingType.CLEAR },
                margins: { top: 120, bottom: 120, left: 160, right: 160 },
                children: [
                  new Paragraph({
                    children: [
                      new TextRun({
                        text: "Problem: ",
                        bold: true,
                        font: "Arial",
                        size: 20,
                        color: "475569",
                      }),
                      new TextRun({
                        text: reportData.problem.title,
                        font: "Arial",
                        size: 20,
                        color: "1E293B",
                      }),
                    ],
                  }),
                  new Paragraph({
                    children: [
                      new TextRun({
                        text: "Difficulty: ",
                        bold: true,
                        font: "Arial",
                        size: 20,
                        color: "475569",
                      }),
                      new TextRun({
                        text: reportData.problem.difficulty,
                        font: "Arial",
                        size: 20,
                        color: "1E293B",
                      }),
                    ],
                  }),
                  new Paragraph({
                    children: [
                      new TextRun({
                        text: "Language: ",
                        bold: true,
                        font: "Arial",
                        size: 20,
                        color: "475569",
                      }),
                      new TextRun({
                        text: reportData.language,
                        font: "Arial",
                        size: 20,
                        color: "1E293B",
                      }),
                    ],
                  }),
                ],
              }),
              new TableCell({
                borders,
                width: { size: 2400, type: WidthType.DXA },
                shading: { fill: statusBg, type: ShadingType.CLEAR },
                margins: { top: 120, bottom: 120, left: 160, right: 160 },
                verticalAlign: "center",
                children: [
                  new Paragraph({
                    alignment: AlignmentType.CENTER,
                    children: [
                      new TextRun({
                        text: reportData.result.includes("Accepted")
                          ? "✓ Accepted"
                          : "✗ " + reportData.result,
                        bold: true,
                        font: "Arial",
                        size: 20,
                        color: statusColor,
                      }),
                    ],
                  }),
                ],
              }),
            ],
          }),
        ],
      }),
    );

    // ── Solution code block as styled table ──
    children.push(
      new Paragraph({
        spacing: { before: 240, after: 120 },
        children: [
          new TextRun({
            text: "Solution Code",
            bold: true,
            size: 24,
            font: "Arial",
            color: "334155",
          }),
        ],
      }),
    );

    const codeLines = reportData.solution.split("\n");
    const codeChildren = codeLines.flatMap((codeLine, idx) => [
      new Paragraph({
        spacing: { before: 0, after: 0 },
        children: [
          new TextRun({
            text: codeLine || " ",
            font: "Courier New",
            size: 18,
            color: "1E293B",
          }),
        ],
      }),
    ]);

    children.push(
      new Table({
        width: { size: 9360, type: WidthType.DXA },
        columnWidths: [9360],
        rows: [
          new TableRow({
            children: [
              new TableCell({
                borders: {
                  top: { style: BorderStyle.SINGLE, size: 1, color: "CBD5E1" },
                  bottom: {
                    style: BorderStyle.SINGLE,
                    size: 1,
                    color: "CBD5E1",
                  },
                  left: { style: BorderStyle.SINGLE, size: 6, color: "6366F1" },
                  right: {
                    style: BorderStyle.SINGLE,
                    size: 1,
                    color: "CBD5E1",
                  },
                },
                width: { size: 9360, type: WidthType.DXA },
                shading: { fill: "F8FAFC", type: ShadingType.CLEAR },
                margins: { top: 120, bottom: 120, left: 200, right: 120 },
                children: codeChildren,
              }),
            ],
          }),
        ],
      }),
    );

    // ── Footer note ──
    children.push(
      new Paragraph({
        spacing: { before: 480, after: 0 },
        alignment: AlignmentType.CENTER,
        border: {
          top: {
            style: BorderStyle.SINGLE,
            size: 2,
            color: "E2E8F0",
            space: 1,
          },
        },
        children: [
          new TextRun({
            text: `Generated by LeetSolve  •  ${new Date().toLocaleString()}`,
            font: "Arial",
            size: 16,
            color: "94A3B8",
            italics: true,
          }),
        ],
      }),
    );

    const doc = new Document({
      styles: {
        default: { document: { run: { font: "Arial", size: 22 } } },
      },
      sections: [
        {
          properties: {
            page: {
              size: { width: 12240, height: 15840 },
              margin: { top: 1440, right: 1440, bottom: 1440, left: 1440 },
            },
          },
          children,
        },
      ],
    });

    const buffer = await Packer.toBuffer(doc);
    fs.writeFileSync(outputPath, buffer);
    console.log(`[OK] DOCX report saved: ${outputPath}`);
  } catch (err) {
    console.error("[DOCX GENERATION FAILED]");
    console.error(err);

    throw new Error(
      "DOCX generation failed. Make sure 'docx' package is installed correctly.",
    );
  }
}

/**
 * Generates a PDF report using reportlab via a small Python helper script.
 * If Python/reportlab is unavailable, skips gracefully.
 *
 * @param {string} markdownContent  - Filled report markdown
 * @param {string} outputPath       - Path to write the .pdf
 * @param {object} reportData       - Problem/result metadata
 */
async function generatePdfReport(markdownContent, outputPath, reportData) {
  const { execSync } = require("child_process");

  // Write a temporary python script to generate the PDF
  const tmpPy = path.join(
    path.dirname(outputPath),
    `_tmp_report_gen_${Date.now()}.py`,
  );
  const safeTitle = reportData.problem.title.replace(/'/g, "\\'");
  const safeResult = reportData.result.replace(/'/g, "\\'");
  const safeDifficulty = reportData.problem.difficulty.replace(/'/g, "\\'");
  const safeLanguage = reportData.language.replace(/'/g, "\\'");
  const safeSlug = reportData.problem.titleSlug;
  const safeDate = new Date().toLocaleDateString("en-US", {
    year: "numeric",
    month: "long",
    day: "numeric",
  });

  // Escape solution for embedding in Python
  const escapedSolution = reportData.solution
    .replace(/\\/g, "\\\\")
    .replace(/'/g, "\\'")
    .replace(/\n/g, "\\n");

  // Escape markdown for embedding in Python
  const escapedMarkdown = markdownContent
    .replace(/\\/g, "\\\\")
    .replace(/'/g, "\\'")
    .replace(/\n/g, "\\n");

  const isAccepted = reportData.result.includes("Accepted");
  const statusColor = isAccepted ? "(0.1, 0.5, 0.22)" : "(0.81, 0.13, 0.18)";
  const statusBg = isAccepted ? "(0.86, 0.99, 0.89)" : "(0.99, 0.89, 0.89)";

  const pyScript = `
import sys
try:
    from reportlab.lib.pagesizes import letter
    from reportlab.platypus import (SimpleDocTemplate, Paragraph, Spacer,
                                    Preformatted, Table, TableStyle, HRFlowable)
    from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
    from reportlab.lib import colors
    from reportlab.lib.units import inch
    from reportlab.lib.enums import TA_LEFT, TA_CENTER, TA_RIGHT
except ImportError:
    print("REPORTLAB_MISSING")
    sys.exit(0)

OUTPUT = '${outputPath.replace(/\\/g, "/")}'
TITLE = '${safeTitle}'
RESULT = '${safeResult}'
DIFFICULTY = '${safeDifficulty}'
LANGUAGE = '${safeLanguage}'
SLUG = '${safeSlug}'
DATE = '${safeDate}'
SOLUTION = '${escapedSolution}'
MARKDOWN = '${escapedMarkdown}'
IS_ACCEPTED = ${isAccepted ? "True" : "False"}

doc = SimpleDocTemplate(
    OUTPUT, pagesize=letter,
    leftMargin=inch, rightMargin=inch,
    topMargin=inch, bottomMargin=inch,
)

styles = getSampleStyleSheet()

# Custom styles
title_style = ParagraphStyle(
    'CustomTitle', parent=styles['Title'],
    fontName='Helvetica-Bold', fontSize=22,
    textColor=colors.HexColor('#1E293B'),
    spaceAfter=6, spaceBefore=0,
)
brand_style = ParagraphStyle(
    'Brand', parent=styles['Normal'],
    fontName='Helvetica-Bold', fontSize=10,
    textColor=colors.HexColor('#6366F1'),
    spaceAfter=4, alignment=TA_CENTER,
)
h2_style = ParagraphStyle(
    'H2', parent=styles['Heading2'],
    fontName='Helvetica-Bold', fontSize=14,
    textColor=colors.HexColor('#334155'),
    spaceBefore=16, spaceAfter=6,
)
h3_style = ParagraphStyle(
    'H3', parent=styles['Heading3'],
    fontName='Helvetica-Bold', fontSize=12,
    textColor=colors.HexColor('#475569'),
    spaceBefore=12, spaceAfter=4,
)
body_style = ParagraphStyle(
    'Body', parent=styles['Normal'],
    fontName='Helvetica', fontSize=11,
    textColor=colors.HexColor('#334155'),
    spaceBefore=2, spaceAfter=4, leading=16,
)
code_style = ParagraphStyle(
    'Code', parent=styles['Code'],
    fontName='Courier', fontSize=9,
    textColor=colors.HexColor('#1E293B'),
    backColor=colors.HexColor('#F8FAFC'),
    spaceBefore=0, spaceAfter=0, leading=14,
    leftIndent=8, rightIndent=8,
)
footer_style = ParagraphStyle(
    'Footer', parent=styles['Normal'],
    fontName='Helvetica-Oblique', fontSize=8,
    textColor=colors.HexColor('#94A3B8'),
    alignment=TA_CENTER,
)
label_style = ParagraphStyle(
    'Label', parent=styles['Normal'],
    fontName='Helvetica-Bold', fontSize=10,
    textColor=colors.HexColor('#475569'),
)
value_style = ParagraphStyle(
    'Value', parent=styles['Normal'],
    fontName='Helvetica', fontSize=10,
    textColor=colors.HexColor('#1E293B'),
)
status_style = ParagraphStyle(
    'Status', parent=styles['Normal'],
    fontName='Helvetica-Bold', fontSize=11,
    textColor=colors.HexColor('${isAccepted ? "1A7F37" : "CF222E"}'),
    alignment=TA_CENTER,
)

story = []

# Brand
story.append(Paragraph('⚡ LeetSolve', brand_style))
story.append(HRFlowable(width='100%', thickness=1, color=colors.HexColor('#E2E8F0'), spaceAfter=8))

# Parse markdown for structured content
lines = MARKDOWN.split('\\\\n')
in_code_block = False
code_buf = []

for line in lines:
    if line.startswith('\`\`\`'):
        if in_code_block:
            # flush code block
            if code_buf:
                code_text = '\\\\n'.join(code_buf)
                story.append(Preformatted(code_text, code_style))
                story.append(Spacer(1, 6))
            code_buf = []
            in_code_block = False
        else:
            in_code_block = True
        continue

    if in_code_block:
        code_buf.append(line)
        continue

    if not line.strip():
        story.append(Spacer(1, 4))
        continue

    if line.startswith('# '):
        story.append(Paragraph(line[2:], title_style))
        story.append(HRFlowable(width='100%', thickness=2,
                                color=colors.HexColor('#6366F1'), spaceAfter=8))
    elif line.startswith('## '):
        story.append(Paragraph(line[3:], h2_style))
        story.append(HRFlowable(width='100%', thickness=0.5,
                                color=colors.HexColor('#E2E8F0'), spaceAfter=4))
    elif line.startswith('### '):
        story.append(Paragraph(line[4:], h3_style))
    elif line.startswith('- ') or line.startswith('* '):
        story.append(Paragraph(f'&bull; {line[2:]}', body_style))
    else:
        # Handle **bold**
        import re
        formatted = re.sub(r'\\\\*\\\\*(.*?)\\\\*\\\\*', r'<b>\\\\1</b>', line)
        story.append(Paragraph(formatted, body_style))

# ── Meta info table ──
story.append(Spacer(1, 12))
story.append(HRFlowable(width='100%', thickness=1, color=colors.HexColor('#E2E8F0'), spaceAfter=8))

meta_data = [
    [Paragraph('<b>Problem</b>', label_style), Paragraph(TITLE, value_style)],
    [Paragraph('<b>Difficulty</b>', label_style), Paragraph(DIFFICULTY, value_style)],
    [Paragraph('<b>Language</b>', label_style), Paragraph(LANGUAGE, value_style)],
    [Paragraph('<b>URL</b>', label_style), Paragraph(f'leetcode.com/problems/{SLUG}/', value_style)],
    [Paragraph('<b>Date</b>', label_style), Paragraph(DATE, value_style)],
    [Paragraph('<b>Status</b>', label_style), Paragraph(RESULT, status_style)],
]
meta_table = Table(meta_data, colWidths=[1.5*inch, 5.5*inch])
meta_table.setStyle(TableStyle([
    ('BACKGROUND', (0, 0), (0, -1), colors.HexColor('#F8FAFC')),
    ('BACKGROUND', (0, 5), (-1, 5), colors.HexColor('${isAccepted ? "DCFCE7" : "FEE2E2"}')),
    ('GRID', (0, 0), (-1, -1), 0.5, colors.HexColor('#E2E8F0')),
    ('TOPPADDING', (0, 0), (-1, -1), 6),
    ('BOTTOMPADDING', (0, 0), (-1, -1), 6),
    ('LEFTPADDING', (0, 0), (-1, -1), 10),
    ('RIGHTPADDING', (0, 0), (-1, -1), 10),
    ('VALIGN', (0, 0), (-1, -1), 'MIDDLE'),
]))
story.append(meta_table)

# ── Solution code ──
story.append(Spacer(1, 16))
story.append(Paragraph('Solution Code', h2_style))
story.append(HRFlowable(width='100%', thickness=0.5, color=colors.HexColor('#E2E8F0'), spaceAfter=6))
story.append(Preformatted(SOLUTION, code_style))

# ── Footer ──
story.append(Spacer(1, 24))
story.append(HRFlowable(width='100%', thickness=1, color=colors.HexColor('#E2E8F0'), spaceAfter=6))
import datetime
now = datetime.datetime.now().strftime('%Y-%m-%d %H:%M:%S')
story.append(Paragraph(f'Generated by LeetSolve  •  {now}', footer_style))

doc.build(story)
print("PDF_OK:" + OUTPUT)
`;

  fs.writeFileSync(tmpPy, pyScript, "utf8");

  try {
    const result = execSync(`python3 "${tmpPy}"`, { timeout: 30000 })
      .toString()
      .trim();
    if (result === "REPORTLAB_MISSING") {
      console.log(
        "[!] reportlab not installed. Install with: pip install reportlab",
      );
      console.log("[!] Skipping PDF generation. DOCX report was still saved.");
    } else if (result.startsWith("PDF_OK:")) {
      console.log(`[OK] PDF report saved: ${outputPath}`);
    } else {
      console.log("[!] PDF generation output:", result);
    }
  } catch (err) {
    console.log(`[!] PDF generation failed: ${err.message}`);
    console.log(
      "[!] Make sure Python 3 and reportlab are installed: pip install reportlab",
    );
  } finally {
    try {
      fs.unlinkSync(tmpPy);
    } catch (_) {}
  }
}

/**
 * Main report generation orchestrator.
 * Reads the template, generates content via Groq, then writes both DOCX and PDF.
 *
 * @param {string} templatePath - Path to the user's report template (.pdf or .docx)
 * @param {object} reportData   - { problem, solution, result, language, languageSlug }
 */
async function generateReport(templatePath, reportData) {
  if (!templatePath || !fs.existsSync(templatePath)) {
    console.log("[*] No report template provided. Skipping report generation.");
    return;
  }

  console.log(
    `\n[*] Report generation started using template: ${templatePath}`,
  );

  // Create reports/ directory
  const reportsDir = path.join(process.cwd(), "reports");
  if (!fs.existsSync(reportsDir)) fs.mkdirSync(reportsDir, { recursive: true });

  const safeSlug = reportData.problem.titleSlug.replace(/[^a-z0-9-]/gi, "_");
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const baseName = `${safeSlug}_${timestamp}`;

  try {
    // 1. Extract template structure
    const templateText = await extractTemplateText(templatePath);
    console.log(`[OK] Template text extracted (${templateText.length} chars)`);

    // 2. Generate report content matching template structure
    const reportContent = await generateReportContent(templateText, reportData);

    // 3. Save as DOCX
    const docxPath = path.join(reportsDir, `${baseName}.docx`);
    await generateDocxReport(reportContent, docxPath, reportData);

    // 4. Save as PDF
    const pdfPath = path.join(reportsDir, `${baseName}.pdf`);
    await generatePdfReport(reportContent, pdfPath, reportData);

    // 5. Also save raw markdown for reference
    console.log(`  - ${baseName}.md`);

    console.log(`\n[REPORT] Files saved to: ${reportsDir}/`);
    console.log(`  - ${baseName}.docx`);
    console.log(`  - ${baseName}.pdf`);
    console.log(`  - ${baseName}.md`);
  } catch (err) {
    console.log(`[!] Report generation failed: ${err.message}`);
  }
}

// ─── Main ────────────────────────────────────────────────────────────────────────
// ─── Main ────────────────────────────────────────────────────────────────────────
async function main() {
  requireGroqApiKey();

  const pdfPath = process.argv[2] || "questions.pdf";

  // Optional 2nd argument = report template
  const templatePath = process.argv[3] || null;

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

      let finalSolution = "";

      let finalResult = "Not attempted";

      let errorDetails = "";

      for (let attempt = 1; attempt <= config.maxRetries; attempt += 1) {
        console.log(`\n[*] AI solving attempt ${attempt}/${config.maxRetries}`);

        const solution = await solveWithGroq(
          problem,
          starter,
          attempt,
          errorDetails,
        );

        finalSolution = solution;

        await injectCode(page, solution);

        const result = await submitAndWait(page);

        finalResult = result;

        console.log(`[RESULT - Attempt ${attempt}]: ${result}`);

        // Capture detailed page output for retry context
        try {
          errorDetails = await page.evaluate(() => {
            return document.body.innerText.slice(0, 5000);
          });

          console.log("[*] Captured LeetCode feedback for retry context");
        } catch (err) {
          console.log("[!] Failed to capture error details:", err.message);
        }

        // Success
        if (String(result).toLowerCase().includes("accepted")) {
          console.log(`[SUCCESS] ${slug}`);

          accepted = true;

          break;
        }

        // Retry
        if (attempt < config.maxRetries) {
          console.log("[!] Submission failed. AI will retry with feedback...");

          await sleep(3000);
        }
      }

      // Final failure
      if (!accepted) {
        console.log(`[FAILED] ${slug}`);

        console.log(
          "[!] Report generation skipped because solution was not accepted.",
        );
      } else {
        console.log("[OK] Accepted solution confirmed.");

        // Generate report ONLY after success
        if (templatePath) {
          console.log("[*] Generating final report from accepted solution...");

          await generateReport(templatePath, {
            problem,
            solution: finalSolution,
            result: finalResult,
            language: langLabel(config.language),
            languageSlug: langSlug(config.language),
          });

          console.log("[OK] Report generation completed.");
        }
      }

      await sleep(3000);
    }

    await waitForEnter("Press Enter to close browser...");
  } finally {
    await browser.close();
  }
}

main().catch((error) => {
  console.error("[FULL ERROR STACK]");
  console.error(error);
  console.error(error.stack);
  process.exit(1);
});
