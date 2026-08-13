# Security Policy

## Supported versions

This project is a template rather than a versioned library. Security fixes are
applied to the latest version of the `master` branch.

Projects created from this template do not receive fixes automatically. Their
maintainers are responsible for reviewing relevant changes and updating their
own copies.

## Reporting a vulnerability

Please do not disclose vulnerability details in a public issue, pull request,
discussion, or Discord message.

Use GitHub's private
[Report a vulnerability](https://github.com/JCodesMore/ai-website-cloner-template/security/advisories/new)
form instead. Include, when available:

- A clear description of the vulnerability and its potential impact
- The affected files, dependencies, configuration, or commit
- Steps to reproduce the issue or a minimal proof of concept
- Any suggested mitigation or fix

We will acknowledge the report as soon as practical, investigate it, and
coordinate with you before any public disclosure.

If the private form is unavailable, you may use the
[Discord community](https://discord.gg/hrTSX5yTpB) only to ask a maintainer for
a private contact method. Do not post vulnerability details there.

## Scope

Security reports may cover:

- Code and dependencies shipped on the `master` branch
- Helper and synchronization scripts under `scripts/`
- Repository configuration or defaults that could make generated projects
  insecure
- AI-agent instructions that introduce a concrete security vulnerability

Generated website code, third-party services, vulnerabilities in unrelated
websites, and automated audit output without a demonstrated impact on this
template are outside this project's security scope.

## Responsible use

This template is intended for authorized development, migration, recovery, and
learning. See [Not Intended For](README.md#not-intended-for) for prohibited
uses. Reports about abuse or copied content should not include sensitive
security details in public channels.

## Private ChatGPT MCP boundary

The `mcp/` workspace is a private, single-operator development configuration.
By default it binds only to loopback and is designed for OpenAI Secure MCP
Tunnel. Keep `MCP_HOST=127.0.0.1`; non-loopback binding is rejected.

The MCP server limits file visibility and writes, requires SHA-256 concurrency
tokens for existing files, blocks path and symbolic-link escapes, accepts no
model-supplied shell commands, and validates public inspection URLs and every
redirect against private and reserved network ranges. These controls reduce
the impact of mistakes and prompt injection; they do not make an
unauthenticated public deployment safe.

Do not expose this private MVP directly to the internet or to untrusted users.
A public or multi-user deployment requires OAuth authorization, per-user
workspace isolation, durable audit and rate-limit controls, secret management,
and a separate security review. Never commit MCP environment files, tunnel
runtime keys, or other credentials.
