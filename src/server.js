import dotenv from "dotenv";
import express from "express";
import { Pool } from "pg";
import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";

dotenv.config();

const app = express();
const port = Number(process.env.PORT || 3000);
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const LLM_FALLBACK_ENABLED = String(process.env.LLM_FALLBACK_ENABLED || "false").toLowerCase() === "true";
const OPENAI_API_KEY = String(process.env.OPENAI_API_KEY || "").trim();
const OPENAI_MODEL = String(process.env.OPENAI_MODEL || "gpt-4o-mini").trim();
const LATENCY_MODE = String(process.env.LATENCY_MODE || "fast").toLowerCase(); // fast | normal
const UI_CHAT_ONLY = String(process.env.UI_CHAT_ONLY || "false").toLowerCase() === "true";
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const intentsFilePath = path.resolve(__dirname, "..", "data", "intents.json");
const stateResponsesFilePath = path.resolve(__dirname, "..", "data", "state_responses.json");

app.use(express.json({ limit: "2mb" }));
app.use(express.static(path.resolve(__dirname, "..", "public")));

function formatPerson(salutation, firstName, lastName) {
  const value = `${salutation || ""} ${firstName || ""} ${lastName || ""}`.replace(/\s+/g, " ").trim();
  return value || "Ihnen";
}

function withLeadFallback(inputLead = {}) {
  return {
    salutation: inputLead.salutation || "Herr",
    first_name: inputLead.first_name || "Max",
    last_name: inputLead.last_name || "Mustermann",
    street: inputLead.street || "Hauptstr. 12",
    city: inputLead.city || "Ludwigshafen",
    email: inputLead.email || "max@example.com"
  };
}

const TEXT = {
  recordingNotice: "Hinweis vorab: Dieses Gespräch kann zu Schulungszwecken aufgezeichnet werden. Ist das für Sie in Ordnung?",
  recordingAccepted: "Vielen Dank.",
  recordingDeclined: "Alles klar, dann führen wir das Gespräch ohne Aufzeichnung weiter.",
  recordingQuestion: "Nein, das muss nicht aufgezeichnet werden. Wir nutzen Aufzeichnungen nur zur Qualitätsverbesserung. Wenn Sie das nicht möchten, führen wir das Gespräch ohne Aufzeichnung weiter.",
  identityGate: (salutation, firstName, lastName) => `Damit ich korrekt bleibe: Spreche ich mit ${formatPerson(salutation, firstName, lastName)}?`,
  mainPitch:
    "Ich halte es ganz kurz. Gerade in der Region hat sich zuletzt einiges verändert. Deshalb schauen viele ehemalige Leser aktuell noch einmal kurz in die RHEINPFALZ rein. Dafür gibt es eine kostenlose Leseprobe, die automatisch endet. Was passt besser zu Ihnen – Zeitung nach Hause oder direkt digital?",
  objectionDefault:
    "Verstehe ich. Genau deshalb ist es nur zum kurzen Testen gedacht. Was passt besser – Zeitung nach Hause oder digital?",
  chooseQuestion: "Was passt besser zu Ihnen – Zeitung nach Hause oder digital?",
  handoffConfirm: "Verstanden. Ich leite Sie gern an einen Mitarbeiter weiter.",
  handoffDone: "Vielen Dank. Die Weiterleitung wurde gestartet. Auf Wiederhören.",
  stopRespect: "Alles klar, das respektiere ich. Vielen Dank für Ihre Zeit und einen schönen Tag. Auf Wiederhören.",
  noDataClose:
    "Das ist völlig in Ordnung. Ohne bestätigte Daten richte ich nichts ein. Dann beende ich das Gespräch an der Stelle sauber. Vielen Dank für Ihre Zeit und einen schönen Tag.",
  printDataStart: (salutation, firstName, lastName) =>
    `Alles klar, dann nehmen wir die klassische Variante mit Zeitung nach Hause. Ich starte direkt mit dem Datenabgleich: Spreche ich mit ${formatPerson(salutation, firstName, lastName)}, korrekt?`,
  digitalDataStart: (salutation, firstName, lastName) =>
    `Gut, dann nehmen wir die digitale Variante. Ich starte direkt mit dem Datenabgleich: Spreche ich mit ${formatPerson(salutation, firstName, lastName)}, korrekt?`,
  askAddress: (street, city) => `Ihre Adresse ist ${normalizeStreet(street)} in ${city || ""}, korrekt?`.replace(/\s+/g, " ").trim(),
  askEmail: (email) => `Ihre E-Mail ist ${email || ""}, korrekt?`,
  completionSetup: "Ich habe das gerade für Sie eingerichtet. Die Leseprobe startet in 5 Tagen.",
  completionPrint: "Sie erhalten 2 Wochen die Zeitung nach Hause.",
  completionDigital: "Sie erhalten 4 Wochen digitalen Zugriff.",
  completionEnd: "Dann ist alles für Sie eingerichtet. Vielen Dank für Ihr Vertrauen und einen schönen Tag. Auf Wiederhören.",
  notTarget: (firstName, lastName) => {
    const name = `${firstName || ""} ${lastName || ""}`.replace(/\s+/g, " ").trim();
    return name ? `Danke für die Info. Ist ${name} gerade erreichbar?` : "Danke für die Info. Ist die Zielperson gerade erreichbar?";
  },
  sympathy: "Das tut mir sehr leid. Bitte nehmen Sie mein aufrichtiges Beileid an.",
  sympathyAsk: "Darf ich kurz mit Ihnen weitersprechen, damit ich den Kontakt sauber aktualisieren kann?"
};

const FAST_TEXT = {
  recordingNotice: "Hinweis: Gespräch kann zu Schulungszwecken aufgezeichnet werden. Ist das in Ordnung?",
  identityGate: (salutation, firstName, lastName) => `Spreche ich mit ${formatPerson(salutation, firstName, lastName)}?`,
  mainPitch: "Kurz: kostenlose Leseprobe, endet automatisch. Was passt besser – digital oder Zeitung nach Hause?",
  objectionDefault: "Verstehe. Kurz: kostenlos, endet automatisch. Lieber digital oder Zeitung nach Hause?",
  chooseQuestion: "Was passt besser – digital oder Zeitung nach Hause?",
  handoffConfirm: "Verstanden. Ich leite an einen Mitarbeiter weiter.",
  handoffDone: "Weiterleitung gestartet. Auf Wiederhören.",
  stopRespect: "Alles klar. Vielen Dank für Ihre Zeit. Auf Wiederhören.",
  noDataClose: "Ohne bestätigte Daten richte ich nichts ein. Vielen Dank. Auf Wiederhören.",
  printDataStart: (salutation, firstName, lastName) =>
    `Dann Print. Datenabgleich: Spreche ich mit ${formatPerson(salutation, firstName, lastName)}, korrekt?`,
  digitalDataStart: (salutation, firstName, lastName) =>
    `Dann digital. Datenabgleich: Spreche ich mit ${formatPerson(salutation, firstName, lastName)}, korrekt?`,
  askAddress: (street, city) => `Adresse: ${normalizeStreet(street)} in ${city || ""}, korrekt?`.replace(/\s+/g, " ").trim(),
  askEmail: (email) => `E-Mail: ${email || ""}, korrekt?`,
  completionSetup: "Eingerichtet. Start in 5 Tagen.",
  completionPrint: "Sie erhalten 2 Wochen Zeitung nach Hause.",
  completionDigital: "Sie erhalten 4 Wochen digitalen Zugriff.",
  completionEnd: "Vielen Dank. Auf Wiederhören.",
  notTarget: (firstName, lastName) => {
    const name = `${firstName || ""} ${lastName || ""}`.replace(/\s+/g, " ").trim();
    return name ? `Ist ${name} gerade erreichbar?` : "Ist die Zielperson gerade erreichbar?";
  },
  sympathy: "Das tut mir sehr leid. Mein Beileid.",
  sympathyAsk: "Darf ich kurz weitersprechen, um den Kontakt zu aktualisieren?"
};

function t() {
  return LATENCY_MODE === "fast" ? FAST_TEXT : TEXT;
}

function normalizeStreet(street) {
  if (!street) return "";
  return street.replace(/\bstr\.?\b/gi, "Straße");
}

function extractEmail(text) {
  const m = String(text || "").match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);
  return m ? m[0].toLowerCase() : null;
}

function extractAddress(text, fallbackLead) {
  const raw = String(text || "").trim();
  if (!raw) return { street: fallbackLead.street, city: fallbackLead.city, ok: false };
  const cleaned = raw.replace(/\s+/g, " ").trim();
  const sep = cleaned.match(/\s+in\s+/i);
  if (sep) {
    const parts = cleaned.split(/\s+in\s+/i);
    const street = (parts[0] || "").trim();
    const city = (parts.slice(1).join(" in ") || "").trim();
    if (street && city) return { street, city, ok: true };
  }
  return { street: cleaned, city: fallbackLead.city, ok: true };
}

function repeatQuestionForState(state, lead) {
  const person = formatPerson(lead?.salutation, lead?.first_name, lead?.last_name);
  if (state === "recording_consent") return t().recordingNotice;
  if (state === "identity_gate") return `Spreche ich mit ${person}?`;
  if (state === "pitch" || state === "objection") return t().chooseQuestion;
  if (state === "data_confirmation") {
    return `Spreche ich mit ${person}, korrekt?`;
  }
  return t().chooseQuestion;
}

