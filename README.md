# Trello MCP Server

Een kleine, dependency-free MCP-server waarmee ChatGPT/Codex/andere MCP-clients Trello kunnen lezen en bijwerken.

De server exposeert tools voor boards, lijsten, kaarten, comments en labels. Hij gebruikt Trello's officiële REST API via `TRELLO_API_KEY` en `TRELLO_TOKEN`.

## Wat zit erin?

- `trello_list_boards`
- `trello_get_board`
- `trello_list_lists`
- `trello_create_list`
- `trello_list_cards`
- `trello_get_card`
- `trello_create_card`
- `trello_update_card`
- `trello_move_card`
- `trello_archive_card`
- `trello_add_comment`
- `trello_list_labels`
- `trello_add_label_to_card`
- `trello_whoami`

## Trello credentials maken

1. Open <https://trello.com/app-key>.
2. Kopieer je API key.
3. Klik op de token-link op die pagina om een token te genereren.
4. Zet beide waarden als omgevingsvariabelen:

```bash
export TRELLO_API_KEY="jouw-api-key"
export TRELLO_TOKEN="jouw-token"
```

Of maak een `.env` bestand in deze map:

```bash
cp .env.example .env
```

Vul daarna je Trello key en token in.

## Lokaal draaien via stdio

Dit is de meest gebruikelijke vorm voor lokale MCP-clients:

```bash
npm run start
```

Voor een snelle protocolcheck:

```bash
npm run check
npm run inspect
```

## Configuratie voor een lokale MCP-client

Gebruik dit patroon in de MCP-configuratie van je client:

```json
{
  "mcpServers": {
    "trello": {
      "command": "node",
      "args": ["/Users/thom/Documents/Trello MCP/src/server.js"],
      "env": {
        "TRELLO_API_KEY": "jouw-api-key",
        "TRELLO_TOKEN": "jouw-token"
      }
    }
  }
}
```

## HTTP endpoint draaien

Voor ChatGPT Apps SDK / remote connector workflows is HTTP handiger. Start de server zo:

```bash
export TRELLO_API_KEY="jouw-api-key"
export TRELLO_TOKEN="jouw-token"
export MCP_TRANSPORT=http
export HOST=127.0.0.1
export PORT=3333
export MCP_BEARER_TOKEN="een-lange-random-secret"
export MCP_CONNECT_CODE="een-code-die-je-in-chatgpt-kunt-typen"
npm run start:http
```

Endpoint:

```text
http://localhost:3333/mcp
```

Health check:

```text
http://localhost:3333/health
```

Als je ChatGPT web of mobiel wilt koppelen, moet deze HTTP-server bereikbaar zijn via een publieke HTTPS URL. Voor lokaal testen kun je een tunnel gebruiken. Zet dan de publieke URL naar `/mcp` in ChatGPT's connector/app configuratie en gebruik de bearer token als authenticatie als je client dat ondersteunt.

## Deployen op Railway

Railway is de aanbevolen route voor dit project, omdat deze server als normale langlopende Node HTTP-service draait.

1. Zet deze map in een GitHub repository.
2. Maak in Railway een nieuw project vanuit die repository.
3. Zet bij de service variables:

```text
TRELLO_API_KEY=jouw-api-key
TRELLO_TOKEN=jouw-token
MCP_BEARER_TOKEN=een-lange-random-secret
MCP_CONNECT_CODE=een-code-die-je-in-chatgpt-kunt-typen
```

4. Deploy. Railway gebruikt `railway.json` om de server in HTTP-modus te starten.
5. Ga in Railway naar Networking en genereer een publieke domain.
6. Gebruik deze MCP URL:

```text
https://jouw-service.up.railway.app/mcp
```

Voor ChatGPT Custom Apps gebruikt de server OAuth. Tijdens het koppelen opent ChatGPT een autorisatiepagina. Vul daar `MCP_CONNECT_CODE` in. Als je `MCP_CONNECT_CODE` niet hebt gezet, gebruik dan `MCP_BEARER_TOKEN`.

## Netlify?

Netlify kan wel serverless HTTP endpoints draaien, maar deze code is nu een normale langlopende MCP HTTP-server. Voor Netlify zouden we hem moeten ombouwen naar een Netlify Function. Dat kan, maar Railway is simpeler en past beter bij deze server.

## Belangrijke veiligheidsnoot

Je Trello token geeft toegang tot je Trello-account. Deel hem niet, commit hem niet, en gebruik voor publieke deployment liever OAuth of een beperkte, aparte Trello-account/token.
