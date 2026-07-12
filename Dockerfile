FROM node:20-bookworm-slim

# node-pty compiles a native addon on install.
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev
COPY . .

ENV PORT=3000
EXPOSE 3000

CMD ["node", "server.js"]