function lower(text) {
  return (text || "").toLowerCase().trim();
}
function normalizeQuestion(text) {
  return String(text || "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function hasAny(text, phrases) {
  return phrases.some((p) => text.includes(p));
}

function isExplicitVariantChoice(text, variant) {
  const t = lower(text);
  const digitalPatterns = [
    "digital bitte",
    "ich nehme digital",
    "nehme digital",
    "lieber digital",
    "machen wir digital",
    "dann digital",
    "digital waere besser",
    "digital wäre besser",
    "digital passt"
  ];
  const printPatterns = [
    "print bitte",
    "ich nehme print",
    "nehme print",
    "zeitung nach hause",
    "lieber print",
    "machen wir print",
    "dann print",
    "klassische variante",
    "gedruckt bitte"
  ];
  const patterns = variant === "digital" ? digitalPatterns : printPatterns;
  return patterns.some((p) => t.includes(p));
}

function isInfoRequest(text) {
  const t = lower(text);
  if (!t) return false;
  if (t.includes("?")) return true;
  return hasAny(t, [
    "info",
    "mehr info",
    "warum",
    "wieso",
    "weshalb",
    "was ist",
    "was genau",
    "wie funktioniert",
    "welche",
    "welcher",
    "wann",
    "wo",
    "mehr information",
    "mehr infos",
    "erklären",
    "genauer",
    "was ist das"
  ]);
}

function isSimpleYes(text) {
  const raw = lower(text)
    .replace(/[.,!?;:]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!raw) return false;
  const yesWords = ["ja", "genau", "korrekt", "stimmt", "okay", "ok"];
  const tokens = raw.split(" ");
  if (tokens.length > 3) return false;
  return tokens.every((t) => yesWords.includes(t));
}

function isSimpleNo(text) {
  const raw = lower(text)
    .replace(/[.,!?;:]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!raw) return false;
  const noWords = ["nein", "nicht", "falsch", "no"];
  const tokens = raw.split(" ");
  if (tokens.length > 3) return false;
  return tokens.every((t) => noWords.includes(t));
}

const SYSTEM_INTENTS = [
  { key: "legal_privacy", phrases: ["datenschutz", "dsgvo", "rechtlich", "rechtslage", "datenherkunft", "anwalt"] },
  { key: "aggressive", phrases: ["idiot", "spinn", "fuck", "kurwa", "verpiss", "chuj"] },
  { key: "do_not_call", phrases: ["nicht anrufen", "do not call", "rufe mich nicht", "kein anruf"] },
  { key: "human_request", phrases: ["mitarbeiter", "person sprechen", "echter mensch", "human", "richtige person"] },
  { key: "bot_identity", phrases: ["robot", "roboter", "bot"] },
  { key: "objection_no_time", phrases: ["keine zeit", "nie mam czasu", "teraz nie", "no time"] },
  { key: "objection_no_buy", phrases: ["ich will nichts kaufen", "nie chce kupowac", "kein abo", "abo andrehen"] },
  { key: "contact_deceased", phrases: ["verstorben", "nie zyje", "zmar", "passed away"] },
  { key: "choose_digital", phrases: ["digital", "online"] },
  { key: "choose_print", phrases: ["zeitung", "print", "papier", "gedruckt", "nach hause"] },
  { key: "yes", phrases: ["ja", "genau", "korrekt", "stimmt"] },
  { key: "no", phrases: ["nein", "nicht", "falsch"] }
];

async function loadCustomIntents() {
  try {
    const raw = await fs.readFile(intentsFilePath, "utf8");
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed.intents) ? parsed.intents : [];
  } catch {
    return [];
  }
}

async function saveCustomIntents(intents) {
  await fs.writeFile(intentsFilePath, JSON.stringify({ intents }, null, 2), "utf8");
}

const DEFAULT_STATE_RESPONSES = {
  intro:
    "Hinweis vorab: Dieses Gespräch kann zu Schulungszwecken aufgezeichnet werden, damit wir die Gesprächsqualität verbessern können. Ist das für Sie in Ordnung?",
  recording_consent:
    "Vielen Dank. Damit ich korrekt bleibe und den Vorgang richtig zuordnen kann: Spreche ich mit Ihnen persönlich?",
  identity_gate:
    "Damit ich korrekt bleibe und den Vorgang richtig zuordnen kann: Spreche ich mit Ihnen persönlich?",
  pitch:
    "Ich halte es ganz kurz: Wir bieten aktuell eine kostenlose Leseprobe der RHEINPFALZ an, die automatisch endet und ohne Verpflichtung ist. Was passt besser zu Ihnen – Zeitung nach Hause oder direkt digital?",
  objection:
    "Verstehe ich gut. Genau deshalb ist es als kurzer, kostenloser Test gedacht, ohne Risiko und ohne Verpflichtung. Was wäre für Sie passender – digital oder die Zeitung nach Hause?",
  data_confirmation:
    "Perfekt, dann starte ich direkt mit dem Datenabgleich, damit alles korrekt eingerichtet wird und Sie die Leseprobe pünktlich erhalten.",
  end_handoff:
    "Verstanden, ich leite Sie gern an einen Mitarbeiter weiter. Einen kleinen Moment bitte, ich gebe Ihren Wunsch jetzt direkt weiter.",
  end_success:
    "Vielen Dank für Ihr Vertrauen. Dann ist alles für Sie eingerichtet. Ich wünsche Ihnen einen schönen Tag. Auf Wiederhören.",
  end_reject:
    "Vielen Dank für Ihre Zeit und die klare Rückmeldung. Ich wünsche Ihnen einen schönen Tag. Auf Wiederhören.",
  end_compliance:
    "Damit ich Ihnen nichts Falsches sage, übergebe ich das an einen Mitarbeiter. Vielen Dank und auf Wiederhören."
};

async function loadStateResponses() {
  try {
    const raw = await fs.readFile(stateResponsesFilePath, "utf8");
    const parsed = JSON.parse(raw);
    return parsed.responses && typeof parsed.responses === "object" ? parsed.responses : {};
  } catch {
    return {};
  }
}

async function saveStateResponses(responses) {
  await fs.writeFile(stateResponsesFilePath, JSON.stringify({ responses }, null, 2), "utf8");
}

async function detectIntent(text) {
  const t = lower(text);

  if (!t) return "empty";

  const customIntents = await loadCustomIntents();
  const matchedCustomIntent = customIntents.find((intent) => {
    if (!Array.isArray(intent.phrases)) return false;
    return hasAny(t, intent.phrases.map((p) => String(p).toLowerCase()));
  });
  if (matchedCustomIntent?.key) return matchedCustomIntent.key;

  // Priority rule: informational questions must not be misread as variant choice.
  if (isInfoRequest(t)) return "info_request";

  // Variant choice only when the customer explicitly selects one option.
  if (isExplicitVariantChoice(t, "digital")) return "choose_digital";
  if (isExplicitVariantChoice(t, "print")) return "choose_print";

  const matchedSystemIntent = SYSTEM_INTENTS.find((intent) => {
    if (intent.key === "choose_digital" || intent.key === "choose_print") return false;
    return hasAny(t, intent.phrases);
  });
  if (matchedSystemIntent) return matchedSystemIntent.key;

  return "unknown";
}

function clampTwoSentences(input) {
  const text = String(input || "").replace(/\s+/g, " ").trim();
  if (!text) return "";
  const parts = text.split(/(?<=[.!?])\s+/).filter(Boolean);
  return parts.slice(0, 2).join(" ");
}

