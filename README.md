# GuideMe.md

## Project Name
LeetSolve - AI Powered LeetCode Auto Solver

## Overview
LeetSolve is an automation script that:
- Reads LeetCode problem links from a PDF
- Extracts the problem slugs
- Opens LeetCode automatically using Puppeteer
- Uses Groq AI to generate solutions
- Injects the code into the LeetCode editor
- Submits the solution automatically

Source file: :contentReference[oaicite:0]{index=0}

---

# Requirements

## Install Node.js
Download and install:

- Node.js 18+
- Google Chrome

Official website:
- https://nodejs.org

---

# Install Dependencies

Run:

```bash
npm install puppeteer groq-sdk pdf-parse
