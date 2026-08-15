# ClonerTemplate for ChatGPT (private MVP)

This workspace exposes the existing ClonerTemplate repository to ChatGPT as a private [Model Context Protocol (MCP)](https://developers.openai.com/plugins/build/mcp-server) server. ChatGPT remains the agent; this process provides a small, controlled set of inspection, file, validation, and preview tools.

The server uses Streamable HTTP at `http://127.0.0.1:3001/mcp`. It is loopback-only by default and is intended to connect through [OpenAI Secure MCP Tunnel](https://developers.openai.com/api/docs/guides/secure-mcp-tunnels), so no inbound port or public MCP endpoint is needed.

## What ChatGPT can do

| Tool | Purpose |
| --- | --- |
| `inspect_site` | Summarize the public HTML and visible design signals of a site the user explicitly confirms they own or may recreate. |
| `list_workspace_files` | List supported text files in the bounded workspace. |
| `read_workspace_file` | Read a file and return the SHA-256 token required to change an existing file. |
| `write_workspace_files` | Create, replace, or delete up to 25 guarded files in one batch. |
| `get_workspace_status` | Show the current branch and Git changes. |
| `start_quality_check` | Start the fixed `lint`, `typecheck`, and `build` sequence without accepting shell input. |
| `get_quality_check` | Poll a quality-check job and read bounded output. |
| `check_preview` | Check the local Next.js preview and page title. |

Writes are limited to `src/`, `public/`, and `docs/research/`. Selected project configuration files are readable but not writable. The MCP server never commits, pushes, deploys, or starts the Next.js application.

## 1. Run the project locally

Requirements:

- Node.js 22+
- A private copy of this repository
- A ChatGPT account or workspace where developer mode and Secure MCP Tunnel are available
- `tunnel-client`, installed from the supported download in [Platform tunnel settings](https://platform.openai.com/settings/organization/tunnels) or on macOS with `brew install openai/tools/tunnel-client`

From the repository root:

```bash
npm ci
cp mcp/.env.example mcp/.env
```

Keep three terminals open. Start the website in the first:

```bash
npm run dev
```

Start the private MCP server in the second:

```bash
npm run mcp:dev
```

Confirm it is healthy:

```bash
curl -fsS http://127.0.0.1:3001/health
```

## 2. Create and run the secure tunnel

In OpenAI Platform:

1. Create a tunnel in [Tunnel settings](https://platform.openai.com/settings/organization/tunnels) and associate it with the ChatGPT workspace that will use it.
2. Give the runtime principal **Tunnels Read + Use** permission. Creating or editing a tunnel additionally requires **Tunnels Read + Manage**.
3. Create a runtime key in [organization API keys](https://platform.openai.com/settings/organization/api-keys). Do not use an admin key for the long-running tunnel process.

In the third terminal, keep the key only in the environment:

```bash
export CONTROL_PLANE_API_KEY="sk-..."

tunnel-client init \
  --sample sample_mcp_remote_no_auth \
  --profile cloner-template \
  --tunnel-id tunnel_0123456789abcdef0123456789abcdef \
  --mcp-server-url http://127.0.0.1:3001/mcp

tunnel-client doctor --profile cloner-template --explain
tunnel-client run --profile cloner-template
```

Keep `tunnel-client run` and the MCP server running while ChatGPT uses the connection. The tunnel authenticates the transport to OpenAI; it is not an OpenAI model API call and does not add model inference code to this repository.

## 3. Add it to ChatGPT

1. In ChatGPT, open **Settings → Security and login** and enable **Developer mode**. Availability can depend on workspace policy.
2. Open [ChatGPT Plugins](https://chatgpt.com/#settings/Connectors), select the plus button, and enter a name such as `ClonerTemplate (Private)`.
3. Under **Connection**, choose **Tunnel**, then select the tunnel or paste its `tunnel_id`.
4. Create the connection and verify that ChatGPT discovers the eight tools listed above.
5. Start a new chat, add `ClonerTemplate (Private)` from the tools menu, and ask it to work in the repository.

Example first request:

> I own `https://example.com` and authorize you to inspect it. Use ClonerTemplate to recreate the landing page in this workspace. Read the repository instructions and current files first, create only original or authorized assets, run the quality check, and verify the preview. Do not commit or deploy.

For a task that does not need a reference site:

> Use ClonerTemplate to list the workspace and improve the landing-page accessibility. Read every file before changing it, run the quality check, and summarize the Git status.

## Local verification

```bash
npm run mcp:check
```

To inspect and call tools directly before connecting ChatGPT:

```bash
npx @modelcontextprotocol/inspector@latest
```

Use `http://127.0.0.1:3001/mcp` as the Streamable HTTP endpoint.

## Security boundary

- Keep `MCP_HOST=127.0.0.1`; the server rejects non-loopback binding for this MVP.
- Never commit `mcp/.env`, tunnel profiles containing sensitive values, or API keys.
- Site inspection blocks local, private, link-local, reserved, and mixed public/private DNS answers, and rechecks every redirect.
- Inspection reads bounded public HTML only. It does not authenticate to the target, bypass access controls, or download assets.
- Existing file writes require a current SHA-256 token, which prevents silently overwriting a file that changed after ChatGPT read it.
- Repository paths, hidden/build directories, binary files, oversized files, traversal, duplicate targets, and symbolic-link escapes are blocked.
- If this MCP server is ever exposed directly to multiple users or the public internet, add proper OAuth authorization and a per-user workspace model first. The private MVP is not a public deployment configuration.

## Troubleshooting

- **ChatGPT does not list the tunnel:** confirm that the tunnel is associated with the correct ChatGPT workspace and that your principal has Tunnels Read + Use.
- **Tool discovery fails:** keep both `npm run mcp:dev` and `tunnel-client run --profile cloner-template` running, then rerun `tunnel-client doctor --profile cloner-template --explain`.
- **Preview is unreachable:** start `npm run dev`; the MCP server intentionally does not start it.
- **A write is rejected as stale:** ask ChatGPT to read the file again and retry with the new SHA-256 token.
- **Tool metadata changed:** restart the MCP server, open the connection in ChatGPT Plugins, and select **Refresh**.
