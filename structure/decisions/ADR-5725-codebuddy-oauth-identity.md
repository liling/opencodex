# ADR-5725 — decision recorded under "CodeBuddy IOA OAuth identity and destination"

- Contract owner: [providers-and-adapters.md](../providers-and-adapters.md#codebuddy-ioa-oauth-identity-and-destination)

## Decision record

- Context: The existing CodeBuddy presets call the vendor's documented headless CLI with region-specific API keys. The IOA browser flow used by the external OpenCode plugin obtains an OAuth token and sends HTTP Chat Completions requests to a separate service surface.
- Decision: Add `codebuddy-oauth` for China and `codebuddy-oauth-global` for Global. Each name is both its route identity and OAuth account-store namespace. The HTTP adapter is a distinct implementation that inherits the OpenAI Chat wire contract. The OAuth access token may only be sent to its region's fixed HTTPS origin.
- Alternatives: Reusing `codebuddy` or `codebuddy-cn` would change the meaning of saved API-key configurations and cross the CLI credential boundary. A single OAuth identity with a configurable region would let one stored account's token be routed to another region. A generic plugin loader would add a system-wide extension contract for one provider.
- Consequences: Existing CLI and API-key configurations retain their behavior. Authentication, account selection, refresh, and lifecycle remain with the shared OAuth authority. The HTTP path needs CodeBuddy-specific request metadata. The private IOA/API endpoint contract and vendor routing permission need primary-source evidence and explicit security review before any upstream merge.
