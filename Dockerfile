FROM node:20-slim

WORKDIR /app

# better-sqlite3 needs build tools
RUN apt-get update && apt-get install -y python3 make g++ && rm -rf /var/lib/apt/lists/*

COPY package.json ./
RUN npm install --production

COPY . .

# Entrypoint: ensure DB exists, then run
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh
ENTRYPOINT ["/entrypoint.sh"]

# Default: run the loop collector
CMD ["node", "collect-loop.js"]
