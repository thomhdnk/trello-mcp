#!/usr/bin/env node

import { spawn } from "node:child_process";

function frame(message) {
  const body = JSON.stringify(message);
  return `Content-Length: ${Buffer.byteLength(body, "utf8")}\r\n\r\n${body}`;
}

function parseFrames(onMessage) {
  let buffer = Buffer.alloc(0);
  return (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    while (true) {
      const separator = buffer.indexOf("\r\n\r\n");
      if (separator === -1) return;
      const header = buffer.subarray(0, separator).toString("utf8");
      const match = header.match(/content-length:\s*(\d+)/i);
      if (!match) throw new Error(`Bad header: ${header}`);
      const length = Number(match[1]);
      const start = separator + 4;
      const end = start + length;
      if (buffer.length < end) return;
      onMessage(JSON.parse(buffer.subarray(start, end).toString("utf8")));
      buffer = buffer.subarray(end);
    }
  };
}

const child = spawn(process.execPath, ["./src/server.js"], {
  stdio: ["pipe", "pipe", "inherit"],
  env: {
    ...process.env,
    TRELLO_API_KEY: process.env.TRELLO_API_KEY ?? "dummy",
    TRELLO_TOKEN: process.env.TRELLO_TOKEN ?? "dummy"
  }
});

let seen = 0;
child.stdout.on("data", parseFrames((message) => {
  console.log(JSON.stringify(message, null, 2));
  seen += 1;
  if (seen === 2) child.kill();
}));

child.stdin.write(frame({
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "inspect", version: "1.0.0" } }
}));
child.stdin.write(frame({ jsonrpc: "2.0", id: 2, method: "tools/list" }));