async function llmFallbackResponse({ state, customerText, facts = [], compliance = [], repeatQuestion = "" }) {
  const safeRepeat = String(repeatQuestion || "").trim() || t().chooseQuestion;
  if (!OPENAI_API_KEY) {
    return `Verstehe. ${safeRepeat}`;
  }

  const factsText = facts.length
    ? facts.map((f) => `- ${f.fact_key}: ${JSON.stringify(f.fact_value)}`).join("\n")
    : "- keine Fakten vorhanden";
  const complianceText = compliance.length
    ? compliance.map((r) => `- ${r.rule_key}: ${r.rule_text || ""}`).join("\n")
    : "- keine Compliance-Regeln vorhanden";

  const system = [
    "Du bist ein strikt kontrollierter Voice-Sales-Assistent.",
    "Antworte auf Deutsch, maximal 2 kurze Sätze.",
    "Nutze ausschließlich die bereitgestellten Fakten.",
    "Erfinde keine Preise, Laufzeiten, Zusagen oder Vertragsdetails.",
    "Wenn Fakten fehlen, antworte vorsichtig und kurz.",
    "Wichtig: Der zweite Satz muss exakt die Wiederholungsfrage sein.",
    "Verändere die Wiederholungsfrage nicht."
  ].join(" ");

  const user = [
    `Aktueller State: ${state}`,
    `Kundenaussage: ${customerText}`,
    "Fakten:",
    factsText,
    "Compliance:",
    complianceText,
    `Wiederholungsfrage (exakt so als Satz 2 verwenden): ${safeRepeat}`,
    "Aufgabe: Satz 1 = kurze, natürliche Antwort auf den Kunden. Satz 2 = exakt die Wiederholungsfrage."
  ].join("\n");

  try {
    const r = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${OPENAI_API_KEY}`
      },
      body: JSON.stringify({
        model: OPENAI_MODEL,
        temperature: 0.2,
        max_tokens: 120,
        messages: [
          { role: "system", content: system },
          { role: "user", content: user }
        ]
      })
    });
    const data = await r.json();
    if (!r.ok) {
      return `Kurz zur Einordnung: Es geht um eine kostenlose Leseprobe, die automatisch endet. ${safeRepeat}`;
    }
    const raw = data?.choices?.[0]?.message?.content || "";
    const out = clampTwoSentences(raw);
    if (!out) return `Kurz zur Einordnung: Es geht um eine kostenlose Leseprobe, die automatisch endet. ${safeRepeat}`;
    if (!out.includes(safeRepeat)) {
      const first = out.split(/(?<=[.!?])\s+/)[0] || "Verstehe.";
      return `${first} ${safeRepeat}`;
    }
    return out;
  } catch {
    return `Kurz zur Einordnung: Es geht um eine kostenlose Leseprobe, die automatisch endet. ${safeRepeat}`;
  }
}

async function getProject(client, projectKey) {
  const row = await client.query(`select id, project_key from projects where project_key = $1 and active = true limit 1`, [projectKey]);
  return row.rows[0] || null;
}

async function getDbResponseVariant(client, projectId, stateKey, intentKey) {
  const exact = await client.query(
    `select response_text
     from response_variants
     where project_id = $1 and active = true and state_key = $2 and intent_key = $3
     order by is_default desc, variant_key asc
     limit 1`,
    [projectId, stateKey, intentKey]
  );
  if (exact.rows[0]?.response_text) return exact.rows[0].response_text;

  const fallback = await client.query(
    `select response_text
     from response_variants
     where project_id = $1 and active = true and state_key = $2 and is_default = true
     order by variant_key asc
     limit 1`,
    [projectId, stateKey]
  );
  return fallback.rows[0]?.response_text || null;
}

async function logEvent(client, projectId, callId, eventType, payload) {
  await client.query(`insert into call_events(project_id, call_id, event_type, payload) values ($1, $2, $3, $4)`, [
    projectId,
    callId,
    eventType,
    payload
  ]);
}

async function upsertCallLog(client, projectId, callId, patch) {
  await client.query(
    `insert into call_logs(project_id, call_id, status, final_state, variant_selected, identity_confirmed, address_confirmed, email_confirmed, handoff_used, end_call_reason, started_at)
     values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10, now())
     on conflict (project_id, call_id)
     do update set
       status = coalesce(excluded.status, call_logs.status),
       final_state = coalesce(excluded.final_state, call_logs.final_state),
       variant_selected = coalesce(excluded.variant_selected, call_logs.variant_selected),
       identity_confirmed = excluded.identity_confirmed,
       address_confirmed = excluded.address_confirmed,
       email_confirmed = excluded.email_confirmed,
       handoff_used = excluded.handoff_used,
       end_call_reason = coalesce(excluded.end_call_reason, call_logs.end_call_reason)`,
    [
      projectId,
      callId,
      patch.status || null,
      patch.final_state || null,
      patch.variant_selected || null,
      Boolean(patch.identity_confirmed),
      Boolean(patch.address_confirmed),
      Boolean(patch.email_confirmed),
      Boolean(patch.handoff_used),
      patch.end_call_reason || null
    ]
  );
}

async function getCallMemory(client, projectId, callId) {
  const row = await client.query(
    `select final_state, variant_selected, identity_confirmed, address_confirmed, email_confirmed
     from call_logs
     where project_id = $1 and call_id = $2
     limit 1`,
    [projectId, callId]
  );
  return row.rows[0] || null;
}

async function getProjectFacts(client, projectId) {
  const r = await client.query(
    `select fact_key, fact_value
     from facts
     where project_id=$1 and active=true
     order by fact_key`,
    [projectId]
  );
  return r.rows;
}

async function getProjectCompliance(client, projectId) {
  const r = await client.query(
    `select rule_key, rule_text
     from compliance_rules
     where project_id=$1 and active=true
     order by priority asc, rule_key asc
     limit 30`,
    [projectId]
  );
  return r.rows;
}

async function ensureLearningTables() {
  await pool.query(`
    create table if not exists learned_questions (
      id bigserial primary key,
      project_key text not null,
      project_id uuid null,
      state_key text not null,
      question_text text not null,
      normalized_question text not null,
      intent_key text,
      llm_answer text,
      approved_response text,
      status text not null default 'pending',
      created_at timestamp default now(),
      updated_at timestamp default now(),
      resolved_at timestamp null
    )
  `);
  await pool.query(`alter table learned_questions add column if not exists project_key text`);
  await pool.query(`alter table learned_questions add column if not exists state_keys text[]`);
  await pool.query(`update learned_questions set state_keys = array[state_key] where state_keys is null`);
  await pool.query(`create index if not exists idx_learned_questions_lookup on learned_questions(project_key, state_key, normalized_question, status)`);
}

async function findApprovedLearnedAnswer(client, projectKey, stateKey, customerText) {
  const nq = normalizeQuestion(customerText);
  if (!nq) return null;
  const r = await client.query(
    `select approved_response
     from learned_questions
     where project_key=$1
       and normalized_question=$3
       and status='approved'
       and (coalesce(state_keys, array[state_key]) @> array[$2::text])
     order by updated_at desc
     limit 1`,
    [projectKey, stateKey, nq]
  );
  return r.rows[0]?.approved_response || null;
}

async function upsertPendingLearnedQuestion(client, projectKey, stateKey, customerText, intentKey, llmAnswer) {
  const nq = normalizeQuestion(customerText);
  if (!nq) return;
  const existing = await client.query(
    `select id from learned_questions
     where project_key=$1 and state_key=$2 and normalized_question=$3 and status in ('pending','approved')
     limit 1`,
    [projectKey, stateKey, nq]
  );
  if (existing.rows[0]?.id) return;
  await client.query(
    `insert into learned_questions(project_key, state_key, question_text, normalized_question, intent_key, llm_answer, status)
     values($1,$2,$3,$4,$5,$6,'pending')`,
    [projectKey, stateKey, customerText, nq, intentKey || null, llmAnswer || null]
  );
}

app.get("/health", async (_req, res) => {
  await pool.query("select 1");
  res.json({ ok: true });
});

app.get("/api/ui-config", (_req, res) => {
  res.json({ chat_only: UI_CHAT_ONLY });
});

app.post("/api/latency-probe", async (req, res) => {
  const t0 = Date.now();
  const mode = String(req.query.mode || req.body?.mode || "A").toUpperCase(); // A | B | C
  const customerText = String(req.body?.customer_text || "");
  const state = String(req.body?.state || "intro");

  try {
    let tool_response = "Ja, das klingt gut. Ich erkläre es Ihnen kurz.";
    let intent = "probe";
    let source = "probe_fixed";

    // Mode A: fixed response only, no DB, no LLM.
    if (mode === "B" || mode === "C") {
      intent = await detectIntent(customerText);
      source = "rules_only";

      if (state === "intro") {
        tool_response = "Vorab ein kurzer Hinweis: Dieses Gespräch kann zu Schulungszwecken aufgezeichnet werden. Ist das für Sie in Ordnung?";
      } else if (intent === "choose_digital") {
        tool_response = "Alles klar, dann nehmen wir digital.";
      } else if (intent === "choose_print") {
        tool_response = "Alles klar, dann nehmen wir die Zeitung nach Hause.";
      } else if (intent === "objection_no_time") {
        tool_response = "Verstehe ich. Es dauert nur einen Moment: kostenlos und endet automatisch.";
      } else if (intent === "yes") {
        tool_response = "Perfekt, danke für die Bestätigung.";
      } else {
        tool_response = "Verstanden. Ich erkläre es Ihnen kurz.";
      }
    }

    // Mode C: simulate fallback LLM path (only if explicitly enabled).
    if (mode === "C" && LLM_FALLBACK_ENABLED) {
      tool_response = await llmFallbackResponse({ state, customerText });
      source = "llm_fallback";
    }

    const t1 = Date.now();
    res.json({
      ok: true,
      mode,
      intent,
      tool_response,
      response_source: source,
      metrics: {
        backend_ms: t1 - t0,
        started_at_ms: t0,
        finished_at_ms: t1
      }
    });
  } catch (error) {
    const t1 = Date.now();
    res.status(500).json({
      ok: false,
      error: "latency_probe_failed",
      details: String(error?.message || error),
      metrics: {
        backend_ms: t1 - t0,
        started_at_ms: t0,
        finished_at_ms: t1
      }
    });
  }
});

app.get("/api/flow-plan", async (_req, res) => {
  const client = await pool.connect();
  try {
    const projectKey = String(_req.query.project || "rheinpfalz");
    const prj = await getProject(client, projectKey);
    if (!prj) return res.status(404).json({ error: `project ${projectKey} not found` });

    const colsRes = await client.query(
      `select column_name
       from information_schema.columns
       where table_schema = 'public' and table_name = 'conversation_states'`
    );
    const hasNextStates = new Set(colsRes.rows.map((r) => r.column_name)).has("next_states");
    const statesSql = hasNextStates
      ? `select state_key, goal, max_duration_seconds, next_states, active
         from conversation_states
         where project_id = $1
         order by state_key asc`
      : `select state_key, goal, max_duration_seconds, active
         from conversation_states
         where project_id = $1
         order by state_key asc`;
    const statesRes = await client.query(statesSql, [prj.id]);
    const customResponses = await loadStateResponses();
    const states = statesRes.rows.map((s) => ({
      key: s.state_key,
      goal: s.goal || "",
      max_duration_seconds: s.max_duration_seconds,
      next_states: Array.isArray(s.next_states) ? s.next_states : [],
      active: s.active,
      proposed_response: customResponses[s.state_key] || DEFAULT_STATE_RESPONSES[s.state_key] || ""
    }));
    res.json({ states });
  } finally {
    client.release();
  }
});

app.put("/api/flow-plan/:stateKey", async (req, res) => {
  const client = await pool.connect();
  try {
    const projectKey = String(req.body?.project || "rheinpfalz");
    const { stateKey } = req.params;
    const { goal, max_duration_seconds, active, proposed_response } = req.body || {};

    const prj = await getProject(client, projectKey);
    if (!prj) return res.status(404).json({ error: `project ${projectKey} not found` });

    await client.query(
      `update conversation_states
       set goal = coalesce($1, goal),
           max_duration_seconds = coalesce($2, max_duration_seconds),
           active = coalesce($3, active)
       where project_id = $4 and state_key = $5`,
      [goal ?? null, Number.isFinite(max_duration_seconds) ? max_duration_seconds : null, typeof active === "boolean" ? active : null, prj.id, stateKey]
    );

    if (typeof proposed_response === "string") {
      const responses = await loadStateResponses();
      responses[stateKey] = proposed_response;
      await saveStateResponses(responses);
    }

    res.json({ ok: true });
  } finally {
    client.release();
  }
});

app.get("/api/intents", async (_req, res) => {
  const intents = await loadCustomIntents();
  res.json({ intents });
});

app.get("/api/system-intents", async (_req, res) => {
  res.json({ intents: SYSTEM_INTENTS });
});

app.get("/api/rules", async (req, res) => {
  const client = await pool.connect();
  try {
    const projectKey = String(req.query.project || "rheinpfalz");
    const prj = await getProject(client, projectKey);
    if (!prj) return res.status(404).json({ error: `project ${projectKey} not found` });

    const complianceRes = await client.query(
      `select rule_key, category, rule_text, action, priority, active
       from compliance_rules
       where project_id = $1
       order by priority asc, rule_key asc`,
      [prj.id]
    );

    const runtimeRules = [
      {
        key: "identity_gate_required",
        scope: "runtime",
        description: "Ohne bestätigte Identität keine Angebotslogik und kein Abschluss.",
        effect: "force_state=identity_gate"
      },
      {
        key: "legal_privacy_handoff",
        scope: "runtime",
        description: "Bei Rechts-/Datenschutzfragen sofort Weiterleitung und Gespräch beenden.",
        effect: "handoff + end_call"
      },
      {
        key: "aggressive_or_dnc_stop",
        scope: "runtime",
        description: "Bei Aggression/Beleidigung oder Do-Not-Call sofort freundlich beenden.",
        effect: "end_call"
      },
      {
        key: "choice_required",
        scope: "runtime",
        description: "Ziel ist immer die klare Wahl: print oder digital.",
        effect: "state progression"
      },
      {
        key: "data_confirmation_required",
        scope: "runtime",
        description: "Vor Abschluss: Identität, Adresse und E-Mail bestätigen.",
        effect: "no close without confirmations"
      }
    ];

    res.json({
      compliance_rules: complianceRes.rows,
      runtime_rules: runtimeRules
    });
  } finally {
    client.release();
  }
});

app.get("/api/events/recent", async (req, res) => {
  const client = await pool.connect();
  try {
    const projectKey = String(req.query.project || "rheinpfalz");
    const limit = Math.min(Number(req.query.limit || 20), 100);
    const prj = await getProject(client, projectKey);
    if (!prj) return res.status(404).json({ error: `project ${projectKey} not found` });

    const rows = await client.query(
      `select call_id, event_type, payload, created_at
       from call_events
       where project_id = $1
       order by id desc
       limit $2`,
      [prj.id, limit]
    );
    res.json({ events: rows.rows });
  } finally {
    client.release();
  }
});

app.get("/api/calls/recent", async (req, res) => {
  const client = await pool.connect();
  try {
    const projectKey = String(req.query.project || "rheinpfalz");
    const limit = Math.min(Number(req.query.limit || 20), 100);
    const prj = await getProject(client, projectKey);
    if (!prj) return res.status(404).json({ error: `project ${projectKey} not found` });

    const rows = await client.query(
      `select call_id, status, final_state, variant_selected, identity_confirmed, address_confirmed, email_confirmed, handoff_used, end_call_reason, phone_to, started_at, ended_at, created_at
       from call_logs
       where project_id = $1
       order by created_at desc
       limit $2`,
      [prj.id, limit]
    );
    res.json({ calls: rows.rows });
  } finally {
    client.release();
  }
});

app.get("/api/chat", async (req, res) => {
  const client = await pool.connect();
  try {
    const projectKey = String(req.query.project || "rheinpfalz");
    const requestedCallId = String(req.query.call_id || "").trim();
    const prj = await getProject(client, projectKey);
    if (!prj) return res.status(404).json({ error: `project ${projectKey} not found` });

    let callId = requestedCallId;
    if (!callId) {
      const last = await client.query(
        `select call_id from call_logs
         where project_id = $1
         order by created_at desc
         limit 1`,
        [prj.id]
      );
      callId = last.rows[0]?.call_id || "";
    }
    if (!callId) return res.json({ call_id: null, messages: [] });

    const events = await client.query(
      `select event_type, payload, created_at
       from call_events
       where project_id = $1 and call_id = $2
       order by id asc`,
      [prj.id, callId]
    );

    const messages = [];
    for (const ev of events.rows) {
      if (ev.event_type !== "turn_handled") continue;
      const p = ev.payload || {};
      const userText = String(p.customer_text || "").trim();
      const botText = String(p.tool_response || "").trim();
      const ts = ev.created_at;
      if (userText) {
        messages.push({
          role: "user",
          text: userText,
          created_at: ts,
          info: {
            current_state: p.current_state || null,
            customer_text: p.customer_text || "",
            source: "call_events.turn_handled"
          }
        });
      }
      if (botText) {
        messages.push({
          role: "bot",
          text: botText,
          created_at: ts,
          info: {
            next_state: p.next_state || null,
            intent: p.intent || null,
            end_call: Boolean(p.end_call),
            handoff: Boolean(p.handoff),
            handoff_reason: p.handoff_reason || null,
            used_llm: Boolean(p.used_llm),
            response_source: p.response_source || "rules",
            tool_response: p.tool_response || "",
            context_patch: p.context_patch || {},
            source: "call_events.turn_handled"
          }
        });
      }
    }

    res.json({ call_id: callId, messages });
  } finally {
    client.release();
  }
});

app.post("/api/chat/send", async (req, res) => {
  try {
    const project = String(req.body?.project || "rheinpfalz");
    const call_id = String(req.body?.call_id || `chat-${Date.now()}`);
    const customer_text = String(req.body?.customer_text || "").trim();
    const current_state = String(req.body?.current_state || "intro");
    const context = req.body?.context && typeof req.body.context === "object" ? req.body.context : {};
    const lead = req.body?.lead && typeof req.body.lead === "object" ? req.body.lead : {};

    if (!customer_text) return res.status(400).json({ error: "customer_text is required" });

    const payload = { project, call_id, current_state, customer_text, context, lead };
    const r = await fetch(`http://127.0.0.1:${port}/handle-turn`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
    const data = await r.json();
    if (!r.ok) return res.status(r.status).json(data);
    res.json({ ok: true, call_id, request: payload, response: data });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "chat_send_failed" });
  }
});

