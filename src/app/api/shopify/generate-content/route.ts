import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

// YesScale API hosts, tried in order. The .vip direct endpoint is preferred
// for image/vision requests (avoids the Cloudflare 524 timeout on the .io
// host), with .io as a fallback if .vip is unreachable. Override the whole
// list via YESCALE_API_HOSTS (comma-separated hostnames) without a code change.
const DEFAULT_YESCALE_HOSTS = ["api.yescale.vip", "api.yescale.io"];
const YESCALE_HOSTS = (process.env.YESCALE_API_HOSTS ?? "")
  .split(",")
  .map((h) => h.trim())
  .filter(Boolean);
const API_HOSTS = YESCALE_HOSTS.length ? YESCALE_HOSTS : DEFAULT_YESCALE_HOSTS;
const yescaleUrl = (host: string) => `https://${host}/v1/chat/completions`;

const YESCALE_TOKEN = process.env.YESCALE_API_TOKEN ?? "";
const DEFAULT_MODEL = "gpt-5.4-mini";

// Vision-confirmed working models with 1080x1080 PNG (tested 2026-06-01)
const FALLBACK_MODELS = ["gpt-5.4-mini", "gpt-4o", "gpt-5.4-nano", "gpt-5.2", "gpt-4.1-mini", "gpt-4.1"];

// Available models exposed to the UI
export const AVAILABLE_MODELS = [
  { id: "gpt-5.4-mini", label: "GPT-5.4 Mini (Recommended)" },
  { id: "gpt-4o", label: "GPT-4o (Quality)" },
  { id: "gpt-5.4-nano", label: "GPT-5.4 Nano (Lite)" },
  { id: "gpt-5.2", label: "GPT-5.2" },
  { id: "gpt-4.1-mini", label: "GPT-4.1 Mini (Balanced)" },
  { id: "gpt-4.1", label: "GPT-4.1" },
];

const SYSTEM_PROMPT = `You are a professional product copywriter for a premium pool cue shop called "Uni Cues".
Given an image of a custom billiard cue, generate product content with exactly these markers:

ENGLISH_TITLE: <concise product title, max 80 chars, no code, describe the design>
ENGLISH_DESCRIPTION: <3-5 sentence description highlighting design, craftsmanship, and appeal>
VIETNAMESE_TITLE: <Vietnamese translation of the title>
VIETNAMESE_DESCRIPTION: <Vietnamese translation of the description>
TAGS: <5-10 comma-separated tags relevant to the design, e.g. floral, blue, gradient, custom-cue>

Be specific about colours, patterns, and artistic style you see in the image.`;

const TEXT_ONLY_SYSTEM_PROMPT = `You are a professional product copywriter for a premium pool cue shop called "Uni Cues".
Generate product content for a custom billiard cue with exactly these markers:

ENGLISH_TITLE: <concise product title, max 80 chars, no code, describe the design>
ENGLISH_DESCRIPTION: <3-5 sentence description highlighting design, craftsmanship, and appeal>
VIETNAMESE_TITLE: <Vietnamese translation of the title>
VIETNAMESE_DESCRIPTION: <Vietnamese translation of the description>
TAGS: <5-10 comma-separated tags relevant to the design, e.g. floral, blue, gradient, custom-cue>

Focus on the theme and style described by the user. Create compelling marketing copy.`;

// Output-format contract appended after a ticked skill. The skill decides the
// tone/content; this only guarantees the markers the parser reads, so the
// title/description/tags fields always render. Keep these markers in sync with
// the extract() calls below.
const OUTPUT_FORMAT_CONTRACT = `IMPORTANT — output format rules (override any conflicting instruction):

- Output ONLY the markers below. Do NOT write any preamble, classification, or
  headings before ENGLISH_TITLE. Your entire reply must start with ENGLISH_TITLE.
- Put ALL the rich content (design highlights, materials, why-choose, gifting,
  etc.) INSIDE the ENGLISH_DESCRIPTION marker — not before it. Markdown is allowed
  in the description (headings, bullet lists, bold) and will be rendered.
- Each marker label sits on its own line, exactly as written.

ENGLISH_TITLE: <concise product title, max 80 chars, no code>
ENGLISH_DESCRIPTION: <full rich description — multiple paragraphs / bullet sections, markdown ok>`;

function buildPromptWithAiHint(baseHint: string, withImage: boolean): string {
  const hint = baseHint.trim();
  if (!hint && withImage) {
    return "Please describe and write product copy for this custom pool cue.";
  }
  if (!hint) {
    return "Please write product copy for a custom pool cue. Make it elegant and appealing.";
  }
  return [
    "PRIMARY THEME REQUIREMENT (HIGH PRIORITY):",
    `- Main theme to target: ${hint}`,
    "- Keep this theme as the central direction for the whole copy.",
    "- Reflect it clearly in ENGLISH_TITLE and the first paragraph of ENGLISH_DESCRIPTION.",
    ...(withImage ? ["- Use image details to support this theme, not replace it."] : ["- Create compelling copy based on this theme."]),
    "- Avoid unrelated topics or style drift.",
    "",
    withImage ? "Please describe and write product copy for this custom pool cue." : "Please write product copy for a custom pool cue.",
    "",
    "FINAL PRIORITY REMINDER:",
    "- When conflicts happen, prioritize PRIMARY THEME direction first.",
  ].join("\n");
}

