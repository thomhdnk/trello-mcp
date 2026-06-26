#!/usr/bin/env node

import http from "node:http";
import fs from "node:fs";
import crypto from "node:crypto";
import { URL } from "node:url";

const SERVER_NAME = "trello-mcp-server";
const SERVER_VERSION = "1.0.0";
const TRELLO_API_BASE = "https://api.trello.com/1";

const text = (value) => ({
  content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value, null, 2) }]
});

const jsonSchema = (properties, required = []) => ({
  type: "object",
  properties,
  required,
  additionalProperties: false
});

const stringProp = (description) => ({ type: "string", description });
const boolProp = (description) => ({ type: "boolean", description });
const numberProp = (description) => ({ type: "number", description });
const oauthClients = new Map();
const oauthCodes = new Map();

function loadDotEnv() {
  if (!fs.existsSync(".env")) return;
  const lines = fs.readFileSync(".env", "utf8").split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || !trimmed.includes("=")) continue;
    const index = trimmed.indexOf("=");
    const key = trimmed.slice(0, index).trim();
    const rawValue = trimmed.slice(index + 1).trim();
    const value = rawValue.replace(/^['"]|['"]$/g, "");
    if (key && process.env[key] === undefined) process.env[key] = value;
  }
}

loadDotEnv();

function randomToken(prefix) {
  return `${prefix}_${crypto.randomBytes(24).toString("base64url")}`;
}

function oauthSigningSecret() {
  const secret = process.env.MCP_OAUTH_SIGNING_SECRET ?? process.env.MCP_BEARER_TOKEN;
  if (!secret) {
    throw new Error("Missing MCP_BEARER_TOKEN or MCP_OAUTH_SIGNING_SECRET for OAuth token signing.");
  }
  return secret;
}

function signToken(type, payload, ttlSeconds) {
  const expiresAt = Math.floor(Date.now() / 1000) + ttlSeconds;
  const body = Buffer.from(JSON.stringify({ ...payload, typ: type, exp: expiresAt }), "utf8").toString("base64url");
  const signature = crypto
    .createHmac("sha256", oauthSigningSecret())
    .update(body)
    .digest("base64url");
  return `${type}.${body}.${signature}`;
}

function verifyToken(token, type) {
  const [tokenType, body, signature] = String(token ?? "").split(".");
  if (tokenType !== type || !body || !signature) return null;

  const expected = crypto
    .createHmac("sha256", oauthSigningSecret())
    .update(body)
    .digest("base64url");
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
  return [process.env.MCP_CONNECT_CODE, process.env.MCP_BEARER_TOKEN]
    .filter(Boolean)
    .map((value) => String(value).trim());
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

async function parseFormBody(req) {
  const body = await parseBodyText(req);
  return Object.fromEntries(new URLSearchParams(body));
}

function pkceChallenge(verifier) {
  return crypto.createHash("sha256").update(verifier).digest("base64url");
}

function pkceMatches(code, verifier) {
  if (!code.code_challenge) return true;
  if (code.code_challenge_method === "S256") {
    return pkceChallenge(verifier) === code.code_challenge;
  }
  return verifier === code.code_challenge;
}

function protectedResourceMetadata(req) {
  const root = baseUrl(req);
  return {
    resource: `${root}/mcp`,
    authorization_servers: [root],
    bearer_methods_supported: ["header"],
    resource_name: "Trello MCP Server"
  };
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
    scopes_supported: ["trello"]
  };
}