app.get("/api/turns/latest", async (req, res) => {
  const client = await pool.connect();
  try {
    const projectKey = String(req.query.project || "rheinpfalz");
    const prj = await getProject(client, projectKey);
    if (!prj) return res.status(404).json({ error: `project ${projectKey} not found` });

    const row = await client.query(
      `select call_id, event_type, payload, created_at
       from call_events
       where project_id = $1 and event_type = 'turn_handled'
       order by id desc
       limit 1`,
      [prj.id]
    );
    res.json({ turn: row.rows[0] || null });
  } finally {
    client.release();
  }
});

app.get("/api/diagnostics/calls", async (req, res) => {
  const client = await pool.connect();
  try {
    const projectKey = String(req.query.project || "rheinpfalz");
    const prj = await getProject(client, projectKey);
    if (!prj) return res.status(404).json({ error: `project ${projectKey} not found` });

    const callsRes = await client.query(
      `select call_id, status, final_state, end_call_reason, started_at, ended_at, created_at
       from call_logs
       where project_id = $1
       order by created_at desc
       limit 50`,
      [prj.id]
    );

    const reasonCount = {};
    const statusCount = {};
    callsRes.rows.forEach((c) => {
      const reason = c.end_call_reason || "unknown";
      const status = c.status || "unknown";
      reasonCount[reason] = (reasonCount[reason] || 0) + 1;
      statusCount[status] = (statusCount[status] || 0) + 1;
    });

    const lastCall = callsRes.rows[0] || null;
    let lastEvents = [];
    if (lastCall?.call_id) {
      const ev = await client.query(
        `select event_type, payload, created_at
         from call_events
         where project_id = $1 and call_id = $2
         order by id desc
         limit 10`,
        [prj.id, lastCall.call_id]
      );
      lastEvents = ev.rows;
    }

    res.json({
      total_calls: callsRes.rows.length,
      reason_count: reasonCount,
      status_count: statusCount,
      last_call: lastCall,
      last_call_events: lastEvents
    });
  } finally {
    client.release();
  }
});

