# Contributing

```bash
npm ci
npm run lint
npm run format:check
npm run typecheck
npm test
npm run build
```

- Branch from `main`: `feat/<topic>`, `fix/<topic>`, `chore/<topic>`.
- Conventional commit subjects (`feat(proxy): ...`, `fix(routing): ...`).
- Every behaviour change needs a Vitest case in `tests/`. Proxy tests spin up real local HTTP servers on port 0; do not hard-code ports.
- Add a line to `CHANGELOG.md` under Unreleased.
- Errors thrown to callers should be `GatewayError` subclasses so the proxy can map them to a status code.