async function callOneHost(host: string, model: string, messages: unknown[]): Promise<{ ok: boolean; content: string; status: number; error: string }> {
  try {
    const response = await fetch(yescaleUrl(host), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${YESCALE_TOKEN}`,
      },
      body: JSON.stringify({ model, messages, max_tokens: 1000 }),
      signal: AbortSignal.timeout(90_000),
    });
    if (response.ok) {
      const data = (await response.json()) as { choices: Array<{ message: { content: string } }> };
      const content = data.choices?.[0]?.message?.content ?? "";
      return { ok: true, content, status: response.status, error: "" };
    }
    const text = await response.text();
    return { ok: false, content: "", status: response.status, error: text };
  } catch (fetchErr) {
    // status 0 = connection-level failure (host unreachable / timeout).
    return { ok: false, content: "", status: 0, error: String(fetchErr) };
  }
}

async function callYesScale(model: string, messages: unknown[], attempt: number): Promise<{ ok: boolean; content: string; status: number; error: string }> {
  if (attempt > 0) await new Promise((r) => setTimeout(r, 1000 * attempt));

  let last = { ok: false, content: "", status: 0, error: "no hosts configured" };
  for (const host of API_HOSTS) {
    const result = await callOneHost(host, model, messages);
    last = result;
    // A real HTTP response (even an error like 503/400) means the host is
    // reachable — stop host-hopping and let model fallback handle it.
    if (result.status !== 0) {
      if (result.status >= 500 && API_HOSTS.length > 1) {
        // 5xx (e.g. Cloudflare 530, gateway): try the next host too.
        console.warn(`[generate-content] host ${host} returned ${result.status}, trying next host`);
        continue;
      }
      return result;
    }
    // Connection failure → try the next host.
    console.warn(`[generate-content] host ${host} unreachable (${result.error.slice(0, 120)}), trying next host`);
  }
  return last;
}

export async function GET() {
  return NextResponse.json({ models: AVAILABLE_MODELS });
}

function sse(event: Record<string, unknown>): string {
  return `data: ${JSON.stringify(event)}\n\n`;
}

export async function POST(request: Request) {
  const supabase = await createClient();
  const {
    data: { user },
    error: userError,
  } = await supabase.auth.getUser();
  if (userError || !user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = (await request.json()) as {
    imageUrl: string;
    hint?: string;
    model?: string;
    // Combined text of the user-selected skills, applied as a system prompt
    // for strict adherence (separate from the theme hint).
    skillPrompt?: string;
  };
  const { imageUrl, hint, model: requestedModel, skillPrompt } = body;

  if (!imageUrl) return NextResponse.json({ error: "imageUrl is required" }, { status: 400 });
  if (!YESCALE_TOKEN) return NextResponse.json({ error: "YESCALE_API_TOKEN is not configured" }, { status: 500 });

  // When a skill is ticked, it controls the tone/content (the built-in copywriter
  // persona is dropped). But the parser below reads ENGLISH_TITLE / DESCRIPTION /
  // TAGS markers out of the response, so we ALWAYS append just the output-format
  // contract after the skill — otherwise the model writes free-form prose with no
  // markers and the title/description fields come back empty.
  const skill = skillPrompt?.trim();
  const visionSystem = skill ? `${skill}\n\n---\n\n${OUTPUT_FORMAT_CONTRACT}` : SYSTEM_PROMPT;
  const textSystem = skill ? `${skill}\n\n---\n\n${OUTPUT_FORMAT_CONTRACT}` : TEXT_ONLY_SYSTEM_PROMPT;

  const primaryModel = requestedModel ?? DEFAULT_MODEL;
  const modelsToTry = [primaryModel, ...FALLBACK_MODELS.filter((m) => m !== primaryModel)];

  const visionUserText = buildPromptWithAiHint(hint ?? "", true);

  // ── DEBUG: log the exact final payload sent to the LLM ──────────────────
  // Server-side only — visible in the terminal running `npm run dev`, NOT in
  // Chrome (Chrome only shows the browser→/api request body, not the prompt
  // assembled here and forwarded to YesScale).
  console.log("\n========== [generate-content] FINAL PAYLOAD TO LLM ==========");
  console.log(`[skill received] ${skill ? `YES (${skill.length} chars)` : "NO — none ticked / empty"}`);
  console.log(`[ai hint]        ${hint?.trim() ? hint.trim() : "(none)"}`);
  console.log(`[model]          ${primaryModel}`);
  console.log("---------- SYSTEM (vision) ----------");
  console.log(visionSystem);
  console.log("---------- USER (vision) ----------");
  console.log(visionUserText);
  console.log("============================================================\n");

  const visionMessages = [
    { role: "system", content: visionSystem },
    {
      role: "user",
      content: [
        { type: "text", text: visionUserText },
        { type: "image_url", image_url: { url: imageUrl, detail: "low" } },
      ],
    },
  ];

  const stream = new ReadableStream({
    async start(controller) {
      const enc = new TextEncoder();
      const push = (event: Record<string, unknown>) => controller.enqueue(enc.encode(sse(event)));

      // Stop a field only at the NEXT known marker, not at any uppercase-colon
      // line — rich descriptions may contain headings like "WHY CHOOSE:" that
      // would otherwise truncate ENGLISH_DESCRIPTION.
      const MARKERS = ["ENGLISH_TITLE", "ENGLISH_DESCRIPTION", "VIETNAMESE_TITLE", "VIETNAMESE_DESCRIPTION", "TAGS"];
      function extract(content: string, marker: string): string {
        const others = MARKERS.filter((m) => m !== marker).join("|");
        const match = content.match(new RegExp(`${marker}:\\s*(.+?)(?=\\n(?:${others}):|$)`, "s"));
        return match ? match[1].trim() : "";
      }

      // Titles must be plain text — strip markdown bold/italic markers and any
      // surrounding quotes the model sometimes adds (e.g. **Title** or "Title").
      function cleanTitle(s: string): string {
        return s
          .replace(/\*\*/g, "")
          .replace(/(^|[\s(])[*_]([^*_]+)[*_]/g, "$1$2")
          .replace(/^["'“”]+|["'“”]+$/g, "")
          .trim();
      }

      let content = "";
      let lastError = "";

      // Phase 1: vision
      outer: for (const model of modelsToTry) {
        for (let attempt = 0; attempt < 2; attempt++) {
          if (attempt === 0) push({ type: "trying", model, phase: "vision" });
          console.log(`[generate-content] Trying vision: model=${model} attempt=${attempt}`);
          const result = await callYesScale(model, visionMessages, attempt);
          if (result.ok) {
            console.log(`[generate-content] Vision success: model=${model}`);
            content = result.content;
            break outer;
          }
          lastError = result.error;
          console.error(`[generate-content] Vision error (model=${model} attempt=${attempt} status=${result.status}):`, result.error.slice(0, 200));
          if (result.status >= 400 && result.status < 500) {
            push({ type: "failed", model, phase: "vision" });
            break;
          }
        }
        if (!content) push({ type: "failed", model, phase: "vision" });
      }

      // Phase 2: text-only fallback
      if (!content) {
        console.warn("[generate-content] All vision attempts failed, falling back to text-only mode");
        push({ type: "fallback", phase: "text-only" });
        const textMessages = [
          { role: "system", content: textSystem },
          { role: "user", content: buildPromptWithAiHint(hint ?? "", false) },
        ];
        outer2: for (const model of modelsToTry) {
          push({ type: "trying", model, phase: "text-only" });
          for (let attempt = 0; attempt < 2; attempt++) {
            console.log(`[generate-content] Trying text-only: model=${model} attempt=${attempt}`);
            const result = await callYesScale(model, textMessages, attempt);
            if (result.ok) {
              console.log(`[generate-content] Text-only success: model=${model}`);
              content = result.content;
              break outer2;
            }
            lastError = result.error;
            console.error(`[generate-content] Text-only error (model=${model} attempt=${attempt} status=${result.status}):`, result.error.slice(0, 200));
            if (result.status >= 400 && result.status < 500) break;
          }
          if (!content) push({ type: "failed", model, phase: "text-only" });
        }
      }

      if (!content) {
        push({ type: "error", message: "Dịch vụ AI tạm thời không khả dụng. Vui lòng thử lại sau ít phút." });
        controller.close();
        return;
      }

      // ── DEBUG: log the RAW model response + what the parser extracted ──
      console.log("\n========== [generate-content] RAW MODEL RESPONSE ==========");
      console.log(content);
      console.log("============================================================\n");

      const enTitle = cleanTitle(extract(content, "ENGLISH_TITLE"));
      const enDesc = extract(content, "ENGLISH_DESCRIPTION");
      const viTitle = cleanTitle(extract(content, "VIETNAMESE_TITLE"));
      const viDesc = extract(content, "VIETNAMESE_DESCRIPTION");
      const tagsRaw = extract(content, "TAGS");
      const tags = tagsRaw
        .split(",")
        .map((t) => t.trim().toLowerCase())
        .filter(Boolean);

      console.log(
        "[generate-content] PARSED →",
        `enTitle=${enTitle ? `"${enTitle}"` : "(empty)"}`,
        `| enDesc=${enDesc ? `${enDesc.length} chars` : "(empty)"}`,
        `| tags=${tags.length}`
      );

      push({ type: "result", title: enTitle, description: enDesc, viTitle, viDescription: viDesc, tags, raw: content });
      controller.close();
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}