app.get("/api/kb/overview", async (req, res) => {
  const client = await pool.connect();
  try {
    const projectKey = String(req.query.project || "rheinpfalz");
    const prj = await getProject(client, projectKey);
    if (!prj) return res.status(404).json({ error: `project ${projectKey} not found` });

    const facts = await client.query(
      `select id, fact_key as key, fact_value::text as value, active from facts where project_id=$1 order by fact_key`,
      [prj.id]
    );
    const objections = await client.query(
      `select id, objection_key as key, goal, strategy, next_state, active from objections where project_id=$1 order by objection_key`,
      [prj.id]
    );
    const states = await client.query(
      `select id, state_key as key, goal, max_duration_seconds, active from conversation_states where project_id=$1 order by state_key`,
      [prj.id]
    );
    const compliance = await client.query(
      `select id, rule_key as key, category, action, priority, active, rule_text from compliance_rules where project_id=$1 order by priority, rule_key`,
      [prj.id]
    );
    const variants = await client.query(
      `select id, state_key, intent_key, variant_key, response_text, is_default, active from response_variants where project_id=$1 order by state_key, intent_key`,
      [prj.id]
    );

    res.json({
      facts: facts.rows,
      objections: objections.rows,
      states: states.rows,
      compliance_rules: compliance.rows,
      response_variants: variants.rows
    });
  } finally {
    client.release();
  }
});

app.get("/api/kb/full-view", async (req, res) => {
  const client = await pool.connect();
  try {
    const projectKey = String(req.query.project || "rheinpfalz");
    const prj = await getProject(client, projectKey);
    if (!prj) return res.status(404).json({ error: `project ${projectKey} not found` });

    async function getTableColumns(tableName) {
      const r = await client.query(
        `select column_name
         from information_schema.columns
         where table_schema = 'public' and table_name = $1
         order by ordinal_position`,
        [tableName]
      );
      return new Set(r.rows.map((x) => x.column_name));
    }

    async function selectExisting(tableName, preferredColumns, orderBy = null) {
      const cols = await getTableColumns(tableName);
      const selected = preferredColumns.filter((c) => cols.has(c));
      if (!selected.length) return { rows: [] };
      const selectCols = selected.join(", ");
      const orderSql = orderBy ? ` order by ${orderBy}` : "";
      const hasProject = cols.has("project_id");
      if (hasProject) {
        return client.query(
          `select ${selectCols} from ${tableName} where project_id=$1${orderSql}`,
          [prj.id]
        );
      }
      return client.query(`select ${selectCols} from ${tableName}${orderSql}`);
    }

    const [facts, objections, states, compliance, variants, rules] = await Promise.all([
      selectExisting("facts", ["id", "project_id", "fact_key", "fact_value", "active", "created_at"], "fact_key"),
      selectExisting(
        "objections",
        [
          "id",
          "project_id",
          "objection_key",
          "customer_phrase_examples",
          "emotion",
          "goal",
          "strategy",
          "response_level",
          "allowed_response",
          "fallback_response",
          "next_state",
          "active",
          "created_at"
        ],
        "objection_key"
      ),
      selectExisting(
        "conversation_states",
        ["id", "project_id", "state_key", "goal", "max_duration_seconds", "allowed_actions", "forbidden_actions", "next_states", "active", "created_at"],
        "state_key"
      ),
      selectExisting("compliance_rules", ["id", "project_id", "rule_key", "category", "action", "priority", "active", "rule_text", "created_at"], "priority, rule_key"),
      selectExisting("response_variants", ["id", "project_id", "state_key", "intent_key", "variant_key", "response_text", "is_default", "active", "created_at"], "state_key, intent_key, variant_key"),
      selectExisting("routing_rules", ["key", "target_state", "max_retries", "escalation_action"], "key")
    ]);

    const customIntents = await loadCustomIntents();

    const stateResponses = await loadStateResponses();
    const stateResponseRows = Object.keys({ ...DEFAULT_STATE_RESPONSES, ...stateResponses })
      .sort()
      .map((stateKey) => ({
        state_key: stateKey,
        response_text: stateResponses[stateKey] || DEFAULT_STATE_RESPONSES[stateKey] || "",
        source: stateResponses[stateKey] ? "custom" : "default"
      }));

    const decision_columns = {
      input: ["project", "call_id", "current_state", "customer_text"],
      context: [
        "identity_confirmed",
        "address_confirmed",
        "email_confirmed",
        "selected_variant",
        "rejection_count",
        "human_recovery_attempted"
      ],
      output: ["next_state", "tool_response", "end_call", "handoff", "handoff_reason", "intent", "used_llm", "response_source"]
    };

    res.json({
      project: { id: prj.id, key: prj.key, name: prj.name },
      decision_columns,
      system_intents: SYSTEM_INTENTS,
      custom_intents: customIntents,
      routing_rules: rules.rows,
      facts: facts.rows,
      objections: objections.rows,
      conversation_states: states.rows,
      compliance_rules: compliance.rows,
      response_variants: variants.rows,
      state_responses: stateResponseRows
    });
  } finally {
    client.release();
  }
});

app.delete("/api/response-variants/:id", async (req, res) => {
  const client = await pool.connect();
  try {
    const id = String(req.params.id || "").trim();
    const projectKey = String(req.query.project || "rheinpfalz").trim();
    if (!id) return res.status(400).json({ error: "id is required" });
    const prj = await getProject(client, projectKey);
    if (!prj) return res.status(404).json({ error: `project ${projectKey} not found` });

    const result = await client.query(
      `delete from response_variants
       where id = $1 and project_id = $2`,
      [id, prj.id]
    );
    if (!result.rowCount) return res.status(404).json({ error: "response_variant not found" });
    res.json({ ok: true });
  } finally {
    client.release();
  }
});

app.get("/api/code-texts", async (_req, res) => {
  const keys = Object.keys(TEXT);
  const items = keys.map((key) => {
    const normal = TEXT[key];
    const fast = FAST_TEXT[key];
    return {
      key,
      normal_type: typeof normal,
      normal_text: typeof normal === "function" ? "[function runtime template]" : String(normal ?? ""),
      fast_type: typeof fast,
      fast_text: typeof fast === "function" ? "[function runtime template]" : String(fast ?? "")
    };
  });
  res.json({
    latency_mode: LATENCY_MODE,
    note: "Function entries are rendered with lead/context values at runtime.",
    items
  });
});

app.post("/api/kb/facts", async (req, res) => {
  const client = await pool.connect();
  try {
    const { project = "rheinpfalz", key, value, active = true } = req.body || {};
    if (!key || value == null) return res.status(400).json({ error: "key and value are required" });
    const prj = await getProject(client, project);
    if (!prj) return res.status(404).json({ error: `project ${project} not found` });
    const jsonValue = typeof value === "string" ? JSON.parse(value) : value;
    const row = await client.query(
      `insert into facts(project_id, fact_key, fact_value, active)
       values($1,$2,$3,$4)
       on conflict(project_id, fact_key) do update set fact_value=excluded.fact_value, active=excluded.active
       returning id, fact_key as key, fact_value::text as value, active`,
      [prj.id, String(key).trim(), jsonValue, Boolean(active)]
    );
    res.status(201).json({ ok: true, item: row.rows[0] });
  } catch (e) {
    res.status(400).json({ error: "invalid_fact_value_json" });
  } finally {
    client.release();
  }
});

app.delete("/api/kb/facts/:id", async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query(`delete from facts where id=$1`, [req.params.id]);
    res.json({ ok: true });
  } finally {
    client.release();
  }
});

