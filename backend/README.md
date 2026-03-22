# Save to Brain Backend

## Setup

1. Create a Postgres database and enable pgvector.
2. Apply schema:

```bash
psql "$DATABASE_URL" -f schema.sql
```

3. Copy `.env.example` to `.env` and set values (use `EMBED_MODEL=gemini-embedding-001`).

## Run

```bash
npm install
npm run start
```

## API

### `POST /save-session`

Headers:

- `Authorization: Bearer <API_KEY>`

Body:

```json
{
  "project": "optional-project-name",
  "messages": [
    { "role": "user", "content": "..." },
    { "role": "assistant", "content": "..." }
  ]
}
```

### `GET /brain/:id/context`

Headers:

- `Authorization: Bearer <API_KEY>`

Response is plain text prompt.