const tools = [
  {
    name: "trello_whoami",
    description: "Check which Trello account the configured API key and token belong to.",
    inputSchema: jsonSchema({})
  },
  {
    name: "trello_list_boards",
    description: "List open Trello boards visible to the configured user.",
    inputSchema: jsonSchema({
      filter: stringProp("Board filter. Common values: open, closed, all, starred. Default: open.")
    })
  },
  {
    name: "trello_get_board",
    description: "Get details for a Trello board, including memberships and preferences.",
    inputSchema: jsonSchema({
      boardId: stringProp("The Trello board ID or short link.")
    }, ["boardId"])
  },
  {
    name: "trello_list_lists",
    description: "List lists on a Trello board.",
    inputSchema: jsonSchema({
      boardId: stringProp("The Trello board ID or short link."),
      filter: stringProp("List filter. Common values: open, closed, all. Default: open.")
    }, ["boardId"])
  },
  {
    name: "trello_create_list",
    description: "Create a new list on a board.",
    inputSchema: jsonSchema({
      boardId: stringProp("The Trello board ID or short link."),
      name: stringProp("The name for the new list."),
      position: stringProp("List position. Examples: top, bottom, or a numeric position. Default: bottom.")
    }, ["boardId", "name"])
  },
  {
    name: "trello_list_cards",
    description: "List cards on a board or in a specific list.",
    inputSchema: jsonSchema({
      boardId: stringProp("The Trello board ID or short link. Required when listId is omitted."),
      listId: stringProp("The Trello list ID. If supplied, cards are read from this list."),
      filter: stringProp("Card filter. Common values: open, closed, all. Default: open."),
      limit: numberProp("Maximum number of cards to return. Default: 100.")
    })
  },
  {
    name: "trello_get_card",
    description: "Get detailed information for a card, including comments, labels, members, and checklists.",
    inputSchema: jsonSchema({
      cardId: stringProp("The Trello card ID or short link.")
    }, ["cardId"])
  },
  {
    name: "trello_create_card",
    description: "Create a Trello card in a list.",
    inputSchema: jsonSchema({
      listId: stringProp("The Trello list ID where the card should be created."),
      name: stringProp("The card title."),
      description: stringProp("The card description."),
      due: stringProp("Optional due date as an ISO-8601 string."),
      position: stringProp("Card position. Examples: top, bottom. Default: bottom."),
      labels: stringProp("Comma-separated label IDs to attach.")
    }, ["listId", "name"])
  },
  {
    name: "trello_update_card",
    description: "Update card fields such as name, description, due date, closed state, or subscribed state.",
    inputSchema: jsonSchema({
      cardId: stringProp("The Trello card ID or short link."),
      name: stringProp("New card title."),
      description: stringProp("New card description."),
      due: stringProp("Due date as an ISO-8601 string, or null to clear."),
      closed: boolProp("Whether the card is archived."),
      subscribed: boolProp("Whether the configured user is subscribed to the card.")
    }, ["cardId"])
  },
  {
    name: "trello_move_card",
    description: "Move a card to another list and optionally set its position.",
    inputSchema: jsonSchema({
      cardId: stringProp("The Trello card ID or short link."),
      listId: stringProp("Destination Trello list ID."),
      position: stringProp("Card position. Examples: top, bottom, or a numeric position. Default: bottom.")
    }, ["cardId", "listId"])
  },
  {
    name: "trello_archive_card",
    description: "Archive or unarchive a Trello card.",
    inputSchema: jsonSchema({
      cardId: stringProp("The Trello card ID or short link."),
      archived: boolProp("true archives the card; false unarchives it. Default: true.")
    }, ["cardId"])
  },
  {
    name: "trello_add_comment",
    description: "Add a comment to a Trello card.",
    inputSchema: jsonSchema({
      cardId: stringProp("The Trello card ID or short link."),
      text: stringProp("The comment text.")
    }, ["cardId", "text"])
  },
  {
    name: "trello_list_labels",
    description: "List labels on a Trello board.",
    inputSchema: jsonSchema({
      boardId: stringProp("The Trello board ID or short link.")
    }, ["boardId"])
  },
  {
    name: "trello_add_label_to_card",
    description: "Attach an existing board label to a card.",
    inputSchema: jsonSchema({
      cardId: stringProp("The Trello card ID or short link."),
      labelId: stringProp("The Trello label ID.")
    }, ["cardId", "labelId"])
  }
];

function credentials() {
  const key = process.env.TRELLO_API_KEY;
  const token = process.env.TRELLO_TOKEN;
  if (!key || !token) {
    throw new Error("Missing TRELLO_API_KEY or TRELLO_TOKEN. Copy .env.example values into your environment.");
  }
  return { key, token };
}

function cleanObject(input) {
  return Object.fromEntries(
    Object.entries(input).filter(([, value]) => value !== undefined && value !== "")
  );
}

async function trello(path, { method = "GET", query = {}, body } = {}) {
  const { key, token } = credentials();
  const url = new URL(`${TRELLO_API_BASE}${path}`);
  url.searchParams.set("key", key);
  url.searchParams.set("token", token);
  for (const [name, value] of Object.entries(cleanObject(query))) {
    url.searchParams.set(name, String(value));
  }

  const response = await fetch(url, {
    method,
    headers: body ? { "content-type": "application/json" } : undefined,
    body: body ? JSON.stringify(cleanObject(body)) : undefined
  });

  const payloadText = await response.text();
  let payload;
  try {
    payload = payloadText ? JSON.parse(payloadText) : {};
  } catch {
    payload = payloadText;
  }

  if (!response.ok) {
    const detail = typeof payload === "string" ? payload : JSON.stringify(payload);
    throw new Error(`Trello API ${response.status}: ${detail}`);
  }

  return payload;
}