app.post("/api/simulate-decision", async (req, res) => {
  const client = await pool.connect();
  try {
    const {
      project = "rheinpfalz",
      state = "intro",
      customer_text = "",
      call_id = `sim-${Date.now()}`,
      lead = {},
      context = {}
    } = req.body || {};

    const payload = {
      project,
      call_id,
      current_state: state,
      customer_text,
      lead,
      context
    };

    // Reuse main endpoint logic internally through HTTP-free dispatch.
    req.body = payload;
    const fakeRes = {
      statusCode: 200,
      body: null,
      status(code) {
        this.statusCode = code;
        return this;
      },
      json(data) {
        this.body = data;
        return this;
      }
    };

    // Inline minimal execution by calling shared logic via direct function is not extracted yet.
    // So do a local loopback fetch.
    const r = await fetch(`http://127.0.0.1:${port}/handle-turn`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
    const data = await r.json();
    if (!r.ok) return res.status(r.status).json(data);
    res.json(data);
  } finally {
    client.release();
  }
});

app.post("/api/intents", async (req, res) => {
  const { key, phrases = [] } = req.body || {};
  if (!key || !Array.isArray(phrases) || !phrases.length) {
    return res.status(400).json({ error: "key and non-empty phrases[] are required" });
  }

  const normalizedKey = String(key).trim();
  const normalizedPhrases = phrases.map((p) => String(p).trim().toLowerCase()).filter(Boolean);
  if (!normalizedPhrases.length) {
    return res.status(400).json({ error: "phrases[] must contain valid values" });
  }

  const intents = await loadCustomIntents();
  const withoutCurrent = intents.filter((i) => i.key !== normalizedKey);
  withoutCurrent.push({ key: normalizedKey, phrases: normalizedPhrases });
  await saveCustomIntents(withoutCurrent);
  res.status(201).json({ ok: true, intent: { key: normalizedKey, phrases: normalizedPhrases } });
});

app.delete("/api/intents/:key", async (req, res) => {
  const { key } = req.params;
  const intents = await loadCustomIntents();
  const filtered = intents.filter((i) => i.key !== key);
  await saveCustomIntents(filtered);
  res.json({ ok: true });
});

app.post("/api/calls/outbound", async (req, res) => {
  try {
    const to_number = String(req.body?.to_number || "").trim();
    const agent_id = String(process.env.ELEVENLABS_AGENT_ID || "").trim();
    const agent_phone_number_id = String(process.env.ELEVENLABS_PHONE_NUMBER_ID || "").trim();
    const project = String(req.body?.project || "rheinpfalz").trim();

    if (!to_number) return res.status(400).json({ error: "to_number is required" });
    if (!agent_id) return res.status(400).json({ error: "ELEVENLABS_AGENT_ID missing in .env" });
    if (!agent_phone_number_id) return res.status(400).json({ error: "ELEVENLABS_PHONE_NUMBER_ID missing in .env" });
    if (!process.env.ELEVENLABS_API_KEY) return res.status(400).json({ error: "ELEVENLABS_API_KEY missing in .env" });

    const payload = {
      agent_id,
      agent_phone_number_id,
      to_number,
      conversation_initiation_client_data: {
        dynamic_variables: {
          project,
          current_state: "intro",
          last_user_text: ""
        }
      }
    };

    const response = await fetch("https://api.elevenlabs.io/v1/convai/twilio/outbound-call", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "xi-api-key": process.env.ELEVENLABS_API_KEY
      },
      body: JSON.stringify(payload)
    });

    const data = await response.json();
    if (!response.ok) {
      return res.status(response.status).json({ error: "elevenlabs_error", details: data });
    }

    res.json({ ok: true, result: data });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "outbound_call_failed" });
  }
});

