import express from "express";
import axios from "axios";
import chalk from "chalk";

const app = express();
app.use(express.json({ limit: "2mb" }));

// --- CONFIG ---
const FIRECRAWL_BASE = process.env.FIRECRAWL_BASE || "http://5.188.178.213:3002";
const OLLAMA_BASE    = process.env.OLLAMA_BASE    || "http://5.188.150.5:11434";
const OLLAMA_MODEL   = process.env.OLLAMA_MODEL   || "gpt-oss:20b";

const FRAUD_SCHEMA =
  '{"type":"object","properties":{"is_fraud":{"type":"boolean"},"risk_score":{"type":"number"},"verdict":{"type":"string"}},"required":["is_fraud","risk_score","verdict"],"additionalProperties":false}';

const PROMPT = `You are a web security analyst.
Return ONLY valid minified JSON that matches this schema: ${FRAUD_SCHEMA}
Use page content ONLY (no external lookups). Keep "verdict" short.`;

// --- Helpers ---
async function scrapeMarkdown(url) {
  console.log(chalk.blueBright(`[SCRAPE] → ${url}`));
  const { data } = await axios.post(
    `${FIRECRAWL_BASE}/v2/scrape`,
    { url, formats: ["markdown"] },
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
  console.log(chalk.blueBright(`[OLLAMA] → Sending page (${markdown.length} chars) to ${OLLAMA_MODEL}`));

  const { data } = await axios.post(
    `${OLLAMA_BASE}/api/generate`,
    {
      model: OLLAMA_MODEL,
      stream: false,
      options: { temperature: 0 },
      prompt: `${PROMPT}\n\nPage markdown:\n\n${markdown}`
    },
    { headers: { "Content-Type": "application/json" } }
  );

  const text = data?.response?.trim();
  if (!text) {
    console.log(chalk.red(`[OLLAMA] ✗ Empty response`));
    throw new Error("Empty response from Ollama");
  }

  console.log(chalk.yellow(`[OLLAMA] Raw response:\n${text.slice(0, 400)}${text.length > 400 ? "..." : ""}`));

  try {
    const parsed = JSON.parse(text);
    console.log(chalk.green(`[OLLAMA] ✓ Parsed JSON for ${url}`));
    return parsed;
  } catch {
    const m = text.match(/\{[\s\S]*\}$/);
    if (m) {
      try {
        const parsed = JSON.parse(m[0]);
        console.log(chalk.green(`[OLLAMA] ✓ Parsed salvaged JSON for ${url}`));
        return parsed;
      } catch (err) {
        console.log(chalk.red(`[OLLAMA] ✗ Salvage parse failed`));
        throw err;
      }
    }
    throw new Error("Ollama returned non-JSON");
  }
}

// --- API ---
app.post("/classify", async (req, res) => {
  const { url } = req.body || {};
  console.log(chalk.magentaBright(`\n=== New request: ${url} ===`));

  if (!url) {
    console.log(chalk.red(`[API] Missing 'url' in request`));
    return res.status(400).json({ error: "Missing 'url'" });
  }

  try {
    const md = await scrapeMarkdown(url);
    if (!md) return res.status(502).json({ error: "No markdown from Firecrawl" });

    const result = await classifyWithOllama(md, url);
    console.log(chalk.cyan(`[RESULT] ${JSON.stringify(result)}`));
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

