// index.js
// Node 18+
// install: npm i express axios chalk

import express from "express";
import axios from "axios";
import chalk from "chalk";
import { redisReadyPromise, methods } from './redis.js';  // Import the promise

const app = express();
app.use(express.json({ limit: "2mb" }));

// --- CONFIG ---
const FIRECRAWL_BASE = process.env.FIRECRAWL_BASE || "http://5.188.178.213:3002";
const N8N_WEBHOOK_URL = "https://n8n.edgecenter.ru/webhook/d0f48489-1df0-47c2-a48d-b557bb5e4cda";
const TIMEOUT_MS = 15 * 60 * 1000; // 10 minutes

// Extended schema: fraud verdict + warnings + summary (original language) + language + keywords
// --- CONFIGURED SCHEMA (replace the old SCHEMA const) ---
const SCHEMA = JSON.stringify({
  type: "object",
  properties: {
    // High-level verdict
    is_fraud: { type: "boolean" },                          // true == фишинг/мошенничество/имперсонация брендов/выплаты
    risk_score: { type: "number", minimum: 0, maximum: 1 }, // 0..1 по рубрике ниже
    verdict: { type: "string", maxLength: 220 },            // краткая причина

    // Fine-grained categories required by policy
    content_categories: {
      type: "object",
      properties: {
        porn_erotica: { type: "boolean" },                // порно/эротика (не путать с проституцией)
        sexual_services: { type: "boolean" },             // интим-услуги/проституция
        drugs: { type: "boolean" },                       // наркотики/псилоцибин/атрибуты
        extremism: { type: "boolean" },                   // символика/пропаганда/призывы
        casino_gambling: { type: "boolean" },             // казино/букмекеры/азартные игры
        weapons: { type: "boolean" },                     // огнестрел/холодное/торговля оружием
        phishing: { type: "boolean" },                    // сбор логинов/паролей/кодов/кошельков
        government_services_impersonation: { type: "boolean" }, // подмена/имитация гос-сервисов/порталов
        redirect_buttons: { type: "boolean" },            // кнопки/виджеты, маскирующие редирект
        financial_scam_payouts: { type: "boolean" }       // «выплаты», легкие деньги, лохотроны
      },
      required: [
        "porn_erotica", "sexual_services", "drugs", "extremism", "casino_gambling",
        "weapons", "phishing", "government_services_impersonation", "redirect_buttons",
        "financial_scam_payouts"
      ],
      additionalProperties: false
    },

    // Lang + on-page summary/keywords (original language)
    language: { type: "string", pattern: "^[a-z]{2}(-[A-Z]{2})?$" },
    summary: { type: "string", maxLength: 400 },
    keywords: {
      type: "array",
      items: { type: "string", maxLength: 40 },
      minItems: 3,
      maxItems: 12
    },

    // Useful debug fields for moderators
    evidence: {
      type: "array",
      items: { type: "string", maxLength: 120 },          // короткие цитаты/фрагменты из markdown
      minItems: 1,
      maxItems: 6
    },
    impersonated_brands: {
      type: "array",
      items: { type: "string", maxLength: 50 },
      minItems: 0,
      maxItems: 8
    },
    hosting: {
      type: "object",
      properties: {
        domain: { type: "string", maxLength: 200 },
        is_tilda: { type: "boolean" }                     // true если домен выглядит как tilda (например, *.tilda.ws)
      },
      required: ["domain", "is_tilda"],
      additionalProperties: false
    }
  },
  required: [
    "is_fraud", "risk_score", "verdict",
    "content_categories", "language", "summary", "keywords",
    "evidence", "impersonated_brands", "hosting"
  ],
  additionalProperties: false
});