app.post("/handle-turn", async (req, res) => {
  const client = await pool.connect();
  try {
    const {
      project = "rheinpfalz",
      call_id,
      current_state = "intro",
      customer_text = "",
      lead: inputLead = {},
      context = {}
    } = req.body || {};
    const baseLead = withLeadFallback(inputLead);

    if (!call_id) {
      return res.status(400).json({ error: "call_id is required" });
    }

    const prj = await getProject(client, project);
    if (!prj) {
      return res.status(404).json({ error: `project ${project} not found` });
    }

    const memory = await getCallMemory(client, prj.id, call_id);

    const incomingState = String(current_state || "").trim();
    const safeInitialState =
      !incomingState || incomingState === "end" || String(incomingState).startsWith("end_") ? "intro" : incomingState;
    const effectiveState = memory?.final_state || safeInitialState;
    const selectedVariantFromMemory = memory?.variant_selected || null;
    const identityConfirmedFromMemory = Boolean(memory?.identity_confirmed);
    const addressConfirmedFromMemory = Boolean(memory?.address_confirmed);
    const emailConfirmedFromMemory = Boolean(memory?.email_confirmed);

    const approvedLearned = await findApprovedLearnedAnswer(client, project, effectiveState, customer_text);
    if (approvedLearned) {
      await logEvent(client, prj.id, call_id, "turn_handled", {
        current_state: effectiveState,
        next_state: effectiveState,
        intent: "learned_answer",
        customer_text,
        tool_response: approvedLearned,
        handoff: false,
        end_call: false,
        used_llm: false,
        response_source: "learned_approved"
      });
      return res.json({
        next_state: effectiveState,
        tool_response: approvedLearned,
        end_call: false,
        handoff: false,
        handoff_reason: null,
        intent: "learned_answer",
        context_patch: {},
        used_llm: false,
        response_source: "learned_approved"
      });
    }

    const intent = await detectIntent(customer_text);
    const simpleYes = isSimpleYes(customer_text);
    const simpleNo = isSimpleNo(customer_text);
    let next_state = effectiveState;
    let tool_response = t().chooseQuestion;
    let end_call = false;
    let handoff = false;
    let handoff_reason = null;
    let used_llm = false;
    let response_source = "rules";
    const context_patch = {};

    const leadOverrides = context.lead_overrides && typeof context.lead_overrides === "object" ? context.lead_overrides : {};
    const lead = { ...baseLead, ...leadOverrides };

    const selectedVariant = context.selected_variant ?? selectedVariantFromMemory;
    const identityConfirmed = context.identity_confirmed != null ? Boolean(context.identity_confirmed) : identityConfirmedFromMemory;
    const addressConfirmed = context.address_confirmed != null ? Boolean(context.address_confirmed) : addressConfirmedFromMemory;
    const emailConfirmed = context.email_confirmed != null ? Boolean(context.email_confirmed) : emailConfirmedFromMemory;
    const humanRecoveryAttempted = Boolean(context.human_recovery_attempted);
    const awaitingAddressCorrection = Boolean(context.awaiting_address_correction);
    const awaitingEmailCorrection = Boolean(context.awaiting_email_correction);

    if (effectiveState === "intro") {
      // Keep one question per turn for better tool-read reliability.
      tool_response = t().recordingNotice;
      next_state = "recording_consent";
    } else if (effectiveState === "recording_consent") {
      if (simpleYes) {
        tool_response = t().identityGate(lead.salutation, lead.first_name, lead.last_name);
        next_state = "identity_gate";
      } else if (simpleNo) {
        tool_response = `${t().recordingDeclined} ${t().identityGate(lead.salutation, lead.first_name, lead.last_name)}`;
        next_state = "identity_gate";
      } else if (intent === "info_request" && LLM_FALLBACK_ENABLED) {
        const [facts, compliance] = await Promise.all([getProjectFacts(client, prj.id), getProjectCompliance(client, prj.id)]);
        const info = await llmFallbackResponse({
          state: effectiveState,
          customerText: customer_text,
          facts,
          compliance,
          repeatQuestion: repeatQuestionForState(effectiveState, lead)
        });
        tool_response = info;
        next_state = "recording_consent";
        used_llm = true;
        response_source = "llm_fallback";
      } else {
        tool_response = t().recordingNotice;
        next_state = "recording_consent";
      }
    } else if (!identityConfirmed && effectiveState !== "identity_gate") {
      tool_response = t().identityGate(lead.salutation, lead.first_name, lead.last_name);
      next_state = "identity_gate";
    } else if (intent === "legal_privacy") {
      tool_response = `${t().handoffConfirm} ${t().handoffDone}`;
      next_state = "end_compliance";
      handoff = true;
      handoff_reason = "legal_privacy";
      end_call = true;
    } else if (intent === "aggressive" || intent === "do_not_call") {
      tool_response = t().stopRespect;
      next_state = "end_reject";
      end_call = true;
    } else if (intent === "contact_deceased") {
      tool_response = `${t().sympathy} ${t().sympathyAsk}`;
      next_state = "identity_gate";
    } else if (effectiveState === "identity_gate") {
      if (simpleYes) {
        tool_response = t().mainPitch;
        next_state = "pitch";
        context_patch.identity_confirmed = true;
      } else if (simpleNo) {
        tool_response = t().notTarget(lead.first_name, lead.last_name);
        next_state = "end_reject";
        end_call = true;
      } else if (intent === "info_request" && LLM_FALLBACK_ENABLED) {
        const [facts, compliance] = await Promise.all([getProjectFacts(client, prj.id), getProjectCompliance(client, prj.id)]);
        const info = await llmFallbackResponse({
          state: effectiveState,
          customerText: customer_text,
          facts,
          compliance,
          repeatQuestion: repeatQuestionForState(effectiveState, lead)
        });
        tool_response = info;
        next_state = "identity_gate";
        used_llm = true;
        response_source = "llm_fallback";
      } else {
        tool_response = t().identityGate(lead.salutation, lead.first_name, lead.last_name);
        next_state = "identity_gate";
      }
    } else if (intent === "human_request") {
      if (!humanRecoveryAttempted) {
        tool_response =
          "Verstehe ich vollkommen. Ich kann das auch direkt für Sie erledigen – inklusive kostenloser Leseprobe, Datenabgleich und Abschluss. Möchten Sie trotzdem an einen Mitarbeiter weitergeleitet werden, oder soll ich es direkt hier für Sie einrichten?";
        next_state = "pitch";
        context_patch.human_recovery_attempted = true;
      } else {
        tool_response = `${t().handoffConfirm} ${t().handoffDone}`;
        next_state = "end_handoff";
        handoff = true;
        handoff_reason = "human_requested";
        end_call = true;
      }
    } else if (effectiveState === "pitch" || effectiveState === "objection") {
      if (intent === "choose_digital") {
        tool_response = t().digitalDataStart(lead.salutation, lead.first_name, lead.last_name);
        next_state = "data_confirmation";
        context_patch.selected_variant = "digital";
      } else if (intent === "choose_print") {
        tool_response = t().printDataStart(lead.salutation, lead.first_name, lead.last_name);
        next_state = "data_confirmation";
        context_patch.selected_variant = "print";
      } else if (["objection_no_time", "objection_no_buy", "bot_identity", "unknown"].includes(intent)) {
        if (intent === "unknown" && LLM_FALLBACK_ENABLED) {
          const [facts, compliance] = await Promise.all([getProjectFacts(client, prj.id), getProjectCompliance(client, prj.id)]);
          tool_response = await llmFallbackResponse({
            state: effectiveState,
            customerText: customer_text,
            facts,
            compliance,
            repeatQuestion: repeatQuestionForState(effectiveState, lead)
          });
          next_state = "objection";
          used_llm = true;
          response_source = "llm_fallback";
        } else {
          tool_response = t().objectionDefault;
          next_state = "objection";
        }
      } else if (intent === "info_request" && LLM_FALLBACK_ENABLED) {
        const [facts, compliance] = await Promise.all([getProjectFacts(client, prj.id), getProjectCompliance(client, prj.id)]);
        const info = await llmFallbackResponse({
          state: effectiveState,
          customerText: customer_text,
          facts,
          compliance,
          repeatQuestion: repeatQuestionForState(effectiveState, lead)
        });
        tool_response = info;
        next_state = "pitch";
        used_llm = true;
        response_source = "llm_fallback";
      } else if (intent === "no") {
        if (context.rejection_count && Number(context.rejection_count) >= 1) {
          tool_response = t().stopRespect;
          next_state = "end_reject";
          end_call = true;
        } else {
          tool_response = t().objectionDefault;
          next_state = "objection";
          context_patch.rejection_count = Number(context.rejection_count || 0) + 1;
        }
      } else {
        tool_response = t().chooseQuestion;
        next_state = "pitch";
      }
    } else if (effectiveState === "data_confirmation") {
      const shouldReturnToObjectionFromData = [
        "info_request",
        "cost_concern",
        "objection_no_buy",
        "objection_no_time",
        "uncertain",
        "price_too_high",
        "content_region_mismatch",
        "content_quality_concern",
        "bot_identity"
      ].includes(intent);

      if (shouldReturnToObjectionFromData) {
        const [facts, compliance] = await Promise.all([getProjectFacts(client, prj.id), getProjectCompliance(client, prj.id)]);
        const info = await llmFallbackResponse({
          state: effectiveState,
          customerText: customer_text,
          facts,
          compliance,
          repeatQuestion: repeatQuestionForState("objection", lead)
        });
        tool_response = info;
        next_state = "objection";
        used_llm = true;
        response_source = "llm_fallback";
      } else if (!identityConfirmed) {
        if (simpleYes) {
          tool_response = t().askAddress(lead.street, lead.city);
          next_state = "data_confirmation";
          context_patch.identity_confirmed = true;
        } else if (simpleNo) {
          tool_response = t().noDataClose;
          next_state = "end_reject";
          end_call = true;
        } else if (intent === "info_request" && LLM_FALLBACK_ENABLED) {
          const [facts, compliance] = await Promise.all([getProjectFacts(client, prj.id), getProjectCompliance(client, prj.id)]);
          const info = await llmFallbackResponse({
            state: effectiveState,
            customerText: customer_text,
            facts,
            compliance,
            repeatQuestion: repeatQuestionForState(effectiveState, lead)
          });
          tool_response = info;
          next_state = "data_confirmation";
          used_llm = true;
          response_source = "llm_fallback";
        } else {
          tool_response = `Spreche ich mit ${formatPerson(lead.salutation, lead.first_name, lead.last_name)}, korrekt?`;
        }
      } else if (!addressConfirmed) {
        if (awaitingAddressCorrection) {
          const parsed = extractAddress(customer_text, lead);
          if (parsed.ok) {
            context_patch.lead_overrides = { ...(leadOverrides || {}), street: parsed.street, city: parsed.city };
            context_patch.awaiting_address_correction = false;
            tool_response = `Danke. Ich wiederhole die Adresse kurz: ${normalizeStreet(parsed.street)} in ${parsed.city}, korrekt?`;
            next_state = "data_confirmation";
          } else {
            tool_response = "Bitte nennen Sie mir die vollständige Adresse mit Straße und Ort, dann wiederhole ich sie direkt.";
            next_state = "data_confirmation";
            context_patch.awaiting_address_correction = true;
          }
        } else if (simpleYes) {
          tool_response = t().askEmail(lead.email);
          context_patch.address_confirmed = true;
        } else if (simpleNo) {
          tool_response = "Bitte nennen Sie mir die korrekte Adresse, dann wiederhole ich sie kurz.";
          context_patch.awaiting_address_correction = true;
        } else if (intent === "info_request" && LLM_FALLBACK_ENABLED) {
          const [facts, compliance] = await Promise.all([getProjectFacts(client, prj.id), getProjectCompliance(client, prj.id)]);
          const info = await llmFallbackResponse({
            state: effectiveState,
            customerText: customer_text,
            facts,
            compliance,
            repeatQuestion: repeatQuestionForState(effectiveState, lead)
          });
          tool_response = info;
          next_state = "data_confirmation";
          used_llm = true;
          response_source = "llm_fallback";
        } else {
          tool_response = t().askAddress(lead.street, lead.city);
        }
      } else if (!emailConfirmed) {
        if (awaitingEmailCorrection) {
          const email = extractEmail(customer_text);
          if (email) {
            context_patch.lead_overrides = { ...(leadOverrides || {}), email };
            context_patch.awaiting_email_correction = false;
            tool_response = `Danke. Ich wiederhole die E-Mail: ${email}, korrekt?`;
            next_state = "data_confirmation";
          } else {
            tool_response = "Bitte nennen Sie mir die E-Mail-Adresse noch einmal, gern langsam oder buchstabiert.";
            next_state = "data_confirmation";
            context_patch.awaiting_email_correction = true;
          }
        } else if (simpleYes) {
          tool_response =
            `${t().completionSetup} ${selectedVariant === "print" ? t().completionPrint : t().completionDigital} ${t().completionEnd}`;
          next_state = "end_success";
          end_call = true;
          context_patch.email_confirmed = true;
        } else if (simpleNo) {
          tool_response = "Bitte nennen Sie mir die korrekte E-Mail-Adresse, ich wiederhole sie danach kurz.";
          context_patch.awaiting_email_correction = true;
        } else if (intent === "info_request" && LLM_FALLBACK_ENABLED) {
          const [facts, compliance] = await Promise.all([getProjectFacts(client, prj.id), getProjectCompliance(client, prj.id)]);
          const info = await llmFallbackResponse({
            state: effectiveState,
            customerText: customer_text,
            facts,
            compliance,
            repeatQuestion: repeatQuestionForState(effectiveState, lead)
          });
          tool_response = info;
          next_state = "data_confirmation";
          used_llm = true;
          response_source = "llm_fallback";
        } else {
          tool_response = t().askEmail(lead.email);
        }
      }
    } else {
      if (LLM_FALLBACK_ENABLED && intent === "unknown") {
        const [facts, compliance] = await Promise.all([getProjectFacts(client, prj.id), getProjectCompliance(client, prj.id)]);
        tool_response = await llmFallbackResponse({
          state: effectiveState,
          customerText: customer_text,
          facts,
          compliance,
          repeatQuestion: repeatQuestionForState(effectiveState, lead)
        });
        next_state = "pitch";
        used_llm = true;
        response_source = "llm_fallback";
      } else {
        tool_response = t().chooseQuestion;
        next_state = "pitch";
      }
    }

    const dbResponse = await getDbResponseVariant(client, prj.id, next_state, intent);
    if (dbResponse) {
      tool_response = dbResponse;
      response_source = "db_variant";
    }

    if (used_llm && response_source === "llm_fallback" && (intent === "info_request" || intent === "unknown")) {
      await upsertPendingLearnedQuestion(client, project, effectiveState, customer_text, intent, tool_response);
    }

    await logEvent(client, prj.id, call_id, "turn_handled", {
      current_state: effectiveState,
      next_state,
      intent,
      customer_text,
      tool_response,
      handoff,
      end_call,
      used_llm,
      response_source
    });

    const mergedIdentity = context_patch.identity_confirmed != null ? Boolean(context_patch.identity_confirmed) : identityConfirmed;
    const mergedAddress = context_patch.address_confirmed != null ? Boolean(context_patch.address_confirmed) : addressConfirmed;
    const mergedEmail = context_patch.email_confirmed != null ? Boolean(context_patch.email_confirmed) : emailConfirmed;
    const mergedVariant = context_patch.selected_variant || selectedVariant;

    await upsertCallLog(client, prj.id, call_id, {
      status: end_call ? "completed" : "in_progress",
      final_state: next_state,
      variant_selected: mergedVariant,
      identity_confirmed: mergedIdentity,
      address_confirmed: mergedAddress,
      email_confirmed: mergedEmail,
      handoff_used: handoff,
      end_call_reason: handoff_reason || (end_call ? "flow_end" : null)
    });

    res.json({
      next_state,
      tool_response,
      end_call,
      handoff,
      handoff_reason,
      intent,
      context_patch,
      used_llm,
      response_source
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "internal_error" });
  } finally {
    client.release();
  }
});

