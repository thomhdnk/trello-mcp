#!/usr/bin/env node

import http from "node:http";
import fs from "node:fs";
import crypto from "node:crypto";
import { URL } from "node:url";

const SERVER_NAME = "hdnk-operations-agent";
const SERVER_VERSION = "1.1.0";
const TRELLO_API_BASE = "https://api.trello.com/1";

const text = (value) => ({
  content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value, null, 2) }]
});
const toolError = (error) => ({
  isError: true,
  content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }]
});
const jsonSchema = (properties, required = []) => ({ type: "object", properties, required, additionalProperties: false });
const stringProp = (description) => ({ type: "string", description });
const boolProp = (description) => ({ type: "boolean", description });
const numberProp = (description) => ({ type: "number", description });
const arrayProp = (description, items = { type: "string" }) => ({ type: "array", description, items });

const oauthClients = new Map();
const oauthCodes = new Map();

function loadDotEnv() {
  if (!fs.existsSync(".env")) return;
  for (const line of fs.readFileSync(".env", "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || !trimmed.includes("=")) continue;
    const index = trimmed.indexOf("=");
    const key = trimmed.slice(0, index).trim();
    const value = trimmed.slice(index + 1).trim().replace(/^["']|["']$/g, "");
    if (key && process.env[key] === undefined) process.env[key] = value;
  }
}
loadDotEnv();

function randomToken(prefix) {
  return `${prefix}_${crypto.randomBytes(24).toString("base64url")}`;
}

function oauthSigningSecret() {
  const secret = process.env.MCP_OAUTH_SIGNING_SECRET ?? process.env.MCP_BEARER_TOKEN;
  if (!secret) throw new Error("Missing MCP_BEARER_TOKEN or MCP_OAUTH_SIGNING_SECRET for OAuth token signing.");
  return secret;
}

function signToken(type, payload, ttlSeconds) {
  const expiresAt = Math.floor(Date.now() / 1000) + ttlSeconds;
  const body = Buffer.from(JSON.stringify({ ...payload, typ: type, exp: expiresAt }), "utf8").toString("base64url");
  const signature = crypto.createHmac("sha256", oauthSigningSecret()).update(body).digest("base64url");
  return `${type}.${body}.${signature}`;
}

function verifyToken(token, type) {
  const [tokenType, body, signature] = String(token ?? "").split(".");
  if (tokenType !== type || !body || !signature) return null;
  const expected = crypto.createHmac("sha256", oauthSigningSecret()).update(body).digest("base64url");
  if (signature.length !== expected.length) return null;
  if (!crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
    if (payload.typ !== type || payload.exp <= Math.floor(Date.now() / 1000)) return null;
    return payload;
  } catch {
    return null;
  }
}

function validConnectCodes() {
  return [process.env.MCP_CONNECT_CODE, process.env.MCP_BEARER_TOKEN].filter(Boolean).map((value) => String(value).trim());
}

function connectCodeIsValid(value) {
  const submitted = String(value ?? "").trim();
  const valid = validConnectCodes();
  return valid.length === 0 || valid.includes(submitted);
}

function baseUrl(req) {
  const proto = req.headers["x-forwarded-proto"] ?? "http";
  const host = req.headers["x-forwarded-host"] ?? req.headers.host ?? "localhost";
  return `${proto}://${host}`;
}

function sendJson(res, status, payload, headers = {}) {
  res.writeHead(status, { "content-type": "application/json", ...headers });
  res.end(JSON.stringify(payload));
}

function sendMcpResponse(req, res, payload) {
  if (payload === undefined || payload === null) {
    res.writeHead(202);
    res.end();
    return;
  }
  res.writeHead(200, {
    "content-type": "application/json",
    "cache-control": "no-store",
    "mcp-session-id": req.headers["mcp-session-id"] ?? "hdnk-operations-agent"
  });
  res.end(JSON.stringify(payload));
}

function htmlEscape(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

async function parseBodyText(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

async function parseJsonBody(req) {
  const body = await parseBodyText(req);
  return body ? JSON.parse(body) : {};
}

async function parseFormBody(req) {
  const body = await parseBodyText(req);
  return Object.fromEntries(new URLSearchParams(body));
}

function pkceChallenge(verifier) {
  return crypto.createHash("sha256").update(verifier).digest("base64url");
}

function pkceMatches(code, verifier) {
  if (!code.code_challenge) return true;
  return code.code_challenge_method === "S256" ? pkceChallenge(verifier) === code.code_challenge : verifier === code.code_challenge;
}

function protectedResourceMetadata(req) {
  const root = baseUrl(req);
  return { resource: `${root}/mcp`, authorization_servers: [root], bearer_methods_supported: ["header"], resource_name: "HDNK Operations Agent" };
}

function authorizationServerMetadata(req) {
  const root = baseUrl(req);
  return {
    issuer: root,
    authorization_endpoint: `${root}/authorize`,
    token_endpoint: `${root}/token`,
    registration_endpoint: `${root}/register`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256", "plain"],
    token_endpoint_auth_methods_supported: ["none"],
    scopes_supported: ["trello", "hdnk:operations"]
  };
}

function clientForAuthorization(clientId, redirectUri) {
  const client = oauthClients.get(clientId);
  if (client) return client.redirect_uris.includes(redirectUri) ? client : null;
  try {
    const parsed = new URL(redirectUri);
    if (parsed.protocol !== "https:") return null;
  } catch {
    return null;
  }
  return {
    client_id: clientId,
    client_name: "ChatGPT",
    redirect_uris: [redirectUri],
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    token_endpoint_auth_method: "none",
    scope: "trello hdnk:operations",
    recovered: true
  };
}

function credentials() {
  const key = process.env.TRELLO_API_KEY;
  const token = process.env.TRELLO_TOKEN;
  if (!key || !token) throw new Error("Missing TRELLO_API_KEY or TRELLO_TOKEN. Copy .env.example values into your environment.");
  return { key, token };
}

function cleanObject(input) {
  return Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined && value !== ""));
}

async function trello(path, { method = "GET", query = {}, body } = {}) {
  const { key, token } = credentials();
  const url = new URL(`${TRELLO_API_BASE}${path}`);
  url.searchParams.set("key", key);
  url.searchParams.set("token", token);
  for (const [name, value] of Object.entries(cleanObject(query))) url.searchParams.set(name, String(value));

  let response;
  let payloadText = "";
  const attempts = method === "GET" ? 2 : 1;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 20000);
    try {
      response = await fetch(url, {
        method,
        headers: body ? { "content-type": "application/json" } : undefined,
        body: body ? JSON.stringify(cleanObject(body)) : undefined,
        signal: controller.signal
      });
      payloadText = await response.text();
      if (response.ok || ![429, 500, 502, 503, 504].includes(response.status) || attempt === attempts) break;
      await new Promise((resolve) => setTimeout(resolve, 500 * attempt));
    } catch (error) {
      if (attempt === attempts) throw new Error(`Trello API request failed: ${error instanceof Error ? error.message : String(error)}`);
      await new Promise((resolve) => setTimeout(resolve, 500 * attempt));
    } finally {
      clearTimeout(timeout);
    }
  }

  let payload;
  try {
    payload = payloadText ? JSON.parse(payloadText) : {};
  } catch {
    payload = payloadText;
  }
  if (!response?.ok) {
    const status = response?.status ?? "unknown";
    const detail = typeof payload === "string" ? payload : JSON.stringify(payload);
    throw new Error(`Trello API ${status}: ${detail}`);
  }
  return payload;
}

function normalize(value) {
  return String(value ?? "").toLowerCase().replace(/https?:\/\//g, "").replace(/[^a-z0-9@.]+/g, " ").trim();
}

function numberFrom(value) {
  if (typeof value === "number") return value;
  const match = String(value ?? "").replace(/\./g, "").replace(/,/g, ".").match(/\d+(?:\.\d+)?/);
  return match ? Number(match[0]) : 0;
}

function daysSince(dateLike) {
  const time = Date.parse(dateLike);
  if (!Number.isFinite(time)) return null;
  return Math.floor((Date.now() - time) / 86400000);
}

function extractField(desc, label) {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const regex = new RegExp(`^${escaped}:\\s*(.+)$`, "im");
  return desc?.match(regex)?.[1]?.trim() ?? "";
}

function classifyList(name) {
  const n = normalize(name);
  if (/won|gewonnen|akkoord|klant|client|project/.test(n)) return "won";
  if (/offerte|proposal|quote|voorstel/.test(n)) return "proposal";
  if (/lead|inbox|new|nieuw|contact/.test(n)) return "lead";
  if (/lost|verloren|geen|afgewezen/.test(n)) return "lost";
  return "active";
}

function crmDescription(lead, previous = "") {
  const now = new Date().toISOString();
  const preserved = previous && !previous.includes("## HDNK CRM") ? `\n\n## Previous description\n${previous}` : "";
  return [
    "## HDNK CRM",
    `Company: ${lead.company ?? ""}`,
    `Contact: ${lead.name ?? ""}`,
    `Email: ${lead.email ?? ""}`,
    `Source: ${lead.source ?? "manual"}`,
    `Deal value: ${lead.dealValue ?? ""}`,
    `Stage: ${lead.stage ?? lead.listName ?? "Lead"}`,
    `Last contact: ${lead.lastContactAt ?? now}`,
    `Next action: ${lead.nextAction ?? "Bepaal concrete follow-up"}`,
    `Updated by: HDNK Operations Agent v1 at ${now}`,
    "",
    "## Notes",
    lead.notes ?? lead.messageSummary ?? "",
    preserved
  ].join("\n");
}

function cardLeadSnapshot(card, listName = "") {
  const desc = card.desc ?? "";
  const dealValue = numberFrom(extractField(desc, "Deal value") || card.name);
  const lastContact = extractField(desc, "Last contact") || card.dateLastActivity;
  const nextAction = extractField(desc, "Next action");
  const email = extractField(desc, "Email");
  const company = extractField(desc, "Company");
  const stage = extractField(desc, "Stage") || listName;
  const staleDays = daysSince(lastContact);
  const listType = classifyList(listName);
  let score = dealValue / 1000;
  if (listType === "proposal") score += 10;
  if (staleDays !== null && staleDays > 7 && listType !== "lost" && listType !== "won") score += 5;
  if (!nextAction) score += 3;
  return { id: card.id, name: card.name, url: card.url ?? card.shortUrl, listName, stage, listType, dealValue, lastContact, staleDays, nextAction, email, company, score };
}

async function resolveBoardId(args) {
  const boardId = args.boardId ?? process.env.HDNK_TRELLO_BOARD_ID;
  if (!boardId) throw new Error("Provide boardId or set HDNK_TRELLO_BOARD_ID.");
  return boardId;
}

async function listBoardState(boardId) {
  const [lists, cards] = await Promise.all([
    trello(`/boards/${encodeURIComponent(boardId)}/lists`, { query: { filter: "open", fields: "id,name,closed,pos" } }),
    trello(`/boards/${encodeURIComponent(boardId)}/cards`, { query: { filter: "open", limit: 1000, fields: "id,name,desc,url,shortUrl,closed,due,dueComplete,idBoard,idList,idLabels,idMembers,dateLastActivity,pos" } })
  ]);
  const listById = new Map(lists.map((list) => [list.id, list]));
  return { lists, cards, listById };
}

async function findOrCreateList(boardId, name) {
  const lists = await trello(`/boards/${encodeURIComponent(boardId)}/lists`, { query: { filter: "open", fields: "id,name,closed,pos" } });
  const found = lists.find((list) => normalize(list.name) === normalize(name));
  if (found) return found;
  return trello("/lists", { method: "POST", query: { idBoard: boardId, name, pos: "bottom", fields: "id,name,closed,pos,idBoard" } });
}

function findDuplicate(cards, lead) {
  const email = normalize(lead.email);
  const company = normalize(lead.company);
  const name = normalize(lead.name);
  return cards.find((card) => {
    const haystack = normalize(`${card.name}\n${card.desc}`);
    return (email && haystack.includes(email)) || (company && haystack.includes(company)) || (name && haystack.includes(name));
  });
}

function buildSalesAnalysis(cards, listById) {
  const snapshots = cards.map((card) => cardLeadSnapshot(card, listById.get(card.idList)?.name ?? "Unknown"));
  const active = snapshots.filter((item) => !["lost", "won"].includes(item.listType));
  const proposals = active.filter((item) => item.listType === "proposal");
  const stale = active.filter((item) => item.staleDays !== null && item.staleDays > 7);
  const missingNextAction = active.filter((item) => !item.nextAction);
  const expectedRevenue = active.reduce((sum, item) => sum + item.dealValue, 0);
  const openProposalValue = proposals.reduce((sum, item) => sum + item.dealValue, 0);
  const topOpportunities = [...active].sort((a, b) => b.score - a.score).slice(0, 10);
  return { generatedAt: new Date().toISOString(), totals: { activeDeals: active.length, expectedRevenue, openProposals: proposals.length, openProposalValue, staleLeads: stale.length, missingNextAction: missingNextAction.length }, stale, proposals, missingNextAction, topOpportunities };
}

const tools = [
  { name: "trello_whoami", description: "Check which Trello account the configured API key and token belong to.", inputSchema: jsonSchema({}) },
  { name: "trello_list_boards", description: "List open Trello boards visible to the configured user.", inputSchema: jsonSchema({ filter: stringProp("Board filter. Common values: open, closed, all, starred. Default: open.") }) },
  { name: "trello_get_board", description: "Get details for a Trello board, including memberships and preferences.", inputSchema: jsonSchema({ boardId: stringProp("The Trello board ID or short link.") }, ["boardId"]) },
  { name: "trello_list_lists", description: "List lists on a Trello board.", inputSchema: jsonSchema({ boardId: stringProp("The Trello board ID or short link."), filter: stringProp("List filter. Common values: open, closed, all. Default: open.") }, ["boardId"]) },
  { name: "trello_create_list", description: "Create a new list on a board.", inputSchema: jsonSchema({ boardId: stringProp("The Trello board ID or short link."), name: stringProp("The name for the new list."), position: stringProp("List position. Examples: top, bottom, or a numeric position. Default: bottom.") }, ["boardId", "name"]) },
  { name: "trello_list_cards", description: "List cards on a board or in a specific list.", inputSchema: jsonSchema({ boardId: stringProp("The Trello board ID or short link. Required when listId is omitted."), listId: stringProp("The Trello list ID. If supplied, cards are read from this list."), filter: stringProp("Card filter. Common values: open, closed, all. Default: open."), limit: numberProp("Maximum number of cards to return. Default: 100.") }) },
  { name: "trello_get_card", description: "Get detailed information for a card, including comments, labels, members, and checklists.", inputSchema: jsonSchema({ cardId: stringProp("The Trello card ID or short link.") }, ["cardId"]) },
  { name: "trello_create_card", description: "Create a Trello card in a list.", inputSchema: jsonSchema({ listId: stringProp("The Trello list ID where the card should be created."), name: stringProp("The card title."), description: stringProp("The card description."), due: stringProp("Optional due date as an ISO-8601 string."), position: stringProp("Card position. Examples: top, bottom. Default: bottom."), labels: stringProp("Comma-separated label IDs to attach.") }, ["listId", "name"]) },
  { name: "trello_update_card", description: "Update card fields such as name, description, due date, closed state, or subscribed state.", inputSchema: jsonSchema({ cardId: stringProp("The Trello card ID or short link."), name: stringProp("New card title."), description: stringProp("New card description."), due: stringProp("Due date as an ISO-8601 string, or null to clear."), closed: boolProp("Whether the card is archived."), subscribed: boolProp("Whether the configured user is subscribed to the card.") }, ["cardId"]) },
  { name: "trello_move_card", description: "Move a card to another list and optionally set its position.", inputSchema: jsonSchema({ cardId: stringProp("The Trello card ID or short link."), listId: stringProp("Destination Trello list ID."), position: stringProp("Card position. Examples: top, bottom, or a numeric position. Default: bottom.") }, ["cardId", "listId"]) },
  { name: "trello_add_comment", description: "Add a comment to a Trello card.", inputSchema: jsonSchema({ cardId: stringProp("The Trello card ID or short link."), text: stringProp("The comment text.") }, ["cardId", "text"]) },
  { name: "hdnk_sync_crm_lead", description: "V1 HDNK CRM sync. Create or update one Trello CRM lead, detect duplicates by email, company or contact name, set last contact, next action and deal value. Does not send email or archive anything.", inputSchema: jsonSchema({ boardId: stringProp("HDNK CRM Trello board ID. Defaults to HDNK_TRELLO_BOARD_ID."), listName: stringProp("Target list name. Defaults to HDNK_CRM_DEFAULT_LIST_NAME or Leads."), name: stringProp("Contact name."), email: stringProp("Contact email."), company: stringProp("Company name."), source: stringProp("Lead source, for example Gmail, Lemlist, LinkedIn or manual."), dealValue: stringProp("Estimated deal value, for example 5500 or 7500."), stage: stringProp("CRM stage label."), lastContactAt: stringProp("ISO date for last contact. Defaults to now."), nextAction: stringProp("Concrete next action."), notes: stringProp("Context or message summary."), messageSummary: stringProp("Short source message summary."), dryRun: boolProp("When true, return the proposed Trello change without writing.") }, ["name"]) },
  { name: "hdnk_analyze_sales", description: "Analyze the HDNK Trello CRM for stale leads, open proposals, missing next actions and highest revenue opportunities. Read-only.", inputSchema: jsonSchema({ boardId: stringProp("HDNK CRM Trello board ID. Defaults to HDNK_TRELLO_BOARD_ID.") }) },
  { name: "hdnk_generate_sales_briefing", description: "Generate a daily HDNK sales briefing from Trello CRM. Read-only. Use this for pipeline, expected revenue, open proposals, risks and top actions.", inputSchema: jsonSchema({ boardId: stringProp("HDNK CRM Trello board ID. Defaults to HDNK_TRELLO_BOARD_ID."), maxActions: numberProp("Maximum number of top actions. Default: 5.") }) },
  { name: "hdnk_bulk_next_action_audit", description: "Add an operations comment to CRM cards that miss a next action or have had no contact for more than seven days. No email sending and no archiving.", inputSchema: jsonSchema({ boardId: stringProp("HDNK CRM Trello board ID. Defaults to HDNK_TRELLO_BOARD_ID."), dryRun: boolProp("When true, return proposed comments without writing."), staleAfterDays: numberProp("Days without contact before a lead is marked stale. Default: 7.") }) }
];

async function callTool(name, args = {}) {
  switch (name) {
    case "trello_whoami":
      return text(await trello("/members/me", { query: { fields: "id,username,fullName,initials,url,confirmed,email" } }));
    case "trello_list_boards":
      return text(await trello("/members/me/boards", { query: { filter: args.filter ?? "open", fields: "id,name,desc,url,shortUrl,closed,dateLastActivity,starred" } }));
    case "trello_get_board":
      return text(await trello(`/boards/${encodeURIComponent(args.boardId)}`, { query: { fields: "all", memberships: "active", organization: "true", prefs: "true" } }));
    case "trello_list_lists":
      return text(await trello(`/boards/${encodeURIComponent(args.boardId)}/lists`, { query: { filter: args.filter ?? "open", fields: "id,name,closed,pos,subscribed" } }));
    case "trello_create_list":
      return text(await trello("/lists", { method: "POST", query: { idBoard: args.boardId, name: args.name, pos: args.position ?? "bottom", fields: "id,name,closed,pos,idBoard" } }));
    case "trello_list_cards": {
      if (!args.boardId && !args.listId) throw new Error("Provide boardId or listId.");
      const path = args.listId ? `/lists/${encodeURIComponent(args.listId)}/cards` : `/boards/${encodeURIComponent(args.boardId)}/cards`;
      return text(await trello(path, { query: { filter: args.filter ?? "open", limit: args.limit ?? 100, fields: "id,name,desc,url,shortUrl,closed,due,dueComplete,idBoard,idList,idLabels,idMembers,dateLastActivity,pos" } }));
    }
    case "trello_get_card":
      return text(await trello(`/cards/${encodeURIComponent(args.cardId)}`, { query: { fields: "all", actions: "commentCard", action_fields: "id,type,date,data,memberCreator", members: "true", member_fields: "id,username,fullName,initials", labels: "true", checklists: "all" } }));
    case "trello_create_card":
      return text(await trello("/cards", { method: "POST", query: { idList: args.listId, name: args.name, desc: args.description, due: args.due, pos: args.position ?? "bottom", idLabels: args.labels, fields: "id,name,desc,url,shortUrl,closed,due,idBoard,idList,idLabels" } }));
    case "trello_update_card":
      return text(await trello(`/cards/${encodeURIComponent(args.cardId)}`, { method: "PUT", query: { name: args.name, desc: args.description, due: args.due, closed: args.closed, subscribed: args.subscribed, fields: "id,name,desc,url,shortUrl,closed,due,idBoard,idList,idLabels" } }));
    case "trello_move_card":
      return text(await trello(`/cards/${encodeURIComponent(args.cardId)}`, { method: "PUT", query: { idList: args.listId, pos: args.position ?? "bottom", fields: "id,name,url,shortUrl,closed,due,idBoard,idList" } }));
    case "trello_add_comment":
      return text(await trello(`/cards/${encodeURIComponent(args.cardId)}/actions/comments`, { method: "POST", query: { text: args.text } }));
    case "hdnk_sync_crm_lead": {
      const boardId = await resolveBoardId(args);
      const listName = args.listName ?? process.env.HDNK_CRM_DEFAULT_LIST_NAME ?? "Leads";
      const { cards, listById } = await listBoardState(boardId);
      const duplicate = findDuplicate(cards, args);
      const targetList = duplicate ? listById.get(duplicate.idList) : await findOrCreateList(boardId, listName);
      const title = args.company ? `${args.company} - ${args.name}` : args.name;
      const description = crmDescription(args, duplicate?.desc ?? "");
      const operation = duplicate ? "update" : "create";
      const proposed = { operation, boardId, list: targetList?.name ?? listName, cardId: duplicate?.id, title, duplicate: Boolean(duplicate), description };
      if (args.dryRun) return text({ dryRun: true, proposed });
      const card = duplicate
        ? await trello(`/cards/${encodeURIComponent(duplicate.id)}`, { method: "PUT", query: { name: title, desc: description, fields: "id,name,desc,url,shortUrl,idList,dateLastActivity" } })
        : await trello("/cards", { method: "POST", query: { idList: targetList.id, name: title, desc: description, pos: "top", fields: "id,name,desc,url,shortUrl,idList,dateLastActivity" } });
      await trello(`/cards/${encodeURIComponent(card.id)}/actions/comments`, { method: "POST", query: { text: `HDNK Operations Agent v1: CRM ${operation}. Next action: ${args.nextAction ?? "Bepaal concrete follow-up"}` } });
      return text({ ok: true, operation, card });
    }
    case "hdnk_analyze_sales": {
      const boardId = await resolveBoardId(args);
      const { cards, listById } = await listBoardState(boardId);
      return text(buildSalesAnalysis(cards, listById));
    }
    case "hdnk_generate_sales_briefing": {
      const boardId = await resolveBoardId(args);
      const { cards, listById } = await listBoardState(boardId);
      const analysis = buildSalesAnalysis(cards, listById);
      const actions = analysis.topOpportunities.slice(0, args.maxActions ?? 5).map((item, index) => `${index + 1}. ${item.name} (${item.listName}, €${item.dealValue || 0}) - ${item.nextAction || (item.staleDays > 7 ? `follow-up na ${item.staleDays} dagen` : "bepaal next action")}`);
      return text([
        `HDNK Sales Briefing - ${new Date().toLocaleDateString("nl-NL")}`,
        "",
        `Pipeline: ${analysis.totals.activeDeals} actieve deals`,
        `Verwachte omzet: €${analysis.totals.expectedRevenue}`,
        `Open offertes: ${analysis.totals.openProposals} (€${analysis.totals.openProposalValue})`,
        `Risico's: ${analysis.totals.staleLeads} leads zonder contact >7 dagen, ${analysis.totals.missingNextAction} zonder next action`,
        "",
        "Belangrijkste acties:",
        actions.length ? actions.join("\n") : "Geen directe salesacties gevonden."
      ].join("\n"));
    }
    case "hdnk_bulk_next_action_audit": {
      const boardId = await resolveBoardId(args);
      const staleAfterDays = args.staleAfterDays ?? 7;
      const { cards, listById } = await listBoardState(boardId);
      const analysis = buildSalesAnalysis(cards, listById);
      const targets = analysis.topOpportunities.filter((item) => !item.nextAction || (item.staleDays !== null && item.staleDays > staleAfterDays));
      const comments = targets.map((item) => ({ cardId: item.id, name: item.name, comment: `HDNK Operations Agent v1: check nodig. ${!item.nextAction ? "Next action ontbreekt. " : ""}${item.staleDays > staleAfterDays ? `Laatste contact lijkt ${item.staleDays} dagen geleden. ` : ""}Advies: plan concrete follow-up of werk status bij.` }));
      if (args.dryRun) return text({ dryRun: true, count: comments.length, comments });
      for (const item of comments) await trello(`/cards/${encodeURIComponent(item.cardId)}/actions/comments`, { method: "POST", query: { text: item.comment } });
      return text({ ok: true, updated: comments.length, comments });
    }
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

async function handleRequest(message) {
  if (!message || typeof message !== "object") throw new Error("Invalid JSON-RPC message.");
  const { id, method, params } = message;
  if (!method) return undefined;
  try {
    let result;
    switch (method) {
      case "initialize":
        result = {
          protocolVersion: params?.protocolVersion ?? "2024-11-05",
          capabilities: { tools: {} },
          serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
          instructions: [
            "You are the HDNK Operations Agent for Trello-based CRM and sales operations.",
            "V1 scope: synchronize CRM leads, analyze sales, and update Trello only when explicitly asked.",
            "Do not send emails, do not archive leads automatically, and do not create project sprint boards unless a later agent explicitly supports it.",
            "Always protect margin, flag missing next actions, stale leads, open proposals and high-value opportunities."
          ].join(" ")
        };
        break;
      case "tools/list":
        result = { tools };
        break;
      case "tools/call":
        try {
          result = await callTool(params?.name, params?.arguments ?? {});
        } catch (error) {
          result = toolError(error);
        }
        break;
      case "resources/list":
        result = { resources: [] };
        break;
      case "prompts/list":
        result = { prompts: [] };
        break;
      case "ping":
        result = {};
        break;
      case "notifications/initialized":
      case "notifications/cancelled":
        return undefined;
      default:
        throw new Error(`Unsupported method: ${method}`);
    }
    if (id === undefined || id === null) return undefined;
    return { jsonrpc: "2.0", id, result };
  } catch (error) {
    if (id === undefined || id === null) return undefined;
    return { jsonrpc: "2.0", id, error: { code: -32000, message: error instanceof Error ? error.message : String(error) } };
  }
}

function encodeMessage(message) {
  const body = JSON.stringify(message);
  return `Content-Length: ${Buffer.byteLength(body, "utf8")}\r\n\r\n${body}`;
}

function startStdio() {
  let buffer = Buffer.alloc(0);
  process.stdin.on("data", async (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    while (true) {
      const separator = buffer.indexOf("\r\n\r\n");
      if (separator === -1) break;
      const header = buffer.subarray(0, separator).toString("utf8");
      const lengthMatch = header.match(/content-length:\s*(\d+)/i);
      if (!lengthMatch) {
        buffer = buffer.subarray(separator + 4);
        continue;
      }
      const length = Number(lengthMatch[1]);
      const start = separator + 4;
      const end = start + length;
      if (buffer.length < end) break;
      const rawBody = buffer.subarray(start, end).toString("utf8");
      buffer = buffer.subarray(end);
      try {
        const response = await handleRequest(JSON.parse(rawBody));
        if (response) process.stdout.write(encodeMessage(response));
      } catch (error) {
        process.stdout.write(encodeMessage({ jsonrpc: "2.0", id: null, error: { code: -32700, message: error instanceof Error ? error.message : String(error) } }));
      }
    }
  });
}

function isAuthorized(req) {
  const expected = process.env.MCP_BEARER_TOKEN;
  const auth = req.headers.authorization;
  if (!auth?.startsWith("Bearer ")) return !expected;
  const token = auth.slice("Bearer ".length);
  if (expected && token === expected) return true;
  return Boolean(verifyToken(token, "mcp"));
}

function unauthorized(req, res) {
  const metadataUrl = `${baseUrl(req)}/.well-known/oauth-protected-resource`;
  res.writeHead(401, { "content-type": "application/json", "www-authenticate": `Bearer resource_metadata="${metadataUrl}"` });
  res.end(JSON.stringify({ error: "Unauthorized" }));
}

async function handleRegister(req, res) {
  const body = await parseJsonBody(req);
  const clientId = randomToken("client");
  const client = { client_id: clientId, client_name: body.client_name ?? "ChatGPT", redirect_uris: Array.isArray(body.redirect_uris) ? body.redirect_uris : [], grant_types: body.grant_types ?? ["authorization_code", "refresh_token"], response_types: body.response_types ?? ["code"], token_endpoint_auth_method: "none", scope: body.scope ?? "trello hdnk:operations", created_at: Date.now() };
  oauthClients.set(clientId, client);
  sendJson(res, 201, client);
}

function handleAuthorizeGet(req, res, url) {
  const client = clientForAuthorization(url.searchParams.get("client_id"), url.searchParams.get("redirect_uri"));
  if (!client) return sendJson(res, 400, { error: "invalid_client_or_redirect_uri" });
  const page = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Authorize HDNK Operations Agent</title><style>body{font-family:system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;margin:0;background:#f6f7f9;color:#172b4d}main{max-width:420px;margin:12vh auto;background:#fff;border:1px solid #dfe1e6;border-radius:8px;padding:24px}h1{font-size:22px;margin:0 0 12px}p{line-height:1.45}label{display:block;font-weight:600;margin:18px 0 6px}input{width:100%;box-sizing:border-box;padding:10px 12px;border:1px solid #c1c7d0;border-radius:6px;font-size:16px}button{margin-top:18px;width:100%;padding:11px 14px;border:0;border-radius:6px;background:#111;color:white;font-weight:700;font-size:16px}small{display:block;color:#626f86;margin-top:12px}</style></head><body><main><h1>Authorize HDNK Operations Agent</h1><p>Allow ${htmlEscape(client.client_name)} to connect to the HDNK Trello operations agent.</p><form method="post" action="/authorize">${[...url.searchParams.entries()].map(([key, value]) => `<input type="hidden" name="${htmlEscape(key)}" value="${htmlEscape(value)}">`).join("")}<label for="connect_code">Connect code</label><input id="connect_code" name="connect_code" type="password" autocomplete="one-time-code" autofocus required><button type="submit">Authorize</button><small>Use Railway MCP_CONNECT_CODE. MCP_BEARER_TOKEN also works.</small></form></main></body></html>`;
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  res.end(page);
}

async function handleAuthorizePost(req, res) {
  const form = await parseFormBody(req);
  if (!connectCodeIsValid(form.connect_code)) return sendJson(res, 403, { error: "invalid_connect_code" });
  const client = clientForAuthorization(form.client_id, form.redirect_uri);
  if (!client) return sendJson(res, 400, { error: "invalid_client_or_redirect_uri" });
  const code = randomToken("code");
  oauthCodes.set(code, { client_id: form.client_id, redirect_uri: form.redirect_uri, code_challenge: form.code_challenge, code_challenge_method: form.code_challenge_method ?? "plain", resource: form.resource, scope: form.scope ?? "trello hdnk:operations", expires_at: Date.now() + 5 * 60 * 1000 });
  const redirect = new URL(form.redirect_uri);
  redirect.searchParams.set("code", code);
  if (form.state) redirect.searchParams.set("state", form.state);
  res.writeHead(302, { location: redirect.toString() });
  res.end();
}

async function handleToken(req, res) {
  const form = await parseFormBody(req);
  if (form.grant_type === "authorization_code") {
    const code = oauthCodes.get(form.code);
    oauthCodes.delete(form.code);
    if (!code || code.expires_at <= Date.now()) return sendJson(res, 400, { error: "invalid_grant" });
    if (code.client_id !== form.client_id || code.redirect_uri !== form.redirect_uri) return sendJson(res, 400, { error: "invalid_grant" });
    if (!pkceMatches(code, form.code_verifier)) return sendJson(res, 400, { error: "invalid_grant", error_description: "PKCE verification failed" });
    const tokenPayload = { client_id: form.client_id, scope: code.scope, resource: form.resource ?? code.resource };
    return sendJson(res, 200, { access_token: signToken("mcp", tokenPayload, 60 * 60), token_type: "Bearer", expires_in: 3600, refresh_token: signToken("refresh", tokenPayload, 30 * 24 * 60 * 60), scope: code.scope }, { "cache-control": "no-store" });
  }
  if (form.grant_type === "refresh_token") {
    const refresh = verifyToken(form.refresh_token, "refresh");
    if (!refresh) return sendJson(res, 400, { error: "invalid_grant" });
    const tokenPayload = { client_id: refresh.client_id, scope: refresh.scope, resource: form.resource ?? refresh.resource };
    return sendJson(res, 200, { access_token: signToken("mcp", tokenPayload, 60 * 60), token_type: "Bearer", expires_in: 3600, scope: refresh.scope }, { "cache-control": "no-store" });
  }
  sendJson(res, 400, { error: "unsupported_grant_type" });
}

async function handleHttpRequest(req, res) {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
  if (req.method === "OPTIONS") {
    res.writeHead(204, { "access-control-allow-origin": "*", "access-control-allow-methods": "GET,POST,DELETE,OPTIONS", "access-control-allow-headers": "authorization,content-type,mcp-session-id", "access-control-expose-headers": "mcp-session-id,www-authenticate" });
    res.end();
    return;
  }
  if (req.method === "GET" && url.pathname === "/health") return sendJson(res, 200, { ok: true, name: SERVER_NAME, version: SERVER_VERSION });
  if (req.method === "GET" && url.pathname === "/debug") return sendJson(res, 200, { ok: true, name: SERVER_NAME, version: SERVER_VERSION, transport: process.env.MCP_TRANSPORT ?? "stdio", trelloConfigured: Boolean(process.env.TRELLO_API_KEY && process.env.TRELLO_TOKEN), hdnkBoardConfigured: Boolean(process.env.HDNK_TRELLO_BOARD_ID), authConfigured: Boolean(process.env.MCP_BEARER_TOKEN || process.env.MCP_CONNECT_CODE) });
  if (req.method === "GET" && (url.pathname === "/.well-known/oauth-protected-resource" || url.pathname === "/.well-known/oauth-protected-resource/mcp")) return sendJson(res, 200, protectedResourceMetadata(req));
  if (req.method === "GET" && (url.pathname === "/.well-known/oauth-authorization-server" || url.pathname === "/.well-known/openid-configuration")) return sendJson(res, 200, authorizationServerMetadata(req));
  if (req.method === "POST" && url.pathname === "/register") return handleRegister(req, res);
  if (req.method === "GET" && url.pathname === "/authorize") return handleAuthorizeGet(req, res, url);
  if (req.method === "POST" && url.pathname === "/authorize") return handleAuthorizePost(req, res);
  if (req.method === "POST" && url.pathname === "/token") return handleToken(req, res);
  if (url.pathname !== "/mcp") return sendJson(res, 404, { error: "Not found. Use POST /mcp." });
  if (!isAuthorized(req)) return unauthorized(req, res);
  if (req.method === "GET") {
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache, no-transform", connection: "keep-alive", "mcp-session-id": req.headers["mcp-session-id"] ?? "hdnk-operations-agent" });
    res.write(": connected\n\n");
    const heartbeat = setInterval(() => res.write(": keepalive\n\n"), 15000);
    req.on("close", () => clearInterval(heartbeat));
    return;
  }
  if (req.method === "DELETE") {
    res.writeHead(202);
    res.end();
    return;
  }
  if (req.method !== "POST") return sendJson(res, 405, { error: "Method not allowed. Use GET, POST, or DELETE /mcp." }, { allow: "GET,POST,DELETE" });
  try {
    const payload = await parseJsonBody(req);
    const messages = Array.isArray(payload) ? payload : [payload];
    const responses = (await Promise.all(messages.map(handleRequest))).filter(Boolean);
    sendMcpResponse(req, res, Array.isArray(payload) ? responses : responses[0] ?? null);
  } catch (error) {
    res.writeHead(400, { "content-type": "application/json" });
    res.end(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: error instanceof Error ? error.message : String(error) } }));
  }
}

function startHttp() {
  const port = Number(process.env.PORT ?? 3333);
  const defaultHost = process.env.RAILWAY_ENVIRONMENT ? "0.0.0.0" : "127.0.0.1";
  const host = process.env.HOST ?? defaultHost;
  const server = http.createServer(async (req, res) => {
    try {
      await handleHttpRequest(req, res);
    } catch (error) {
      console.error("Unhandled HTTP error", error);
      if (!res.headersSent) res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "internal_server_error" }));
    }
  });
  server.listen(port, host, () => console.error(`${SERVER_NAME} listening on http://${host}:${port}/mcp`));
}

if (process.env.MCP_TRANSPORT === "http") startHttp();
else startStdio();
