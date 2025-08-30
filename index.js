// index.js
// Node 18+
// install: npm i express axios chalk

import express from "express";
import axios from "axios";
import chalk from "chalk";

const app = express();
app.use(express.json({ limit: "2mb" }));

// --- CONFIG ---
const FIRECRAWL_BASE = process.env.FIRECRAWL_BASE || "http://5.188.178.213:3002";
const OLLAMA_BASE    = process.env.OLLAMA_BASE    || "http://5.188.150.5:11434"; // your Ollama host
const OLLAMA_MODEL   = process.env.OLLAMA_MODEL   || "gpt-oss:20b";               // try qwen3:32b if you prefer

// Extended schema: fraud verdict + warnings + summary (original language) + language + keywords
const SCHEMA = JSON.stringify({
  type: "object",
  properties: {
    is_fraud: { type: "boolean" },
    risk_score: { type: "number", minimum: 0, maximum: 1 },
    verdict: { type: "string", maxLength: 220 },

    content_warnings: {
      type: "object",
      properties: {
        drugs: { type: "boolean" },              // recreational/illegal drug sales/promotions
        sexual_services: { type: "boolean" }     // prostitution or paid sexual services
      },
      required: ["drugs", "sexual_services"],
      additionalProperties: false
    },

    language: { type: "string", pattern: "^[a-z]{2}(-[A-Z]{2})?$" }, // ISO 639-1 (optionally with region)
    summary: { type: "string", maxLength: 400 },                      // must be in original language
    keywords: {
      type: "array",
      items: { type: "string", maxLength: 40 },                       // in original language
      minItems: 3,
      maxItems: 12
    }
  },
  required: ["is_fraud", "risk_score", "verdict", "content_warnings", "language", "summary", "keywords"],
  additionalProperties: false
});

// Prompt: strict JSON, original-language summary/keywords, plus the fraud rubric
const PROMPT = `You are a web security/content analyst.
Rules:
1) Output ONLY valid minified JSON matching the schema below. No prose, no markdown, no extra keys.
2) Use ONLY on-page content (scraped markdown provided). Do NOT follow external links or use off-page info.
3) Detect the page's original language accurately (ISO 639-1, optionally region), and write both "summary" and "keywords" in that same language.
4) Fraud rubric for "risk_score":
   - ≥0.80: clear fraud/phishing/scam or urgent payment/credential capture/brand impersonation
   - 0.40–0.79: multiple red flags but partial evidence
   - <0.40: likely legitimate/informational
5) Content warnings:
   - "drugs": true if the page promotes/sells illegal/controlled recreational drugs or paraphernalia or mushrooms.
   - "sexual_services": true if the page advertises prostitution or paid sexual services.
6) "keywords": return 3–12 short, topical keywords (no hashtags), in original language; avoid duplicates.

Schema: ${SCHEMA}
Return ONLY the JSON object.`;

// --- Helpers ---
async function scrapeMarkdown(url) {
  console.log(chalk.blueBright(`[SCRAPE] → ${url}`));
  const { data } = await axios.post(
    `${FIRECRAWL_BASE}/v2/scrape`,
    { url, formats: ["markdown"] },            // v2 interface
    { headers: { "Content-Type": "application/json" } }
  );

  const md =
    data?.data?.markdown ??
    data?.data?.content ??
    data?.markdown ??
    data?.content?.markdown ??
    null;

  if (md) {
    console.log(chalk.green(`[SCRAPE] ✓ Got markdown (${md.length} chars)`));
  } else {
    console.log(chalk.red(`[SCRAPE] ✗ No markdown found`));
  }
  return md;
}

async function classifyWithOllama(markdown, url) {
  console.log(chalk.blueBright(`[OLLAMA] → ${OLLAMA_MODEL}, sending ${markdown.length} chars`));

  const { data } = await axios.post(
    `${OLLAMA_BASE}/api/generate`,
    {
      model: OLLAMA_MODEL,
      stream: false,
      options: { temperature: 0 }, // low temp → better JSON compliance
      prompt: `${PROMPT}\n\nPage markdown:\n\n${markdown}`
    },
    { headers: { "Content-Type": "application/json" } }
  );

  const text = data?.response?.trim();
  if (!text) {
    console.log(chalk.red(`[OLLAMA] ✗ Empty response`));
    throw new Error("Empty response from Ollama");
  }

  console.log(chalk.yellow(`[OLLAMA] Raw response (first 400 chars):\n${text.slice(0, 400)}${text.length > 400 ? "..." : ""}`));

  // Parse JSON (with salvage attempt)
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    const m = text.match(/\{[\s\S]*\}$/); // last JSON-ish object
    if (m) {
      try { parsed = JSON.parse(m[0]); } catch {}
    }
  }
  if (!parsed) throw new Error("Ollama returned non-JSON");

  console.log(chalk.green(`[OLLAMA] ✓ Parsed JSON for ${url}`));
  return parsed;
}

// Pretty warnings in console
function logWarnings(result) {
  const w = result?.content_warnings || {};
  if (w.drugs || w.sexual_services) {
    const flags = [
      w.drugs ? chalk.bgRed.white(" DRUGS ") : null,
      w.sexual_services ? chalk.bgMagenta.white(" SEXUAL_SERVICES ") : null
    ].filter(Boolean).join(" ");
    console.log(chalk.bold.redBright(`[WARNINGS] ${flags}`));
  }
}

// --- API ---
app.post("/classify", async (req, res) => {
  const { url } = req.body || {};
  console.log(chalk.magentaBright(`\n=== New request: ${url || "(missing)"} ===`));

  if (!url) {
    console.log(chalk.red(`[API] Missing 'url' in request`));
    return res.status(400).json({ error: "Missing 'url'" });
  }

  try {
    const md = await scrapeMarkdown(url);
    if (!md) return res.status(502).json({ error: "No markdown from Firecrawl" });

    const result = await classifyWithOllama(md, url);
    logWarnings(result);

    // brief console summary
    console.log(chalk.cyan(`[RESULT] is_fraud=${result.is_fraud} risk=${result.risk_score} lang=${result.language}`));
    if (Array.isArray(result.keywords)) {
      console.log(chalk.cyan(`[KEYWORDS] ${result.keywords.join(", ").slice(0, 200)}`));
    }

    return res.json({ success: true, url, result });
  } catch (e) {
    console.log(chalk.red(`[ERROR] ${e.message || e}`));
    return res.status(500).json({ success: false, error: String(e.message || e) });
  }
});

app.get("/", (_, res) => res.send("OK"));

// --- Start ---
const PORT = process.env.PORT || 8080;
app.listen(PORT, "0.0.0.0", () => {
  console.log(chalk.greenBright(`\nServer running on http://0.0.0.0:${PORT}`));
  console.log(chalk.green(`Firecrawl: ${FIRECRAWL_BASE}`));
  console.log(chalk.green(`Ollama:    ${OLLAMA_BASE}  model=${OLLAMA_MODEL}\n`));
});

