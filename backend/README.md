# Save to Brain Backend

## Setup

1. Create a Postgres database and enable pgvector.
2. Apply schema:

```bash
psql "$DATABASE_URL" -f schema.sql
```

3. Copy `.env.example` to `.env` and set values (use `EMBED_MODEL=gemini-embedding-001`).
4. (First time) Clear DB data if needed:

```bash
psql "$DATABASE_URL" -f clear_db.sql
```

## Run

```bash
npm install
npm run start
```

## API

### `POST /auth/request-otp`

Body:

```json
{ "email": "you@example.com" }
```

### `POST /auth/verify-otp`

Body:

```json
{ "email": "you@example.com", "code": "123456" }
```

### `POST /save-session`

Headers:

- `Authorization: Bearer <JWT>`

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

### `GET /history`

Headers:

- `Authorization: Bearer <JWT>`

### `GET /brain/:id/context`

Headers:

- `Authorization: Bearer <JWT>`

Response is plain text prompt.