app.get("/api/learning/questions", async (req, res) => {
  const client = await pool.connect();
  try {
    const projectKey = String(req.query.project || "rheinpfalz");
    const status = String(req.query.status || "pending");
    const q = String(req.query.q || "").trim().toLowerCase();
    const state = String(req.query.state || "all").trim();
    const prj = await getProject(client, projectKey);
    if (!prj) return res.status(404).json({ error: `project ${projectKey} not found` });
    const rows = await client.query(
      `select id, project_key, state_key, coalesce(state_keys, array[state_key]) as state_keys, question_text, intent_key, llm_answer, approved_response, status, created_at, updated_at, resolved_at
       from learned_questions
       where project_key=$1
         and ($2 = 'all' or status = $2)
         and ($3 = '' or lower(question_text) like ('%' || $3 || '%'))
         and ($4 = 'all' or coalesce(state_keys, array[state_key]) @> array[$4::text])
       order by created_at desc
       limit 300`,
      [projectKey, status, q, state]
    );
    res.json({ items: rows.rows });
  } finally {
    client.release();
  }
});

app.post("/api/learning/questions", async (req, res) => {
  const client = await pool.connect();
  try {
    const projectKey = String(req.body?.project || "rheinpfalz").trim();
    const question_text = String(req.body?.question_text || "").trim();
    const intent_key = String(req.body?.intent_key || "").trim() || null;
    const approved_response = String(req.body?.approved_response || "").trim();
    const statusRaw = String(req.body?.status || "pending").trim();
    const status = statusRaw === "approved" ? "approved" : "pending";
    const rawStates = Array.isArray(req.body?.state_keys) ? req.body.state_keys : [];
    const state_keys = [...new Set(rawStates.map((s) => String(s || "").trim()).filter(Boolean))];

    if (!question_text) return res.status(400).json({ error: "question_text is required" });
    if (!state_keys.length) return res.status(400).json({ error: "state_keys[] is required" });
    if (status === "approved" && !approved_response) {
      return res.status(400).json({ error: "approved_response is required when status=approved" });
    }

    const prj = await getProject(client, projectKey);
    if (!prj) return res.status(404).json({ error: `project ${projectKey} not found` });

    const normalized_question = normalizeQuestion(question_text);
    const first_state = state_keys[0];
    const llm_answer = approved_response || null;

    const row = await client.query(
      `insert into learned_questions(project_key, project_id, state_key, state_keys, question_text, normalized_question, intent_key, llm_answer, approved_response, status, created_at, updated_at, resolved_at)
       values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10, now(), now(), case when $10='approved' then now() else null end)
       returning id`,
      [projectKey, prj.id, first_state, state_keys, question_text, normalized_question, intent_key, llm_answer, approved_response || null, status]
    );
    const id = row.rows[0]?.id;

    if (status === "approved" && approved_response) {
      for (const stateKey of state_keys) {
        await client.query(
          `insert into response_variants(project_id, state_key, intent_key, variant_key, response_text, is_default, active)
           values($1,$2,$3,$4,$5,false,true)`,
          [prj.id, stateKey, intent_key || "info_request", `learned_${id}_${stateKey}`, approved_response]
        );
      }
    }

    res.json({ ok: true, id });
  } finally {
    client.release();
  }
});

app.post("/api/learning/questions/:id/approve", async (req, res) => {
  const client = await pool.connect();
  try {
    const id = Number(req.params.id);
    const approved_response = String(req.body?.approved_response || "").trim();
    if (!id || !approved_response) return res.status(400).json({ error: "id and approved_response are required" });
    const row = await client.query(
      `update learned_questions
       set approved_response=$1, status='approved', updated_at=now(), resolved_at=now()
       where id=$2
       returning id, project_key, state_key, coalesce(state_keys, array[state_key]) as state_keys, intent_key`,
      [approved_response, id]
    );
    if (!row.rows[0]) return res.status(404).json({ error: "question not found" });
    const q = row.rows[0];
    const prj = await getProject(client, q.project_key);
    if (!prj) return res.status(404).json({ error: `project ${q.project_key} not found` });
    const stateKeys = Array.isArray(q.state_keys) && q.state_keys.length ? q.state_keys : [q.state_key];
    await client.query(
      `delete from response_variants
       where project_id=$1
         and variant_key like $2`,
      [prj.id, `learned_${id}%`]
    );
    for (const stateKey of stateKeys) {
      await client.query(
        `insert into response_variants(project_id, state_key, intent_key, variant_key, response_text, is_default, active)
         values($1,$2,$3,$4,$5,false,true)`,
        [prj.id, stateKey, q.intent_key || "info_request", `learned_${id}_${stateKey}`, approved_response]
      );
    }
    res.json({ ok: true });
  } finally {
    client.release();
  }
});

app.put("/api/learning/questions/:id/states", async (req, res) => {
  const client = await pool.connect();
  try {
    const id = Number(req.params.id);
    const rawStates = Array.isArray(req.body?.state_keys) ? req.body.state_keys : [];
    const state_keys = [...new Set(rawStates.map((s) => String(s || "").trim()).filter(Boolean))];
    if (!id || !state_keys.length) return res.status(400).json({ error: "id and state_keys[] are required" });

    const row = await client.query(
      `update learned_questions
       set state_keys=$1, updated_at=now()
       where id=$2
       returning id, project_key, intent_key, approved_response, status`,
      [state_keys, id]
    );
    const q = row.rows[0];
    if (!q) return res.status(404).json({ error: "question not found" });

    if (q.status === "approved" && q.approved_response) {
      const prj = await getProject(client, q.project_key);
      if (prj) {
        for (const s of state_keys) {
          await client.query(
            `insert into response_variants(project_id, state_key, intent_key, variant_key, response_text, is_default, active)
             values($1,$2,$3,$4,$5,false,true)
             on conflict do nothing`,
            [prj.id, s, q.intent_key || "info_request", `learned_${id}_${s}`, q.approved_response]
          );
        }
      }
    }

    res.json({ ok: true, state_keys });
  } finally {
    client.release();
  }
});

app.delete("/api/learning/questions/:id", async (req, res) => {
  const client = await pool.connect();
  try {
    const id = Number(req.params.id);
    const cascade = String(req.query.cascade || "false").toLowerCase() === "true";
    if (!id) return res.status(400).json({ error: "id is required" });
    const row = await client.query(`select project_key from learned_questions where id=$1`, [id]);
    if (!row.rows[0]) return res.status(404).json({ error: "question not found" });
    const projectKey = row.rows[0].project_key;
    const result = await client.query(`delete from learned_questions where id=$1`, [id]);
    if (!result.rowCount) return res.status(404).json({ error: "question not found" });
    if (cascade) {
      const prj = await getProject(client, projectKey);
      if (prj) {
        await client.query(
          `delete from response_variants
           where project_id=$1 and variant_key like $2`,
          [prj.id, `learned_${id}%`]
        );
      }
    }
    res.json({ ok: true });
  } finally {
    client.release();
  }
});

app.post("/prepare-call", async (req, res) => {
  const client = await pool.connect();
  try {
    const { project = "rheinpfalz", lead_id } = req.body || {};
    if (!lead_id) {
      return res.status(400).json({ error: "lead_id is required" });
    }

    const prj = await getProject(client, project);
    if (!prj) {
      return res.status(404).json({ error: `project ${project} not found` });
    }

    const leadRow = await client.query(
      `select id, salutation, first_name, last_name, phone, street, city, email
       from leads where id = $1 and project_id = $2 and active = true limit 1`,
      [lead_id, prj.id]
    );

    if (!leadRow.rows[0]) {
      return res.status(404).json({ error: "lead not found" });
    }

    const lead = leadRow.rows[0];
    res.json({
      project,
      lead_id: lead.id,
      lead: {
        salutation: lead.salutation,
        first_name: lead.first_name,
        last_name: lead.last_name,
        phone: lead.phone,
        street: lead.street,
        city: lead.city,
        email: lead.email
      },
      context: {
        current_state: "intro",
        identity_confirmed: false,
        address_confirmed: false,
        email_confirmed: false,
        selected_variant: null,
        rejection_count: 0,
        human_recovery_attempted: false
      }
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "internal_error" });
  } finally {
    client.release();
  }
});

app.post("/webhook/post-call", async (req, res) => {
  const client = await pool.connect();
  try {
    const event = req.body || {};
    const type = event.type || "unknown";
    const data = event.data || {};
    const projectKey = data?.metadata?.project || "rheinpfalz";
    const callId = data?.conversation_id || data?.call_id || `unknown-${Date.now()}`;
    const prj = await getProject(client, projectKey);

    if (!prj) {
      return res.status(404).json({ error: `project ${projectKey} not found` });
    }

    await client.query(
      `insert into call_logs(project_id, call_id, agent_id, phone_to, status, started_at, ended_at)
       values($1,$2,$3,$4,$5,$6,$7)
       on conflict (project_id, call_id)
       do update set
         status = excluded.status,
         ended_at = excluded.ended_at,
         agent_id = coalesce(excluded.agent_id, call_logs.agent_id),
         phone_to = coalesce(excluded.phone_to, call_logs.phone_to)`,
      [
        prj.id,
        callId,
        data.agent_id || null,
        data?.metadata?.phone_call?.to_number || null,
        data.status || type,
        data?.metadata?.start_time_unix_secs ? new Date(data.metadata.start_time_unix_secs * 1000) : null,
        data?.metadata?.call_duration_secs ? new Date(Date.now()) : null
      ]
    );

    await logEvent(client, prj.id, callId, type, event);

    res.status(200).json({ ok: true });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "internal_error" });
  } finally {
    client.release();
  }
});

ensureLearningTables()
  .then(() => {
    app.listen(port, () => {
      console.log(`MVP server listening on :${port}`);
    });
  })
  .catch((e) => {
    console.error("Failed to initialize learning tables", e);
    process.exit(1);
  });