async function callTool(name, args = {}) {
  switch (name) {
    case "trello_whoami":
      return text(await trello("/members/me", {
        query: { fields: "id,username,fullName,initials,url,confirmed,email" }
      }));

    case "trello_list_boards":
      return text(await trello("/members/me/boards", {
        query: {
          filter: args.filter ?? "open",
          fields: "id,name,desc,url,shortUrl,closed,dateLastActivity,starred"
        }
      }));

    case "trello_get_board":
      return text(await trello(`/boards/${encodeURIComponent(args.boardId)}`, {
        query: {
          fields: "all",
          memberships: "active",
          organization: "true",
          prefs: "true"
        }
      }));

    case "trello_list_lists":
      return text(await trello(`/boards/${encodeURIComponent(args.boardId)}/lists`, {
        query: {
          filter: args.filter ?? "open",
          fields: "id,name,closed,pos,subscribed"
        }
      }));

    case "trello_create_list":
      return text(await trello("/lists", {
        method: "POST",
        query: {
          idBoard: args.boardId,
          name: args.name,
          pos: args.position ?? "bottom"
        }
      }));

    case "trello_list_cards": {
      if (!args.boardId && !args.listId) {
        throw new Error("Provide boardId or listId.");
      }
      const path = args.listId
        ? `/lists/${encodeURIComponent(args.listId)}/cards`
        : `/boards/${encodeURIComponent(args.boardId)}/cards`;
      return text(await trello(path, {
        query: {
          filter: args.filter ?? "open",
          limit: args.limit ?? 100,
          fields: "id,name,desc,url,shortUrl,closed,due,dueComplete,idBoard,idList,idLabels,idMembers,dateLastActivity,pos"
        }
      }));
    }

    case "trello_get_card":
      return text(await trello(`/cards/${encodeURIComponent(args.cardId)}`, {
        query: {
          fields: "all",
          actions: "commentCard",
          action_fields: "id,type,date,data,memberCreator",
          members: "true",
          member_fields: "id,username,fullName,initials",
          labels: "true",
          checklists: "all"
        }
      }));

    case "trello_create_card":
      return text(await trello("/cards", {
        method: "POST",
        query: {
          idList: args.listId,
          name: args.name,
          desc: args.description,
          due: args.due,
          pos: args.position ?? "bottom",
          idLabels: args.labels
        }
      }));

    case "trello_update_card":
      return text(await trello(`/cards/${encodeURIComponent(args.cardId)}`, {
        method: "PUT",
        query: {
          name: args.name,
          desc: args.description,
          due: args.due,
          closed: args.closed,
          subscribed: args.subscribed
        }
      }));

    case "trello_move_card":
      return text(await trello(`/cards/${encodeURIComponent(args.cardId)}`, {
        method: "PUT",
        query: {
          idList: args.listId,
          pos: args.position ?? "bottom"
        }
      }));

    case "trello_archive_card":
      return text(await trello(`/cards/${encodeURIComponent(args.cardId)}`, {
        method: "PUT",
        query: { closed: args.archived ?? true }
      }));

    case "trello_add_comment":
      return text(await trello(`/cards/${encodeURIComponent(args.cardId)}/actions/comments`, {
        method: "POST",
        query: { text: args.text }
      }));

    case "trello_list_labels":
      return text(await trello(`/boards/${encodeURIComponent(args.boardId)}/labels`, {
        query: { fields: "id,name,color,uses" }
      }));

    case "trello_add_label_to_card":
      return text(await trello(`/cards/${encodeURIComponent(args.cardId)}/idLabels`, {
        method: "POST",
        query: { value: args.labelId }
      }));

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

async function handleRequest(message) {
  if (!message || typeof message !== "object") {
    throw new Error("Invalid JSON-RPC message.");
  }

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
            "Use Trello tools to inspect and change boards, lists, cards, comments, and labels.",
            "Prefer reading the current board/list/card state before making changes.",
            "When a user asks to change Trello data, clearly state the intended board, list, card, and text before calling a write tool if there is ambiguity."
          ].join(" ")
        };
        break;
      case "tools/list":
        result = { tools };
        break;
      case "tools/call":
        result = await callTool(params?.name, params?.arguments ?? {});
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
    return {
      jsonrpc: "2.0",
      id,
      error: {
        code: -32000,
        message: error instanceof Error ? error.message : String(error)
      }
    };
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
        const response = {
          jsonrpc: "2.0",
          id: null,
          error: {
            code: -32700,
            message: error instanceof Error ? error.message : String(error)
          }
        };
        process.stdout.write(encodeMessage(response));
      }
    }
  });
}