// Prompt: strict JSON, original-language summary/keywords, plus the fraud rubric
const PROMPT = `You are a web security & trust & safety analyst.

Rules (very strict):
1) Output ONLY valid **minified JSON** matching the provided schema. No prose, markdown, comments, or extra keys.
2) Use ONLY on-page content (the scraped markdown below). Do NOT imagine images. Treat alt-text, filenames, captions, anchors, and button labels as text evidence. Do NOT follow links.
3) Detect the original page language (ISO 639-1, optional region). Write both "summary" and "keywords" in Russian language only!
4) Fill "hosting":
   - "domain": the primary domain you can infer from links/markdown context; if unknown, use an empty string "".
   - "is_tilda": true if the domain looks like a Tilda host (e.g., ends with ".tilda.ws" or similar Tilda patterns); else false.
5) Category definitions ("content_categories"):
   - porn_erotica: porn/erotica/nudity meant for arousal (not the same as prostitution ads).
   - sexual_services: prostitution/paid sexual services/escorts/sex work ads.
   - drugs: illegal/controlled recreational drugs (incl. mushrooms) or paraphernalia sales/promo.
   - extremism: extremist symbols, propaganda, recruiting, praise of violent orgs/acts.
   - casino_gambling: casinos, betting, lotteries with real-money stakes or promos (incl. recognizable betting/casino logos).
   - weapons: sale/promo of firearms, ammunition, combat knives, or instructions to traffic these.
   - phishing: credential/payment capture, fake logins/2FA, seed phrases, wallet drains, brand or government impersonation forms.
   - government_services_impersonation: pages imitating official government portals/services to collect data or payments.
   - redirect_buttons: UI that disguises redirects (e.g., deceptive "Download/Play/Continue" that lead elsewhere).
   - financial_scam_payouts: promises of instant payouts/benefits with upfront fees, "get rich quick", pyramid-like pitches.
   Set each boolean strictly from the markdown evidence (true if present/promoted; otherwise false).
6) Fraud rubric:
   - "is_fraud": true if the page aims to deceive or steal (e.g., phishing, impersonation, payout scams). False otherwise.
   - "risk_score":
       ≥0.90 clear fraud/phishing/impersonation with capture forms, seed/wallet requests, or multiple severe violations.
       0.70–0.89 strong evidence of violations (e.g., explicit drug sales, prostitution ads, extremist propaganda, weapons trade, casino with payment funnels), or multiple red flags.
       0.40–0.69 partial/indirect evidence, suggestive language, or weak signals.
       <0.40 likely informational or benign.
7) "verdict": one concise sentence (<=220 chars) explaining the top reason(s) for the score, naming categories (and brand/government names if applicable).
8) "evidence": 1–6 short quotes/snippets from the markdown that justify the decision (remove PII; keep quotes short).
9) "impersonated_brands": brand/org names being mimicked (banks, wallets, gov portals), if any; else [].
10) "keywords": 3–12 topical keywords (no hashtags), in the original language; avoid duplicates.
11) "summary": <=400 chars, in the original language, neutral tone.
12) Be conservative: if signals are weak, lower the score and set unrelated categories to false.

Schema: ${SCHEMA}

Return ONLY the JSON object.

`;

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
async function classifyWithReplicate(markdown, url) {
  console.log(chalk.blueBright(`[REPLICATE] → Sending ${markdown.length} chars to API`));
  
  const { data } = await axios.post(
    'https://api.replicate.com/v1/models/openai/gpt-oss-120b/predictions',
    {
      input: {
        top_p: 1,
        prompt: `${PROMPT}\n\nPage markdown:\n\n${markdown}`,
        max_tokens: 8024,
        temperature: 0.1,
        presence_penalty: 0,
        frequency_penalty: 0
      }
    },
    { 
      headers: { 
        "Authorization": "Bearer 9db188dadde7ff98174dc76fef4b168060cdb37b",
        "Content-Type": "application/json",
        "Prefer": "wait"
      },
      timeout: 10 * 60 * 1000 // 10 minutes
    }
  );

  console.log(chalk.green(`[REPLICATE] ✓ Got response for ${url}`));
  
  // Parse the response output
  let parsed;
  try {
    const output = data?.output;
    if (typeof output === 'string') {
      parsed = JSON.parse(output);
    } else {
      parsed = output;
    }
  } catch (e) {
    console.log(chalk.red(`[REPLICATE] ✗ Failed to parse response: ${e.message}`));
    throw new Error("Invalid response from Replicate API");
  }

  console.log(chalk.green(`[REPLICATE] ✓ Parsed JSON for ${url}`));
  return parsed;
}
async function classifyWithN8N(markdown, url) {
  console.log(chalk.blueBright(`[N8N] → Sending ${markdown.length} chars to webhook`));
  console.log(N8N_WEBHOOK_URL);

  // Wait for Redis to be ready
  await redisReadyPromise;

  const { data } = await axios.post(
    N8N_WEBHOOK_URL,
    {
      prompt: `${PROMPT}\n\nPage markdown:\n\n${markdown}`,
      url: url
    },
    { 
      headers: { "Content-Type": "application/json" },
      timeout: 10 * 60 * 1000 // 10 minutes
    }
  );

  const requestId = data?.request_id;
  if (!requestId) {
    console.log(chalk.red(`[N8N] ✗ No request_id in response`));
    throw new Error("No request_id from N8N webhook");
  }

  console.log(chalk.blue(`[N8N] Got request_id: ${requestId}`));

  // Poll Redis for results
  const redisKey = `tilda_${requestId}`;
  const startTime = Date.now();
  
  while (Date.now() - startTime < TIMEOUT_MS) {
    console.log(chalk.yellow(`[REDIS] Checking ${redisKey}...`));
    
    const result = await methods.get(redisKey);
    if (result) {
      console.log(chalk.green(`[REDIS] ✓ Found result for ${requestId}`));
      
      // Parse JSON result
      let parsed;
      try {
        parsed = JSON.parse(result);
      } catch (e) {
        console.log(chalk.red(`[REDIS] ✗ Failed to parse JSON result: ${e.message}`));
        throw new Error("Invalid JSON in Redis result");
      }

      console.log(chalk.green(`[N8N] ✓ Parsed JSON for ${url}`));
      return parsed;
    }

    // Wait 20 seconds before next check
    await new Promise(resolve => setTimeout(resolve, 20000));
  }

  // Timeout reached
  throw new Error("Timeout waiting for N8N webhook result");
}

// Pretty warnings in console
function logWarnings(result) {
  const w = result?.content_categories || {};
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

    const result = await classifyWithN8N(md, url);
    logWarnings(result);

    // brief console summary
    console.log(chalk.cyan(`[RESULT] is_fraud=${result.is_fraud} risk=${result.risk_score} lang=${result.language}`));
    if (Array.isArray(result.keywords)) {
      console.log(chalk.cyan(`[KEYWORDS] ${result.keywords.join(", ").slice(0, 200)}`));
    }

    return res.json({ success: true, url, result });
  } catch (e) {
    console.log(e)
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
  console.log(chalk.green(`N8N Webhook: ${N8N_WEBHOOK_URL}\n`));
});
