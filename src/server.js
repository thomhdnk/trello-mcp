#!/usr/bin/env node

import http from "node:http";
import fs from "node:fs";
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
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const body = Buffer.concat(chunks).toString("utf8");
  return body ? JSON.parse(body) : {};
}

function isAuthorized(req) {
  const expected = process.env.MCP_BEARER_TOKEN;
  if (!expected) return true;
  return req.headers.authorization === `Bearer ${expected}`;
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

    if (url.pathname !== "/mcp") {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "Not found. Use POST /mcp." }));
      return;
    }

    if (!isAuthorized(req)) {
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "Unauthorized" }));
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