async function parseJsonBody(req) {
  const body = await parseBodyText(req);
  return body ? JSON.parse(body) : {};
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
  res.writeHead(401, {
    "content-type": "application/json",
    "www-authenticate": `Bearer resource_metadata="${metadataUrl}"`
  });
  res.end(JSON.stringify({ error: "Unauthorized" }));
}

async function handleRegister(req, res) {
  const body = await parseJsonBody(req);
  const clientId = randomToken("client");
  const client = {
    client_id: clientId,
    client_name: body.client_name ?? "ChatGPT",
    redirect_uris: Array.isArray(body.redirect_uris) ? body.redirect_uris : [],
    grant_types: body.grant_types ?? ["authorization_code", "refresh_token"],
    response_types: body.response_types ?? ["code"],
    token_endpoint_auth_method: "none",
    scope: body.scope ?? "trello",
    created_at: Date.now()
  };
  oauthClients.set(clientId, client);
  sendJson(res, 201, client);
}

function handleAuthorizeGet(req, res, url) {
  const client = oauthClients.get(url.searchParams.get("client_id"));
  const redirectUri = url.searchParams.get("redirect_uri");
  if (!client || !redirectUri || !client.redirect_uris.includes(redirectUri)) {
    sendJson(res, 400, { error: "invalid_client_or_redirect_uri" });
    return;
  }

  const page = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Authorize Trello MCP</title>
  <style>
    body { font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; margin: 0; background: #f6f7f9; color: #172b4d; }
    main { max-width: 420px; margin: 12vh auto; background: #fff; border: 1px solid #dfe1e6; border-radius: 8px; padding: 24px; }
    h1 { font-size: 22px; margin: 0 0 12px; }
    p { line-height: 1.45; }
    label { display: block; font-weight: 600; margin: 18px 0 6px; }
    input { width: 100%; box-sizing: border-box; padding: 10px 12px; border: 1px solid #c1c7d0; border-radius: 6px; font-size: 16px; }
    button { margin-top: 18px; width: 100%; padding: 11px 14px; border: 0; border-radius: 6px; background: #0c66e4; color: white; font-weight: 700; font-size: 16px; }
    small { display: block; color: #626f86; margin-top: 12px; }
  </style>
</head>
<body>
  <main>
    <h1>Authorize Trello MCP</h1>
    <p>Allow ${htmlEscape(client.client_name)} to connect to this Trello MCP server.</p>
    <form method="post" action="/authorize">
      ${[...url.searchParams.entries()].map(([key, value]) => `<input type="hidden" name="${htmlEscape(key)}" value="${htmlEscape(value)}">`).join("")}
      <label for="connect_code">Connect code</label>
      <input id="connect_code" name="connect_code" type="password" autocomplete="one-time-code" autofocus required>
      <button type="submit">Authorize</button>
      <small>Use your Railway MCP_CONNECT_CODE. MCP_BEARER_TOKEN also works.</small>
    </form>
  </main>
</body>
</html>`;

  res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  res.end(page);
}

async function handleAuthorizePost(req, res) {
  const form = await parseFormBody(req);
  if (!connectCodeIsValid(form.connect_code)) {
    sendJson(res, 403, { error: "invalid_connect_code" });
    return;
  }

  const client = oauthClients.get(form.client_id);
  if (!client || !client.redirect_uris.includes(form.redirect_uri)) {
    sendJson(res, 400, { error: "invalid_client_or_redirect_uri" });
    return;
  }

  const code = randomToken("code");
  oauthCodes.set(code, {
    client_id: form.client_id,
    redirect_uri: form.redirect_uri,
    code_challenge: form.code_challenge,
    code_challenge_method: form.code_challenge_method ?? "plain",
    resource: form.resource,
    scope: form.scope ?? "trello",
    expires_at: Date.now() + 5 * 60 * 1000
  });

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

    if (!code || code.expires_at <= Date.now()) {
      sendJson(res, 400, { error: "invalid_grant" });
      return;
    }
    if (code.client_id !== form.client_id || code.redirect_uri !== form.redirect_uri) {
      sendJson(res, 400, { error: "invalid_grant" });
      return;
    }
    if (!pkceMatches(code, form.code_verifier)) {
      sendJson(res, 400, { error: "invalid_grant", error_description: "PKCE verification failed" });
      return;
    }

    const tokenPayload = {
      client_id: form.client_id,
      scope: code.scope,
      resource: form.resource ?? code.resource
    };

    sendJson(res, 200, {
      access_token: signToken("mcp", tokenPayload, 60 * 60),
      token_type: "Bearer",
      expires_in: 3600,
      refresh_token: signToken("refresh", tokenPayload, 30 * 24 * 60 * 60),
      scope: code.scope
    }, { "cache-control": "no-store" });
    return;
  }

  if (form.grant_type === "refresh_token") {
    const refresh = verifyToken(form.refresh_token, "refresh");
    if (!refresh) {
      sendJson(res, 400, { error: "invalid_grant" });
      return;
    }

    const tokenPayload = {
      client_id: refresh.client_id,
      scope: refresh.scope,
      resource: form.resource ?? refresh.resource
    };

    sendJson(res, 200, {
      access_token: signToken("mcp", tokenPayload, 60 * 60),
      token_type: "Bearer",
      expires_in: 3600,
      scope: refresh.scope
    }, { "cache-control": "no-store" });
    return;
  }

  sendJson(res, 400, { error: "unsupported_grant_type" });
}

function startHttp() {
  const port = Number(process.env.PORT ?? 3333);
  const defaultHost = process.env.RAILWAY_ENVIRONMENT ? "0.0.0.0" : "127.0.0.1";
  const host = process.env.HOST ?? defaultHost;
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);

    if (req.method === "GET" && url.pathname === "/health") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, name: SERVER_NAME, version: SERVER_VERSION }));
      return;
    }

    if (req.method === "GET" && (
      url.pathname === "/.well-known/oauth-protected-resource" ||
      url.pathname === "/.well-known/oauth-protected-resource/mcp"
    )) {
      sendJson(res, 200, protectedResourceMetadata(req));
      return;
    }

    if (req.method === "GET" && (
      url.pathname === "/.well-known/oauth-authorization-server" ||
      url.pathname === "/.well-known/openid-configuration"
    )) {
      sendJson(res, 200, authorizationServerMetadata(req));
      return;
    }

    if (req.method === "POST" && url.pathname === "/register") {
      await handleRegister(req, res);
      return;
    }

    if (req.method === "GET" && url.pathname === "/authorize") {
      handleAuthorizeGet(req, res, url);
      return;
    }

    if (req.method === "POST" && url.pathname === "/authorize") {
      await handleAuthorizePost(req, res);
      return;
    }

    if (req.method === "POST" && url.pathname === "/token") {
      await handleToken(req, res);
      return;
    }

    if (url.pathname !== "/mcp") {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "Not found. Use POST /mcp." }));
      return;
    }

    if (!isAuthorized(req)) {
      unauthorized(req, res);
      return;
    }

    if (req.method !== "POST") {
      res.writeHead(405, { "allow": "POST", "content-type": "application/json" });
      res.end(JSON.stringify({ error: "Method not allowed. Use POST /mcp." }));
      return;
    }

    try {
      const payload = await parseJsonBody(req);
      const messages = Array.isArray(payload) ? payload : [payload];
      const responses = (await Promise.all(messages.map(handleRequest))).filter(Boolean);
      res.writeHead(200, {
        "content-type": "application/json",
        "mcp-session-id": req.headers["mcp-session-id"] ?? "trello-mcp"
      });
      res.end(JSON.stringify(Array.isArray(payload) ? responses : responses[0] ?? null));
    } catch (error) {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({
        jsonrpc: "2.0",
        id: null,
        error: {
          code: -32700,
          message: error instanceof Error ? error.message : String(error)
        }
      }));
    }
  });

  server.listen(port, host, () => {
    console.error(`${SERVER_NAME} listening on http://${host}:${port}/mcp`);
  });
}

if (process.env.MCP_TRANSPORT === "http") {
  startHttp();
} else {
  startStdio();
}
