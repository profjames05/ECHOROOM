# EchoRoom

EchoRoom is a live audio community app with a React client, Express API, Prisma persistence, Socket.IO chat/signaling, and browser WebRTC audio.

## GitHub-ready project setup

This repository is structured for GitHub upload and a clean separation between the public frontend and the private API/backend.

1. From the project folder, initialize Git:
   `git init`
2. Add the remote:
   `git remote add origin https://github.com/<your-username>/<your-repo-name>.git`
3. Create the initial commit:
   `git add . && git commit -m "Initial EchoRoom release"`
4. Push to GitHub:
   `git branch -M main && git push -u origin main`

The GitHub Pages workflow in `.github/workflows/deploy-pages.yml` builds the static client automatically. The API must remain on a separate host (for example Render, Railway, Fly.io, or another Node server provider) because GitHub Pages only serves static files.

## Run locally

1. Install dependencies from the repository root:
   `npm install`
2. Start the API and initialize the local SQLite database:
   `npm run dev:server`
3. In a second terminal, start the client:
   `npm run dev`
4. Open http://localhost:5173.

The API listens on http://localhost:4000. The API startup script runs `prisma db push` and an idempotent demo seed. The local database is `server/prisma/dev.db`.

For hosted deployments, set `VITE_API_URL` to the public API origin before building the client, and set `CLIENT_URL`, `DATABASE_URL`, and a strong `JWT_SECRET` for the server.

## Production hosting notes

- Frontend: GitHub Pages
- Backend: separate Node host (Render/Railway/Fly.io/VM)
- Required client env value: `VITE_API_URL=https://your-api-domain.com`
- Required server env values: `CLIENT_URL=https://your-github-pages-url`, `DATABASE_URL=...`, `JWT_SECRET=...`

Use the `.env.example` files as the baseline for your real environment values before deployment.

## Demo accounts

- Member: `ariana@echoroom.app` / `password123`
- Admin: `admin@echoroom.app` / `AdminPass123!`

Change the development JWT secret and use a production database before deployment. `server/.env.example` lists the server environment variables.

## Working features

- Persistent sign-up, password-hashed sign-in, JWT sessions, and sign-out
- Public room discovery, room creation, membership, leave, and speaker requests
- Persistent discussions, notifications, and feedback submissions
- Admin-only database-backed platform metrics
- Room chat persisted to SQLite and broadcast with Socket.IO
- WebRTC peer signaling and microphone controls in live rooms

## Build checks

- `npm run build --workspace client`
- `npm run build --workspace server`

WebRTC audio requires browser microphone permission. Direct peer-to-peer connections can be restricted by some NAT/firewall configurations; production deployments should configure a TURN service. SQLite is the local development adapter; choose and configure a production database before deploying.
